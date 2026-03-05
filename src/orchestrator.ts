import { randomUUID } from "crypto";
import { loadConfig } from "./config";
import { parseContractOutput } from "./parser";
import { validateContract } from "./contract";
import { resolveTarget } from "./router";
import { askHumanInput as defaultAskHumanInput } from "./human-gate";
import { invokeAgent as defaultInvokeAgent } from "./adapters";
import { acquireRunLock, createRunLogger, resolveTimeoutMs } from "./runtime";
import { getRepoStateSignature as defaultGetRepoStateSignature } from "./git-state";
import { AgentName, Config, Contract, OrchestratorResult, RunInput, TargetName } from "./types";

export const CONTRACT_SUFFIX = [
  "---",
  "You must end your response with exactly one JSON block and no text after it:",
  "```json",
  "{",
  '  "contract_version": "1",',
  '  "next_action": "plan | implement | review | ask-human | done",',
  '  "to": "(optional) plan | implement | review | ask-human | done",',
  '  "message": "task/context for next step",',
  '  "questions": [{"id":"q1","text":"Only for ask-human"}]',
  "}",
  "```",
].join("\n");

type InvokeAgentFn = NonNullable<NonNullable<RunInput["runtime"]>["invokeAgent"]>;
type AskHumanInputFn = NonNullable<NonNullable<RunInput["runtime"]>["askHumanInput"]>;
type RepoStateFn = NonNullable<NonNullable<RunInput["runtime"]>["getRepoStateSignature"]>;

function buildPrompt(message: string): string {
  return `${message}\n\n${CONTRACT_SUFFIX}`;
}

function buildRetryMessage(message: string, errorText: string): string {
  return [
    "Your previous response did not end with a valid contract JSON block.",
    "Return a corrected response now.",
    `Validation/parsing error:\n${errorText}`,
    `Original task/context:\n${message}`,
  ].join("\n\n");
}

function clipText(value: string, max = 3000): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...[truncated]`;
}

function parseAndValidate(output: string): Contract {
  const parsed = parseContractOutput(output);
  return validateContract(parsed);
}

async function getContractWithRetry(params: {
  agent: AgentName;
  message: string;
  config: Config;
  cwd: string;
  stepId: number;
  logger: { logEvent: (event: Record<string, unknown>) => void };
  timeoutMs: number;
  maxInvalidContractRetries: number;
  invokeAgentFn: InvokeAgentFn;
}): Promise<{ contract: Contract; attempts: number }> {
  const {
    agent,
    message,
    config,
    cwd,
    stepId,
    logger,
    timeoutMs,
    maxInvalidContractRetries,
    invokeAgentFn,
  } = params;

  const totalAttempts = maxInvalidContractRetries + 1;
  let promptMessage = message;
  let lastError = new Error("Unknown contract parsing error");

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    if (attempt > 1) {
      console.log(`\n[retry] requesting strict contract from ${agent} (attempt ${attempt}/${totalAttempts})`);
      logger.logEvent({
        type: "contract_retry",
        step_id: stepId,
        agent,
        attempt,
      });
    }

    const invocation = await invokeAgentFn(agent, buildPrompt(promptMessage), {
      config,
      cwd,
      timeoutMs,
      onOutput: (chunk, stream) => {
        if (stream === "stderr") {
          process.stderr.write(chunk);
          return;
        }
        process.stdout.write(chunk);
      },
    });

    logger.logEvent({
      type: "agent_invocation",
      step_id: stepId,
      agent,
      attempt,
      duration_ms: invocation.durationMs,
      timeout_ms: invocation.timeoutMs,
      command: invocation.command,
      stderr_sample: clipText(invocation.stderr),
    });

    const candidates = [invocation.stdout, invocation.combined];
    let parsedContract: Contract | null = null;

    for (const candidate of candidates) {
      try {
        parsedContract = parseAndValidate(candidate);
        break;
      } catch (error) {
        lastError = error as Error;
      }
    }

    if (parsedContract) {
      return {
        contract: parsedContract,
        attempts: attempt,
      };
    }

    console.error(`\n[warn] invalid contract from ${agent}: ${lastError.message}`);
    logger.logEvent({
      type: "contract_invalid",
      step_id: stepId,
      agent,
      attempt,
      error: lastError.message,
      stdout_sample: clipText(invocation.stdout),
    });
    promptMessage = buildRetryMessage(message, lastError.message);
  }

  throw new Error(
    `Contract parse/validation failed after ${totalAttempts} attempt(s): ${lastError.message}`
  );
}

export async function runOrchestrator(input: RunInput): Promise<OrchestratorResult> {
  const cwd = input.cwd || process.cwd();
  const config = loadConfig({ cwd, configPath: input.configPath || undefined });
  const runId = randomUUID();
  const logger = createRunLogger({ cwd, config, runId });
  const lock = acquireRunLock({ cwd, config, runId });

  const invokeAgentFn: InvokeAgentFn = input.runtime?.invokeAgent || defaultInvokeAgent;
  const askHumanInputFn: AskHumanInputFn = input.runtime?.askHumanInput || defaultAskHumanInput;
  const getRepoStateSignatureFn: RepoStateFn =
    input.runtime?.getRepoStateSignature || defaultGetRepoStateSignature;

  const maxHops = Number.isInteger(input.maxHops) && (input.maxHops as number) > 0 ? (input.maxHops as number) : config.max_hops;
  const maxInvalidContractRetries =
    Number.isInteger(input.maxInvalidContractRetries) && (input.maxInvalidContractRetries as number) >= 0
      ? (input.maxInvalidContractRetries as number)
      : config.max_invalid_contract_retries;
  const timeoutOverrideMs =
    Number.isInteger(input.timeoutMs) && (input.timeoutMs as number) > 0
      ? (input.timeoutMs as number)
      : undefined;
  const noProgressHops =
    Number.isInteger(input.noProgressHops) && (input.noProgressHops as number) >= 0
      ? (input.noProgressHops as number)
      : config.no_progress_hops;

  let currentAgent: AgentName = input.firstAgent || config.first_agent;
  let currentMessage = input.task;
  let hopCount = 0;
  let activeStepId = 0;
  let signalHandled = false;
  let noProgressCount = 0;
  let previousRepoState = await Promise.resolve(getRepoStateSignatureFn(cwd));

  const handleSignal = (signalName: string): void => {
    if (signalHandled) {
      return;
    }
    signalHandled = true;

    logger.logEvent({
      type: "signal",
      signal: signalName,
      step_id: activeStepId,
    });
    lock.release();
    console.error(`\n[signal] ${signalName} received. Released lock and exiting.`);
    process.exit(130);
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  const effectiveTimeout = timeoutOverrideMs || config.agent_timeout_ms;

  console.log(`run_id=${runId}`);
  console.log(`cwd=${cwd}`);
  console.log(`lock_file=${lock.lockPath}`);
  console.log(`log_file=${logger.logPath}`);
  console.log(`first_agent=${currentAgent}`);
  console.log(`max_hops=${maxHops}`);
  console.log(`agent_timeout_ms=${effectiveTimeout}`);
  console.log(`no_progress_hops=${noProgressHops}`);

  logger.logEvent({
    type: "run_started",
    cwd,
    first_agent: currentAgent,
    max_hops: maxHops,
    max_invalid_contract_retries: maxInvalidContractRetries,
    timeout_override_ms: timeoutOverrideMs || null,
    no_progress_hops: noProgressHops,
    lock_file: lock.lockPath,
    log_file: logger.logPath,
    repo_state_available: previousRepoState !== null,
  });

  try {
    while (hopCount < maxHops) {
      const stepId = hopCount + 1;
      activeStepId = stepId;
      const timeoutMs = resolveTimeoutMs(currentAgent, config, timeoutOverrideMs);
      console.log(`\n=== step ${stepId} | agent: ${currentAgent} | timeout_ms: ${timeoutMs} ===`);
      logger.logEvent({
        type: "step_started",
        step_id: stepId,
        agent: currentAgent,
        timeout_ms: timeoutMs,
        message: clipText(currentMessage),
      });

      let contract: Contract;
      let attempts = 0;
      try {
        const result = await getContractWithRetry({
          agent: currentAgent,
          message: currentMessage,
          config,
          cwd,
          stepId,
          logger,
          timeoutMs,
          maxInvalidContractRetries,
          invokeAgentFn,
        });
        contract = result.contract;
        attempts = result.attempts;
      } catch (error) {
        logger.logEvent({
          type: "step_failed",
          step_id: stepId,
          agent: currentAgent,
          error: (error as Error).message,
        });

        const humanResponse = await askHumanInputFn({
          message: `Agent invocation/contract failed for ${currentAgent}: ${(error as Error).message}\nProvide next instruction for ${currentAgent}.`,
        });

        if (humanResponse === "") {
          throw new Error("No human input provided after failure; stopping run");
        }

        logger.logEvent({
          type: "human_response",
          step_id: stepId,
          reason: "agent-failure",
          response: clipText(humanResponse),
        });
        currentMessage = humanResponse;
        noProgressCount = 0;
        hopCount += 1;
        continue;
      }

      let target: TargetName;
      try {
        target = resolveTarget(contract, config);
      } catch (error) {
        logger.logEvent({
          type: "routing_failed",
          step_id: stepId,
          agent: currentAgent,
          contract,
          error: (error as Error).message,
        });

        const humanResponse = await askHumanInputFn({
          message: `Routing error: ${(error as Error).message}\nProvide next instruction for ${currentAgent}.`,
        });

        if (humanResponse === "") {
          throw new Error("No human input provided after routing error; stopping run");
        }

        logger.logEvent({
          type: "human_response",
          step_id: stepId,
          reason: "routing-error",
          response: clipText(humanResponse),
        });
        currentMessage = humanResponse;
        noProgressCount = 0;
        hopCount += 1;
        continue;
      }

      logger.logEvent({
        type: "step_contract",
        step_id: stepId,
        agent: currentAgent,
        parse_attempts: attempts,
        contract,
        target,
      });

      if (target === "stop" || contract.next_action === "done") {
        console.log("\n=== done ===");
        console.log(contract.message);
        logger.logEvent({
          type: "run_completed",
          status: "done",
          step_id: stepId,
          message: clipText(contract.message),
        });
        return {
          runId,
          hops: stepId,
          status: "done",
          logPath: logger.logPath,
        };
      }

      if (target === "human") {
        const response = await askHumanInputFn({
          message: contract.message,
          questions: contract.questions,
        });

        if (response === "") {
          throw new Error("Empty human response; stopping run");
        }

        logger.logEvent({
          type: "human_response",
          step_id: stepId,
          reason: "ask-human",
          response: clipText(response),
        });
        currentMessage = response;
        noProgressCount = 0;
        hopCount += 1;
        continue;
      }

      if (noProgressHops > 0) {
        const currentRepoState = await Promise.resolve(getRepoStateSignatureFn(cwd));
        if (currentRepoState !== null && previousRepoState !== null) {
          noProgressCount = currentRepoState === previousRepoState ? noProgressCount + 1 : 0;
          logger.logEvent({
            type: "no_progress_check",
            step_id: stepId,
            no_progress_count: noProgressCount,
          });

          if (noProgressCount >= noProgressHops) {
            const response = await askHumanInputFn({
              message:
                `No repository changes detected for ${noProgressCount} consecutive agent steps. ` +
                "Provide guidance for the next agent.",
            });

            if (response === "") {
              throw new Error("Empty human response after no-progress guard; stopping run");
            }

            logger.logEvent({
              type: "human_response",
              step_id: stepId,
              reason: "no-progress",
              response: clipText(response),
            });
            currentAgent = target as AgentName;
            currentMessage = response;
            noProgressCount = 0;
            previousRepoState = currentRepoState;
            hopCount += 1;
            continue;
          }

          previousRepoState = currentRepoState;
        } else if (currentRepoState !== null) {
          previousRepoState = currentRepoState;
        }
      }

      currentAgent = target as AgentName;
      currentMessage = contract.message;
      hopCount += 1;
    }

    const stopMessage = `Reached max_hops=${maxHops}.`;
    console.log(`\n=== max hops reached ===\n${stopMessage}`);
    logger.logEvent({
      type: "run_completed",
      status: "max-hops",
      step_id: maxHops,
      message: stopMessage,
    });
    return {
      runId,
      hops: maxHops,
      status: "max-hops",
      logPath: logger.logPath,
    };
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    lock.release();
    logger.logEvent({
      type: "run_finalized",
    });
  }
}

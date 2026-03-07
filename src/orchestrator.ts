import { randomUUID } from "crypto";
import { loadConfig } from "./config";
import { parseContractOutput } from "./parser";
import { validateContract } from "./contract";
import { resolveTarget } from "./router";
import { askHumanInput as defaultAskHumanInput } from "./human-gate";
import { invokeAgent as defaultInvokeAgent } from "./adapters";
import { acquireRunLock, createRunLogger, resolveTimeoutMs } from "./runtime";
import { getRepoStateSignature as defaultGetRepoStateSignature } from "./git-state";
import {
  AgentName,
  Config,
  Contract,
  NextAction,
  OrchestratorResult,
  RunInput,
  StepPromptScope,
  TargetName,
} from "./types";

export const CONTRACT_SUFFIX = [
  "---",
  "You must end your response with exactly one JSON block and no text after it:",
  "```json",
  "{",
  '  "contract_version": "1",',
  '  "next_action": "plan | implement | review | pair | ask-human | done",',
  '  "to": "(optional) plan | implement | review | pair | ask-human | done",',
  '  "message": "task/context for next step",',
  '  "questions": [{"id":"q1","text":"Only for ask-human"}]',
  "}",
  "```",
].join("\n");

const AGENT_HEARTBEAT_MS = 10000;
const PROMPT_CONTEXT_TURNS = 4;

type PromptSpeaker = AgentName | "human";
type ConversationTurn = {
  speaker: PromptSpeaker;
  message: string;
};

type InvokeAgentFn = NonNullable<NonNullable<RunInput["runtime"]>["invokeAgent"]>;
type AskHumanInputFn = NonNullable<NonNullable<RunInput["runtime"]>["askHumanInput"]>;
type RepoStateFn = NonNullable<NonNullable<RunInput["runtime"]>["getRepoStateSignature"]>;

type StepThreadState = {
  threadKey: string;
  agent: AgentName;
  sessionRef: string | null;
  lastHistoryIndex: number;
};

interface PairReturnContext {
  returnAgent: AgentName;
  returnStepPromptScope: StepPromptScope;
  returnThreadKey: string;
}

function indentBlock(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function formatConversationTurns(turns: ConversationTurn[]): string {
  return turns
    .map((turn) => `${turn.speaker}:\n${indentBlock(clipText(turn.message, 1200))}`)
    .join("\n");
}

function buildPromptBody(params: {
  message: string;
  speaker: PromptSpeaker;
  stepPrompts: string[];
  contextLabel: string;
  contextTurns: ConversationTurn[];
}): string {
  const sections: string[] = [];

  if (params.stepPrompts.length > 0) {
    sections.push(
      [
        "Step-specific instructions (follow these in addition to the task):",
        ...params.stepPrompts.map((prompt) => `- ${prompt}`),
      ].join("\n")
    );
  }

  sections.push(`Current handoff from ${params.speaker}:\n${params.message}`);

  if (params.contextTurns.length > 0) {
    sections.push(
      [params.contextLabel, formatConversationTurns(params.contextTurns)].join("\n")
    );
  }

  return sections.join("\n\n");
}

function buildInitialPromptBody(params: {
  message: string;
  speaker: PromptSpeaker;
  history: ConversationTurn[];
  stepPrompts: string[];
}): string {
  const recentTurns = params.history.slice(-PROMPT_CONTEXT_TURNS);
  return buildPromptBody({
    message: params.message,
    speaker: params.speaker,
    stepPrompts: params.stepPrompts,
    contextLabel:
      "Recent conversation context (oldest first; use this for continuity and do not ask the human to repeat it unless necessary):",
    contextTurns: recentTurns.slice(0, -1),
  });
}

function buildResumePromptBody(params: {
  message: string;
  speaker: PromptSpeaker;
  history: ConversationTurn[];
  stepPrompts: string[];
  lastHistoryIndex: number;
}): string {
  const turnsSinceLastActive = params.history.slice(params.lastHistoryIndex);
  return buildPromptBody({
    message: params.message,
    speaker: params.speaker,
    stepPrompts: params.stepPrompts,
    contextLabel:
      "Conversation since this step last ran (oldest first; the existing session already has older context):",
    contextTurns: turnsSinceLastActive.slice(0, -1),
  });
}

function buildPrompt(message: string): string {
  return `${message}\n\n${CONTRACT_SUFFIX}`;
}

function appendConversationTurn(
  history: ConversationTurn[],
  speaker: PromptSpeaker,
  message: string
): void {
  history.push({ speaker, message });
}

function resolveStepPromptScope(action: NextAction | undefined): StepPromptScope | null {
  if (action === "plan" || action === "implement" || action === "review" || action === "pair") {
    return action;
  }

  return null;
}

function resolveNextThreadKey(routedAction: NextAction | undefined, currentThreadKey: string): string {
  if (routedAction === "pair") {
    return `pair:${currentThreadKey}`;
  }

  const nextScope = resolveStepPromptScope(routedAction);
  return nextScope || currentThreadKey;
}

function getOrCreateThreadState(
  threads: Map<string, StepThreadState>,
  threadKey: string,
  agent: AgentName
): StepThreadState {
  const existing = threads.get(threadKey);
  if (existing) {
    existing.agent = agent;
    return existing;
  }

  const created: StepThreadState = {
    threadKey,
    agent,
    sessionRef: null,
    lastHistoryIndex: 0,
  };
  threads.set(threadKey, created);
  return created;
}

class ContractAcquisitionError extends Error {
  sessionRef: string | null;

  constructor(message: string, sessionRef: string | null) {
    super(message);
    this.name = "ContractAcquisitionError";
    this.sessionRef = sessionRef;
  }
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

export function createPrefixedWriter(
  target: NodeJS.WriteStream,
  prefix: string
): (chunk: string) => void {
  let atLineStart = true;

  return (chunk: string): void => {
    if (chunk === "") {
      return;
    }

    let output = "";
    for (const char of chunk) {
      if (atLineStart) {
        output += prefix;
        atLineStart = false;
      }

      output += char;
      if (char === "\n") {
        atLineStart = true;
      }
    }

    target.write(output);
  };
}

function parseAndValidate(output: string): Contract {
  const parsed = parseContractOutput(output);
  return validateContract(parsed);
}

async function getContractWithRetry(params: {
  agent: AgentName;
  message: string;
  sessionRef: string | null;
  config: Config;
  cwd: string;
  stepId: number;
  logger: { logEvent: (event: Record<string, unknown>) => void };
  timeoutMs: number;
  maxInvalidContractRetries: number;
  invokeAgentFn: InvokeAgentFn;
}): Promise<{ contract: Contract; attempts: number; sessionRef: string | null }> {
  const {
    agent,
    message,
    sessionRef,
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
  let currentSessionRef = sessionRef;
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

    const writeStdout = createPrefixedWriter(process.stdout, `[${agent}] `);
    const writeStderr = createPrefixedWriter(process.stderr, `[${agent}:stderr] `);
    let lastOutputAt = Date.now();
    const heartbeatId = setInterval(() => {
      const idleMs = Date.now() - lastOutputAt;
      if (idleMs < AGENT_HEARTBEAT_MS) {
        return;
      }

      process.stdout.write(`\n[${agent}] ... still working (${Math.floor(idleMs / 1000)}s idle)\n`);
    }, AGENT_HEARTBEAT_MS);

    const invocation = await (async () => {
      try {
        return await invokeAgentFn(agent, buildPrompt(promptMessage), {
          config,
          cwd,
          timeoutMs,
          sessionRef: currentSessionRef,
          onOutput: (chunk, stream) => {
            lastOutputAt = Date.now();
            if (stream === "stderr") {
              writeStderr(chunk);
              return;
            }
            writeStdout(chunk);
          },
        });
      } finally {
        clearInterval(heartbeatId);
      }
    })();
    currentSessionRef = invocation.sessionRef || currentSessionRef;

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
        sessionRef: currentSessionRef,
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

  throw new ContractAcquisitionError(
    `Contract parse/validation failed after ${totalAttempts} attempt(s): ${lastError.message}`,
    currentSessionRef
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
  let currentMessageSpeaker: PromptSpeaker = "human";
  let currentStepPromptScope: StepPromptScope = "first_agent";
  let currentThreadKey = "first_agent";
  let hopCount = 0;
  let activeStepId = 0;
  let signalHandled = false;
  let noProgressCount = 0;
  let pairReturn: PairReturnContext | null = null;
  let previousRepoState = await Promise.resolve(getRepoStateSignatureFn(cwd));
  const stepThreads = new Map<string, StepThreadState>();
  const conversationHistory: ConversationTurn[] = [
    {
      speaker: currentMessageSpeaker,
      message: currentMessage,
    },
  ];

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

      const threadState = getOrCreateThreadState(stepThreads, currentThreadKey, currentAgent);
      const historyIndexAtPrompt = conversationHistory.length;
      const promptMessage = threadState.sessionRef
        ? buildResumePromptBody({
            message: currentMessage,
            speaker: currentMessageSpeaker,
            history: conversationHistory,
            stepPrompts: config.step_prompts[currentStepPromptScope],
            lastHistoryIndex: threadState.lastHistoryIndex,
          })
        : buildInitialPromptBody({
            message: currentMessage,
            speaker: currentMessageSpeaker,
            history: conversationHistory,
            stepPrompts: config.step_prompts[currentStepPromptScope],
          });

      logger.logEvent({
        type: threadState.sessionRef ? "thread_session_resumed" : "thread_session_started",
        step_id: stepId,
        agent: currentAgent,
        thread_key: currentThreadKey,
        session_ref: threadState.sessionRef,
      });

      let contract: Contract;
      let attempts = 0;
      let resolvedSessionRef = threadState.sessionRef;
      try {
        const result = await getContractWithRetry({
          agent: currentAgent,
          message: promptMessage,
          sessionRef: threadState.sessionRef,
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
        resolvedSessionRef = result.sessionRef;
      } catch (error) {
        if (error instanceof ContractAcquisitionError) {
          resolvedSessionRef = error.sessionRef;
        }
        threadState.sessionRef = resolvedSessionRef;
        threadState.lastHistoryIndex = historyIndexAtPrompt;
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
        appendConversationTurn(conversationHistory, "human", humanResponse);
        currentMessage = humanResponse;
        currentMessageSpeaker = "human";
        noProgressCount = 0;
        hopCount += 1;
        continue;
      }

      threadState.sessionRef = resolvedSessionRef;

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
        appendConversationTurn(conversationHistory, "human", humanResponse);
        currentMessage = humanResponse;
        currentMessageSpeaker = "human";
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
      const handoffSpeaker = currentAgent;
      const routedAction = contract.to || contract.next_action;
      const nextStepPromptScope: StepPromptScope =
        resolveStepPromptScope(routedAction) || currentStepPromptScope;
      const nextThreadKey = resolveNextThreadKey(routedAction, currentThreadKey);

      if (target !== "stop" || routedAction === "done") {
        appendConversationTurn(conversationHistory, handoffSpeaker, contract.message);
      }
      threadState.lastHistoryIndex = conversationHistory.length;

      // --- Pair return: force routing back to the invoking agent ---
      if (pairReturn !== null) {
        console.log(`\n[pair] returning to ${pairReturn.returnAgent}`);
        logger.logEvent({
          type: "pair_return",
          step_id: stepId,
          return_agent: pairReturn.returnAgent,
        });
        currentAgent = pairReturn.returnAgent;
        currentMessage = contract.message;
        currentMessageSpeaker = handoffSpeaker;
        currentStepPromptScope = pairReturn.returnStepPromptScope;
        currentThreadKey = pairReturn.returnThreadKey;
        pairReturn = null;
        hopCount += 1;
        continue;
      }

      if (target === "stop") {
        if (routedAction === "done") {
          logger.logEvent({
            type: "done_gate_opened",
            step_id: stepId,
            agent: currentAgent,
            thread_key: currentThreadKey,
            session_ref: threadState.sessionRef,
          });

          const decision = await askHumanInputFn({
            message:
              `${contract.message}\n\n` +
              'Reply with "finish" to end the run, "continue" to continue with the same agent session, or enter a follow-up message/question directly to continue with the same agent session.',
          });

          if (decision === "") {
            throw new Error("Empty response at done gate; stopping run");
          }

          const normalizedDecision = decision.trim().toLowerCase();
          if (normalizedDecision === "finish") {
            console.log("\n=== done ===");
            console.log(contract.message);
            logger.logEvent({
              type: "done_gate_finish",
              step_id: stepId,
              agent: currentAgent,
              thread_key: currentThreadKey,
            });
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

          let followUp = decision;
          if (normalizedDecision === "continue") {
            followUp = await askHumanInputFn({
              message:
                `Continuing with ${currentAgent} on the same saved session.\n` +
                "Enter the follow-up message or question for that agent.",
            });

            if (followUp === "") {
              throw new Error("Empty follow-up after continue; stopping run");
            }
          }

          logger.logEvent({
            type: "done_gate_continue",
            step_id: stepId,
            agent: currentAgent,
            thread_key: currentThreadKey,
            response: clipText(followUp),
          });
          appendConversationTurn(conversationHistory, "human", followUp);
          currentMessage = followUp;
          currentMessageSpeaker = "human";
          noProgressCount = 0;
          hopCount += 1;
          continue;
        }

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
          reason: (contract.to || contract.next_action) === "ask-human" ? "ask-human" : `routed-to-human:${contract.to || contract.next_action}`,
          response: clipText(response),
        });
        appendConversationTurn(conversationHistory, "human", response);
        currentMessage = response;
        currentMessageSpeaker = "human";
        currentStepPromptScope = nextStepPromptScope;
        currentThreadKey = nextThreadKey;
        noProgressCount = 0;
        hopCount += 1;
        continue;
      }

      // --- Pair invocation: save return context and route to pair agent ---
      if (routedAction === "pair") {
        console.log(`\n[pair] ${currentAgent} invoking pair session -> ${target}`);
        logger.logEvent({
          type: "pair_invoked",
          step_id: stepId,
          invoking_agent: currentAgent,
          pair_target: target,
        });
        pairReturn = {
          returnAgent: currentAgent,
          returnStepPromptScope: currentStepPromptScope,
          returnThreadKey: currentThreadKey,
        };
        currentAgent = target as AgentName;
        currentMessage = contract.message;
        currentMessageSpeaker = handoffSpeaker;
        currentStepPromptScope = nextStepPromptScope;
        currentThreadKey = nextThreadKey;
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
            appendConversationTurn(conversationHistory, "human", response);
            currentAgent = target as AgentName;
            currentMessage = response;
            currentMessageSpeaker = "human";
            currentStepPromptScope = nextStepPromptScope;
            currentThreadKey = nextThreadKey;
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
      currentMessageSpeaker = handoffSpeaker;
      currentStepPromptScope = nextStepPromptScope;
      currentThreadKey = nextThreadKey;
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

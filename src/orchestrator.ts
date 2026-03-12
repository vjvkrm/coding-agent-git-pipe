import { randomUUID } from "crypto";
import { loadConfig } from "./config";
import { parseContractOutput } from "./parser";
import { validateContract } from "./contract";
import { resolveTarget } from "./router";
import { askHumanInput as defaultAskHumanInput } from "./human-gate";
import { invokeAgent as defaultInvokeAgent } from "./adapters";
import {
  acquireRunLock,
  createRunLogger,
  resolveTimeoutMs,
  validateConfiguredAgentsAvailable,
} from "./runtime";
import { getRepoStateSignature as defaultGetRepoStateSignature } from "./git-state";
import {
  AgentName,
  Config,
  Contract,
  HumanInputPayload,
  NextAction,
  OrchestratorResult,
  RunInput,
  StepPromptScope,
  TargetName,
} from "./types";
import {
  runPlanAndDiscuss,
  inferDiscussionParticipants,
} from "./discussion";
import { createRunSurface, RunSurface } from "./run-ui";
import * as ui from "./ui";

export const CONTRACT_SUFFIX = [
  "---",
  "When handing off to another action, make the `message` field a concise technical handoff.",
  "Include the current state or diagnosis, the exact next task, and any relevant files, tests, commands, or constraints.",
  "Keep it specific and compact. Avoid vague summaries.",
  "You must end your response with exactly one JSON block and no text after it:",
  "```json",
  "{",
  '  "contract_version": "1",',
  '  "next_action": "primary | review | pair | ask-human | done",',
  '  "to": "(optional) primary | review | pair | ask-human | done",',
  '  "message": "concise technical handoff for the next step",',
  '  "questions": [{"id":"q1","text":"Only for ask-human"}],',
  '  "review_verdict": "(optional, review step only) approve | request-changes",',
  '  "review_comments": [{"file":"path/to/file","line":42,"comment":"issue description"}]',
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
  stepScope: StepPromptScope;
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

  sections.push(
    [
      "Technical handoff rules:",
      "- Treat the current handoff as the primary continuation state for this step.",
      "- If you route again, make `message` a concise technical handoff with current state/diagnosis, exact next task, and relevant files/tests/constraints.",
      "- Keep the handoff compact and specific.",
    ].join("\n")
  );

  const actionRulesByScope: Record<StepPromptScope, string[]> = {
    primary: [
      "- Stay in `primary` while you are still actively working.",
      "- Use `pair` when you want advisory help from the configured pair agent.",
      "- Use `review` when implementation or analysis is ready for signoff.",
      "- Use `done` only when no further review is needed for the current repo state.",
    ],
    review: [
      "- You are the review gate for the current repo state.",
      "- Include `review_verdict` in your contract: `approve` if code is ready to ship, `request-changes` if fixes are needed.",
      "- When requesting changes, include `review_comments` array with specific `file`, `line`, and `comment` for each issue found.",
      "- Use `primary` to send concrete fixes or follow-up work back.",
      "- Use `pair` only for extra advisory input; the run will return to this review thread.",
      "- Use `done` only when the current state is approved to finish.",
    ],
    pair: [
      "- Provide concise expert advice for the invoking step.",
      "- Focus on diagnosis, options, and recommended next actions.",
      "- Pair routing is fixed by the caller. Your `next_action` and `to` fields are ignored; only `message` is used.",
      "- Return a handoff message for the invoking agent; do not attempt to choose global routing for the run.",
      "- Set `next_action` to `done` and focus on making `message` useful for the caller.",
      "- Your response will return to the invoking thread automatically.",
    ],
  };
  sections.push(["Step routing guidance:", ...actionRulesByScope[params.stepScope]].join("\n"));

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
  stepScope: StepPromptScope;
  history: ConversationTurn[];
  stepPrompts: string[];
}): string {
  const recentTurns = params.history.slice(-PROMPT_CONTEXT_TURNS);
  return buildPromptBody({
    message: params.message,
    speaker: params.speaker,
    stepScope: params.stepScope,
    stepPrompts: params.stepPrompts,
    contextLabel:
      "Recent conversation context (oldest first; use this for continuity and do not ask the human to repeat it unless necessary):",
    contextTurns: recentTurns.slice(0, -1),
  });
}

function buildResumePromptBody(params: {
  message: string;
  speaker: PromptSpeaker;
  stepScope: StepPromptScope;
  history: ConversationTurn[];
  stepPrompts: string[];
  lastHistoryIndex: number;
}): string {
  const turnsSinceLastActive = params.history.slice(params.lastHistoryIndex);
  return buildPromptBody({
    message: params.message,
    speaker: params.speaker,
    stepScope: params.stepScope,
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
  if (action === "primary" || action === "review" || action === "pair") {
    return action;
  }

  return null;
}

function buildHumanGateFooter(base: string | null = null): string {
  const suffix = 'Reply with "/finish" to end the run immediately.';
  return base && base.trim() !== "" ? `${base}\n${suffix}` : suffix;
}

function isGlobalFinishCommand(value: string): boolean {
  return value.trim().toLowerCase() === "/finish";
}

function didRepoChangeSinceBaseline(
  currentRepoState: string | null,
  baselineRepoState: string | null
): boolean | null {
  if (currentRepoState === null || baselineRepoState === null) {
    return null;
  }

  return currentRepoState !== baselineRepoState;
}

function normalizePairContract(contract: Contract): Contract {
  return {
    contract_version: "1",
    next_action: "done",
    to: "done",
    message: contract.message,
  };
}

function isAgentTarget(target: TargetName): target is AgentName {
  return target === "claude" || target === "codex" || target === "gemini";
}

function resolveNextThreadKey(target: TargetName, currentThreadKey: string): string {
  return isAgentTarget(target) ? target : currentThreadKey;
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
  humanInputPayload: HumanInputPayload | null;
  directHumanRequest: string | null;

  constructor(
    message: string,
    sessionRef: string | null,
    humanInputPayload: HumanInputPayload | null = null,
    directHumanRequest: string | null = null
  ) {
    super(message);
    this.name = "ContractAcquisitionError";
    this.sessionRef = sessionRef;
    this.humanInputPayload = humanInputPayload;
    this.directHumanRequest = directHumanRequest;
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

function formatAgentLabel(agent: AgentName): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

function looksLikeDirectHumanRequest(text: string): boolean {
  if (!text.includes("?")) {
    return /(need|needs|needed|require|requires|required|clarif|confirm|choose|pick|decide|specify|provide)/i.test(text);
  }

  return true;
}

function buildDirectHumanRequestPayload(agent: AgentName, output: string): HumanInputPayload | null {
  const trimmed = output.trim();
  if (trimmed === "" || !looksLikeDirectHumanRequest(trimmed)) {
    return null;
  }

  return {
    message:
      `${formatAgentLabel(agent)} asked the human a direct follow-up instead of returning an ` +
      `\`ask-human\` contract. Reply below and the same session will resume.\n\n${clipText(trimmed, 1200)}`,
  };
}

function extractDirectHumanRequest(output: string): string | null {
  const trimmed = output.trim();
  if (trimmed === "" || !looksLikeDirectHumanRequest(trimmed)) {
    return null;
  }

  return clipText(trimmed, 1200);
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

export function formatTerminalPrefix(
  agent: AgentName,
  stepScope: StepPromptScope,
  stream: "stdout" | "stderr" = "stdout"
): string {
  if (stream === "stderr") {
    return `[${agent}][${stepScope}][stderr] `;
  }

  return `[${agent}][${stepScope}] `;
}

function formatReviewFeedback(contract: Contract): string {
  const parts: string[] = [];
  parts.push("## Review Feedback — Changes Requested\n");
  parts.push(contract.message);

  if (contract.review_comments && contract.review_comments.length > 0) {
    parts.push("\n### Specific Issues:\n");
    for (const comment of contract.review_comments) {
      const location = comment.file
        ? comment.line !== undefined
          ? `${comment.file}:${comment.line}`
          : comment.file
        : "(general)";
      parts.push(`- **${location}**: ${comment.comment}`);
    }
  }

  parts.push(
    "\nAddress all review comments above, then route to `review` for re-review."
  );
  return parts.join("\n");
}

function parseAndValidate(output: string): Contract {
  const parsed = parseContractOutput(output);
  return validateContract(parsed);
}

async function getContractWithRetry(params: {
  agent: AgentName;
  stepScope: StepPromptScope;
  message: string;
  sessionRef: string | null;
  config: Config;
  cwd: string;
  stepId: number;
  logger: { logEvent: (event: Record<string, unknown>) => void };
  timeoutMs: number;
  maxInvalidContractRetries: number;
  invokeAgentFn: InvokeAgentFn;
  surface: RunSurface;
}): Promise<{
  contract: Contract;
  attempts: number;
  sessionRef: string | null;
  renderedStdout: boolean;
}> {
  const {
    agent,
    stepScope,
    message,
    sessionRef,
    config,
    cwd,
    stepId,
    logger,
    timeoutMs,
    maxInvalidContractRetries,
    invokeAgentFn,
    surface,
  } = params;

  const totalAttempts = maxInvalidContractRetries + 1;
  let promptMessage = message;
  let currentSessionRef = sessionRef;
  let lastError = new Error("Unknown contract parsing error");
  let humanInputPayload: HumanInputPayload | null = null;
  let directHumanRequest: string | null = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    if (attempt > 1) {
      surface.note(ui.retryNote(agent, attempt, totalAttempts));
      logger.logEvent({
        type: "contract_retry",
        step_id: stepId,
        agent,
        attempt,
      });
    }

    let renderedStdout = false;
    let lastOutputAt = Date.now();
    const heartbeatId = setInterval(() => {
      const idleMs = Date.now() - lastOutputAt;
      if (idleMs < AGENT_HEARTBEAT_MS) {
        return;
      }

      surface.note(ui.heartbeat(agent, stepScope, Math.floor(idleMs / 1000)));
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
            if (stream === "stdout" && /\S/.test(chunk)) {
              renderedStdout = true;
            }
            surface.writeAgentChunk(agent, stepScope, chunk, stream);
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
        renderedStdout,
      };
    }

    surface.note(`\n${ui.contractErrorNote(agent, lastError.message)}`, "stderr");
    logger.logEvent({
      type: "contract_invalid",
      step_id: stepId,
      agent,
      attempt,
      error: lastError.message,
      stdout_sample: clipText(invocation.stdout),
    });
    humanInputPayload =
      buildDirectHumanRequestPayload(agent, invocation.stdout) ||
      buildDirectHumanRequestPayload(agent, invocation.combined) ||
      humanInputPayload;
    directHumanRequest =
      extractDirectHumanRequest(invocation.stdout) ||
      extractDirectHumanRequest(invocation.combined) ||
      directHumanRequest;
    promptMessage = buildRetryMessage(message, lastError.message);
  }

  throw new ContractAcquisitionError(
    `Contract parse/validation failed after ${totalAttempts} attempt(s): ${lastError.message}`,
    currentSessionRef,
    humanInputPayload,
    directHumanRequest
  );
}

export async function runOrchestrator(input: RunInput): Promise<OrchestratorResult> {
  const cwd = input.cwd || process.cwd();
  const loadedConfig = loadConfig({ cwd, configPath: input.configPath || undefined });
  let config: Config = loadedConfig;
  if (input.primaryAgent !== undefined && input.primaryAgent !== null) {
    config = {
      ...config,
      routing: { ...config.routing, primary: input.primaryAgent },
    };
  }
  if (input.discuss === true) {
    config = {
      ...config,
      discussion: { ...config.discussion, enabled: true },
    };
  }
  const runId = randomUUID();
  const logger = createRunLogger({ cwd, config, runId });
  const lock = acquireRunLock({ cwd, config, runId });

  const invokeAgentFn: InvokeAgentFn = input.runtime?.invokeAgent || defaultInvokeAgent;
  const askHumanInputFn: AskHumanInputFn = input.runtime?.askHumanInput || defaultAskHumanInput;
  const getRepoStateSignatureFn: RepoStateFn =
    input.runtime?.getRepoStateSignature || defaultGetRepoStateSignature;
  const surface = createRunSurface({ mode: input.uiMode });

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

  let currentAgent: AgentName = config.routing.primary as AgentName;
  let currentMessage = input.task;
  let currentMessageSpeaker: PromptSpeaker = "human";
  let currentStepPromptScope: StepPromptScope = "primary";
  let currentThreadKey: string = currentAgent;
  let hopCount = 0;
  let activeStepId = 0;
  let signalHandled = false;
  let noProgressCount = 0;
  let pairReturn: PairReturnContext | null = null;
  let previousRepoState = await Promise.resolve(getRepoStateSignatureFn(cwd));
  let lastReviewedRepoState = previousRepoState;
  let reviewIterationCount = 0;
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
    surface.stop();
    console.error(ui.signalNote(signalName));
    process.exit(130);
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  const effectiveTimeout = timeoutOverrideMs || config.agent_timeout_ms;

  const pkg = (() => {
    try {
      return require("../package.json") as { version?: string };
    } catch {
      return {};
    }
  })();
  surface.startRun({
    version: pkg.version,
    task: input.task,
    primaryAgent: currentAgent,
    maxHops,
    timeoutMs: effectiveTimeout,
    discussionEnabled: config.discussion.enabled,
    reviewGate: config.review_gate,
    logPath: logger.logPath,
    lockPath: lock.lockPath,
    runId,
    cwd,
    noProgressHops,
  });

  logger.logEvent({
    type: "run_started",
    cwd,
    primary_agent: currentAgent,
    max_hops: maxHops,
    max_invalid_contract_retries: maxInvalidContractRetries,
    timeout_override_ms: timeoutOverrideMs || null,
    no_progress_hops: noProgressHops,
    lock_file: lock.lockPath,
    log_file: logger.logPath,
    repo_state_available: previousRepoState !== null,
  });

  const finishRun = (stepId: number, message: string): OrchestratorResult => {
    surface.done(message);
    logger.logEvent({
      type: "run_completed",
      status: "done",
      step_id: stepId,
      message: clipText(message),
    });
    return {
      runId,
      hops: stepId,
      status: "done",
      logPath: logger.logPath,
    };
  };

  const requestHumanInput = (payload: HumanInputPayload): Promise<string> =>
    surface.askHumanInput(payload, askHumanInputFn);

  try {
    if (!input.runtime?.invokeAgent) {
      validateConfiguredAgentsAvailable(config, currentAgent);
    }

    // --- Plan & Discussion phase (before implementation) ---
    if (config.discussion.enabled) {
      const discussionParticipants =
        config.discussion.participants.length > 0
          ? config.discussion.participants
          : inferDiscussionParticipants(config, currentAgent);

      if (discussionParticipants.length > 0) {
        surface.note(
          ui.discussionBanner(
            currentAgent,
            discussionParticipants,
            config.discussion.max_rounds,
            config.discussion.require_consensus
          )
        );

        logger.logEvent({
          type: "discussion_phase_started",
          proposer: currentAgent,
          participants: discussionParticipants,
          max_rounds: config.discussion.max_rounds,
          require_consensus: config.discussion.require_consensus,
        });

        const discussResult = await runPlanAndDiscuss(
          input.task,
          currentAgent,
          {
            config,
            cwd,
            invokeAgentFn,
            askHumanInputFn: requestHumanInput,
            surface,
            logger,
            timeoutOverrideMs,
          }
        );

        // Add discussion to conversation history
        appendConversationTurn(
          conversationHistory,
          currentAgent,
          `[PROPOSAL] ${discussResult.proposal.summary}\n\n${discussResult.proposal.approach}`
        );
        for (const round of discussResult.rounds) {
          appendConversationTurn(
            conversationHistory,
            round.speaker,
            `[DISCUSSION] (${round.sentiment}) ${round.message}`
          );
        }

        currentMessage = discussResult.approvedMessage;
        currentMessageSpeaker = currentAgent;
        hopCount += discussResult.totalHops;

        surface.note(ui.discussionCompleteNote(discussResult.status, discussResult.totalHops));
        surface.note(ui.implementationHeader());

        logger.logEvent({
          type: "discussion_phase_completed",
          status: discussResult.status,
          hops_used: discussResult.totalHops,
          proposal_summary: discussResult.proposal.summary,
          rounds_count: discussResult.rounds.length,
        });
      } else {
        surface.note(`\n  ${ui.dim("Discussion enabled but no participants available; skipping")}`);
      }
    }

    while (hopCount < maxHops) {
      const stepId = hopCount + 1;
      activeStepId = stepId;
      const timeoutMs = resolveTimeoutMs(currentAgent, config, timeoutOverrideMs);
      surface.startStep(stepId, currentAgent, currentStepPromptScope, timeoutMs);
      logger.logEvent({
        type: "step_started",
        step_id: stepId,
        agent: currentAgent,
        step_scope: currentStepPromptScope,
        timeout_ms: timeoutMs,
        message: clipText(currentMessage),
      });

      const threadState = getOrCreateThreadState(stepThreads, currentThreadKey, currentAgent);
      const historyIndexAtPrompt = conversationHistory.length;
      const promptMessage = threadState.sessionRef
        ? buildResumePromptBody({
            message: currentMessage,
            speaker: currentMessageSpeaker,
            stepScope: currentStepPromptScope,
            history: conversationHistory,
            stepPrompts: config.step_prompts[currentStepPromptScope],
            lastHistoryIndex: threadState.lastHistoryIndex,
          })
        : buildInitialPromptBody({
            message: currentMessage,
            speaker: currentMessageSpeaker,
            stepScope: currentStepPromptScope,
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
      let renderedStdout = false;
      try {
        const result = await getContractWithRetry({
          agent: currentAgent,
          stepScope: currentStepPromptScope,
          message: promptMessage,
          sessionRef: threadState.sessionRef,
          config,
          cwd,
          stepId,
          logger,
          timeoutMs,
          maxInvalidContractRetries,
          invokeAgentFn,
          surface,
        });
        contract = result.contract;
        attempts = result.attempts;
        resolvedSessionRef = result.sessionRef;
        renderedStdout = result.renderedStdout;
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

        const contractFailurePayload =
          error instanceof ContractAcquisitionError && error.humanInputPayload
            ? {
                ...error.humanInputPayload,
                footer: buildHumanGateFooter(error.humanInputPayload.footer || null),
              }
            : {
                message:
                  `Agent invocation/contract failed for ${currentAgent}: ${(error as Error).message}\n` +
                  `Provide next instruction for ${currentAgent}.`,
                footer: buildHumanGateFooter(),
              };
        const humanResponse = await requestHumanInput(contractFailurePayload);

        if (humanResponse === "") {
          throw new Error("No human input provided after failure; stopping run");
        }

        logger.logEvent({
          type: "human_response",
          step_id: stepId,
          reason:
            error instanceof ContractAcquisitionError && error.humanInputPayload
              ? "agent-direct-human-request"
              : "agent-failure",
          response: clipText(humanResponse),
        });
        if (isGlobalFinishCommand(humanResponse)) {
          return finishRun(stepId, "Run finished by human via /finish.");
        }
        if (error instanceof ContractAcquisitionError && error.directHumanRequest) {
          appendConversationTurn(conversationHistory, currentAgent, error.directHumanRequest);
        }
        appendConversationTurn(conversationHistory, "human", humanResponse);
        currentMessage = humanResponse;
        currentMessageSpeaker = "human";
        noProgressCount = 0;
        hopCount += 1;
        continue;
      }

      if (currentStepPromptScope === "pair" && pairReturn !== null) {
        contract = normalizePairContract(contract);
      }

      if (!renderedStdout) {
        surface.writeAgentChunk(currentAgent, currentStepPromptScope, `${contract.message}\n`);
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

        const humanResponse = await requestHumanInput({
          message: `Routing error: ${(error as Error).message}\nProvide next instruction for ${currentAgent}.`,
          footer: buildHumanGateFooter(),
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
        if (isGlobalFinishCommand(humanResponse)) {
          return finishRun(stepId, "Run finished by human via /finish.");
        }
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
      let routedAction = (contract.to || contract.next_action) as NextAction;
      let nextStepPromptScope: StepPromptScope =
        resolveStepPromptScope(routedAction) || currentStepPromptScope;
      let nextThreadKey = resolveNextThreadKey(target, currentThreadKey);
      const currentRepoState = await Promise.resolve(getRepoStateSignatureFn(cwd));
      const repoChangedSinceLastReview = didRepoChangeSinceBaseline(
        currentRepoState,
        lastReviewedRepoState
      );

      // --- Review gate: intercept primary→done when repo state has changed since the last review ---
      if (
        config.review_gate &&
        routedAction === "done" &&
        currentStepPromptScope === "primary" &&
        repoChangedSinceLastReview !== false
      ) {
        const reviewReason =
          repoChangedSinceLastReview === null
            ? "repo-state-unavailable"
            : "repo-changed-since-review";
        surface.note(`\n${ui.reviewGateNote()}`);
        logger.logEvent({
          type: "review_gate_redirect",
          step_id: stepId,
          agent: currentAgent,
          original_action: "done",
          redirected_to: "review",
          reason: reviewReason,
        });
        routedAction = "review";
        target = config.routing.review;
        nextStepPromptScope = "review";
        nextThreadKey = resolveNextThreadKey(target, currentThreadKey);
      }

      // --- Review iteration: auto-route request-changes back to primary ---
      if (
        currentStepPromptScope === "review" &&
        contract.review_verdict === "request-changes" &&
        reviewIterationCount < config.max_review_iterations
      ) {
        reviewIterationCount += 1;
        surface.note(`\n${ui.reviewIterationNote(reviewIterationCount, config.max_review_iterations)}`);
        logger.logEvent({
          type: "review_iteration_redirect",
          step_id: stepId,
          agent: currentAgent,
          review_iteration: reviewIterationCount,
          max_iterations: config.max_review_iterations,
          review_comments_count: contract.review_comments?.length || 0,
        });

        const reviseMessage = formatReviewFeedback(contract);
        routedAction = "primary";
        target = config.routing.primary;
        nextStepPromptScope = "primary";
        nextThreadKey = resolveNextThreadKey(target, currentThreadKey);
        contract = {
          ...contract,
          next_action: "primary",
          message: reviseMessage,
        };
      }

      // Reset review iteration count on approval
      if (
        currentStepPromptScope === "review" &&
        contract.review_verdict === "approve"
      ) {
        surface.note(`\n${ui.reviewApprovedNote(reviewIterationCount)}`);
        logger.logEvent({
          type: "review_approved",
          step_id: stepId,
          agent: currentAgent,
          iterations: reviewIterationCount,
        });
        reviewIterationCount = 0;
      }

      if (target !== "stop" || routedAction === "done") {
        appendConversationTurn(conversationHistory, handoffSpeaker, contract.message);
      }
      threadState.lastHistoryIndex = conversationHistory.length;
      if (currentStepPromptScope === "review" && currentRepoState !== null) {
        lastReviewedRepoState = currentRepoState;
      }

      // --- Pair return: force routing back to the invoking agent ---
      if (pairReturn !== null) {
        surface.note(`\n${ui.pairReturnNote(pairReturn.returnAgent)}`);
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

          const decision = await requestHumanInput({
            heading: "=== human response awaited ===",
            message: contract.message,
            showMessage: false,
            footer:
              'Reply with "finish" or "/finish" to end the run, or enter a follow-up message/question directly to continue with the same agent session.',
            promptText: "human response awaited> ",
          });

          if (decision === "") {
            throw new Error("Empty response at done gate; stopping run");
          }

          const normalizedDecision = decision.trim().toLowerCase();
          if (normalizedDecision === "finish" || isGlobalFinishCommand(decision)) {
            logger.logEvent({
              type: "done_gate_finish",
              step_id: stepId,
              agent: currentAgent,
              thread_key: currentThreadKey,
            });
            return finishRun(stepId, contract.message);
          }

          let followUp = decision;
          if (normalizedDecision === "continue") {
            followUp = await requestHumanInput({
              heading: "=== human response awaited ===",
              showMessage: false,
              footer: buildHumanGateFooter("Enter the follow-up message or question for that agent."),
              promptText: "human response awaited> ",
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
          if (isGlobalFinishCommand(followUp)) {
            return finishRun(stepId, "Run finished by human via /finish.");
          }
          appendConversationTurn(conversationHistory, "human", followUp);
          currentMessage = followUp;
          currentMessageSpeaker = "human";
          noProgressCount = 0;
          hopCount += 1;
          continue;
        }

        return finishRun(stepId, contract.message);
      }

      if (target === "human") {
        const response = await requestHumanInput({
          heading: "=== human response awaited ===",
          message: contract.message,
          questions: contract.questions,
          showMessage: false,
          footer: buildHumanGateFooter(),
          promptText: "human response awaited> ",
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
        if (isGlobalFinishCommand(response)) {
          return finishRun(stepId, "Run finished by human via /finish.");
        }
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
        surface.note(`\n${ui.pairInvokeNote(currentAgent, target as string)}`);
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
        if (currentRepoState !== null && previousRepoState !== null) {
          noProgressCount = currentRepoState === previousRepoState ? noProgressCount + 1 : 0;
          logger.logEvent({
            type: "no_progress_check",
            step_id: stepId,
            no_progress_count: noProgressCount,
          });

          if (noProgressCount >= noProgressHops) {
            const response = await requestHumanInput({
              message:
                `No repository changes detected for ${noProgressCount} consecutive agent steps. ` +
                "Provide guidance for the next agent.",
              footer: buildHumanGateFooter(),
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
            if (isGlobalFinishCommand(response)) {
              return finishRun(stepId, "Run finished by human via /finish.");
            }
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
    surface.note(ui.maxHopsNote(maxHops));
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
    surface.stop();
    lock.release();
    logger.logEvent({
      type: "run_finalized",
    });
  }
}

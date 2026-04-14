import {
  AgentName,
  AdapterInvocation,
  Config,
  Contract,
  HumanInputPayload,
  InvokeAgentOptions,
  TaskMode,
} from "./types";
import { parseContractOutput } from "./parser";
import { validateContract } from "./contract";
import { resolveTimeoutMs } from "./runtime";
import { RunSurface } from "./run-ui";
import * as ui from "./ui";

// --- Types ---

export interface BrainstormTurn {
  speaker: AgentName;
  message: string;
  turn: number;
}

export interface BrainstormResult {
  turns: BrainstormTurn[];
  finalPlan: string;
  totalHops: number;
}

type InvokeAgentFn = (
  agentName: AgentName,
  prompt: string,
  options: InvokeAgentOptions
) => Promise<AdapterInvocation>;

type AskHumanInputFn = (payload: HumanInputPayload) => Promise<string>;

export interface BrainstormDeps {
  config: Config;
  cwd: string;
  invokeAgentFn: InvokeAgentFn;
  askHumanInputFn: AskHumanInputFn;
  surface: RunSurface;
  logger: { logEvent: (event: Record<string, unknown>) => void };
  timeoutOverrideMs?: number;
}

// --- Contract suffixes ---

const BRAINSTORM_INITIAL_SUFFIX = [
  "---",
  "You are brainstorming with another AI agent. Be terse — agent-to-agent, no fluff.",
  "Propose your solution in short bullet points. Include concrete file paths, function names, approach.",
  "End with a JSON block:",
  "```json",
  "{",
  '  "contract_version": "1",',
  '  "next_action": "done",',
  '  "message": "your terse proposal"',
  "}",
  "```",
].join("\n");

const BRAINSTORM_REPLY_SUFFIX = [
  "---",
  "You are brainstorming with another AI agent. Be terse — no pleasantries, no repetition.",
  "Respond to their points: agree, disagree, or refine. Be specific.",
  'If you fully agree, say "AGREED" at the start of your message and include the final plan with clear pros/cons.',
  "If not, push back on specifics and propose alternatives.",
  "End with a JSON block:",
  "```json",
  "{",
  '  "contract_version": "1",',
  '  "next_action": "done",',
  '  "message": "your terse response"',
  "}",
  "```",
].join("\n");

const DIAGNOSE_INITIAL_SUFFIX = [
  "---",
  "You are diagnosing a bug with another AI agent. Be terse — agent-to-agent.",
  "Read the relevant code, identify the root cause, propose the minimal fix.",
  "Be specific: file paths, line numbers, what's wrong, what to change.",
  "End with a JSON block:",
  "```json",
  "{",
  '  "contract_version": "1",',
  '  "next_action": "done",',
  '  "message": "your terse diagnosis and fix proposal"',
  "}",
  "```",
].join("\n");

const DIAGNOSE_REPLY_SUFFIX = [
  "---",
  "You are diagnosing a bug with another AI agent. Be terse — no fluff.",
  "Respond to their diagnosis: agree, disagree, or refine. Be specific.",
  'If you agree on root cause and fix, say "AGREED" at the start and state the final diagnosis with the minimal fix.',
  "If not, explain what they missed and propose your alternative.",
  "End with a JSON block:",
  "```json",
  "{",
  '  "contract_version": "1",',
  '  "next_action": "done",',
  '  "message": "your terse response"',
  "}",
  "```",
].join("\n");

// --- Helpers ---

function createPhaseWriter(
  deps: BrainstormDeps,
  phase: string,
  agent: AgentName
): (chunk: string) => void {
  return (chunk: string): void => {
    deps.surface.writeAgentChunk(agent, phase, chunk);
  };
}

function emitNote(deps: BrainstormDeps, text: string): void {
  deps.surface.note(text);
}

async function invokeAndParse(
  agent: AgentName,
  prompt: string,
  phase: string,
  deps: BrainstormDeps
): Promise<Contract> {
  const timeoutMs = resolveTimeoutMs(agent, deps.config, deps.timeoutOverrideMs);
  const writer = createPhaseWriter(deps, phase, agent);

  const invocation = await deps.invokeAgentFn(agent, prompt, {
    config: deps.config,
    cwd: deps.cwd,
    timeoutMs,
    onOutput: (chunk, stream) => {
      if (stream === "stdout") writer(chunk);
    },
  });

  const candidates = [invocation.stdout, invocation.combined];
  let lastError: Error | null = null;

  for (const candidate of candidates) {
    try {
      const parsed = parseContractOutput(candidate);
      return validateContract(parsed);
    } catch (error) {
      lastError = error as Error;
    }
  }

  throw lastError || new Error("Failed to parse contract from agent output");
}

function buildInitialPrompt(task: string, mode: TaskMode): string {
  const suffix = mode === "fix" ? DIAGNOSE_INITIAL_SUFFIX : BRAINSTORM_INITIAL_SUFFIX;
  return `## Task\n\n${task}\n\n${suffix}`;
}

function buildReplyPrompt(
  task: string,
  turns: BrainstormTurn[],
  mode: TaskMode
): string {
  const suffix = mode === "fix" ? DIAGNOSE_REPLY_SUFFIX : BRAINSTORM_REPLY_SUFFIX;
  const parts: string[] = [];
  parts.push(`## Task\n\n${task}`);
  parts.push("## Discussion so far\n");
  for (const turn of turns) {
    parts.push(`**${turn.speaker}** (turn ${turn.turn}):\n${turn.message}`);
  }
  parts.push(suffix);
  return parts.join("\n\n");
}

function isAgreed(message: string): boolean {
  return /^AGREED/i.test(message.trim());
}

// --- Main export ---

export async function runBrainstorm(
  task: string,
  primaryAgent: AgentName,
  secondaryAgent: AgentName,
  mode: TaskMode,
  deps: BrainstormDeps
): Promise<BrainstormResult> {
  const maxTurns = deps.config.brainstorm.max_turns;
  const turns: BrainstormTurn[] = [];
  let totalHops = 0;
  const phaseLabel = mode === "fix" ? "diagnose" : "brainstorm";

  emitNote(deps, ui.brainstormBanner(primaryAgent, secondaryAgent, maxTurns, mode));

  // Phase 1: Both agents propose in parallel
  emitNote(deps, ui.brainstormParallelNote(primaryAgent, secondaryAgent));
  deps.logger.logEvent({ type: "brainstorm_parallel_start", primary: primaryAgent, secondary: secondaryAgent });

  const [primaryResult, secondaryResult] = await Promise.all([
    invokeAndParse(primaryAgent, buildInitialPrompt(task, mode), phaseLabel, deps),
    invokeAndParse(secondaryAgent, buildInitialPrompt(task, mode), phaseLabel, deps),
  ]);
  totalHops += 2;

  turns.push({ speaker: primaryAgent, message: primaryResult.message, turn: 1 });
  turns.push({ speaker: secondaryAgent, message: secondaryResult.message, turn: 1 });

  emitNote(deps, ui.brainstormTurnNote(1, primaryAgent, primaryResult.message));
  emitNote(deps, ui.brainstormTurnNote(1, secondaryAgent, secondaryResult.message));

  deps.logger.logEvent({
    type: "brainstorm_parallel_done",
    primary_msg: primaryResult.message.slice(0, 200),
    secondary_msg: secondaryResult.message.slice(0, 200),
  });

  // Phase 2: Back-and-forth discussion
  let currentSpeaker = primaryAgent;
  let otherSpeaker = secondaryAgent;

  for (let turnNum = 2; turnNum <= maxTurns; turnNum++) {
    // Swap speakers each turn
    [currentSpeaker, otherSpeaker] = [otherSpeaker, currentSpeaker];

    emitNote(deps, ui.brainstormReplyNote(turnNum, maxTurns, currentSpeaker));

    const replyPrompt = buildReplyPrompt(task, turns, mode);
    const replyContract = await invokeAndParse(currentSpeaker, replyPrompt, phaseLabel, deps);
    totalHops++;

    turns.push({ speaker: currentSpeaker, message: replyContract.message, turn: turnNum });
    emitNote(deps, ui.brainstormTurnNote(turnNum, currentSpeaker, replyContract.message));

    deps.logger.logEvent({
      type: "brainstorm_turn",
      turn: turnNum,
      speaker: currentSpeaker,
      agreed: isAgreed(replyContract.message),
    });

    if (isAgreed(replyContract.message)) {
      emitNote(deps, ui.brainstormAgreedNote(turnNum));
      return {
        turns,
        finalPlan: replyContract.message,
        totalHops,
      };
    }
  }

  // Max turns reached — ask the last response to summarize anyway
  const lastTurn = turns[turns.length - 1];
  emitNote(deps, ui.brainstormMaxTurnsNote(maxTurns));

  // Build final plan from last two messages
  const finalPlan = [
    `After ${maxTurns} turns, agents did not fully agree. Best proposal from last exchange:`,
    "",
    `**${turns[turns.length - 2].speaker}:** ${turns[turns.length - 2].message}`,
    "",
    `**${lastTurn.speaker}:** ${lastTurn.message}`,
  ].join("\n");

  return {
    turns,
    finalPlan,
    totalHops,
  };
}

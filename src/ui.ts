// Terminal UI utilities — zero dependencies, ANSI escape codes only

import { AgentName, StepPromptScope, Sentiment, ReviewVerdict, TaskMode } from "./types";

// --- ANSI codes ---

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const FG_RED = `${ESC}31m`;
const FG_GREEN = `${ESC}32m`;
const FG_YELLOW = `${ESC}33m`;
const FG_BLUE = `${ESC}34m`;
const FG_MAGENTA = `${ESC}35m`;
const FG_CYAN = `${ESC}36m`;
const FG_GRAY = `${ESC}90m`;
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function wrap(style: string, text: string): string {
  return `${style}${text}${RESET}`;
}

export function bold(text: string): string {
  return wrap(BOLD, text);
}

export function dim(text: string): string {
  return wrap(DIM, text);
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

// --- Agent colors ---

const AGENT_STYLE: Record<AgentName, string> = {
  claude: FG_MAGENTA,
  codex: FG_CYAN,
  gemini: FG_YELLOW,
};

export function agentLabel(agent: AgentName): string {
  const style = AGENT_STYLE[agent] || "";
  const name = agent.charAt(0).toUpperCase() + agent.slice(1);
  return `${BOLD}${style}${name}${RESET}`;
}

// --- Icons ---

export function sentimentIcon(sentiment: Sentiment | string): string {
  switch (sentiment) {
    case "agree":
      return wrap(FG_GREEN, "✓");
    case "disagree":
      return wrap(FG_RED, "✗");
    case "partial":
      return wrap(FG_YELLOW, "◐");
    case "neutral":
      return wrap(FG_GRAY, "○");
    default:
      return wrap(FG_GRAY, "?");
  }
}

export function verdictLabel(verdict: ReviewVerdict): string {
  switch (verdict) {
    case "approve":
      return `${wrap(FG_GREEN, "✓")} ${wrap(FG_GREEN, "approved")}`;
    case "request-changes":
      return `${wrap(FG_YELLOW, "↻")} ${wrap(FG_YELLOW, "changes requested")}`;
    case "reject":
      return `${wrap(FG_RED, "✗")} ${wrap(FG_RED, "rejected")}`;
    default:
      return String(verdict);
  }
}

// --- Separators ---

function pad(char: string, count: number): string {
  return char.repeat(Math.max(0, count));
}

export function line(char = "─", width = 50): string {
  return dim(pad(char, width));
}

// --- Run banner ---

export function runBanner(params: {
  version?: string;
  task: string;
  primaryAgent: AgentName;
  maxHops: number;
  timeoutMs: number;
  discussionEnabled: boolean;
  taskMode?: TaskMode;
  reviewGate: boolean;
  logPath: string;
  lockPath: string;
  runId: string;
  cwd: string;
  noProgressHops: number;
}): string {
  const lines: string[] = [];
  const taskClipped =
    params.task.length > 72
      ? params.task.slice(0, 69) + "..."
      : params.task;

  lines.push("");
  lines.push(
    `  ${BOLD}agent-pipe${RESET}${params.version ? dim(` v${params.version}`) : ""}`
  );
  lines.push(`  ${dim("Task:")} ${taskClipped}`);
  lines.push(
    `  ${dim("Primary:")} ${agentLabel(params.primaryAgent)}  ${dim("Hops:")} ${params.maxHops}  ${dim("Timeout:")} ${Math.round(params.timeoutMs / 1000)}s  ${dim("No-progress:")} ${params.noProgressHops}`
  );

  if (params.taskMode) {
    lines.push(`  ${dim("Mode:")} ${wrap(FG_BLUE, params.taskMode)}`);
  }

  const features: string[] = [];
  if (params.discussionEnabled)
    features.push(wrap(FG_GREEN, params.taskMode === "fix" ? "diagnose" : "brainstorm"));
  if (params.reviewGate) features.push(wrap(FG_GREEN, "review-gate"));
  if (features.length > 0) {
    lines.push(`  ${dim("Features:")} ${features.join(dim("  "))}`);
  }

  lines.push(`  ${dim("Run:")} ${wrap(FG_GRAY, params.runId)}`);
  lines.push(`  ${dim("Log:")} ${wrap(FG_GRAY, params.logPath)}`);
  lines.push("");

  return lines.join("\n");
}

// --- Phase headers ---

export function sectionHeader(title: string): string {
  return `\n${BOLD}${pad("━", 2)} ${title} ${pad("━", 44)}${RESET}`;
}

export function stepBanner(
  stepId: number,
  agent: AgentName,
  scope: StepPromptScope,
  timeoutMs: number
): string {
  const secs = Math.round(timeoutMs / 1000);
  return (
    `\n${dim("──")} Step ${bold(String(stepId))} ${dim("│")} ` +
    `${agentLabel(agent)} ${dim("│")} ${dim(scope)} ${dim("│")} ` +
    `${dim(secs + "s")} ${dim(pad("─", 24))}`
  );
}

// --- Discussion ---

export function discussionBanner(
  proposer: AgentName,
  participants: AgentName[],
  maxRounds: number,
  requireConsensus: boolean
): string {
  const lines: string[] = [];
  lines.push(sectionHeader("Plan & Discuss"));
  lines.push(`  ${dim("Proposer:")} ${agentLabel(proposer)}`);
  lines.push(
    `  ${dim("Participants:")} ${participants.map(agentLabel).join(dim(", "))}`
  );
  lines.push(
    `  ${dim("Rounds:")} ${maxRounds}  ${dim("Consensus:")} ${requireConsensus ? "required" : "optional"}`
  );
  return lines.join("\n");
}

export function planPhaseLabel(agent: AgentName): string {
  return `\n${dim("──")} ${bold("Plan")}: ${agentLabel(agent)} proposing ${dim(pad("─", 24))}`;
}

export function discussionRoundLabel(round: number, maxRounds: number): string {
  return `\n${dim("──")} ${bold("Discussion " + round + "/" + maxRounds)} ${dim(pad("─", 30))}`;
}

export function reviewingNote(agent: AgentName): string {
  return `  ${dim("▸")} ${agentLabel(agent)} reviewing...`;
}

export function feedbackLine(
  agent: AgentName,
  sentiment: Sentiment | string,
  concerns: string[]
): string {
  const icon = sentimentIcon(sentiment);
  const extra =
    concerns.length > 0
      ? dim(` (${concerns.length} concern${concerns.length > 1 ? "s" : ""})`)
      : "";
  return `  ${dim("→")} ${agentLabel(agent)}: ${icon} ${sentiment}${extra}`;
}

export function consensusNote(
  status: "consensus" | "partial-consensus" | "deadlock"
): string {
  switch (status) {
    case "consensus":
      return `\n  ${wrap(FG_GREEN, "✓")} ${bold("Full consensus reached")}`;
    case "partial-consensus":
      return `\n  ${wrap(FG_YELLOW, "◐")} ${bold("Partial consensus")} ${dim("(proceeding)")}`;
    case "deadlock":
      return `\n  ${wrap(FG_RED, "✗")} ${bold("Deadlock")} ${dim("— escalating to human")}`;
  }
}

export function revisionNote(agent: AgentName): string {
  return `\n  ${dim("↻")} ${agentLabel(agent)} revising proposal...`;
}

export function proposalNote(summary: string): string {
  const clipped =
    summary.length > 80 ? summary.slice(0, 77) + "..." : summary;
  return `  ${dim("Proposal:")} ${clipped}`;
}

export function discussionCompleteNote(
  status: string,
  hopsUsed: number
): string {
  return `\n  ${dim("Discussion:")} ${status} ${dim("(" + hopsUsed + " hops used)")}`;
}

export function implementationHeader(): string {
  return sectionHeader("Implementation");
}

// --- Review ---

export function reviewIterationNote(
  iteration: number,
  maxIterations: number
): string {
  return `  ${wrap(FG_YELLOW, "↻")} ${bold("Changes requested")} ${dim("(iteration " + iteration + "/" + maxIterations + ")")} — routing to primary`;
}

export function reviewApprovedNote(iterations: number): string {
  const extra =
    iterations > 0
      ? dim(` after ${iterations} iteration${iterations > 1 ? "s" : ""}`)
      : "";
  return `  ${wrap(FG_GREEN, "✓")} ${bold("Review approved")}${extra}`;
}

export function reviewGateNote(): string {
  return `  ${dim("▸")} Review gate: redirecting to review`;
}

// --- Done ---

export function doneMessage(message: string): string {
  return `\n${BOLD}${pad("═", 2)} Done ${pad("═", 44)}${RESET}\n${message}`;
}

// --- Pair ---

export function pairInvokeNote(
  invoker: AgentName,
  target: string
): string {
  return `  ${dim("▸")} ${agentLabel(invoker)} ${dim("→")} pair with ${bold(target)}`;
}

export function pairReturnNote(agent: AgentName): string {
  return `  ${dim("◀")} Returning to ${agentLabel(agent)}`;
}

// --- Misc ---

export function retryNote(
  agent: AgentName,
  attempt: number,
  total: number
): string {
  return `\n${wrap(FG_YELLOW, "↻")} Retry contract from ${agentLabel(agent)} ${dim("(attempt " + attempt + "/" + total + ")")}`;
}

export function contractErrorNote(
  agent: AgentName,
  error: string
): string {
  return `${wrap(FG_RED, "⚠")} Invalid contract from ${agentLabel(agent)}: ${dim(error)}`;
}

export function maxHopsNote(maxHops: number): string {
  return `\n${wrap(FG_YELLOW, "⚠")} ${bold("Reached max_hops=" + maxHops)}`;
}

export function noProgressNote(count: number): string {
  return `  ${wrap(FG_YELLOW, "⚠")} No repo changes for ${count} consecutive steps`;
}

export function signalNote(signalName: string): string {
  return `\n${wrap(FG_RED, "⚠")} ${signalName} received. Released lock and exiting.`;
}

export function errorNote(message: string): string {
  return `${wrap(FG_RED, "✗")} ${message}`;
}

// --- Colored prefixed writer ---

export function formatColoredPrefix(
  agent: AgentName,
  scope: StepPromptScope | string,
  stream: "stdout" | "stderr" = "stdout"
): string {
  const style = AGENT_STYLE[agent] || "";
  if (stream === "stderr") {
    return `${DIM}[${RESET}${BOLD}${style}${agent}${RESET}${DIM}][${scope}][stderr]${RESET} `;
  }
  return `${DIM}[${RESET}${BOLD}${style}${agent}${RESET}${DIM}][${scope}]${RESET} `;
}

export function createColoredPrefixedWriter(
  target: NodeJS.WriteStream,
  agent: AgentName,
  scope: StepPromptScope | string,
  stream: "stdout" | "stderr" = "stdout"
): (chunk: string) => void {
  const prefix = formatColoredPrefix(agent, scope, stream);
  let atLineStart = true;

  return (chunk: string): void => {
    if (chunk === "") return;
    let output = "";
    for (const char of chunk) {
      if (atLineStart) {
        output += prefix;
        atLineStart = false;
      }
      output += char;
      if (char === "\n") atLineStart = true;
    }
    target.write(output);
  };
}

// --- Brainstorm ---

export function brainstormBanner(
  primary: AgentName,
  secondary: AgentName,
  maxTurns: number,
  mode: TaskMode
): string {
  const title = mode === "fix" ? "Diagnose" : "Brainstorm";
  const lines: string[] = [];
  lines.push(sectionHeader(title));
  lines.push(`  ${dim("Agents:")} ${agentLabel(primary)} ${dim("+")} ${agentLabel(secondary)}`);
  lines.push(`  ${dim("Max turns:")} ${maxTurns}`);
  return lines.join("\n");
}

export function brainstormParallelNote(primary: AgentName, secondary: AgentName): string {
  return `\n  ${dim("▸")} Both ${agentLabel(primary)} and ${agentLabel(secondary)} thinking in parallel...`;
}

export function brainstormTurnNote(turn: number, agent: AgentName, message: string): string {
  const clipped = message.length > 100 ? message.slice(0, 97) + "..." : message;
  return `  ${dim("turn " + turn + ":")} ${agentLabel(agent)} ${dim("→")} ${clipped}`;
}

export function brainstormReplyNote(turn: number, maxTurns: number, agent: AgentName): string {
  return `\n${dim("──")} ${bold("Turn " + turn + "/" + maxTurns)} ${dim("│")} ${agentLabel(agent)} ${dim(pad("─", 24))}`;
}

export function brainstormAgreedNote(turn: number): string {
  return `\n  ${wrap(FG_GREEN, "✓")} ${bold("Agreed")} ${dim("at turn " + turn)}`;
}

export function brainstormMaxTurnsNote(maxTurns: number): string {
  return `\n  ${wrap(FG_YELLOW, "⚠")} ${bold("Max turns reached")} ${dim("(" + maxTurns + ")")} — using best proposal`;
}

export function brainstormCompleteNote(totalHops: number): string {
  return `\n  ${dim("Brainstorm:")} complete ${dim("(" + totalHops + " hops used)")}`;
}

export function heartbeat(
  agent: AgentName,
  scope: StepPromptScope | string,
  idleSeconds: number
): string {
  const prefix = formatColoredPrefix(agent, scope);
  return `\n${prefix}${dim("··· still working (" + idleSeconds + "s idle)")}\n`;
}

import {
  AgentName,
  AdapterInvocation,
  Config,
  Contract,
  HumanInputPayload,
  InvokeAgentOptions,
  Proposal,
  Sentiment,
} from "./types";
import { parseContractOutput } from "./parser";
import { validateContract } from "./contract";
import { resolveTimeoutMs } from "./runtime";

// --- Types ---

export interface DiscussionRound {
  speaker: AgentName;
  sentiment: Sentiment;
  concerns: string[];
  message: string;
  confidence?: number;
}

export interface DiscussionResult {
  proposal: Proposal;
  rounds: DiscussionRound[];
  status: "consensus" | "partial-consensus" | "deadlock" | "human-decided";
  totalHops: number;
  approvedMessage: string;
}

type InvokeAgentFn = (
  agentName: AgentName,
  prompt: string,
  options: InvokeAgentOptions
) => Promise<AdapterInvocation>;

type AskHumanInputFn = (payload: HumanInputPayload) => Promise<string>;

export interface DiscussionDeps {
  config: Config;
  cwd: string;
  invokeAgentFn: InvokeAgentFn;
  askHumanInputFn: AskHumanInputFn;
  logger: { logEvent: (event: Record<string, unknown>) => void };
  timeoutOverrideMs?: number;
}

// --- Phase-specific contract suffixes ---

const PLAN_SUFFIX = [
  "---",
  "You are in the PLANNING phase. Analyze the task and propose a clear implementation approach.",
  "Do NOT implement anything yet. Focus on design, architecture, and planning.",
  "Think about: what files to create/modify, what approach to use, edge cases, and trade-offs.",
  "You must end your response with exactly one JSON block and no text after it:",
  "```json",
  "{",
  '  "contract_version": "1",',
  '  "next_action": "done",',
  '  "message": "summary of your proposed approach",',
  '  "proposal": {',
  '    "summary": "what you plan to build or change",',
  '    "approach": "detailed technical approach and key design decisions",',
  '    "files": ["files you expect to create or modify"]',
  "  },",
  '  "confidence": 0.9',
  "}",
  "```",
].join("\n");

const DISCUSS_SUFFIX = [
  "---",
  "You are in the DISCUSSION phase reviewing a teammate's proposed approach.",
  "Evaluate the proposal critically as a senior engineer would in a design review.",
  "Consider: correctness, performance, security, maintainability, edge cases, alternatives.",
  "Be constructive but honest. If you disagree, explain why and suggest alternatives.",
  "Do NOT implement anything. Focus on reviewing the design.",
  "You must end your response with exactly one JSON block and no text after it:",
  "```json",
  "{",
  '  "contract_version": "1",',
  '  "next_action": "done",',
  '  "message": "your detailed technical feedback on the proposal",',
  '  "sentiment": "agree | disagree | partial",',
  '  "concerns": ["list specific technical concerns, or empty array if none"],',
  '  "confidence": 0.85',
  "}",
  "```",
].join("\n");

const REVISE_SUFFIX = [
  "---",
  "Your teammates have reviewed your proposal and provided feedback.",
  "Revise your proposal to address their concerns, or explain why you stand by your original approach.",
  "Do NOT implement anything yet. Focus on refining the design.",
  "You must end your response with exactly one JSON block and no text after it:",
  "```json",
  "{",
  '  "contract_version": "1",',
  '  "next_action": "done",',
  '  "message": "summary of revised approach and how you addressed feedback",',
  '  "proposal": {',
  '    "summary": "what you plan to build or change (revised)",',
  '    "approach": "detailed revised technical approach",',
  '    "files": ["files you expect to create or modify"]',
  "  },",
  '  "confidence": 0.9',
  "}",
  "```",
].join("\n");

// --- Output helpers ---

function createPhaseWriter(
  phase: string,
  agent: AgentName
): (chunk: string) => void {
  const prefix = `[${agent}][${phase}] `;
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
    process.stdout.write(output);
  };
}

// --- Agent invocation ---

async function invokeAndParse(
  agent: AgentName,
  prompt: string,
  phase: string,
  deps: DiscussionDeps
): Promise<Contract> {
  const timeoutMs = resolveTimeoutMs(agent, deps.config, deps.timeoutOverrideMs);
  const writer = createPhaseWriter(phase, agent);

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

// --- Discussion helpers ---

export function inferDiscussionParticipants(
  config: Config,
  primaryAgent: AgentName
): AgentName[] {
  const agents = new Set<AgentName>();
  for (const target of Object.values(config.routing)) {
    if (target === "human" || target === "stop") continue;
    if (target !== primaryAgent) agents.add(target as AgentName);
  }
  return Array.from(agents);
}

function checkConsensus(rounds: DiscussionRound[]): boolean {
  if (rounds.length === 0) return false;
  return rounds.every(
    (r) => r.sentiment === "agree" && r.concerns.length === 0
  );
}

function checkPartialConsensus(rounds: DiscussionRound[]): boolean {
  if (rounds.length === 0) return false;
  return rounds.every((r) => r.sentiment !== "disagree");
}

function buildDiscussPrompt(
  task: string,
  proposal: Proposal,
  previousRounds: DiscussionRound[]
): string {
  const parts: string[] = [];
  parts.push(`## Original Task\n\n${task}`);
  parts.push(
    `## Proposed Approach\n\n**Summary:** ${proposal.summary}\n\n**Approach:** ${proposal.approach}`
  );
  if (proposal.files && proposal.files.length > 0) {
    parts.push(`**Files:** ${proposal.files.join(", ")}`);
  }
  if (previousRounds.length > 0) {
    parts.push("## Previous Discussion\n");
    for (const round of previousRounds) {
      parts.push(
        `**${round.speaker}** (${round.sentiment}): ${round.message}`
      );
      if (round.concerns.length > 0) {
        parts.push(`  Concerns: ${round.concerns.join("; ")}`);
      }
    }
  }
  parts.push(DISCUSS_SUFFIX);
  return parts.join("\n\n");
}

function buildRevisePrompt(
  task: string,
  proposal: Proposal,
  feedback: DiscussionRound[]
): string {
  const parts: string[] = [];
  parts.push(`## Original Task\n\n${task}`);
  parts.push(
    `## Your Current Proposal\n\n**Summary:** ${proposal.summary}\n\n**Approach:** ${proposal.approach}`
  );
  if (proposal.files && proposal.files.length > 0) {
    parts.push(`**Files:** ${proposal.files.join(", ")}`);
  }
  parts.push("## Team Feedback\n");
  for (const round of feedback) {
    parts.push(`**${round.speaker}** (${round.sentiment}): ${round.message}`);
    if (round.concerns.length > 0) {
      parts.push(`  Concerns: ${round.concerns.join("; ")}`);
    }
  }
  parts.push(REVISE_SUFFIX);
  return parts.join("\n\n");
}

function formatApprovedProposal(
  task: string,
  proposal: Proposal,
  rounds: DiscussionRound[]
): string {
  const parts: string[] = [];
  parts.push("## Approved Implementation Plan\n");
  parts.push(`**Task:** ${task}\n`);
  parts.push(`**Approach:** ${proposal.approach}\n`);
  if (proposal.files && proposal.files.length > 0) {
    parts.push(`**Files to modify:** ${proposal.files.join(", ")}\n`);
  }
  if (rounds.length > 0) {
    parts.push("**Team discussion summary:**");
    for (const round of rounds) {
      const concerns =
        round.concerns.length > 0
          ? ` (concerns: ${round.concerns.join(", ")})`
          : "";
      parts.push(`- ${round.speaker}: ${round.sentiment}${concerns}`);
    }
    parts.push("");
  }
  parts.push(
    "Proceed with implementation following this approved plan. The team has reviewed and agreed on this approach."
  );
  return parts.join("\n");
}

function formatDeadlockSummary(
  proposal: Proposal,
  rounds: DiscussionRound[]
): string {
  const parts: string[] = [];
  parts.push("The team could not reach consensus after discussion.\n");
  parts.push(`**Current proposal:** ${proposal.summary}\n`);
  parts.push(`**Approach:** ${proposal.approach}\n`);
  parts.push("**Discussion:**");
  for (const round of rounds) {
    const concerns =
      round.concerns.length > 0
        ? `\n  Concerns: ${round.concerns.join("; ")}`
        : "";
    parts.push(
      `- ${round.speaker} (${round.sentiment}): ${round.message}${concerns}`
    );
  }
  return parts.join("\n");
}

// --- Main export ---

export async function runPlanAndDiscuss(
  task: string,
  primaryAgent: AgentName,
  deps: DiscussionDeps
): Promise<DiscussionResult> {
  const discussion = deps.config.discussion;
  const participants =
    discussion.participants.length > 0
      ? discussion.participants.filter((a) => a !== primaryAgent)
      : inferDiscussionParticipants(deps.config, primaryAgent);

  let totalHops = 0;
  const allRounds: DiscussionRound[] = [];

  // --- PLAN phase ---
  console.log(`\n--- plan phase: ${primaryAgent} proposing approach ---`);
  deps.logger.logEvent({ type: "plan_phase_started", agent: primaryAgent });

  const planPrompt = `## Task\n\n${task}\n\n${PLAN_SUFFIX}`;
  const planContract = await invokeAndParse(
    primaryAgent,
    planPrompt,
    "plan",
    deps
  );
  totalHops++;

  let proposal: Proposal = planContract.proposal || {
    summary: planContract.message,
    approach: planContract.message,
  };

  deps.logger.logEvent({
    type: "plan_phase_completed",
    agent: primaryAgent,
    proposal_summary: proposal.summary,
    confidence: planContract.confidence,
  });

  console.log(`\n--- proposal: ${proposal.summary} ---`);

  if (participants.length === 0) {
    console.log("--- no discussion participants available; skipping discussion ---");
    return {
      proposal,
      rounds: [],
      status: "consensus",
      totalHops,
      approvedMessage: formatApprovedProposal(task, proposal, []),
    };
  }

  // --- DISCUSS phase ---
  for (let round = 0; round < discussion.max_rounds; round++) {
    console.log(
      `\n--- discussion round ${round + 1}/${discussion.max_rounds} ---`
    );
    deps.logger.logEvent({
      type: "discussion_round_started",
      round: round + 1,
      max_rounds: discussion.max_rounds,
    });

    const roundFeedback: DiscussionRound[] = [];

    for (const participant of participants) {
      console.log(`\n--- ${participant} reviewing proposal ---`);

      const discussPrompt = buildDiscussPrompt(task, proposal, allRounds);
      const discussContract = await invokeAndParse(
        participant,
        discussPrompt,
        "discuss",
        deps
      );
      totalHops++;

      const feedback: DiscussionRound = {
        speaker: participant,
        sentiment: discussContract.sentiment || "neutral",
        concerns: discussContract.concerns || [],
        message: discussContract.message,
        confidence: discussContract.confidence,
      };

      roundFeedback.push(feedback);
      allRounds.push(feedback);

      deps.logger.logEvent({
        type: "discussion_feedback",
        round: round + 1,
        speaker: participant,
        sentiment: feedback.sentiment,
        concerns_count: feedback.concerns.length,
        concerns: feedback.concerns,
        confidence: feedback.confidence,
      });

      console.log(
        `--- ${participant}: ${feedback.sentiment}${
          feedback.concerns.length > 0
            ? ` (${feedback.concerns.length} concern(s))`
            : ""
        } ---`
      );
    }

    // Check consensus
    const hasFullConsensus = checkConsensus(roundFeedback);
    const hasPartialConsensus = checkPartialConsensus(roundFeedback);

    if (hasFullConsensus) {
      console.log("\n--- full consensus reached ---");
      deps.logger.logEvent({
        type: "discussion_consensus",
        round: round + 1,
        status: "consensus",
      });
      return {
        proposal,
        rounds: allRounds,
        status: "consensus",
        totalHops,
        approvedMessage: formatApprovedProposal(task, proposal, allRounds),
      };
    }

    if (hasPartialConsensus && !discussion.require_consensus) {
      console.log(
        "\n--- partial consensus reached (proceeding without full agreement) ---"
      );
      deps.logger.logEvent({
        type: "discussion_consensus",
        round: round + 1,
        status: "partial-consensus",
      });
      return {
        proposal,
        rounds: allRounds,
        status: "partial-consensus",
        totalHops,
        approvedMessage: formatApprovedProposal(task, proposal, allRounds),
      };
    }

    // No consensus yet — ask proposer to revise (unless last round)
    if (round < discussion.max_rounds - 1) {
      console.log(
        `\n--- no consensus; ${primaryAgent} revising proposal ---`
      );
      deps.logger.logEvent({
        type: "proposal_revision_started",
        round: round + 1,
        agent: primaryAgent,
      });

      const revisePrompt = buildRevisePrompt(task, proposal, roundFeedback);
      const reviseContract = await invokeAndParse(
        primaryAgent,
        revisePrompt,
        "revise",
        deps
      );
      totalHops++;

      proposal = reviseContract.proposal || {
        summary: reviseContract.message,
        approach: reviseContract.message,
      };

      deps.logger.logEvent({
        type: "proposal_revised",
        round: round + 1,
        revised_summary: proposal.summary,
        confidence: reviseContract.confidence,
      });

      console.log(`\n--- revised proposal: ${proposal.summary} ---`);
    }
  }

  // Max rounds reached without consensus — escalate to human
  console.log(
    `\n--- discussion deadlock after ${discussion.max_rounds} round(s) ---`
  );
  deps.logger.logEvent({
    type: "discussion_deadlock",
    rounds_completed: discussion.max_rounds,
  });

  const humanResponse = await deps.askHumanInputFn({
    heading: "=== discussion deadlock ===",
    message: formatDeadlockSummary(proposal, allRounds),
    footer:
      'Reply "proceed" to implement the current proposal as-is, or provide guidance to refine it.',
    promptText: "human> ",
  });

  deps.logger.logEvent({
    type: "discussion_human_decision",
    response:
      humanResponse.length > 200
        ? humanResponse.slice(0, 200) + "...[truncated]"
        : humanResponse,
  });

  const normalized = humanResponse.trim().toLowerCase();
  if (normalized === "proceed" || normalized === "") {
    return {
      proposal,
      rounds: allRounds,
      status: "human-decided",
      totalHops,
      approvedMessage: formatApprovedProposal(task, proposal, allRounds),
    };
  }

  // Human provided guidance — append it to the proposal
  return {
    proposal: {
      ...proposal,
      approach: `${proposal.approach}\n\nHuman guidance: ${humanResponse}`,
    },
    rounds: allRounds,
    status: "human-decided",
    totalHops,
    approvedMessage:
      formatApprovedProposal(task, proposal, allRounds) +
      `\n\n## Human Guidance\n${humanResponse}`,
  };
}

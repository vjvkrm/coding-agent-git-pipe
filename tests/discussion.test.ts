import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { runPlanAndDiscuss, inferDiscussionParticipants } from "../src/discussion";
import { RunSurface } from "../src/run-ui";
import { AgentName, Config, Contract, InvokeAgentOptions } from "../src/types";

function toFencedContract(contract: Contract): string {
  return `\`\`\`json\n${JSON.stringify(contract)}\n\`\`\``;
}

function createTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-pipe-discuss-"));
}

function cleanupTempRepo(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createMockSurface(): RunSurface {
  return {
    mode: "plain",
    startRun: () => {},
    startStep: () => {},
    note: () => {},
    writeAgentChunk: () => {},
    done: () => {},
    askHumanInput: async (payload, fallback) => fallback(payload),
    stop: () => {},
  };
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    routing: {
      primary: "codex",
      review: "gemini",
      pair: "claude",
      "ask-human": "human",
      done: "stop",
    },
    max_hops: 50,
    agent_timeout_ms: 1800000,
    max_invalid_contract_retries: 1,
    no_progress_hops: 0,
    lock_file: ".agentpipe.lock",
    log_dir: ".agentpipe/runs",
    agent_timeouts_ms: {},
    adapter_modes: {},
    adapter_args: {},
    adapters: {},
    step_prompts: { primary: [], review: [], pair: [] },
    review_gate: true,
    discussion: {
      enabled: true,
      participants: [],
      max_rounds: 3,
      require_consensus: true,
    },
    max_review_iterations: 3,
    ...overrides,
  };
}

test("inferDiscussionParticipants excludes primary agent", () => {
  const config = baseConfig();
  const participants = inferDiscussionParticipants(config, "codex");
  assert.ok(!participants.includes("codex"));
  assert.ok(participants.includes("gemini") || participants.includes("claude"));
});

test("inferDiscussionParticipants returns empty when only primary in routing", () => {
  const config = baseConfig({
    routing: {
      primary: "codex",
      review: "codex",
      pair: "codex",
      "ask-human": "human",
      done: "stop",
    },
  });
  const participants = inferDiscussionParticipants(config, "codex");
  assert.equal(participants.length, 0);
});

test("runPlanAndDiscuss reaches consensus with agreeing participants", async () => {
  const cwd = createTempRepo();
  try {
    const invokeQueue: Contract[] = [
      // Plan phase: primary proposes
      {
        contract_version: "1",
        next_action: "done",
        message: "Proposed adding auth middleware",
        proposal: {
          summary: "Add JWT auth middleware",
          approach: "Create middleware that validates JWT tokens on protected routes",
          files: ["src/middleware/auth.ts"],
        },
        confidence: 0.9,
      },
      // Discuss phase: gemini agrees
      {
        contract_version: "1",
        next_action: "done",
        message: "Solid approach, JWT middleware is the right pattern",
        sentiment: "agree",
        concerns: [],
        confidence: 0.85,
      },
      // Discuss phase: claude agrees
      {
        contract_version: "1",
        next_action: "done",
        message: "Agree, well-structured plan",
        sentiment: "agree",
        concerns: [],
        confidence: 0.9,
      },
    ];

    let invokeIndex = 0;
    const invokeAgentFn = async (
      _agent: AgentName,
      _prompt: string,
      _options: InvokeAgentOptions
    ) => {
      const contract = invokeQueue[invokeIndex++];
      const output = toFencedContract(contract);
      return {
        agent: _agent,
        command: ["test"],
        args: [],
        timeoutMs: 30000,
        stdout: output,
        stderr: "",
        combined: output,
        durationMs: 100,
      };
    };

    const config = baseConfig({
      discussion: {
        enabled: true,
        participants: ["gemini", "claude"],
        max_rounds: 3,
        require_consensus: true,
      },
    });

    const result = await runPlanAndDiscuss("Add JWT auth", "codex", {
      config,
      cwd,
      invokeAgentFn,
      askHumanInputFn: async () => "",
      surface: createMockSurface(),
      logger: { logEvent: () => {} },
    });

    assert.equal(result.status, "consensus");
    assert.equal(result.proposal.summary, "Add JWT auth middleware");
    assert.equal(result.rounds.length, 2);
    assert.equal(result.rounds[0].speaker, "gemini");
    assert.equal(result.rounds[0].sentiment, "agree");
    assert.equal(result.rounds[1].speaker, "claude");
    assert.equal(result.rounds[1].sentiment, "agree");
    assert.equal(result.totalHops, 3); // 1 plan + 2 discuss
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("runPlanAndDiscuss triggers revision when participant disagrees", async () => {
  const cwd = createTempRepo();
  try {
    const invokeQueue: Contract[] = [
      // Plan phase: primary proposes
      {
        contract_version: "1",
        next_action: "done",
        message: "Proposed approach A",
        proposal: {
          summary: "Approach A",
          approach: "Do it approach A way",
        },
        confidence: 0.8,
      },
      // Discuss round 1: participant disagrees
      {
        contract_version: "1",
        next_action: "done",
        message: "Approach A has performance issues",
        sentiment: "disagree",
        concerns: ["O(n^2) complexity in hot path"],
        confidence: 0.7,
      },
      // Revise: primary revises
      {
        contract_version: "1",
        next_action: "done",
        message: "Revised to approach B",
        proposal: {
          summary: "Approach B (optimized)",
          approach: "Do it approach B way with O(n log n)",
        },
        confidence: 0.9,
      },
      // Discuss round 2: participant agrees
      {
        contract_version: "1",
        next_action: "done",
        message: "Much better, approach B addresses the concern",
        sentiment: "agree",
        concerns: [],
        confidence: 0.9,
      },
    ];

    let invokeIndex = 0;
    const invokeAgentFn = async (
      _agent: AgentName,
      _prompt: string,
      _options: InvokeAgentOptions
    ) => {
      const contract = invokeQueue[invokeIndex++];
      const output = toFencedContract(contract);
      return {
        agent: _agent,
        command: ["test"],
        args: [],
        timeoutMs: 30000,
        stdout: output,
        stderr: "",
        combined: output,
        durationMs: 100,
      };
    };

    const config = baseConfig({
      discussion: {
        enabled: true,
        participants: ["claude"],
        max_rounds: 3,
        require_consensus: true,
      },
    });

    const result = await runPlanAndDiscuss("Optimize search", "codex", {
      config,
      cwd,
      invokeAgentFn,
      askHumanInputFn: async () => "",
      surface: createMockSurface(),
      logger: { logEvent: () => {} },
    });

    assert.equal(result.status, "consensus");
    assert.equal(result.proposal.summary, "Approach B (optimized)");
    assert.equal(result.rounds.length, 2); // one disagree + one agree
    assert.equal(result.totalHops, 4); // 1 plan + 1 discuss + 1 revise + 1 discuss
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("runPlanAndDiscuss escalates to human on deadlock", async () => {
  const cwd = createTempRepo();
  try {
    const invokeQueue: Contract[] = [
      // Plan phase
      {
        contract_version: "1",
        next_action: "done",
        message: "Plan X",
        proposal: { summary: "Plan X", approach: "Do X" },
      },
      // Round 1: disagree
      {
        contract_version: "1",
        next_action: "done",
        message: "No",
        sentiment: "disagree",
        concerns: ["Bad idea"],
      },
      // Revise
      {
        contract_version: "1",
        next_action: "done",
        message: "Plan X revised",
        proposal: { summary: "Plan X v2", approach: "Do X differently" },
      },
      // Round 2: still disagree
      {
        contract_version: "1",
        next_action: "done",
        message: "Still no",
        sentiment: "disagree",
        concerns: ["Still bad"],
      },
    ];

    let invokeIndex = 0;
    const invokeAgentFn = async (
      _agent: AgentName,
      _prompt: string,
      _options: InvokeAgentOptions
    ) => {
      const contract = invokeQueue[invokeIndex++];
      const output = toFencedContract(contract);
      return {
        agent: _agent,
        command: ["test"],
        args: [],
        timeoutMs: 30000,
        stdout: output,
        stderr: "",
        combined: output,
        durationMs: 100,
      };
    };

    const config = baseConfig({
      discussion: {
        enabled: true,
        participants: ["claude"],
        max_rounds: 2,
        require_consensus: true,
      },
    });

    const result = await runPlanAndDiscuss("Do something", "codex", {
      config,
      cwd,
      invokeAgentFn,
      askHumanInputFn: async () => "proceed",
      surface: createMockSurface(),
      logger: { logEvent: () => {} },
    });

    assert.equal(result.status, "human-decided");
    assert.equal(result.totalHops, 4);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("runPlanAndDiscuss skips discussion with no participants", async () => {
  const cwd = createTempRepo();
  try {
    const invokeQueue: Contract[] = [
      // Plan phase only
      {
        contract_version: "1",
        next_action: "done",
        message: "My plan",
        proposal: { summary: "Solo plan", approach: "Just do it" },
      },
    ];

    let invokeIndex = 0;
    const invokeAgentFn = async (
      _agent: AgentName,
      _prompt: string,
      _options: InvokeAgentOptions
    ) => {
      const contract = invokeQueue[invokeIndex++];
      const output = toFencedContract(contract);
      return {
        agent: _agent,
        command: ["test"],
        args: [],
        timeoutMs: 30000,
        stdout: output,
        stderr: "",
        combined: output,
        durationMs: 100,
      };
    };

    const config = baseConfig({
      routing: {
        primary: "codex",
        review: "codex",
        pair: "codex",
        "ask-human": "human",
        done: "stop",
      },
      discussion: {
        enabled: true,
        participants: [],
        max_rounds: 3,
        require_consensus: true,
      },
    });

    const result = await runPlanAndDiscuss("Solo task", "codex", {
      config,
      cwd,
      invokeAgentFn,
      askHumanInputFn: async () => "",
      surface: createMockSurface(),
      logger: { logEvent: () => {} },
    });

    assert.equal(result.status, "consensus");
    assert.equal(result.rounds.length, 0);
    assert.equal(result.totalHops, 1);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("runPlanAndDiscuss accepts partial consensus when require_consensus is false", async () => {
  const cwd = createTempRepo();
  try {
    const invokeQueue: Contract[] = [
      // Plan phase
      {
        contract_version: "1",
        next_action: "done",
        message: "Plan",
        proposal: { summary: "Plan", approach: "Do it" },
      },
      // Discuss: partial (has concerns but not disagreeing)
      {
        contract_version: "1",
        next_action: "done",
        message: "Mostly OK but has some issues",
        sentiment: "partial",
        concerns: ["Minor perf concern"],
        confidence: 0.7,
      },
    ];

    let invokeIndex = 0;
    const invokeAgentFn = async (
      _agent: AgentName,
      _prompt: string,
      _options: InvokeAgentOptions
    ) => {
      const contract = invokeQueue[invokeIndex++];
      const output = toFencedContract(contract);
      return {
        agent: _agent,
        command: ["test"],
        args: [],
        timeoutMs: 30000,
        stdout: output,
        stderr: "",
        combined: output,
        durationMs: 100,
      };
    };

    const config = baseConfig({
      discussion: {
        enabled: true,
        participants: ["claude"],
        max_rounds: 3,
        require_consensus: false,
      },
    });

    const result = await runPlanAndDiscuss("Task", "codex", {
      config,
      cwd,
      invokeAgentFn,
      askHumanInputFn: async () => "",
      surface: createMockSurface(),
      logger: { logEvent: () => {} },
    });

    assert.equal(result.status, "partial-consensus");
    assert.equal(result.rounds[0].sentiment, "partial");
    assert.equal(result.totalHops, 2);
  } finally {
    cleanupTempRepo(cwd);
  }
});

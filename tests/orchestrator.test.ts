import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { runOrchestrator } from "../src/orchestrator";
import { AgentName, Config, Contract, InvokeAgentOptions } from "../src/types";

type QueueItem =
  | Contract
  | string
  | {
      response: Contract | string;
      sessionRef?: string | null;
    };

function toFencedContract(contract: Contract): string {
  return `\`\`\`json\n${JSON.stringify(contract)}\n\`\`\``;
}

function createTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-pipe-test-"));
}

function cleanupTempRepo(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeConfig(cwd: string, overrides: Partial<Config> = {}): string {
  const config: Config = {
    routing: {
      plan: "claude",
      implement: "codex",
      review: "gemini",
      pair: "claude",
      "ask-human": "human",
      done: "stop",
    },
    max_hops: 8,
    first_agent: "claude",
    agent_timeout_ms: 1800000,
    max_invalid_contract_retries: 1,
    no_progress_hops: 0,
    lock_file: ".agentpipe.lock",
    log_dir: ".agentpipe/runs",
    agent_timeouts_ms: {},
    adapter_modes: {},
    adapter_args: {},
    adapters: {},
    step_prompts: {
      first_agent: [],
      plan: [],
      implement: [],
      review: [],
      pair: [],
    },
    review_gate: true,
    ...overrides,
  };

  const configPath = path.join(cwd, ".agentpipe.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}

function createInvokeStub(queue: QueueItem[]) {
  let index = 0;
  const calls: AgentName[] = [];
  const prompts: string[] = [];
  const sessionRefs: Array<string | null | undefined> = [];

  return {
    calls,
    prompts,
    sessionRefs,
    invokeAgent: async (agentName: AgentName, prompt: string, options: InvokeAgentOptions) => {
      calls.push(agentName);
      prompts.push(prompt);
      sessionRefs.push(options.sessionRef);
      if (index >= queue.length) {
        throw new Error(`No more stub outputs. Missing output for call ${index + 1}`);
      }

      const item = queue[index];
      index += 1;
      const resolved = typeof item === "object" && item !== null && "response" in item ? item : null;
      const response = resolved ? resolved.response : item;
      const stdout = typeof response === "string" ? response : toFencedContract(response);
      return {
        agent: agentName,
        command: ["mock"],
        args: ["mock"],
        timeoutMs: 1000,
        stdout,
        stderr: "",
        combined: stdout,
        durationMs: 1,
        sessionRef: resolved?.sessionRef ?? null,
      };
    },
  };
}

test("orchestrator runs plan->implement->review->done", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 });
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "implement",
        message: "implement auth",
      },
      {
        contract_version: "1",
        next_action: "review",
        message: "review auth",
      },
      {
        contract_version: "1",
        next_action: "done",
        message: "all good",
      },
    ]);

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 3);
    assert.deepEqual(invokeStub.calls, ["claude", "codex", "gemini"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator pauses on ask-human and resumes", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 });
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "ask-human",
        message: "need clarification",
        questions: [{ id: "q1", text: "rotate tokens?" }],
      },
      {
        contract_version: "1",
        next_action: "done",
        message: "done after clarification",
      },
    ]);

    let humanCalls = 0;
    const humanReplies = ["clarification from human", "finish"];
    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => {
          humanCalls += 1;
          return humanReplies.shift() || "finish";
        },
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 2);
    assert.equal(humanCalls, 2);
    assert.deepEqual(invokeStub.calls, ["claude", "claude"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator carries recent human and agent context into follow-up prompts", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0, first_agent: "codex" });
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "ask-human",
        message: "I reviewed the docs. Please update README.md and API.md.",
        questions: [{ id: "q1", text: "Should I apply those documentation edits?" }],
      },
      {
        contract_version: "1",
        next_action: "done",
        message: "docs updated",
      },
    ]);

    const humanReplies = ["please update these", "finish"];
    const result = await runOrchestrator({
      task: "check for latest code changes and update documentation accordingly",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => humanReplies.shift() || "",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.equal(invokeStub.prompts.length, 2);
    assert.match(
      invokeStub.prompts[1],
      /Current handoff from human:\nplease update these/
    );
    assert.match(
      invokeStub.prompts[1],
      /codex:\n  I reviewed the docs\. Please update README\.md and API\.md\./
    );
    assert.match(
      invokeStub.prompts[1],
      /human:\n  check for latest code changes and update documentation accordingly/
    );
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator injects first_agent step prompts on the initial hop", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      step_prompts: {
        first_agent: ["Analyze first and route intentionally."],
        plan: [],
        implement: [],
        review: [],
        pair: [],
      },
    });
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "done",
        message: "done",
      },
    ]);

    await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(invokeStub.prompts.length, 1);
    assert.match(
      invokeStub.prompts[0],
      /Step-specific instructions \(follow these in addition to the task\):\n- Analyze first and route intentionally\./
    );
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator prompts include technical handoff guidance", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 } as Partial<Config>);
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "done",
        message: "all done",
      },
    ]);

    await runOrchestrator({
      task: "inspect only",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.match(invokeStub.prompts[0], /Technical handoff rules:/);
    assert.match(
      invokeStub.prompts[0],
      /make `message` a concise technical handoff with current state\/diagnosis, exact next task, and relevant files\/tests\/constraints/
    );
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator switches hidden step prompts to the routed action", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      review_gate: false,
      step_prompts: {
        first_agent: ["Do not implement immediately."],
        plan: [],
        implement: ["Focus on making concrete repo changes."],
        review: [],
        pair: [],
      },
    } as Partial<Config>);
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "implement",
        message: "implement the fix",
      },
      {
        contract_version: "1",
        next_action: "done",
        message: "done",
      },
    ]);

    await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(invokeStub.prompts.length, 2);
    assert.match(invokeStub.prompts[0], /Do not implement immediately\./);
    assert.match(invokeStub.prompts[1], /Focus on making concrete repo changes\./);
    assert.doesNotMatch(invokeStub.prompts[1], /Do not implement immediately\./);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator preserves the current step prompt scope across ask-human", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      review_gate: false,
      step_prompts: {
        first_agent: ["Route the initial request before coding."],
        plan: [],
        implement: ["Stay in implementation mode after clarification."],
        review: [],
        pair: [],
      },
    } as Partial<Config>);
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "implement",
        message: "implement the fix",
      },
      {
        contract_version: "1",
        next_action: "ask-human",
        message: "need one detail",
        questions: [{ id: "q1", text: "which path?" }],
      },
      {
        contract_version: "1",
        next_action: "done",
        message: "done",
      },
    ]);
    const humanReplies = ["use the README path", "finish"];

    await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => humanReplies.shift() || "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(invokeStub.prompts.length, 3);
    assert.match(invokeStub.prompts[1], /Stay in implementation mode after clarification\./);
    assert.match(invokeStub.prompts[2], /Stay in implementation mode after clarification\./);
    assert.match(invokeStub.prompts[2], /Current handoff from human:\nuse the README path/);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator preserves first_agent step prompts through initial human clarification", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      step_prompts: {
        first_agent: ["Only analyze and route on the first stage."],
        plan: [],
        implement: [],
        review: [],
        pair: [],
      },
    });
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "ask-human",
        message: "need clarification",
        questions: [{ id: "q1", text: "which file?" }],
      },
      {
        contract_version: "1",
        next_action: "done",
        message: "done",
      },
    ]);
    const humanReplies = ["README only", "finish"];

    await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => humanReplies.shift() || "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(invokeStub.prompts.length, 2);
    assert.match(invokeStub.prompts[0], /Only analyze and route on the first stage\./);
    assert.match(invokeStub.prompts[1], /Only analyze and route on the first stage\./);
    assert.match(invokeStub.prompts[1], /Current handoff from human:\nREADME only/);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator limits invisible prompt context to the last four turns", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 });
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "ask-human",
        message: "first agent question",
        questions: [{ id: "q1", text: "first?" }],
      },
      {
        contract_version: "1",
        next_action: "ask-human",
        message: "second agent question",
        questions: [{ id: "q2", text: "second?" }],
      },
      {
        contract_version: "1",
        next_action: "done",
        message: "finished",
      },
    ]);

    const humanReplies = ["first human answer", "second human answer", "finish"];
    await runOrchestrator({
      task: "initial task",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => humanReplies.shift() || "",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(invokeStub.prompts.length, 3);
    assert.match(
      invokeStub.prompts[2],
      /Current handoff from human:\nsecond human answer/
    );
    assert.match(invokeStub.prompts[2], /claude:\n  first agent question/);
    assert.match(invokeStub.prompts[2], /human:\n  first human answer/);
    assert.match(invokeStub.prompts[2], /claude:\n  second agent question/);
    assert.doesNotMatch(invokeStub.prompts[2], /human:\n  initial task/);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator retries once on invalid contract output", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      max_invalid_contract_retries: 1,
    });
    const invokeStub = createInvokeStub([
      "this is not json",
      {
        contract_version: "1",
        next_action: "done",
        message: "recovered",
      },
    ]);

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 1);
    assert.equal(invokeStub.calls.length, 2);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator forwards a direct agent question to the human after contract failure", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      max_invalid_contract_retries: 0,
    });
    const invokeStub = createInvokeStub([
      "Which config file should I update before continuing?",
      {
        contract_version: "1",
        next_action: "done",
        message: "done after clarification",
      },
    ]);

    const humanPayloads: Array<{ message?: string; questions?: { id: string; text: string }[] }> = [];
    const humanReplies = ["Update .agentpipe.json", "finish"];
    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async (payload) => {
          humanPayloads.push(payload);
          return humanReplies.shift() || "";
        },
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.deepEqual(invokeStub.calls, ["claude", "claude"]);
    assert.equal(humanPayloads.length, 2);
    assert.match(
      humanPayloads[0].message || "",
      /Claude asked the human a direct follow-up instead of returning an `ask-human` contract/
    );
    assert.match(humanPayloads[0].message || "", /Which config file should I update before continuing\?/);
    assert.match(invokeStub.prompts[1], /Current handoff from human:\nUpdate \.agentpipe\.json/);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator stops at max_hops", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      max_hops: 3,
      first_agent: "codex",
      routing: {
        plan: "codex",
        implement: "codex",
        review: "codex",
        pair: "codex",
        "ask-human": "human",
        done: "stop",
      },
      no_progress_hops: 0,
    });
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "implement",
        message: "keep going 1",
      },
      {
        contract_version: "1",
        next_action: "implement",
        message: "keep going 2",
      },
      {
        contract_version: "1",
        next_action: "implement",
        message: "keep going 3",
      },
    ]);

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "max-hops");
    assert.equal(result.hops, 3);
    assert.equal(invokeStub.calls.length, 3);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("routing.done is respected from config (not hardcoded)", async () => {
  const cwd = createTempRepo();
  try {
    // Remap "done" to "claude" instead of "stop" — agent should keep running
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      max_hops: 3,
      routing: {
        plan: "claude",
        implement: "codex",
        review: "gemini",
        pair: "claude",
        "ask-human": "human",
        done: "claude",
      },
    });
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "done",
        message: "I think we are done",
      },
      {
        contract_version: "1",
        next_action: "done",
        message: "still done",
      },
      {
        contract_version: "1",
        next_action: "done",
        message: "still done again",
      },
    ]);

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    // With done -> claude, the orchestrator should NOT stop on done.
    // It should keep routing to claude until max_hops.
    assert.equal(result.status, "max-hops");
    assert.equal(result.hops, 3);
    assert.deepEqual(invokeStub.calls, ["claude", "claude", "claude"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("no-progress guard asks human after consecutive unchanged repo states", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 2 });
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "implement",
        message: "step one",
      },
      {
        contract_version: "1",
        next_action: "review",
        message: "step two",
      },
      {
        contract_version: "1",
        next_action: "done",
        message: "finished after guidance",
      },
    ]);

    let noProgressPrompts = 0;
    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async (payload) => {
          if ((payload.message || "").includes("No repository changes detected")) {
            noProgressPrompts += 1;
            return "human guidance";
          }
          return "finish";
        },
        getRepoStateSignature: () => "same-state",
      },
    });

    assert.equal(result.status, "done");
    assert.equal(noProgressPrompts, 1);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("implement -> review -> implement reuses the original implement session", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0, review_gate: false } as Partial<Config>);
    const invokeStub = createInvokeStub([
      {
        response: {
          contract_version: "1",
          next_action: "implement",
          message: "implement auth",
        },
        sessionRef: "first-agent-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "review",
          message: "implemented auth",
        },
        sessionRef: "implement-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "implement",
          message: "please tighten validation",
        },
        sessionRef: "review-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "validation tightened",
        },
        sessionRef: "implement-session",
      },
    ]);

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.deepEqual(invokeStub.calls, ["claude", "codex", "gemini", "codex"]);
    assert.equal(invokeStub.sessionRefs[3], "implement-session");
    assert.match(invokeStub.prompts[3], /Current handoff from gemini:\nplease tighten validation/);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("ask-human within a step resumes the same saved session", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 });
    const invokeStub = createInvokeStub([
      {
        response: {
          contract_version: "1",
          next_action: "ask-human",
          message: "need clarification",
          questions: [{ id: "q1", text: "which scope?" }],
        },
        sessionRef: "claude-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "done after clarification",
        },
        sessionRef: "claude-session",
      },
    ]);
    const humanReplies = ["narrow the scope", "finish"];

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => humanReplies.shift() || "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.deepEqual(invokeStub.calls, ["claude", "claude"]);
    assert.equal(invokeStub.sessionRefs[1], "claude-session");
    assert.match(invokeStub.prompts[1], /Current handoff from human:\nnarrow the scope/);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("direct human fallback without a saved session preserves the agent question in the next prompt", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      max_invalid_contract_retries: 0,
    });
    const invokeStub = createInvokeStub([
      "Which config file should I update before continuing?",
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "done after clarification",
        },
        sessionRef: null,
      },
    ]);
    const humanReplies = ["Update .agentpipe.json first", "finish"];

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => humanReplies.shift() || "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.deepEqual(invokeStub.calls, ["claude", "claude"]);
    assert.equal(invokeStub.sessionRefs[1], null);
    assert.match(invokeStub.prompts[1], /Current handoff from human:\nUpdate \.agentpipe\.json first/);
    assert.match(
      invokeStub.prompts[1],
      /Recent conversation context[\s\S]*claude:\n  Which config file should I update before continuing\?/
    );
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("done routed to stop opens the finish or continue gate", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 });
    const invokeStub = createInvokeStub([
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "all done",
        },
        sessionRef: "claude-session",
      },
    ]);

    let doneGatePrompts = 0;
    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async (payload) => {
          if ((payload.footer || "").includes('Reply with "finish" to end the run')) {
            doneGatePrompts += 1;
          }
          return "finish";
        },
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 1);
    assert.equal(doneGatePrompts, 1);
    assert.deepEqual(invokeStub.calls, ["claude"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("continue after done resumes the same agent session", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 });
    const invokeStub = createInvokeStub([
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "initial answer",
        },
        sessionRef: "claude-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "extra detail",
        },
        sessionRef: "claude-session",
      },
    ]);
    const humanReplies = ["continue", "tell me more", "finish"];

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => humanReplies.shift() || "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 2);
    assert.deepEqual(invokeStub.calls, ["claude", "claude"]);
    assert.equal(invokeStub.sessionRefs[1], "claude-session");
    assert.match(invokeStub.prompts[1], /Current handoff from human:\ntell me more/);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("pair action routes to pair agent and returns to invoking agent", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      routing: {
        plan: "claude",
        implement: "codex",
        review: "gemini",
        pair: "gemini",
        "ask-human": "human",
        done: "stop",
      },
    });
    const invokeStub = createInvokeStub([
      // Step 1: codex (implement) invokes pair
      {
        contract_version: "1",
        next_action: "pair",
        message: "should I use JWT or session tokens?",
      },
      // Step 2: gemini (pair) responds with advice
      {
        contract_version: "1",
        next_action: "implement",
        message: "use JWT with short-lived access tokens and refresh flow",
      },
      // Step 3: codex (returned from pair) finishes
      {
        contract_version: "1",
        next_action: "done",
        message: "implemented JWT flow",
      },
    ]);

    const result = await runOrchestrator({
      task: "start",
      firstAgent: "codex",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 3);
    // codex -> gemini (pair) -> codex (return)
    assert.deepEqual(invokeStub.calls, ["codex", "gemini", "codex"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("pair thread keeps its own session while the invoking step resumes its original session", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      review_gate: false,
      routing: {
        plan: "claude",
        implement: "codex",
        review: "gemini",
        pair: "gemini",
        "ask-human": "human",
        done: "stop",
      },
    } as Partial<Config>);
    const invokeStub = createInvokeStub([
      {
        response: {
          contract_version: "1",
          next_action: "implement",
          message: "implement auth",
        },
        sessionRef: "first-agent-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "pair",
          message: "validate my approach",
        },
        sessionRef: "implement-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "pair advice",
        },
        sessionRef: "pair-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "implemented with pair feedback",
        },
        sessionRef: "implement-session",
      },
    ]);

    let humanCalls = 0;
    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => {
          humanCalls += 1;
          return "finish";
        },
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.deepEqual(invokeStub.calls, ["claude", "codex", "gemini", "codex"]);
    assert.equal(invokeStub.sessionRefs[2], null);
    assert.equal(invokeStub.sessionRefs[3], "implement-session");
    assert.equal(humanCalls, 1);
    assert.match(
      invokeStub.prompts[3],
      /Current handoff from gemini:\npair advice/
    );
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("pair return restores the original step prompt scope", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      review_gate: false,
      step_prompts: {
        first_agent: [],
        plan: [],
        implement: ["Focus on concrete changes."],
        review: [],
        pair: ["Provide expert advice only."],
      },
    } as Partial<Config>);
    const invokeStub = createInvokeStub([
      // Step 1: claude (first_agent) routes to implement
      {
        contract_version: "1",
        next_action: "implement",
        message: "implement auth",
      },
      // Step 2: codex (implement) invokes pair
      {
        contract_version: "1",
        next_action: "pair",
        message: "validate my approach",
      },
      // Step 3: claude (pair) responds
      {
        contract_version: "1",
        next_action: "done",
        message: "approach looks good",
      },
      // Step 4: codex (returned) finishes
      {
        contract_version: "1",
        next_action: "done",
        message: "done",
      },
    ]);

    await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(invokeStub.prompts.length, 4);
    // Step 2 (implement) should have implement prompts
    assert.match(invokeStub.prompts[1], /Focus on concrete changes\./);
    // Step 3 (pair) should have pair prompts
    assert.match(invokeStub.prompts[2], /Provide expert advice only\./);
    // Step 4 (returned to implement) should have implement prompts restored
    assert.match(invokeStub.prompts[3], /Focus on concrete changes\./);
    assert.doesNotMatch(invokeStub.prompts[3], /Provide expert advice only\./);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("review gate redirects implement→done to review", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 });
    const invokeStub = createInvokeStub([
      // Step 1: claude (first_agent) routes to implement
      {
        contract_version: "1",
        next_action: "implement",
        message: "implement auth",
      },
      // Step 2: codex (implement) tries to go done — gate should redirect to review
      {
        contract_version: "1",
        next_action: "done",
        message: "auth implemented",
      },
      // Step 3: gemini (review) approves
      {
        contract_version: "1",
        next_action: "done",
        message: "review passed",
      },
    ]);

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 3);
    // claude -> codex (implement) -> gemini (review, redirected) -> done
    assert.deepEqual(invokeStub.calls, ["claude", "codex", "gemini"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("review gate does not intercept plan→done", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      routing: {
        plan: "claude",
        implement: "codex",
        review: "gemini",
        pair: "claude",
        "ask-human": "human",
        done: "stop",
      },
    });
    const invokeStub = createInvokeStub([
      // Step 1: claude routes to plan
      {
        contract_version: "1",
        next_action: "plan",
        message: "plan first",
      },
      // Step 2: claude (plan) goes done — should NOT be intercepted
      {
        contract_version: "1",
        next_action: "done",
        message: "plan complete",
      },
    ]);

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 2);
    // No redirect to review — plan→done goes straight through
    assert.deepEqual(invokeStub.calls, ["claude", "claude"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("review gate can be disabled via config", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      review_gate: false,
    } as Partial<Config>);
    const invokeStub = createInvokeStub([
      // Step 1: claude routes to implement
      {
        contract_version: "1",
        next_action: "implement",
        message: "implement auth",
      },
      // Step 2: codex (implement) goes done — gate disabled, should NOT redirect
      {
        contract_version: "1",
        next_action: "done",
        message: "auth done",
      },
    ]);

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 2);
    // No review step — gate was disabled
    assert.deepEqual(invokeStub.calls, ["claude", "codex"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("review gate allows review→done to pass through", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 });
    const invokeStub = createInvokeStub([
      // Step 1: claude routes to implement
      {
        contract_version: "1",
        next_action: "implement",
        message: "implement feature",
      },
      // Step 2: codex (implement) routes to review explicitly
      {
        contract_version: "1",
        next_action: "review",
        message: "ready for review",
      },
      // Step 3: gemini (review) goes done — should pass through (scope is review, not implement)
      {
        contract_version: "1",
        next_action: "done",
        message: "looks good",
      },
    ]);

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 3);
    assert.deepEqual(invokeStub.calls, ["claude", "codex", "gemini"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("pair return overrides the pair agent's own routing decision", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 });
    const invokeStub = createInvokeStub([
      // Step 1: claude invokes pair
      {
        contract_version: "1",
        next_action: "pair",
        message: "need advice on architecture",
      },
      // Step 2: pair agent tries to route to review — but return should override
      {
        contract_version: "1",
        next_action: "review",
        message: "here is my analysis",
      },
      // Step 3: back to claude (the invoking agent), not gemini
      {
        contract_version: "1",
        next_action: "done",
        message: "done",
      },
    ]);

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 3);
    // claude -> claude (pair target) -> claude (forced return)
    assert.deepEqual(invokeStub.calls, ["claude", "claude", "claude"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

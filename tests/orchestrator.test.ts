import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { runOrchestrator } from "../src/orchestrator";
import { AgentName, Config, Contract } from "../src/types";

type QueueItem = Contract | string;

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
    adapters: {},
    step_prompts: {
      first_agent: [],
      plan: [],
      implement: [],
      review: [],
    },
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

  return {
    calls,
    prompts,
    invokeAgent: async (agentName: AgentName, prompt: string) => {
      calls.push(agentName);
      prompts.push(prompt);
      if (index >= queue.length) {
        throw new Error(`No more stub outputs. Missing output for call ${index + 1}`);
      }

      const item = queue[index];
      index += 1;
      const stdout = typeof item === "string" ? item : toFencedContract(item);
      return {
        agent: agentName,
        command: ["mock"],
        args: ["mock"],
        timeoutMs: 1000,
        stdout,
        stderr: "",
        combined: stdout,
        durationMs: 1,
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
        askHumanInput: async () => "unused",
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
    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => {
          humanCalls += 1;
          return "clarification from human";
        },
        getRepoStateSignature: () => null,
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 2);
    assert.equal(humanCalls, 1);
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

    const humanReplies = ["please update these"];
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
        askHumanInput: async () => "unused",
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

test("orchestrator switches hidden step prompts to the routed action", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      step_prompts: {
        first_agent: ["Do not implement immediately."],
        plan: [],
        implement: ["Focus on making concrete repo changes."],
        review: [],
      },
    });
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
        askHumanInput: async () => "unused",
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
      step_prompts: {
        first_agent: ["Route the initial request before coding."],
        plan: [],
        implement: ["Stay in implementation mode after clarification."],
        review: [],
      },
    });
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

    await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "use the README path",
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

    await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "README only",
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

    const humanReplies = ["first human answer", "second human answer"];
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
        askHumanInput: async () => "unused",
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
        askHumanInput: async () => "unused",
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
        askHumanInput: async () => "unused",
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
          }
          return "human guidance";
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

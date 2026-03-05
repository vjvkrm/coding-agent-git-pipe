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
    ...overrides,
  };

  const configPath = path.join(cwd, ".agentpipe.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}

function createInvokeStub(queue: QueueItem[]) {
  let index = 0;
  const calls: AgentName[] = [];

  return {
    calls,
    invokeAgent: async (agentName: AgentName) => {
      calls.push(agentName);
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

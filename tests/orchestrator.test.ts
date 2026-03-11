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
      primary: "codex",
      review: "gemini",
      pair: "claude",
      "ask-human": "human",
      done: "stop",
    },
    max_hops: 8,
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
      primary: [],
      review: [],
      pair: [],
    },
    review_gate: true,
    discussion: {
      enabled: false,
      participants: [],
      max_rounds: 3,
      require_consensus: true,
    },
    max_review_iterations: 3,
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

async function captureProcessOutput<T>(
  run: () => Promise<T>
): Promise<{ result: T; stdout: string; stderr: string }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    const result = await run();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    process.stderr.write = originalStderrWrite as typeof process.stderr.write;
  }
}

test("orchestrator runs primary->review->done", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0, review_gate: false });
    const invokeStub = createInvokeStub([
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
    assert.equal(result.hops, 2);
    assert.deepEqual(invokeStub.calls, ["codex", "gemini"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator pauses on ask-human and resumes", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0, review_gate: false });
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
    assert.deepEqual(invokeStub.calls, ["codex", "codex"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator fails fast when a required agent CLI is missing", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      routing: {
        primary: "claude",
        review: "human",
        pair: "human",
        "ask-human": "human",
        done: "stop",
      },
      adapters: {
        claude: ["__definitely_missing_claude_binary__"],
      },
    });

    await assert.rejects(
      () =>
        runOrchestrator({
          task: "start",
          cwd,
          configPath,
          runtime: {
            askHumanInput: async () => {
              throw new Error("human gate should not open for missing binaries");
            },
            getRepoStateSignature: () => null,
          },
        }),
      (error: Error) => {
        assert.match(error.message, /Missing required agent CLI commands/);
        assert.match(error.message, /claude: command "__definitely_missing_claude_binary__" was not found on PATH/);
        return true;
      }
    );
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator carries recent human and agent context into follow-up prompts", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0, review_gate: false });
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

test("orchestrator injects primary step prompts on the initial hop", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      review_gate: false,
      step_prompts: {
        primary: ["Analyze first and route intentionally."],
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

test("orchestrator switches hidden step prompts when routing from primary to review", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      review_gate: false,
      step_prompts: {
        primary: ["Focus on making concrete repo changes."],
        review: ["Audit the result carefully before approving it."],
        pair: [],
      },
    } as Partial<Config>);
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "review",
        message: "ready for review",
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
    assert.match(invokeStub.prompts[0], /Focus on making concrete repo changes\./);
    assert.match(invokeStub.prompts[1], /Audit the result carefully before approving it\./);
    assert.doesNotMatch(invokeStub.prompts[1], /Focus on making concrete repo changes\./);
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
        primary: ["Focus on concrete repo changes."],
        review: ["Stay in review mode after clarification."],
        pair: [],
      },
    } as Partial<Config>);
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "review",
        message: "review the fix",
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
    assert.match(invokeStub.prompts[1], /Stay in review mode after clarification\./);
    assert.match(invokeStub.prompts[2], /Stay in review mode after clarification\./);
    assert.match(invokeStub.prompts[2], /Current handoff from human:\nuse the README path/);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator preserves primary step prompts through initial human clarification", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      review_gate: false,
      step_prompts: {
        primary: ["Only analyze and route on the primary step."],
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
    assert.match(invokeStub.prompts[0], /Only analyze and route on the primary step\./);
    assert.match(invokeStub.prompts[1], /Only analyze and route on the primary step\./);
    assert.match(invokeStub.prompts[1], /Current handoff from human:\nREADME only/);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator limits invisible prompt context to the last four turns", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0, review_gate: false });
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
    assert.match(invokeStub.prompts[2], /codex:\n  first agent question/);
    assert.match(invokeStub.prompts[2], /human:\n  first human answer/);
    assert.match(invokeStub.prompts[2], /codex:\n  second agent question/);
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
      review_gate: false,
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

test("orchestrator prints the parsed contract message when streamed output is silent", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      review_gate: false,
    });
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "done",
        message: "visible fallback summary",
      },
    ]);

    const captured = await captureProcessOutput(() =>
      runOrchestrator({
        task: "start",
        cwd,
        configPath,
        runtime: {
          invokeAgent: invokeStub.invokeAgent,
          askHumanInput: async () => "finish",
          getRepoStateSignature: () => null,
        },
      })
    );

    assert.equal(captured.result.status, "done");
    const plain = captured.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain, /\[codex\]\[primary\] visible fallback summary/);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("orchestrator forwards a direct agent question to the human after contract failure", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      review_gate: false,
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
    assert.deepEqual(invokeStub.calls, ["codex", "codex"]);
    assert.equal(humanPayloads.length, 2);
    assert.match(
      humanPayloads[0].message || "",
      /Codex asked the human a direct follow-up instead of returning an `ask-human` contract/
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
      routing: {
        primary: "codex",
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
        next_action: "primary",
        message: "keep going 1",
      },
      {
        contract_version: "1",
        next_action: "primary",
        message: "keep going 2",
      },
      {
        contract_version: "1",
        next_action: "primary",
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
      review_gate: false,
      routing: {
        primary: "codex",
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
    assert.deepEqual(invokeStub.calls, ["codex", "claude", "claude"]);
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
        next_action: "primary",
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

test("primary -> review -> primary reuses the original primary session", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0, review_gate: false } as Partial<Config>);
    const invokeStub = createInvokeStub([
      {
        response: {
          contract_version: "1",
          next_action: "primary",
          message: "implement auth",
        },
        sessionRef: "primary-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "review",
          message: "implemented auth",
        },
        sessionRef: "primary-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "primary",
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
        sessionRef: "primary-session",
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
    assert.deepEqual(invokeStub.calls, ["codex", "codex", "gemini", "codex"]);
    assert.equal(invokeStub.sessionRefs[3], "primary-session");
    assert.match(invokeStub.prompts[3], /Current handoff from gemini:\nplease tighten validation/);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("the same agent session is reused across primary and review scopes", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      review_gate: false,
      routing: {
        primary: "codex",
        review: "codex",
        pair: "claude",
        "ask-human": "human",
        done: "stop",
      },
    });
    const invokeStub = createInvokeStub([
      {
        response: {
          contract_version: "1",
          next_action: "review",
          message: "ready for review",
        },
        sessionRef: "codex-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "approved",
        },
        sessionRef: "codex-session",
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
    assert.deepEqual(invokeStub.calls, ["codex", "codex"]);
    assert.equal(invokeStub.sessionRefs[1], "codex-session");
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("ask-human within a step resumes the same saved session", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0, review_gate: false });
    const invokeStub = createInvokeStub([
      {
        response: {
          contract_version: "1",
          next_action: "ask-human",
          message: "need clarification",
          questions: [{ id: "q1", text: "which scope?" }],
        },
        sessionRef: "codex-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "done after clarification",
        },
        sessionRef: "codex-session",
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
    assert.deepEqual(invokeStub.calls, ["codex", "codex"]);
    assert.equal(invokeStub.sessionRefs[1], "codex-session");
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
      review_gate: false,
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
    assert.deepEqual(invokeStub.calls, ["codex", "codex"]);
    assert.equal(invokeStub.sessionRefs[1], null);
    assert.match(invokeStub.prompts[1], /Current handoff from human:\nUpdate \.agentpipe\.json first/);
    assert.match(
      invokeStub.prompts[1],
      /Recent conversation context[\s\S]*codex:\n  Which config file should I update before continuing\?/
    );
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("done routed to stop opens the finish or continue gate", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0, review_gate: false });
    const invokeStub = createInvokeStub([
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "all done",
        },
        sessionRef: "codex-session",
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
          if ((payload.footer || "").includes('Reply with "finish" or "/finish" to end the run')) {
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
    assert.deepEqual(invokeStub.calls, ["codex"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("continue after done resumes the same agent session", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0, review_gate: false });
    const invokeStub = createInvokeStub([
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "initial answer",
        },
        sessionRef: "codex-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "extra detail",
        },
        sessionRef: "codex-session",
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
    assert.deepEqual(invokeStub.calls, ["codex", "codex"]);
    assert.equal(invokeStub.sessionRefs[1], "codex-session");
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
      review_gate: false,
      routing: {
        primary: "codex",
        review: "gemini",
        pair: "gemini",
        "ask-human": "human",
        done: "stop",
      },
    });
    const invokeStub = createInvokeStub([
      // Step 1: codex (primary) invokes pair
      {
        contract_version: "1",
        next_action: "pair",
        message: "should I use JWT or session tokens?",
      },
      // Step 2: gemini (pair) responds with advice
      {
        contract_version: "1",
        next_action: "primary",
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

test("pair agent keeps its own session while the invoking agent resumes its original session", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      review_gate: false,
      routing: {
        primary: "codex",
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
          next_action: "primary",
          message: "implement auth",
        },
        sessionRef: "primary-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "pair",
          message: "validate my approach",
        },
        sessionRef: "primary-session",
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
        sessionRef: "primary-session",
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
    assert.deepEqual(invokeStub.calls, ["codex", "codex", "gemini", "codex"]);
    assert.equal(invokeStub.sessionRefs[2], null);
    assert.equal(invokeStub.sessionRefs[3], "primary-session");
    assert.equal(humanCalls, 1);
    assert.match(
      invokeStub.prompts[3],
      /Current handoff from gemini:\npair advice/
    );
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("pair agent session is reused across primary and review callers", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      review_gate: false,
      routing: {
        primary: "codex",
        review: "gemini",
        pair: "claude",
        "ask-human": "human",
        done: "stop",
      },
    } as Partial<Config>);
    const invokeStub = createInvokeStub([
      {
        response: {
          contract_version: "1",
          next_action: "pair",
          message: "pair on implementation",
        },
        sessionRef: "primary-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "first pair advice",
        },
        sessionRef: "claude-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "review",
          message: "ready for review",
        },
        sessionRef: "primary-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "pair",
          message: "pair on review",
        },
        sessionRef: "review-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "second pair advice",
        },
        sessionRef: "claude-session",
      },
      {
        response: {
          contract_version: "1",
          next_action: "done",
          message: "review complete",
        },
        sessionRef: "review-session",
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
    assert.deepEqual(invokeStub.calls, ["codex", "claude", "codex", "gemini", "claude", "gemini"]);
    assert.equal(invokeStub.sessionRefs[4], "claude-session");
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
        primary: ["Focus on concrete changes."],
        review: [],
        pair: ["Provide expert advice only."],
      },
    } as Partial<Config>);
    const invokeStub = createInvokeStub([
      // Step 1: codex (primary) invokes pair
      {
        contract_version: "1",
        next_action: "pair",
        message: "validate my approach",
      },
      // Step 2: claude (pair) responds
      {
        contract_version: "1",
        next_action: "done",
        message: "approach looks good",
      },
      // Step 3: codex (returned) finishes
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

    assert.equal(invokeStub.prompts.length, 3);
    assert.match(invokeStub.prompts[0], /Focus on concrete changes\./);
    assert.match(invokeStub.prompts[1], /Provide expert advice only\./);
    assert.match(
      invokeStub.prompts[1],
      /Return a handoff message for the invoking agent; do not attempt to choose global routing for the run\./
    );
    assert.match(
      invokeStub.prompts[1],
      /Pair routing is fixed by the caller\. Your `next_action` and `to` fields are ignored; only `message` is used\./
    );
    assert.match(
      invokeStub.prompts[1],
      /Set `next_action` to `done` and focus on making `message` useful for the caller\./
    );
    assert.match(invokeStub.prompts[2], /Focus on concrete changes\./);
    assert.doesNotMatch(invokeStub.prompts[2], /Provide expert advice only\./);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("review gate redirects primary→done to review when repo state is unavailable", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 });
    const invokeStub = createInvokeStub([
      // Step 1: codex (primary) tries to finish — gate should redirect to review
      {
        contract_version: "1",
        next_action: "done",
        message: "auth implemented",
      },
      // Step 2: gemini (review) approves
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
    assert.equal(result.hops, 2);
    assert.deepEqual(invokeStub.calls, ["codex", "gemini"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("review gate allows primary→done when repo state is unchanged since the last review", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 });
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "done",
        message: "analysis complete",
      },
    ]);

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => "same-state",
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 1);
    assert.deepEqual(invokeStub.calls, ["codex"]);
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
      // Step 1: codex (primary) goes done — gate disabled, so it should stop directly
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
    assert.equal(result.hops, 1);
    assert.deepEqual(invokeStub.calls, ["codex"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("review updates the reviewed repo-state baseline before returning to primary", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 });
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "done",
        message: "implementation ready",
      },
      {
        contract_version: "1",
        next_action: "primary",
        message: "tighten one validation edge case",
      },
      {
        contract_version: "1",
        next_action: "done",
        message: "validation tightened",
      },
    ]);
    const repoStates = ["repo:clean", "repo:changed", "repo:changed", "repo:changed"];
    let repoStateIndex = 0;

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => repoStates[repoStateIndex++] || repoStates[repoStates.length - 1],
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 3);
    assert.deepEqual(invokeStub.calls, ["codex", "gemini", "codex"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("review gate allows review→done to pass through", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 });
    const invokeStub = createInvokeStub([
      // Step 1: codex (primary) routes to review
      {
        contract_version: "1",
        next_action: "review",
        message: "ready for review",
      },
      // Step 2: gemini (review) goes done — should pass through because the scope is review
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
    assert.equal(result.hops, 2);
    assert.deepEqual(invokeStub.calls, ["codex", "gemini"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("global /finish ends the run from a human gate", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0, review_gate: false });
    const invokeStub = createInvokeStub([
      {
        contract_version: "1",
        next_action: "ask-human",
        message: "need clarification",
        questions: [{ id: "q1", text: "which environment?" }],
      },
    ]);

    const result = await runOrchestrator({
      task: "start",
      cwd,
      configPath,
      runtime: {
        invokeAgent: invokeStub.invokeAgent,
        askHumanInput: async () => "/finish",
        getRepoStateSignature: () => "same-state",
      },
    });

    assert.equal(result.status, "done");
    assert.equal(result.hops, 1);
    assert.deepEqual(invokeStub.calls, ["codex"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("pair return overrides the pair agent's own routing decision", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0, review_gate: false });
    const invokeStub = createInvokeStub([
      // Step 1: codex invokes pair
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
      // Step 3: back to codex (the invoking agent), not gemini
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
    assert.deepEqual(invokeStub.calls, ["codex", "claude", "codex"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

// --- Review iteration tests ---

test("review_verdict request-changes routes back to primary automatically", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, { no_progress_hops: 0 });
    const invokeStub = createInvokeStub([
      // Step 1: codex implements
      {
        contract_version: "1",
        next_action: "done",
        message: "auth implemented",
      },
      // Step 2: gemini reviews — requests changes (review gate redirected here)
      {
        contract_version: "1",
        next_action: "done",
        message: "Missing error handling in auth middleware",
        review_verdict: "request-changes",
        review_comments: [
          { file: "src/auth.ts", line: 15, comment: "Missing null check on token" },
        ],
      },
      // Step 3: codex fixes (auto-routed back from review iteration)
      {
        contract_version: "1",
        next_action: "done",
        message: "Fixed null check",
      },
      // Step 4: gemini re-reviews — approves (review gate intercepts again)
      {
        contract_version: "1",
        next_action: "done",
        message: "Looks good now",
        review_verdict: "approve",
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
    assert.deepEqual(invokeStub.calls, ["codex", "gemini", "codex", "gemini"]);
    // Verify review comments were formatted into the handoff message to primary
    assert.match(invokeStub.prompts[2], /Changes Requested/);
    assert.match(invokeStub.prompts[2], /Missing null check on token/);
    assert.match(invokeStub.prompts[2], /src\/auth\.ts:15/);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("review iteration respects max_review_iterations limit", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      max_review_iterations: 1,
    });
    const invokeStub = createInvokeStub([
      // Step 1: codex implements
      {
        contract_version: "1",
        next_action: "done",
        message: "first attempt",
      },
      // Step 2: gemini requests changes (iteration 1 of 1)
      {
        contract_version: "1",
        next_action: "done",
        message: "needs fix",
        review_verdict: "request-changes",
        review_comments: [{ comment: "Fix bug" }],
      },
      // Step 3: codex fixes
      {
        contract_version: "1",
        next_action: "done",
        message: "fixed",
      },
      // Step 4: gemini requests changes again — but max iterations reached, so this should NOT redirect back
      {
        contract_version: "1",
        next_action: "done",
        message: "still not perfect but acceptable",
        review_verdict: "request-changes",
        review_comments: [{ comment: "Minor style issue" }],
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
    // After max iterations, review→done goes through to the done gate (not back to primary)
    assert.deepEqual(invokeStub.calls, ["codex", "gemini", "codex", "gemini"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

test("review_verdict approve resets iteration count", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      max_review_iterations: 2,
    });
    const invokeStub = createInvokeStub([
      // Round 1: implement -> review -> request-changes -> fix -> review -> approve
      {
        contract_version: "1",
        next_action: "done",
        message: "impl round 1",
      },
      {
        contract_version: "1",
        next_action: "done",
        message: "fix needed",
        review_verdict: "request-changes",
        review_comments: [{ comment: "Bug" }],
      },
      {
        contract_version: "1",
        next_action: "done",
        message: "fixed",
      },
      {
        contract_version: "1",
        next_action: "done",
        message: "approved",
        review_verdict: "approve",
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
    assert.deepEqual(invokeStub.calls, ["codex", "gemini", "codex", "gemini"]);
  } finally {
    cleanupTempRepo(cwd);
  }
});

// --- Discussion integration test ---

test("discuss flag enables plan & discuss phase before implementation", async () => {
  const cwd = createTempRepo();
  try {
    const configPath = writeConfig(cwd, {
      no_progress_hops: 0,
      review_gate: false,
    });

    const allAgentCalls: { agent: string; prompt: string }[] = [];
    let callIndex = 0;
    const responses: Contract[] = [
      // Plan phase: codex proposes
      {
        contract_version: "1",
        next_action: "done",
        message: "Plan to add auth",
        proposal: {
          summary: "Add JWT auth",
          approach: "Create middleware",
          files: ["src/auth.ts"],
        },
        confidence: 0.9,
      },
      // Discuss: gemini agrees
      {
        contract_version: "1",
        next_action: "done",
        message: "Good approach",
        sentiment: "agree",
        concerns: [],
        confidence: 0.85,
      },
      // Discuss: claude agrees
      {
        contract_version: "1",
        next_action: "done",
        message: "Agreed",
        sentiment: "agree",
        concerns: [],
        confidence: 0.9,
      },
      // Implementation: codex implements
      {
        contract_version: "1",
        next_action: "done",
        message: "Auth implemented",
      },
    ];

    const result = await runOrchestrator({
      task: "Add JWT authentication",
      discuss: true,
      cwd,
      configPath,
      runtime: {
        invokeAgent: async (agent, prompt, options) => {
          allAgentCalls.push({ agent, prompt });
          const contract = responses[callIndex++];
          const output = `\`\`\`json\n${JSON.stringify(contract)}\n\`\`\``;
          return {
            agent,
            command: ["test"],
            args: [],
            timeoutMs: 30000,
            stdout: output,
            stderr: "",
            combined: output,
            durationMs: 100,
          };
        },
        askHumanInput: async () => "finish",
        getRepoStateSignature: () => "same-state",
      },
    });

    assert.equal(result.status, "done");
    // 3 discussion hops + 1 implementation hop = 4 total
    assert.equal(result.hops, 4);
    // Plan: codex, Discuss: gemini + claude, Implement: codex
    assert.deepEqual(
      allAgentCalls.map((c) => c.agent),
      ["codex", "gemini", "claude", "codex"]
    );
    // Implementation prompt should contain the approved plan
    assert.match(allAgentCalls[3].prompt, /Approved Implementation Plan/);
  } finally {
    cleanupTempRepo(cwd);
  }
});

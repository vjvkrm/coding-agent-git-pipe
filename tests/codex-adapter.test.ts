import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findCodexSessionRefFromLocalState,
  normalizeCodexJsonOutput,
  resolveCodexStateDbPath,
  resolveCodexResumeCommand,
  resolveCodexStreamingCommand,
} from "../src/adapters/codex";
import { Config } from "../src/types";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    routing: {
      primary: "codex",
      review: "gemini",
      pair: "claude",
      "ask-human": "human",
      done: "stop",
    },
    max_hops: 10,
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
    ...overrides,
  };
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-pipe-codex-"));
}

function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("normalizeCodexJsonOutput extracts the last agent message", () => {
  const output = [
    '{"sandbox":"read-only"}',
    '{"prompt":"Say hello"}',
    '{"id":"0","msg":{"type":"task_started","model_context_window":272000}}',
    '{"id":"0","msg":{"type":"agent_message","message":"Hello\\n```json\\n{\\"contract_version\\":\\"1\\",\\"next_action\\":\\"done\\",\\"message\\":\\"ok\\"}\\n```"}}',
  ].join("\n");

  assert.equal(
    normalizeCodexJsonOutput(output),
    'Hello\n```json\n{"contract_version":"1","next_action":"done","message":"ok"}\n```'
  );
});

test("normalizeCodexJsonOutput falls back to raw output when no agent message exists", () => {
  const output = [
    '{"sandbox":"read-only"}',
    '{"prompt":"Say hello"}',
  ].join("\n");

  assert.equal(normalizeCodexJsonOutput(output), output);
});

test("normalizeCodexJsonOutput prefers the latest message when progress updates arrive", () => {
  const output = [
    '{"id":"0","msg":{"type":"agent_message","message":"Scanning repo"}}',
    '{"id":"0","msg":{"type":"agent_message","message":"Scanning repo complete"}}',
  ].join("\n");

  assert.equal(normalizeCodexJsonOutput(output), "Scanning repo complete");
});

test("normalizeCodexJsonOutput handles live item.updated agent messages", () => {
  const output = [
    '{"type":"thread.started","thread_id":"thread-123"}',
    '{"type":"item.updated","item":{"id":"item_1","type":"agent_message","message":"Scanning repo"}}',
    '{"type":"item.updated","item":{"id":"item_1","type":"agent_message","message":"Scanning repo complete"}}',
  ].join("\n");

  assert.equal(normalizeCodexJsonOutput(output), "Scanning repo complete");
});

test("normalizeCodexJsonOutput prefers assistant message items over reasoning items", () => {
  const output = [
    '{"type":"item.updated","item":{"id":"item_r1","type":"reasoning","text":"Inspecting files"}}',
    '{"type":"item.completed","item":{"id":"item_m1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Final answer\\n```json\\n{\\"contract_version\\":\\"1\\",\\"next_action\\":\\"done\\",\\"message\\":\\"ok\\"}\\n```"}]}}',
  ].join("\n");

  assert.equal(
    normalizeCodexJsonOutput(output),
    'Final answer\n```json\n{"contract_version":"1","next_action":"done","message":"ok"}\n```'
  );
});

test("resolveCodexStreamingCommand keeps custom codex adapters on the JSON streaming path", () => {
  const config = makeConfig({
    adapters: {
      codex: ["codex", "exec", "--skip-git-repo-check", "--full-auto"],
    },
  });

  assert.deepEqual(resolveCodexStreamingCommand(config), [
    "codex",
    "exec",
    "--skip-git-repo-check",
    "--full-auto",
    "--json",
  ]);
});

test("resolveCodexStreamingCommand falls back to raw execution for non-codex wrappers", () => {
  const config = makeConfig({
    adapters: {
      codex: ["env", "FOO=1", "codex", "exec", "--json"],
    },
  });

  assert.equal(resolveCodexStreamingCommand(config), null);
});

test("resolveCodexStreamingCommand preserves adapter_args on the JSON streaming path", () => {
  const config = makeConfig({
    adapter_args: {
      codex: ["--full-auto", "-m", "gpt-5.4"],
    },
  });

  assert.deepEqual(resolveCodexStreamingCommand(config), [
    "codex",
    "exec",
    "--skip-git-repo-check",
    "--full-auto",
    "-m",
    "gpt-5.4",
    "--json",
  ]);
});

test("resolveCodexResumeCommand preserves adapter_args on resume", () => {
  const config = makeConfig({
    adapter_args: {
      codex: ["--full-auto", "-m", "gpt-5.4"],
    },
  });

  assert.deepEqual(resolveCodexResumeCommand(config, "session-123"), [
    "codex",
    "exec",
    "resume",
    "session-123",
    "--skip-git-repo-check",
    "--full-auto",
    "-m",
    "gpt-5.4",
    "--json",
  ]);
});

test("resolveCodexStateDbPath chooses the highest state db version", () => {
  const dir = createTempDir();
  try {
    fs.writeFileSync(path.join(dir, "state_4.sqlite"), "");
    fs.writeFileSync(path.join(dir, "state_12.sqlite"), "");
    fs.writeFileSync(path.join(dir, "state_7.sqlite"), "");

    assert.equal(resolveCodexStateDbPath(dir), path.join(dir, "state_12.sqlite"));
  } finally {
    cleanupTempDir(dir);
  }
});

test("findCodexSessionRefFromLocalState queries the newest thread id for the cwd and time window", () => {
  let seenDbPath = "";
  let seenQuery = "";
  const sessionRef = findCodexSessionRefFromLocalState({
    cwd: "/tmp/example-repo",
    startedAtMs: 1_700_000_000_000,
    endedAtMs: 1_700_000_030_000,
    stateDbPath: "/tmp/state_5.sqlite",
    sqliteQueryFn: (dbPath, query) => {
      seenDbPath = dbPath;
      seenQuery = query;
      return "thread-123\n";
    },
  });

  assert.equal(sessionRef, "thread-123");
  assert.equal(seenDbPath, "/tmp/state_5.sqlite");
  assert.match(seenQuery, /FROM threads/);
  assert.match(seenQuery, /WHERE cwd = '\/tmp\/example-repo'/);
  assert.match(seenQuery, /updated_at >= 1699999995/);
  assert.match(seenQuery, /updated_at <= 1700000035/);
});

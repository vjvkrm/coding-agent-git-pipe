import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCodexJsonOutput, resolveCodexStreamingCommand } from "../src/adapters/codex";
import { Config } from "../src/types";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    routing: {
      plan: "claude",
      implement: "codex",
      review: "gemini",
      "ask-human": "human",
      done: "stop",
    },
    max_hops: 10,
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

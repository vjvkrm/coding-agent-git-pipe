import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGeminiStreamOutput, resolveGeminiStreamingCommand } from "../src/adapters/gemini";
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

test("normalizeGeminiStreamOutput concatenates assistant deltas", () => {
  const output = [
    "Loaded cached credentials.",
    '{"type":"message","role":"assistant","content":"Hello","delta":true}',
    '{"type":"message","role":"assistant","content":" there","delta":true}',
  ].join("\n");

  assert.equal(normalizeGeminiStreamOutput(output), "Hello there");
});

test("normalizeGeminiStreamOutput prefers the last full assistant message", () => {
  const output = [
    '{"type":"message","role":"assistant","content":"Draft","delta":false}',
    '{"type":"message","role":"assistant","content":"Final answer","delta":false}',
  ].join("\n");

  assert.equal(normalizeGeminiStreamOutput(output), "Final answer");
});

test("resolveGeminiStreamingCommand preserves explicit stream-json config", () => {
  const config = makeConfig({
    adapters: {
      gemini: ["gemini", "-o", "stream-json"],
    },
  });

  assert.deepEqual(resolveGeminiStreamingCommand(config), ["gemini", "-o", "stream-json"]);
});

test("resolveGeminiStreamingCommand appends stream-json to direct gemini adapters", () => {
  const config = makeConfig({
    adapters: {
      gemini: ["gemini"],
    },
  });

  assert.deepEqual(resolveGeminiStreamingCommand(config), ["gemini", "-o", "stream-json"]);
});

test("resolveGeminiStreamingCommand falls back to raw execution for explicit non-stream output", () => {
  const config = makeConfig({
    adapters: {
      gemini: ["gemini", "-o", "text"],
    },
  });

  assert.equal(resolveGeminiStreamingCommand(config), null);
});

test("resolveGeminiStreamingCommand preserves adapter_args on the streaming path", () => {
  const config = makeConfig({
    adapter_args: {
      gemini: ["--model", "gemini-2.5-pro"],
    },
  });

  assert.deepEqual(resolveGeminiStreamingCommand(config), [
    "gemini",
    "--model",
    "gemini-2.5-pro",
    "-o",
    "stream-json",
  ]);
});

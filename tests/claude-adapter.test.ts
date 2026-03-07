import assert from "node:assert/strict";
import test from "node:test";
import { formatClaudeToolUse, normalizeClaudeStreamOutput } from "../src/adapters/claude";

test("normalizeClaudeStreamOutput prefers final result text", () => {
  const output = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Plan"},{"type":"text","text":"ning"}]}}',
    '{"type":"result","result":"Final answer\\n```json\\n{\\"contract_version\\":\\"1\\",\\"next_action\\":\\"done\\",\\"message\\":\\"ok\\"}\\n```"}',
  ].join("\n");

  assert.equal(
    normalizeClaudeStreamOutput(output),
    'Final answer\n```json\n{"contract_version":"1","next_action":"done","message":"ok"}\n```'
  );
});

test("normalizeClaudeStreamOutput falls back to latest assistant text", () => {
  const output = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Hel"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}',
  ].join("\n");

  assert.equal(normalizeClaudeStreamOutput(output), "Hello");
});

test("normalizeClaudeStreamOutput ignores thinking-only assistant content", () => {
  const output = [
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Inspecting files"}}}',
    '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Inspecting files"},{"type":"text","text":"Visible answer"}]}}',
  ].join("\n");

  assert.equal(normalizeClaudeStreamOutput(output), "Visible answer");
});

test("formatClaudeToolUse summarizes tool name and input", () => {
  assert.equal(
    formatClaudeToolUse({
      type: "tool_use",
      name: "Read",
      input: { file_path: "/repo/README.md" },
    }),
    '(tool) Read {"file_path":"/repo/README.md"}'
  );
});

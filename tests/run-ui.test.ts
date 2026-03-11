import assert from "node:assert/strict";
import test from "node:test";
import { extractVisibleAgentText, resolveUiMode } from "../src/run-ui";

test("resolveUiMode honors explicit mode overrides", () => {
  assert.equal(resolveUiMode("plain"), "plain");
  assert.equal(resolveUiMode("tui"), "tui");
});

test("resolveUiMode defaults to plain when tty is unavailable", () => {
  assert.equal(
    resolveUiMode(null, {
      stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: { isTTY: true } as NodeJS.WriteStream,
    }),
    "plain"
  );
});

test("resolveUiMode defaults to tui when stdin and stdout are tty", () => {
  assert.equal(
    resolveUiMode(null, {
      stdin: { isTTY: true } as NodeJS.ReadStream,
      stdout: { isTTY: true } as NodeJS.WriteStream,
    }),
    "tui"
  );
});

test("extractVisibleAgentText replaces a contract-only response with the useful summary", () => {
  const raw = [
    "```json",
    "{",
    '  "contract_version": "1",',
    '  "next_action": "ask-human",',
    '  "message": "Need the exact task before editing files.",',
    '  "questions": [{"id":"q1","text":"What should I change?"}]',
    "}",
    "```",
  ].join("\n");

  assert.equal(
    extractVisibleAgentText(raw),
    "Need the exact task before editing files.\n\nQuestion: What should I change?"
  );
});

test("extractVisibleAgentText hides an incomplete contract block from the transcript", () => {
  const raw = [
    "Thinking through the repo",
    "```json",
    "{",
    '  "contract_version": "1",',
  ].join("\n");

  assert.equal(extractVisibleAgentText(raw), "Thinking through the repo");
});

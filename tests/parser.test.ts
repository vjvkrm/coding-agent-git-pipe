import test from "node:test";
import assert from "node:assert/strict";
import { parseContractOutput } from "../src/parser";

test("parseContractOutput reads final fenced json block", () => {
  const output = [
    "some text",
    "```json",
    '{"contract_version":"1","next_action":"done","message":"ok"}',
    "```",
  ].join("\n");

  const parsed = parseContractOutput(output) as { next_action: string };
  assert.equal(parsed.next_action, "done");
});

test("parseContractOutput supports raw json output", () => {
  const parsed = parseContractOutput(
    '{"contract_version":"1","next_action":"done","message":"ok"}'
  ) as { message: string };
  assert.equal(parsed.message, "ok");
});

test("parseContractOutput extracts a contract embedded in JSONL event output", () => {
  const output = [
    '{"type":"status","msg":{"type":"task_started"}}',
    '{"type":"result","payload":{"content":"```json\\n{\\"contract_version\\":\\"1\\",\\"next_action\\":\\"done\\",\\"message\\":\\"ok\\"}\\n```"}}',
  ].join("\n");

  const parsed = parseContractOutput(output) as { next_action: string; message: string };
  assert.equal(parsed.next_action, "done");
  assert.equal(parsed.message, "ok");
});

test("parseContractOutput throws on missing final json block", () => {
  assert.throws(() => parseContractOutput("hello world"), /Could not find/);
});

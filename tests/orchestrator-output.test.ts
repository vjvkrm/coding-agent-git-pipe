import assert from "node:assert/strict";
import test from "node:test";
import { createPrefixedWriter, formatTerminalPrefix } from "../src/orchestrator";

test("createPrefixedWriter prefixes each logical line once", () => {
  let written = "";
  const target = {
    write(chunk: string) {
      written += chunk;
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  const write = createPrefixedWriter(target, "[claude] ");
  write("Hello");
  write(" world\nNext");
  write(" line\n");

  assert.equal(written, "[claude] Hello world\n[claude] Next line\n");
});

test("formatTerminalPrefix includes both agent and step scope", () => {
  assert.equal(formatTerminalPrefix("codex", "primary"), "[codex][primary] ");
  assert.equal(formatTerminalPrefix("claude", "pair", "stderr"), "[claude][pair][stderr] ");
});

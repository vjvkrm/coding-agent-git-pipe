import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-pipe-config-"));
}

function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("loadConfig provides empty step prompt arrays by default", () => {
  const cwd = createTempDir();
  try {
    const config = loadConfig({ cwd });
    assert.deepEqual(config.step_prompts, {
      first_agent: [],
      plan: [],
      implement: [],
      review: [],
      pair: [],
    });
  } finally {
    cleanupTempDir(cwd);
  }
});

test("loadConfig rejects unknown step prompt scopes", () => {
  const cwd = createTempDir();
  try {
    fs.writeFileSync(
      path.join(cwd, ".agentpipe.json"),
      JSON.stringify({
        step_prompts: {
          first_agent: [],
          plan: [],
          implement: [],
          review: [],
          entry: ["not allowed"],
        },
      }),
      "utf8"
    );

    assert.throws(
      () => loadConfig({ cwd }),
      /Invalid step_prompts key "entry"/
    );
  } finally {
    cleanupTempDir(cwd);
  }
});

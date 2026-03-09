import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = path.join(PROJECT_ROOT, "src", "cli.ts");

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-pipe-cli-"));
}

function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_ENTRY, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
}

test("init creates a starter .agentpipe.json in the target cwd", () => {
  const cwd = createTempDir();
  try {
    const result = runCli(["init", "--cwd", cwd]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Created .*\.agentpipe\.json/);

    const configPath = path.join(cwd, ".agentpipe.json");
    assert.equal(fs.existsSync(configPath), true);

    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(config.max_hops, 50);
    assert.equal(config.routing.primary, "codex");
    assert.equal(config.review_gate, true);
    assert.deepEqual(config.adapter_args, {});
    assert.deepEqual(config.step_prompts, {
      primary: [],
      review: [],
      pair: [],
    });
  } finally {
    cleanupTempDir(cwd);
  }
});

test("init refuses to overwrite an existing config without --force", () => {
  const cwd = createTempDir();
  try {
    fs.writeFileSync(path.join(cwd, ".agentpipe.json"), '{"routing":{"primary":"codex"}}\n', "utf8");

    const result = runCli(["init", "--cwd", cwd]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Config already exists/);
  } finally {
    cleanupTempDir(cwd);
  }
});

test("init overwrites an existing config with --force", () => {
  const cwd = createTempDir();
  try {
    const configPath = path.join(cwd, ".agentpipe.json");
    fs.writeFileSync(configPath, '{"routing":{"primary":"codex"}}\n', "utf8");

    const result = runCli(["init", "--cwd", cwd, "--force"]);

    assert.equal(result.status, 0);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(config.routing.primary, "codex");
    assert.equal(config.max_hops, 50);
  } finally {
    cleanupTempDir(cwd);
  }
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    env: {
      ...process.env,
      AGENT_PIPE_INK_DEBUG: "1",
    },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startInteractiveCli(targetCwd = PROJECT_ROOT): {
  child: ChildProcessWithoutNullStreams;
  write: (chunk: string) => void;
  waitForOutput: (pattern: RegExp, timeoutMs?: number) => Promise<string>;
  readOutput: () => string;
  kill: () => void;
} {
  const entryUrl = pathToFileURL(CLI_ENTRY).href;
  const script = `
Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
process.stdin.setRawMode = () => process.stdin;
process.stdin.ref = () => process.stdin;
process.stdin.unref = () => process.stdin;
process.stdout.columns = 100;
process.stdout.rows = 32;
const cliModule = await import(${JSON.stringify(entryUrl)});
process.chdir(${JSON.stringify(targetCwd)});
await cliModule.default.main(["node", "agent-pipe"]);
`;

  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      AGENT_PIPE_INK_DEBUG: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin.setDefaultEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return {
    child,
    write: (chunk: string) => {
      child.stdin.write(chunk);
    },
    waitForOutput: async (pattern: RegExp, timeoutMs = 5000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const combined = `${stdout}${stderr}`;
        if (pattern.test(combined)) {
          return combined;
        }

        await delay(25);
      }

      throw new Error(`Timed out waiting for ${pattern}.\nOutput:\n${stdout}${stderr}`);
    },
    readOutput: () => `${stdout}${stderr}`,
    kill: () => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    },
  };
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

test("interactive mode keeps the first command instead of treating it like EOF", async () => {
  const session = startInteractiveCli();

  try {
    await session.waitForOutput(/Commands: \/help, \/quit/);
    session.write("/help");
    await delay(50);
    session.write("\r");
    await session.waitForOutput(/Usage/);
    session.write("/quit");
    await delay(50);
    session.write("\r");
    await session.waitForOutput(/Bye!/);

    const output = session.readOutput();
    assert.match(output, /Usage/);
    assert.match(output, /Commands: \/help, \/quit/);
    assert.match(output, /> /);
    assert.match(output, /Bye!/);
  } finally {
    session.kill();
  }
});

test("interactive mode keeps multiline paste in the input until Enter is pressed", async () => {
  const cwd = createTempDir();

  try {
    const session = startInteractiveCli(cwd);

    try {
      await session.waitForOutput(/Commands: \/help, \/quit/);
      session.write("copied task\nwith second line");

      const promptOutput = await session.waitForOutput(/copied task with second line/);
      assert.doesNotMatch(promptOutput, /Error:/);

      await delay(200);
      assert.doesNotMatch(session.readOutput(), /Error:/);

      session.write("\u0004");
      await session.waitForOutput(/Bye!/);
      assert.match(session.readOutput(), /Bye!/);
    } finally {
      session.kill();
    }
  } finally {
    cleanupTempDir(cwd);
  }
});

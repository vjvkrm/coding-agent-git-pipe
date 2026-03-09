import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_ADAPTER_COMMANDS,
  PRINT_ADAPTER_COMMANDS,
  resolveAdapterCommand,
  runAdapter,
} from "../src/adapters/base";
import { Config } from "../src/types";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    routing: {
      plan: "claude",
      implement: "codex",
      review: "gemini",
      pair: "claude",
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
    adapter_args: {},
    adapters: {},
    step_prompts: {
      first_agent: [],
      plan: [],
      implement: [],
      review: [],
      pair: [],
    },
    review_gate: true,
    ...overrides,
  };
}

test("print mode throws for codex (no distinct print command)", () => {
  const config = makeConfig({ adapter_modes: { codex: "print" } });
  assert.throws(
    () => runAdapter("codex", "test prompt", { config, timeoutMs: 5000 }),
    (err: Error) => {
      assert.match(err.message, /print mode is not supported for codex/i);
      return true;
    }
  );
});

test("print mode throws for gemini (no distinct print command)", () => {
  const config = makeConfig({ adapter_modes: { gemini: "print" } });
  assert.throws(
    () => runAdapter("gemini", "test prompt", { config, timeoutMs: 5000 }),
    (err: Error) => {
      assert.match(err.message, /print mode is not supported for gemini/i);
      return true;
    }
  );
});

test("built-in claude commands are non-interactive in both modes", () => {
  assert.deepEqual(AUTO_ADAPTER_COMMANDS.claude, ["claude", "--dangerously-skip-permissions", "-p"]);
  assert.deepEqual(PRINT_ADAPTER_COMMANDS.claude, ["claude", "-p", "--tools", ""]);
});

test("resolveAdapterCommand appends adapter_args to built-in commands", () => {
  const config = makeConfig({
    adapter_args: {
      codex: ["--full-auto", "-m", "gpt-5.4"],
    },
  });

  assert.deepEqual(resolveAdapterCommand("codex", config), [
    "codex",
    "exec",
    "--skip-git-repo-check",
    "--full-auto",
    "-m",
    "gpt-5.4",
  ]);
});

test("timeout sends SIGTERM then SIGKILL for unresponsive child", async () => {
  const config = makeConfig({
    adapters: {
      // A child that traps SIGTERM and ignores it, forcing SIGKILL
      claude: ["node", "-e", `
        process.on('SIGTERM', () => {});
        setInterval(() => {}, 100000);
      `],
    },
  });

  const start = Date.now();
  await assert.rejects(
    () => runAdapter("claude", "", { config, timeoutMs: 200 }),
    (err: Error) => {
      assert.match(err.message, /timed out/i);
      return true;
    }
  );
  const elapsed = Date.now() - start;
  // Should take ~200ms timeout + ~5000ms SIGKILL grace, with some tolerance
  assert.ok(elapsed >= 200, `Expected at least 200ms, got ${elapsed}ms`);
  // Should not hang forever — SIGKILL must have fired
  assert.ok(elapsed < 15000, `Expected under 15s, got ${elapsed}ms — SIGKILL may not have fired`);
});

test("runAdapter closes stdin so EOF-gated commands can exit", async () => {
  const config = makeConfig({
    adapters: {
      claude: [
        "node",
        "-e",
        `
          let input = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => { input += chunk; });
          process.stdin.on("end", () => {
            process.stdout.write(input === "" ? "stdin-closed\\n" : "stdin-open\\n");
          });
          process.stdin.resume();
        `,
      ],
    },
  });

  const invocation = await runAdapter("claude", "ignored prompt", { config, timeoutMs: 1000 });
  assert.equal(invocation.stdout, "stdin-closed\n");
});

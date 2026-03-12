import path from "path";
import readline from "node:readline";
import { writeDefaultConfig } from "./config";
import { runOrchestrator } from "./orchestrator";
import { AgentName, UiMode } from "./types";

const pkg = require("../package.json") as { version?: string };

function printHelp(): void {
  const B = "\x1b[1m";
  const D = "\x1b[2m";
  const R = "\x1b[0m";
  console.log(`\n  ${B}agent-pipe${R} ${D}(cagp)${R} — AI engineering team orchestrator\n`);
  console.log(`  ${B}Usage${R}`);
  console.log(`    agent-pipe init ${D}[options]${R}`);
  console.log(`    agent-pipe run ${D}"<task>" [options]${R}\n`);
  console.log(`  ${B}Commands${R}`);
  console.log(`    ${B}init${R}                        Create a starter .agentpipe.json`);
  console.log(`    ${B}run${R}                         Execute an orchestration task\n`);
  console.log(`  ${B}Run options${R}`);
  console.log(`    --primary-agent <name>     Primary agent ${D}(claude|codex|gemini)${R}`);
  console.log(`    --discuss                  Enable plan & discuss phase`);
  console.log(`    --max-hops <number>        Maximum routing hops`);
  console.log(`    --timeout-ms <number>      Per-agent timeout in milliseconds`);
  console.log(`    --max-retries <number>     Contract parse retries`);
  console.log(`    --no-progress-hops <num>   Ask human if repo stalls for N steps`);
  console.log(`    --ui <mode>                UI mode ${D}(auto|plain|tui)${R}`);
  console.log(`    --config <path>            Config path ${D}(default: .agentpipe.json)${R}`);
  console.log(`    --cwd <path>               Working directory ${D}(default: cwd)${R}\n`);
  console.log(`  ${B}Init options${R}`);
  console.log(`    --config <path>            Config output path`);
  console.log(`    --cwd <path>               Target repo directory`);
  console.log(`    --force                    Overwrite existing config`);
  console.log(`    -h, --help                 Show help`);
  console.log(`    -v, --version              Show version\n`);
}

function parseRunArgs(args: string[]): {
  taskParts: string[];
  primaryAgent: AgentName | null;
  discuss: boolean;
  maxHops: number | null;
  timeoutMs: number | null;
  maxRetries: number | null;
  noProgressHops: number | null;
  uiMode: UiMode | null;
  configPathRaw: string | null;
  configPath: string | null;
  cwd: string;
} {
  const parsed = {
    taskParts: [] as string[],
    primaryAgent: null as AgentName | null,
    discuss: false,
    maxHops: null as number | null,
    timeoutMs: null as number | null,
    maxRetries: null as number | null,
    noProgressHops: null as number | null,
    uiMode: null as UiMode | null,
    configPathRaw: null as string | null,
    configPath: null as string | null,
    cwd: process.cwd(),
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "--discuss") {
      parsed.discuss = true;
      continue;
    }

    if (arg === "--primary-agent" && next) {
      parsed.primaryAgent = next as AgentName;
      i += 1;
      continue;
    }

    if (arg === "--max-hops" && next) {
      parsed.maxHops = Number(next);
      i += 1;
      continue;
    }

    if (arg === "--timeout-ms" && next) {
      parsed.timeoutMs = Number(next);
      i += 1;
      continue;
    }

    if (arg === "--max-retries" && next) {
      parsed.maxRetries = Number(next);
      i += 1;
      continue;
    }

    if (arg === "--no-progress-hops" && next) {
      parsed.noProgressHops = Number(next);
      i += 1;
      continue;
    }

    if (arg === "--ui" && next) {
      parsed.uiMode = next as UiMode;
      i += 1;
      continue;
    }

    if (arg === "--config" && next) {
      parsed.configPathRaw = next;
      i += 1;
      continue;
    }

    if (arg === "--cwd" && next) {
      parsed.cwd = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }

    parsed.taskParts.push(arg);
  }

  if (parsed.configPathRaw) {
    parsed.configPath = path.resolve(parsed.cwd, parsed.configPathRaw);
  }

  return parsed;
}

function parseInitArgs(args: string[]): {
  cwd: string;
  configPathRaw: string | null;
  configPath: string | null;
  force: boolean;
  extraArgs: string[];
} {
  const parsed = {
    cwd: process.cwd(),
    configPathRaw: null as string | null,
    configPath: null as string | null,
    force: false,
    extraArgs: [] as string[],
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "--config" && next) {
      parsed.configPathRaw = next;
      i += 1;
      continue;
    }

    if (arg === "--cwd" && next) {
      parsed.cwd = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }

    if (arg === "--force") {
      parsed.force = true;
      continue;
    }

    parsed.extraArgs.push(arg);
  }

  parsed.configPath = parsed.configPathRaw
    ? path.resolve(parsed.cwd, parsed.configPathRaw)
    : path.join(parsed.cwd, ".agentpipe.json");

  return parsed;
}

async function runRepl(): Promise<void> {
  const B = "\x1b[1m";
  const D = "\x1b[2m";
  const R = "\x1b[0m";
  console.log(`\n  ${B}agent-pipe${R} ${D}v${pkg.version || "0.0.0"}${R} — interactive mode`);
  console.log(`  ${D}Type a task (with optional flags) or a command.${R}`);
  console.log(`  ${D}Commands: /help, /quit${R}\n`);

  // Bracketed paste: the terminal wraps pasted text in ESC[200~ ... ESC[201~
  // We enable this so multi-line pastes are collected into one input rather
  // than having readline submit at the first \n and leaking the rest to zsh.
  const PASTE_START = "\x1b[200~";
  const PASTE_END = "\x1b[201~";
  const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
  const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";

  const prompt = (): Promise<string | null> => {
    return new Promise((resolve) => {
      process.stdout.write(ENABLE_BRACKETED_PASTE);

      if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
        // Non-TTY fallback: simple readline
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        let answered = false;
        rl.on("close", () => {
          if (!answered) resolve(null);
        });
        rl.question("> ", (answer: string) => {
          answered = true;
          rl.close();
          resolve(answer);
        });
        return;
      }

      process.stdout.write("> ");
      process.stdin.setRawMode(true);
      process.stdin.resume();

      let buf = "";
      let pasting = false;

      const cleanup = () => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write(DISABLE_BRACKETED_PASTE);
      };

      const submit = (value: string | null) => {
        cleanup();
        if (value !== null) {
          process.stdout.write("\n");
        }
        resolve(value);
      };

      const onData = (data: Buffer) => {
        const str = data.toString("utf8");

        // Check for paste boundaries anywhere in the chunk
        if (str.includes(PASTE_START)) {
          pasting = true;
          // Strip the escape and collect the content
          buf += str.replace(PASTE_START, "").replace(PASTE_END, "");
          if (str.includes(PASTE_END)) {
            pasting = false;
          }
          return;
        }

        if (pasting) {
          if (str.includes(PASTE_END)) {
            buf += str.replace(PASTE_END, "");
            pasting = false;
          } else {
            buf += str;
          }
          return;
        }

        for (const ch of str) {
          const code = ch.charCodeAt(0);

          // Ctrl+D on empty line → EOF
          if (code === 4) {
            submit(null);
            return;
          }

          // Ctrl+C → cancel current line
          if (code === 3) {
            process.stdout.write("^C\n");
            buf = "";
            process.stdout.write("> ");
            continue;
          }

          // Enter → submit
          if (ch === "\r" || ch === "\n") {
            submit(buf);
            return;
          }

          // Backspace / DEL
          if (code === 127 || code === 8) {
            if (buf.length > 0) {
              buf = buf.slice(0, -1);
              process.stdout.write("\b \b");
            }
            continue;
          }

          // Ignore other control chars
          if (code < 32) {
            continue;
          }

          buf += ch;
          process.stdout.write(ch);
        }
      };

      process.stdin.on("data", onData);
    });
  };

  while (true) {
    const input = await prompt();

    if (input === null) {
      // Ctrl+D / EOF
      console.log("\nBye!");
      return;
    }

    const trimmed = input.trim();
    if (trimmed === "") {
      continue;
    }

    if (trimmed === "/quit" || trimmed === "/exit" || trimmed === "/q") {
      console.log("Bye!");
      return;
    }

    if (trimmed === "/help") {
      printHelp();
      continue;
    }

    // Parse the input as run args — supports all flags inline
    const tokens = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const parsed = parseRunArgs(tokens.map((t) => t.replace(/^"|"$/g, "")));
    const task = parsed.taskParts.join(" ").trim();
    if (!task) {
      console.error('No task provided. Example: add JWT refresh token support');
      continue;
    }

    if (parsed.maxHops !== null && (!Number.isInteger(parsed.maxHops) || parsed.maxHops <= 0)) {
      console.error("--max-hops must be a positive integer");
      continue;
    }

    if (parsed.timeoutMs !== null && (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs <= 0)) {
      console.error("--timeout-ms must be a positive integer");
      continue;
    }

    if (parsed.maxRetries !== null && (!Number.isInteger(parsed.maxRetries) || parsed.maxRetries < 0)) {
      console.error("--max-retries must be a non-negative integer");
      continue;
    }

    if (
      parsed.noProgressHops !== null &&
      (!Number.isInteger(parsed.noProgressHops) || parsed.noProgressHops < 0)
    ) {
      console.error("--no-progress-hops must be a non-negative integer");
      continue;
    }

    if (parsed.primaryAgent !== null) {
      const allowed = new Set<AgentName>(["claude", "codex", "gemini"]);
      if (!allowed.has(parsed.primaryAgent)) {
        console.error("--primary-agent must be one of: claude, codex, gemini");
        continue;
      }
    }

    if (
      parsed.uiMode !== null &&
      parsed.uiMode !== "auto" &&
      parsed.uiMode !== "plain" &&
      parsed.uiMode !== "tui"
    ) {
      console.error("--ui must be one of: auto, plain, tui");
      continue;
    }

    try {
      const result = await runOrchestrator({
        task,
        primaryAgent: parsed.primaryAgent,
        discuss: parsed.discuss || null,
        maxHops: parsed.maxHops,
        timeoutMs: parsed.timeoutMs,
        maxInvalidContractRetries: parsed.maxRetries,
        noProgressHops: parsed.noProgressHops,
        uiMode: parsed.uiMode,
        configPath: parsed.configPath,
        cwd: parsed.cwd,
      });

      if (result && result.status) {
        console.log(
          `[agent-pipe] status=${result.status} hops=${result.hops}${
            result.logPath ? ` log=${result.logPath}` : ""
          }`
        );
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
    }

    console.log(""); // blank line between runs
  }
}

export async function main(argv = process.argv): Promise<void> {
  const args = argv.slice(2);
  const command = args[0];

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`coding-agent-git-pipe v${pkg.version || "0.0.0"}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      await runRepl();
      return;
    }
    printHelp();
    process.exit(0);
  }

  if (command !== "run" && command !== "init") {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  if (command === "init") {
    const parsed = parseInitArgs(args.slice(1));

    if (parsed.extraArgs.length > 0) {
      console.error(`init does not accept positional arguments: ${parsed.extraArgs.join(" ")}`);
      process.exit(1);
    }

    const createdPath = writeDefaultConfig({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
      force: parsed.force,
    });

    console.log(`Created ${createdPath}`);
    console.log(
      "Next: set routing.primary, routing.review, and routing.pair to the CLIs you actually use, then run `agent-pipe run \"<task>\"` from that repo."
    );
    process.exit(0);
  }

  const parsed = parseRunArgs(args.slice(1));
  const task = parsed.taskParts.join(" ").trim();
  if (!task) {
    console.error('Missing task string. Example: agent-pipe run "add JWT refresh token support"');
    process.exit(1);
  }

  if (parsed.maxHops !== null && (!Number.isInteger(parsed.maxHops) || parsed.maxHops <= 0)) {
    console.error("--max-hops must be a positive integer");
    process.exit(1);
  }

  if (parsed.timeoutMs !== null && (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs <= 0)) {
    console.error("--timeout-ms must be a positive integer");
    process.exit(1);
  }

  if (parsed.maxRetries !== null && (!Number.isInteger(parsed.maxRetries) || parsed.maxRetries < 0)) {
    console.error("--max-retries must be a non-negative integer");
    process.exit(1);
  }

  if (
    parsed.noProgressHops !== null &&
    (!Number.isInteger(parsed.noProgressHops) || parsed.noProgressHops < 0)
  ) {
    console.error("--no-progress-hops must be a non-negative integer");
    process.exit(1);
  }

  if (parsed.primaryAgent !== null) {
    const allowed = new Set<AgentName>(["claude", "codex", "gemini"]);
    if (!allowed.has(parsed.primaryAgent)) {
      console.error("--primary-agent must be one of: claude, codex, gemini");
      process.exit(1);
    }
  }

  if (
    parsed.uiMode !== null &&
    parsed.uiMode !== "auto" &&
    parsed.uiMode !== "plain" &&
    parsed.uiMode !== "tui"
  ) {
    console.error("--ui must be one of: auto, plain, tui");
    process.exit(1);
  }

  const result = await runOrchestrator({
    task,
    primaryAgent: parsed.primaryAgent,
    discuss: parsed.discuss || null,
    maxHops: parsed.maxHops,
    timeoutMs: parsed.timeoutMs,
    maxInvalidContractRetries: parsed.maxRetries,
    noProgressHops: parsed.noProgressHops,
    uiMode: parsed.uiMode,
    configPath: parsed.configPath,
    cwd: parsed.cwd,
  });

  if (result && result.status) {
    console.log(
      `[agent-pipe] status=${result.status} hops=${result.hops}${
        result.logPath ? ` log=${result.logPath}` : ""
      }`
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal error: ${(error as Error).message}`);
    process.exit(1);
  });
}

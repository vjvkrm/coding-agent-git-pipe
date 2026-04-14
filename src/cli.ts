import path from "path";
import readline from "readline";
import { writeDefaultConfig } from "./config";
import { runOrchestrator } from "./orchestrator";
import { AgentName, TaskMode, UiMode } from "./types";

const pkg = require("../package.json") as { version?: string };

function helpText(): string {
  const B = "\x1b[1m";
  const D = "\x1b[2m";
  const R = "\x1b[0m";

  return [
    "",
    `  ${B}agent-pipe${R} ${D}(cagp)${R} — AI engineering team orchestrator`,
    "",
    `  ${B}Usage${R}`,
    `    agent-pipe init ${D}[options]${R}`,
    `    agent-pipe fast ${D}"<task>" [options]${R}        ${D}implement + review${R}`,
    `    agent-pipe fix ${D}"<bug>" [options]${R}          ${D}diagnose together, then fix + review${R}`,
    `    agent-pipe build ${D}"<feature>" [options]${R}    ${D}brainstorm, then implement + review${R}`,
    `    agent-pipe brainstorm ${D}"<question>" [options]${R}  ${D}brainstorm only${R}`,
    `    agent-pipe run ${D}"<task>" [options]${R}         ${D}alias for fast${R}`,
    "",
    `  ${B}Commands${R}`,
    `    ${B}init${R}                        Create a starter .agentpipe.json`,
    `    ${B}fast${R}  ${D}(run)${R}                 Implement + review ${D}(no brainstorm)${R}`,
    `    ${B}fix${R}                         Diagnose together, then implement + review`,
    `    ${B}build${R}                       Brainstorm, then implement + review`,
    `    ${B}brainstorm${R}                  Brainstorm only ${D}(no implementation)${R}`,
    "",
    `  ${B}Options${R}`,
    `    --primary-agent <name>     Primary agent ${D}(claude|codex|gemini, default: claude)${R}`,
    `    --max-hops <number>        Maximum routing hops`,
    `    --max-turns <number>       Max brainstorm/diagnose turns ${D}(default: 20)${R}`,
    `    --timeout-ms <number>      Per-agent timeout in milliseconds`,
    `    --max-retries <number>     Contract parse retries`,
    `    --no-progress-hops <num>   Ask human if repo stalls for N steps`,
    `    --ui <mode>                UI mode ${D}(auto|plain|tui)${R}`,
    `    --config <path>            Config path ${D}(default: .agentpipe.json)${R}`,
    `    --cwd <path>               Working directory ${D}(default: cwd)${R}`,
    "",
    `  ${B}Init options${R}`,
    `    --config <path>            Config output path`,
    `    --cwd <path>               Target repo directory`,
    `    --force                    Overwrite existing config`,
    `    -h, --help                 Show help`,
    `    -v, --version              Show version`,
    "",
  ].join("\n");
}

function printHelp(): void {
  console.log(helpText());
}

function replBannerText(version: string): string {
  const B = "\x1b[1m";
  const D = "\x1b[2m";
  const R = "\x1b[0m";

  return [
    "",
    `  ${B}agent-pipe${R} ${D}v${version}${R} — interactive mode`,
    `  ${D}Commands: fast, fix, build, brainstorm${R}`,
    `  ${D}Example: fix "auth token not refreshing"${R}`,
    `  ${D}/help, /quit${R}`,
    "",
  ].join("\n");
}

function parseRunArgs(args: string[]): {
  taskParts: string[];
  primaryAgent: AgentName | null;
  discuss: boolean;
  maxHops: number | null;
  maxTurns: number | null;
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
    maxTurns: null as number | null,
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

    if (arg === "--max-turns" && next) {
      parsed.maxTurns = Number(next);
      i += 1;
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

function validateParsedRunArgs(parsed: ReturnType<typeof parseRunArgs>): string | null {
  if (parsed.maxHops !== null && (!Number.isInteger(parsed.maxHops) || parsed.maxHops <= 0)) {
    return "--max-hops must be a positive integer";
  }

  if (parsed.maxTurns !== null && (!Number.isInteger(parsed.maxTurns) || parsed.maxTurns <= 0)) {
    return "--max-turns must be a positive integer";
  }

  if (parsed.timeoutMs !== null && (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs <= 0)) {
    return "--timeout-ms must be a positive integer";
  }

  if (parsed.maxRetries !== null && (!Number.isInteger(parsed.maxRetries) || parsed.maxRetries < 0)) {
    return "--max-retries must be a non-negative integer";
  }

  if (
    parsed.noProgressHops !== null &&
    (!Number.isInteger(parsed.noProgressHops) || parsed.noProgressHops < 0)
  ) {
    return "--no-progress-hops must be a non-negative integer";
  }

  if (parsed.primaryAgent !== null) {
    const allowed = new Set<AgentName>(["claude", "codex", "gemini"]);
    if (!allowed.has(parsed.primaryAgent)) {
      return "--primary-agent must be one of: claude, codex, gemini";
    }
  }

  if (
    parsed.uiMode !== null &&
    parsed.uiMode !== "auto" &&
    parsed.uiMode !== "plain" &&
    parsed.uiMode !== "tui"
  ) {
    return "--ui must be one of: auto, plain, tui";
  }

  return null;
}

function tokenizeReplInput(input: string): string[] {
  return (input.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((token) =>
    token.replace(/^"|"$/g, "")
  );
}

async function runParsedTask(parsed: ReturnType<typeof parseRunArgs>, task: string, taskMode: TaskMode = "fast"): Promise<void> {
  const result = await runOrchestrator({
    task,
    taskMode,
    primaryAgent: parsed.primaryAgent,
    discuss: parsed.discuss || null,
    maxHops: parsed.maxHops,
    maxTurns: parsed.maxTurns,
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

async function promptReplCommand(noticeText: string | null): Promise<string | null> {
  if (noticeText !== null) {
    console.log(noticeText);
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    rl.once("close", () => resolve(null));
    rl.once("SIGINT", () => {
      rl.close();
      resolve(null);
    });

    rl.question("> ", (answer) => {
      rl.removeAllListeners();
      rl.close();
      resolve(answer);
    });
  });
}

async function runRepl(): Promise<void> {
  console.log(replBannerText(pkg.version || "0.0.0"));
  let noticeText: string | null = null;

  while (true) {
    const input = await promptReplCommand(noticeText);

    if (input === null) {
      console.log("Bye!");
      return;
    }

    const trimmed = input.trim();
    if (trimmed === "") {
      noticeText = null;
      continue;
    }

    if (trimmed === "/quit" || trimmed === "/exit" || trimmed === "/q") {
      console.log("Bye!");
      return;
    }

    if (trimmed === "/help") {
      noticeText = helpText();
      continue;
    }

    const tokens = tokenizeReplInput(trimmed);
    const REPL_COMMANDS: Record<string, TaskMode> = {
      run: "fast",
      fast: "fast",
      fix: "fix",
      build: "build",
      brainstorm: "brainstorm",
    };

    let replMode: TaskMode = "fast";
    let argsTokens = tokens;

    if (tokens.length > 0 && REPL_COMMANDS[tokens[0]]) {
      replMode = REPL_COMMANDS[tokens[0]];
      argsTokens = tokens.slice(1);
    }

    const parsed = parseRunArgs(argsTokens);
    const task = parsed.taskParts.join(" ").trim();
    if (!task) {
      noticeText = 'No task provided. Example: fix "auth token not refreshing"';
      continue;
    }

    const validationError = validateParsedRunArgs(parsed);
    if (validationError) {
      noticeText = validationError;
      continue;
    }

    noticeText = null;

    try {
      await runParsedTask(parsed, task, replMode);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
    }

    console.log("");
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

  const TASK_COMMANDS: Record<string, TaskMode> = {
    run: "fast",
    fast: "fast",
    fix: "fix",
    build: "build",
    brainstorm: "brainstorm",
  };

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
      "Next: set routing.primary, routing.review, and routing.pair to the CLIs you actually use, then run `agent-pipe fast \"<task>\"` from that repo."
    );
    process.exit(0);
  }

  const taskMode = TASK_COMMANDS[command!];
  if (!taskMode) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  const parsed = parseRunArgs(args.slice(1));
  const task = parsed.taskParts.join(" ").trim();
  if (!task) {
    console.error(`Missing task string. Example: agent-pipe ${command} "add JWT refresh token support"`);
    process.exit(1);
  }

  const validationError = validateParsedRunArgs(parsed);
  if (validationError) {
    console.error(validationError);
    process.exit(1);
  }

  await runParsedTask(parsed, task, taskMode);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal error: ${(error as Error).message}`);
    process.exit(1);
  });
}

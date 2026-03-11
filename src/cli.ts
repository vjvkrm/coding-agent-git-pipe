import path from "path";
import { writeDefaultConfig } from "./config";
import { runOrchestrator } from "./orchestrator";
import { AgentName } from "./types";

const pkg = require("../package.json") as { version?: string };

function printHelp(): void {
  console.log("agent-pipe (cagp)");
  console.log("");
  console.log('Usage:\n  agent-pipe init [options]\n  agent-pipe run "<task>" [options]');
  console.log("");
  console.log("Commands:");
  console.log("  init                        Create a starter .agentpipe.json in the target repo");
  console.log("  run                         Execute an orchestration task");
  console.log("");
  console.log("Run options:");
  console.log("  --primary-agent <name>     Primary agent (claude|codex|gemini)");
  console.log("  --discuss                  Enable plan & discuss phase before implementation");
  console.log("  --max-hops <number>        Maximum routing hops before pause");
  console.log("  --timeout-ms <number>      Per-agent timeout in milliseconds");
  console.log("  --max-retries <number>     Contract parse retries (default from config)");
  console.log("  --no-progress-hops <num>   Ask human if repo doesn't change for N steps");
  console.log("  --config <path>            Path to config JSON (default: .agentpipe.json)");
  console.log("  --cwd <path>               Working directory (default: current directory)");
  console.log("");
  console.log("Init options:");
  console.log("  --config <path>            Path to write the config JSON (default: .agentpipe.json)");
  console.log("  --cwd <path>               Target repo directory (default: current directory)");
  console.log("  --force                    Overwrite an existing config file");
  console.log("  -h, --help                 Show help");
  console.log("  -v, --version              Show version");
}

function parseRunArgs(args: string[]): {
  taskParts: string[];
  primaryAgent: AgentName | null;
  discuss: boolean;
  maxHops: number | null;
  timeoutMs: number | null;
  maxRetries: number | null;
  noProgressHops: number | null;
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

export async function main(argv = process.argv): Promise<void> {
  const args = argv.slice(2);
  const command = args[0];

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`coding-agent-git-pipe v${pkg.version || "0.0.0"}`);
    process.exit(0);
  }

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
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

  const result = await runOrchestrator({
    task,
    primaryAgent: parsed.primaryAgent,
    discuss: parsed.discuss || null,
    maxHops: parsed.maxHops,
    timeoutMs: parsed.timeoutMs,
    maxInvalidContractRetries: parsed.maxRetries,
    noProgressHops: parsed.noProgressHops,
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

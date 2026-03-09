import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path, { basename } from "node:path";
import { AdapterInvocation, Config, InvokeAgentOptions } from "../types";
import {
  extractSessionRefFromJsonLines,
  resolveAdapterCommand,
  runAdapter,
  runAdapterCommand,
  spawnAdapterProcess,
} from "./base";

const CODEX_STREAM_ARGS = ["--json"];
const CODEX_STATE_DB_PATTERN = /^state_(\d+)\.sqlite$/;
const CODEX_SESSION_LOOKUP_MARGIN_SECONDS = 5;

function parseCodexJsonLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (trimmed === "") {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    return null;
  }
}

function getCodexAgentMessage(event: unknown): string {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return "";
  }

  const value = event as {
    msg?: {
      type?: unknown;
      message?: unknown;
    };
  };

  return value.msg?.type === "agent_message" && typeof value.msg.message === "string"
    ? value.msg.message
    : "";
}

export function normalizeCodexJsonOutput(output: string): string {
  let lastAgentMessage = "";

  for (const line of output.split(/\r?\n/)) {
    const message = getCodexAgentMessage(parseCodexJsonLine(line));
    if (message !== "") {
      lastAgentMessage = message;
    }
  }

  return lastAgentMessage || output.trim();
}

function isCodexCliCommand(commandParts: string[]): boolean {
  return commandParts.length > 0 && basename(commandParts[0]).toLowerCase() === "codex";
}

function resolveCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function resolveCodexStateDbPath(codexHome = resolveCodexHome()): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(codexHome);
  } catch (_error) {
    return null;
  }

  const candidates = entries
    .map((name) => {
      const match = CODEX_STATE_DB_PATTERN.exec(name);
      if (!match) {
        return null;
      }

      return {
        path: path.join(codexHome, name),
        version: Number(match[1]),
      };
    })
    .filter((value): value is { path: string; version: number } => value !== null)
    .sort((a, b) => b.version - a.version);

  return candidates[0]?.path || null;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type SqliteQueryFn = (dbPath: string, query: string) => string;

function defaultSqliteQuery(dbPath: string, query: string): string {
  return execFileSync("sqlite3", [dbPath, query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function findCodexSessionRefFromLocalState(params: {
  cwd: string;
  startedAtMs: number;
  endedAtMs: number;
  sqliteQueryFn?: SqliteQueryFn;
  stateDbPath?: string | null;
}): string | null {
  const stateDbPath =
    params.stateDbPath !== undefined ? params.stateDbPath : resolveCodexStateDbPath();
  if (!stateDbPath) {
    return null;
  }

  const lowerBound = Math.max(
    0,
    Math.floor(params.startedAtMs / 1000) - CODEX_SESSION_LOOKUP_MARGIN_SECONDS
  );
  const upperBound =
    Math.ceil(params.endedAtMs / 1000) + CODEX_SESSION_LOOKUP_MARGIN_SECONDS;
  const query = [
    "SELECT id",
    "FROM threads",
    `WHERE cwd = ${sqlStringLiteral(params.cwd)}`,
    `AND updated_at >= ${lowerBound}`,
    `AND updated_at <= ${upperBound}`,
    "ORDER BY updated_at DESC",
    "LIMIT 1;",
  ].join(" ");

  try {
    const result = (params.sqliteQueryFn || defaultSqliteQuery)(stateDbPath, query).trim();
    return result !== "" ? result : null;
  } catch (_error) {
    return null;
  }
}

export function resolveCodexStreamingCommand(config: Config): string[] | null {
  const commandParts = resolveAdapterCommand("codex", config);
  if (!isCodexCliCommand(commandParts)) {
    return null;
  }

  return commandParts.includes("--json") ? commandParts : [...commandParts, ...CODEX_STREAM_ARGS];
}

export function resolveCodexResumeCommand(config: Config, sessionRef: string): string[] | null {
  const commandParts = resolveAdapterCommand("codex", config);
  if (!isCodexCliCommand(commandParts) || commandParts[1] !== "exec") {
    return null;
  }

  const resumeCommand = [commandParts[0], "exec", "resume", sessionRef, ...commandParts.slice(2)];
  return resumeCommand.includes("--json") ? resumeCommand : [...resumeCommand, ...CODEX_STREAM_ARGS];
}

function runCodexStreamingCommand(
  commandParts: string[],
  prompt: string,
  options: InvokeAgentOptions,
  existingSessionRef: string | null = null
): Promise<AdapterInvocation> {
  const command = commandParts[0];
  const args = [...commandParts.slice(1), prompt];
  const startedAt = Date.now();
  const child = spawnAdapterProcess(command, args, options.cwd);

  let rawStdout = "";
  let stderr = "";
  let timedOut = false;
  let closed = false;
  let stdoutBuffer = "";
  let lastRenderedMessage = "";
  let emittedStdout = false;

  const SIGKILL_GRACE_MS = 5000;
  let killTimerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimerId = setTimeout(() => {
      if (!closed) {
        child.kill("SIGKILL");
      }
    }, SIGKILL_GRACE_MS);
  }, options.timeoutMs);

  child.stdout!.on("data", (chunk) => {
    const text = chunk.toString();
    rawStdout += text;
    stdoutBuffer += text;

    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const message = getCodexAgentMessage(parseCodexJsonLine(line));
      if (message === "" || message === lastRenderedMessage) {
        continue;
      }

      if (message.startsWith(lastRenderedMessage)) {
        const delta = message.slice(lastRenderedMessage.length);
        if (delta !== "") {
          options.onOutput(emittedStdout ? `\n${delta}` : delta, "stdout");
          emittedStdout = true;
        }
      } else {
        options.onOutput(emittedStdout ? `\n${message}` : message, "stdout");
        emittedStdout = true;
      }

      lastRenderedMessage = message;
    }
  });

  child.stderr!.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    options.onOutput(text, "stderr");
  });

  return new Promise<AdapterInvocation>((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(timeoutId);
      if (killTimerId) clearTimeout(killTimerId);
      reject(new Error(`Failed to start codex: ${(error as Error).message}`));
    });

    child.on("close", (code) => {
      closed = true;
      clearTimeout(timeoutId);
      if (killTimerId) clearTimeout(killTimerId);

      if (timedOut) {
        reject(new Error(`codex timed out after ${options.timeoutMs}ms`));
        return;
      }

      const stdout = normalizeCodexJsonOutput(rawStdout);
      if (emittedStdout && stdout !== "" && !lastRenderedMessage.endsWith("\n")) {
        options.onOutput("\n", "stdout");
      }

      if (code !== 0) {
        reject(
          new Error(
            `codex exited with code ${code}\n` +
              `command: ${commandParts.join(" ")}\n` +
              `${stderr || stdout || rawStdout || "(no output)"}`
          )
        );
        return;
      }

      const endedAt = Date.now();
      const sessionRef =
        extractSessionRefFromJsonLines(rawStdout) ||
        existingSessionRef ||
        (commandParts.includes("--ephemeral")
          ? null
          : findCodexSessionRefFromLocalState({
              cwd: options.cwd,
              startedAtMs: startedAt,
              endedAtMs: endedAt,
            }));

      resolve({
        agent: "codex",
        command: commandParts,
        args,
        timeoutMs: options.timeoutMs,
        stdout,
        stderr,
        combined: `${stdout}${stderr}`,
        durationMs: endedAt - startedAt,
        sessionRef,
      });
    });
  });
}

export function invokeCodex(
  prompt: string,
  options: InvokeAgentOptions
): Promise<AdapterInvocation> {
  if (options.sessionRef) {
    const resumeCommand = resolveCodexResumeCommand(options.config, options.sessionRef);
    if (resumeCommand === null) {
      return runAdapter("codex", prompt, options);
    }

    return runCodexStreamingCommand(resumeCommand, prompt, options, options.sessionRef);
  }

  const commandParts = resolveCodexStreamingCommand(options.config);
  if (commandParts === null) {
    return runAdapter("codex", prompt, options);
  }
  return runCodexStreamingCommand(commandParts, prompt, options);
}

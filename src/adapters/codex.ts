import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path, { basename } from "node:path";
import { AdapterInvocation, Config, InvokeAgentOptions } from "../types";
import {
  extractSessionRefFromJsonLines,
  resolveAdapterCommand,
  runAdapter,
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

function asCodexRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function normalizeCodexType(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    return "";
  }

  return value
    .replace(/\//g, ".")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function getCodexString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstNonEmptyString(...values: string[]): string {
  for (const value of values) {
    if (value !== "") {
      return value;
    }
  }

  return "";
}

function extractCodexContentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }

      const record = asCodexRecord(entry);
      if (!record) {
        return "";
      }

      return firstNonEmptyString(
        getCodexString(record.text),
        getCodexString(record.content),
        extractCodexContentText(record.content),
        extractCodexContentText(record.parts)
      );
    })
    .join("");
}

function getCodexItemId(value: unknown): string {
  const record = asCodexRecord(value);
  if (!record) {
    return "";
  }

  return firstNonEmptyString(
    getCodexString(record.id),
    getCodexString(record.item_id),
    getCodexString(record.itemId)
  );
}

function getCodexItemType(value: unknown): string {
  const record = asCodexRecord(value);
  return record ? normalizeCodexType(record.type) : "";
}

function getCodexItemText(value: unknown): string {
  const record = asCodexRecord(value);
  if (!record) {
    return "";
  }

  return firstNonEmptyString(
    getCodexString(record.text),
    getCodexString(record.message),
    getCodexString(record.content),
    extractCodexContentText(record.content),
    extractCodexContentText(record.parts)
  );
}

function getCodexEventText(value: unknown): string {
  const record = asCodexRecord(value);
  if (!record) {
    return typeof value === "string" ? value : "";
  }

  return firstNonEmptyString(
    getCodexString(record.delta),
    getCodexString(record.text),
    getCodexString(record.message),
    getCodexString(record.content),
    extractCodexContentText(record.content),
    getCodexEventText(record.delta),
    getCodexItemText(record.item),
    getCodexEventText(record.payload)
  );
}

function getCodexAgentMessage(event: unknown): string {
  const record = asCodexRecord(event);
  if (!record) {
    return "";
  }

  const legacyMessage = getCodexString(asCodexRecord(record.msg)?.message);
  if (normalizeCodexType(asCodexRecord(record.msg)?.type) === "agent_message" && legacyMessage !== "") {
    return legacyMessage;
  }

  const eventType = normalizeCodexType(record.type);
  const item = asCodexRecord(record.item);
  const itemType = getCodexItemType(item);
  const itemRole = normalizeCodexType(item?.role);

  if (
    (eventType === "item.updated" || eventType === "item.completed") &&
    (itemType === "agent_message" ||
      itemType === "assistant_message" ||
      (itemType === "message" && (itemRole === "" || itemRole === "assistant")))
  ) {
    return getCodexItemText(item);
  }

  if (eventType === "agent_message" || eventType === "assistant_message") {
    return getCodexEventText(record);
  }

  return "";
}

function getCodexAgentMessageDelta(event: unknown): string {
  const record = asCodexRecord(event);
  if (!record) {
    return "";
  }

  const eventType = normalizeCodexType(record.type);
  if (eventType === "item.agent_message.delta" || eventType === "agent_message_delta") {
    return getCodexEventText(record);
  }

  return "";
}

function getCodexReasoningText(event: unknown): {
  id: string;
  text: string;
  delta: boolean;
  completed: boolean;
} | null {
  const record = asCodexRecord(event);
  if (!record) {
    return null;
  }

  const eventType = normalizeCodexType(record.type);
  if (
    eventType === "item.reasoning.text_delta" ||
    eventType === "item.reasoning.summary_text_delta" ||
    eventType === "item.reasoning.summary_part_added" ||
    eventType === "reasoning_text_delta" ||
    eventType === "reasoning_summary_text_delta"
  ) {
    const text = getCodexEventText(record);
    if (text === "") {
      return null;
    }

    return {
      id: firstNonEmptyString(
        getCodexItemId(record),
        getCodexItemId(record.item),
        getCodexString(record.reasoning_id),
        getCodexString(record.reasoningId),
        "__reasoning__"
      ),
      text,
      delta: true,
      completed: false,
    };
  }

  const item = asCodexRecord(record.item);
  if (
    (eventType === "item.updated" || eventType === "item.completed") &&
    getCodexItemType(item) === "reasoning"
  ) {
    const text = getCodexItemText(item);
    if (text === "") {
      return null;
    }

    return {
      id: firstNonEmptyString(getCodexItemId(item), "__reasoning__"),
      text,
      delta: false,
      completed: eventType === "item.completed",
    };
  }

  return null;
}

function getCodexErrorText(event: unknown): string {
  const record = asCodexRecord(event);
  if (!record) {
    return "";
  }

  const eventType = normalizeCodexType(record.type);
  if (eventType === "error") {
    return firstNonEmptyString(getCodexString(record.message), getCodexEventText(record));
  }

  const item = asCodexRecord(record.item);
  if (eventType === "item.completed" && getCodexItemType(item) === "error") {
    return firstNonEmptyString(getCodexItemText(item), getCodexString(item?.message));
  }

  return "";
}

function getCodexCommandEvent(event: unknown): {
  id: string;
  command: string;
  output: string;
  started: boolean;
  completed: boolean;
} | null {
  const record = asCodexRecord(event);
  if (!record) {
    return null;
  }

  const eventType = normalizeCodexType(record.type);
  const item = asCodexRecord(record.item);
  if (!item || getCodexItemType(item) !== "command_execution") {
    return null;
  }

  return {
    id: firstNonEmptyString(getCodexItemId(item), "__command__"),
    command: getCodexString(item.command),
    output: firstNonEmptyString(
      getCodexString(item.aggregated_output),
      getCodexString(item.aggregatedOutput)
    ),
    started: eventType === "item.started",
    completed: eventType === "item.completed",
  };
}

function summarizeCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length <= 80) return trimmed;
  return trimmed.slice(0, 77) + "...";
}

export function normalizeCodexJsonOutput(output: string): string {
  let lastAgentMessage = "";
  let messageDelta = "";

  for (const line of output.split(/\r?\n/)) {
    const parsed = parseCodexJsonLine(line);
    const message = getCodexAgentMessage(parsed);
    if (message !== "") {
      lastAgentMessage = message;
      continue;
    }

    const delta = getCodexAgentMessageDelta(parsed);
    if (delta !== "") {
      messageDelta += delta;
    }
  }

  return lastAgentMessage || messageDelta || output.trim();
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
  let stdoutEndsWithNewline = true;
  let activeTextMode: "message" | "thinking" | null = null;
  const renderedReasoningText = new Map<string, string>();
  const renderedCommandIds = new Set<string>();
  const renderedCommandOutput = new Map<string, string>();

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

    const emitStdout = (value: string): void => {
      if (value === "") {
        return;
      }

      options.onOutput(value, "stdout");
      emittedStdout = true;
      stdoutEndsWithNewline = value.endsWith("\n");
    };

    const ensureOutputBreak = (): void => {
      if (emittedStdout && !stdoutEndsWithNewline) {
        emitStdout("\n");
      }
    };

    const emitStructuredLine = (value: string): void => {
      if (value === "") {
        return;
      }

      ensureOutputBreak();
      emitStdout(`${value}\n`);
      activeTextMode = null;
    };

    for (const line of lines) {
      const parsed = parseCodexJsonLine(line);
      const commandEvent = getCodexCommandEvent(parsed);
      if (commandEvent) {
        if (commandEvent.command !== "" && !renderedCommandIds.has(commandEvent.id)) {
          emitStructuredLine(`(tool) ${summarizeCommand(commandEvent.command)}`);
          renderedCommandIds.add(commandEvent.id);
        }

        // Track output silently (don't stream verbatim — too noisy)
        if (commandEvent.output !== "") {
          renderedCommandOutput.set(commandEvent.id, commandEvent.output);
        }

        if (commandEvent.completed) {
          activeTextMode = null;
        }
      }

      const reasoning = getCodexReasoningText(parsed);
      if (reasoning) {
        if (reasoning.delta) {
          if (activeTextMode !== "thinking") {
            ensureOutputBreak();
            emitStdout("(thinking) ");
            activeTextMode = "thinking";
          }
          emitStdout(reasoning.text);
          const previous = renderedReasoningText.get(reasoning.id) || "";
          renderedReasoningText.set(reasoning.id, `${previous}${reasoning.text}`);
        } else {
          const previous = renderedReasoningText.get(reasoning.id) || "";
          if (reasoning.text !== previous) {
            if (reasoning.text.startsWith(previous)) {
              if (activeTextMode !== "thinking") {
                ensureOutputBreak();
                emitStdout("(thinking) ");
                activeTextMode = "thinking";
              }
              const nextDelta = reasoning.text.slice(previous.length);
              if (nextDelta !== "") {
                emitStdout(nextDelta);
              }
            } else {
              ensureOutputBreak();
              emitStdout(`(thinking) ${reasoning.text}`);
              activeTextMode = "thinking";
            }

            renderedReasoningText.set(reasoning.id, reasoning.text);
          }
        }

        if (reasoning.completed && activeTextMode === "thinking") {
          ensureOutputBreak();
          activeTextMode = null;
        }
      }

      const errorText = getCodexErrorText(parsed);
      if (errorText !== "") {
        emitStructuredLine(`(error) ${errorText}`);
      }

      const delta = getCodexAgentMessageDelta(parsed);
      if (delta !== "") {
        if (activeTextMode === "thinking") {
          ensureOutputBreak();
        }
        emitStdout(delta);
        activeTextMode = "message";
      }

      const message = getCodexAgentMessage(parsed);
      if (message === "" || message === lastRenderedMessage) {
        continue;
      }

      if (activeTextMode === "thinking") {
        ensureOutputBreak();
      }

      if (message.startsWith(lastRenderedMessage)) {
        const nextDelta = message.slice(lastRenderedMessage.length);
        if (nextDelta !== "") {
          emitStdout(nextDelta);
        }
      } else {
        ensureOutputBreak();
        emitStdout(message);
      }

      activeTextMode = "message";
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
      if (emittedStdout && stdout !== "" && !stdoutEndsWithNewline) {
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
        combined: `${rawStdout}${stderr}`,
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

import { basename } from "node:path";
import { spawn } from "child_process";
import { AdapterInvocation, Config } from "../types";
import { resolveAdapterCommand, runAdapter } from "./base";

const CODEX_STREAM_ARGS = ["--json"];

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

export function resolveCodexStreamingCommand(config: Config): string[] | null {
  const configured = config.adapters?.codex;
  if (Array.isArray(configured) && configured.length > 0) {
    if (!isCodexCliCommand(configured)) {
      return null;
    }

    return configured.includes("--json") ? configured : [...configured, ...CODEX_STREAM_ARGS];
  }

  return [...resolveAdapterCommand("codex", config), ...CODEX_STREAM_ARGS];
}

export function invokeCodex(
  prompt: string,
  options: {
    cwd: string;
    config: Config;
    timeoutMs: number;
    onOutput: (chunk: string, stream: "stdout" | "stderr") => void;
  }
): Promise<AdapterInvocation> {
  const commandParts = resolveCodexStreamingCommand(options.config);
  if (commandParts === null) {
    return runAdapter("codex", prompt, options);
  }
  const command = commandParts[0];
  const args = [...commandParts.slice(1), prompt];
  const startedAt = Date.now();
  const child = spawn(command, args, { cwd: options.cwd, env: process.env });

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

  child.stdout.on("data", (chunk) => {
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

  child.stderr.on("data", (chunk) => {
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

      resolve({
        agent: "codex",
        command: commandParts,
        args,
        timeoutMs: options.timeoutMs,
        stdout,
        stderr,
        combined: `${stdout}${stderr}`,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

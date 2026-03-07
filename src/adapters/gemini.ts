import { basename } from "node:path";
import { spawn } from "child_process";
import { AdapterInvocation, Config } from "../types";
import { resolveAdapterCommand, runAdapter } from "./base";

const GEMINI_STREAM_ARGS = ["-o", "stream-json"];

function parseGeminiJsonLine(line: string): unknown | null {
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

function getGeminiAssistantEvent(event: unknown): { content: string; delta: boolean } | null {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }

  const value = event as {
    type?: unknown;
    role?: unknown;
    content?: unknown;
    delta?: unknown;
  };

  if (value.type !== "message" || value.role !== "assistant" || typeof value.content !== "string") {
    return null;
  }

  return {
    content: value.content,
    delta: value.delta === true,
  };
}

export function normalizeGeminiStreamOutput(output: string): string {
  let accumulatedDelta = "";
  let lastFullMessage = "";

  for (const line of output.split(/\r?\n/)) {
    const event = getGeminiAssistantEvent(parseGeminiJsonLine(line));
    if (!event) {
      continue;
    }

    if (event.delta) {
      accumulatedDelta += event.content;
    } else {
      lastFullMessage = event.content;
    }
  }

  return lastFullMessage || accumulatedDelta || output.trim();
}

function isGeminiCliCommand(commandParts: string[]): boolean {
  return commandParts.length > 0 && basename(commandParts[0]).toLowerCase() === "gemini";
}

function hasGeminiStreamOutput(commandParts: string[]): boolean {
  for (let index = 0; index < commandParts.length; index += 1) {
    const current = commandParts[index];
    const next = commandParts[index + 1];

    if ((current === "-o" || current === "--output-format") && next === "stream-json") {
      return true;
    }

    if (current === "-o" && typeof next === "string") {
      return next === "stream-json";
    }

    if (current.startsWith("--output-format=")) {
      return current.slice("--output-format=".length) === "stream-json";
    }
  }

  return false;
}

function hasExplicitGeminiOutputMode(commandParts: string[]): boolean {
  for (let index = 0; index < commandParts.length; index += 1) {
    const current = commandParts[index];
    if (current === "-o" || current === "--output-format" || current.startsWith("--output-format=")) {
      return true;
    }
  }

  return false;
}

export function resolveGeminiStreamingCommand(config: Config): string[] | null {
  const configured = config.adapters?.gemini;
  if (Array.isArray(configured) && configured.length > 0) {
    if (!isGeminiCliCommand(configured)) {
      return null;
    }

    if (hasGeminiStreamOutput(configured)) {
      return configured;
    }

    if (hasExplicitGeminiOutputMode(configured)) {
      return null;
    }

    return [...configured, ...GEMINI_STREAM_ARGS];
  }

  return [...resolveAdapterCommand("gemini", config), ...GEMINI_STREAM_ARGS];
}

export function invokeGemini(
  prompt: string,
  options: {
    cwd: string;
    config: Config;
    timeoutMs: number;
    onOutput: (chunk: string, stream: "stdout" | "stderr") => void;
  }
): Promise<AdapterInvocation> {
  const commandParts = resolveGeminiStreamingCommand(options.config);
  if (commandParts === null) {
    return runAdapter("gemini", prompt, options);
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
  let emittedStdout = false;
  let accumulatedDelta = "";
  let lastFullMessage = "";

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
      const parsedLine = parseGeminiJsonLine(line);
      const event = getGeminiAssistantEvent(parsedLine);
      if (event) {
        if (event.delta) {
          if (event.content !== "") {
            options.onOutput(event.content, "stdout");
            emittedStdout = true;
            accumulatedDelta += event.content;
          }
        } else if (event.content !== "" && event.content !== lastFullMessage) {
          if (event.content.startsWith(lastFullMessage)) {
            const delta = event.content.slice(lastFullMessage.length);
            if (delta !== "") {
              options.onOutput(delta, "stdout");
              emittedStdout = true;
            }
          } else {
            options.onOutput(emittedStdout ? `\n${event.content}` : event.content, "stdout");
            emittedStdout = true;
          }
          lastFullMessage = event.content;
        }
        continue;
      }

      if (parsedLine !== null) {
        continue;
      }

      if (line.trim() !== "") {
        options.onOutput(`${line}\n`, "stdout");
        emittedStdout = true;
      }
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
      reject(new Error(`Failed to start gemini: ${(error as Error).message}`));
    });

    child.on("close", (code) => {
      closed = true;
      clearTimeout(timeoutId);
      if (killTimerId) clearTimeout(killTimerId);

      if (timedOut) {
        reject(new Error(`gemini timed out after ${options.timeoutMs}ms`));
        return;
      }

      const stdout = normalizeGeminiStreamOutput(rawStdout);
      if (emittedStdout && stdout !== "" && !stdout.endsWith("\n")) {
        options.onOutput("\n", "stdout");
      }

      if (code !== 0) {
        reject(
          new Error(
            `gemini exited with code ${code}\n` +
              `command: ${commandParts.join(" ")}\n` +
              `${stderr || stdout || rawStdout || "(no output)"}`
          )
        );
        return;
      }

      resolve({
        agent: "gemini",
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

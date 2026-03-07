import { spawn } from "child_process";
import { AdapterInvocation, Config } from "../types";
import { resolveAdapterCommand, runAdapter } from "./base";

const CLAUDE_STREAM_ARGS = [
  "--verbose",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
];

function extractTextContent(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return "";
      }

      const content = item as { type?: unknown; text?: unknown };
      return content.type === "text" && typeof content.text === "string" ? content.text : "";
    })
    .join("");
}

function parseClaudeJsonLine(line: string): unknown | null {
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

export function normalizeClaudeStreamOutput(output: string): string {
  let lastAssistantText = "";
  let resultText = "";

  for (const line of output.split(/\r?\n/)) {
    const parsed = parseClaudeJsonLine(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }

    const event = parsed as {
      type?: unknown;
      message?: { content?: unknown };
      result?: unknown;
    };

    if (event.type === "assistant") {
      const text = extractTextContent(event.message?.content);
      if (text.length >= lastAssistantText.length) {
        lastAssistantText = text;
      }
      continue;
    }

    if (event.type === "result" && typeof event.result === "string" && event.result.trim() !== "") {
      resultText = event.result;
    }
  }

  return resultText || lastAssistantText;
}

export function invokeClaude(
  prompt: string,
  options: {
    cwd: string;
    config: Config;
    timeoutMs: number;
    onOutput: (chunk: string, stream: "stdout" | "stderr") => void;
  }
): Promise<AdapterInvocation> {
  const configured = options.config.adapters?.claude;
  if (Array.isArray(configured) && configured.length > 0) {
    return runAdapter("claude", prompt, options);
  }

  const commandParts = [...resolveAdapterCommand("claude", options.config), ...CLAUDE_STREAM_ARGS];
  const command = commandParts[0];
  const args = [...commandParts.slice(1), prompt];
  const startedAt = Date.now();
  const child = spawn(command, args, { cwd: options.cwd, env: process.env });

  let rawStdout = "";
  let stderr = "";
  let timedOut = false;
  let closed = false;
  let stdoutBuffer = "";
  let lastRenderedAssistantText = "";
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
      const parsed = parseClaudeJsonLine(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }

      const event = parsed as {
        type?: unknown;
        message?: { content?: unknown };
      };

      if (event.type !== "assistant") {
        continue;
      }

      const assistantText = extractTextContent(event.message?.content);
      if (assistantText === "" || assistantText === lastRenderedAssistantText) {
        continue;
      }

      if (assistantText.startsWith(lastRenderedAssistantText)) {
        const delta = assistantText.slice(lastRenderedAssistantText.length);
        if (delta !== "") {
          options.onOutput(delta, "stdout");
          emittedStdout = true;
        }
      } else if (assistantText.length > lastRenderedAssistantText.length) {
        options.onOutput(assistantText, "stdout");
        emittedStdout = true;
      }

      lastRenderedAssistantText = assistantText;
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
      reject(new Error(`Failed to start claude: ${(error as Error).message}`));
    });

    child.on("close", (code) => {
      closed = true;
      clearTimeout(timeoutId);
      if (killTimerId) clearTimeout(killTimerId);

      if (timedOut) {
        reject(new Error(`claude timed out after ${options.timeoutMs}ms`));
        return;
      }

      const stdout = normalizeClaudeStreamOutput(rawStdout);
      if (emittedStdout && stdout !== "" && !lastRenderedAssistantText.endsWith("\n")) {
        options.onOutput("\n", "stdout");
      }

      if (code !== 0) {
        reject(
          new Error(
            `claude exited with code ${code}\n` +
              `command: ${commandParts.join(" ")}\n` +
              `${stderr || stdout || rawStdout || "(no output)"}`
          )
        );
        return;
      }

      resolve({
        agent: "claude",
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

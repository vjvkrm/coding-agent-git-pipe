import { AdapterInvocation, Config } from "../types";
import { resolveAdapterCommand, runAdapter, spawnAdapterProcess } from "./base";

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

function clipText(value: string, max = 160): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

export function formatClaudeToolUse(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  const toolUse = value as {
    type?: unknown;
    name?: unknown;
    input?: unknown;
  };

  if (toolUse.type !== "tool_use" || typeof toolUse.name !== "string") {
    return "";
  }

  const rawInput =
    toolUse.input !== undefined && toolUse.input !== null ? JSON.stringify(toolUse.input) : "";
  const inputSummary =
    rawInput !== "" && rawInput !== "{}" ? ` ${clipText(rawInput.replace(/\s+/g, " "))}` : "";

  return `(tool) ${toolUse.name}${inputSummary}`;
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
  const child = spawnAdapterProcess(command, args, options.cwd);

  let rawStdout = "";
  let stderr = "";
  let timedOut = false;
  let closed = false;
  let stdoutBuffer = "";
  let lastRenderedAssistantText = "";
  let emittedStdout = false;
  let stdoutEndsWithNewline = true;
  let sawTextDelta = false;
  const openThinkingBlocks = new Set<number>();
  const renderedThinkingBlocks = new Set<number>();
  const renderedToolUseIds = new Set<string>();

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

  const emitStdout = (chunk: string): void => {
    if (chunk === "") {
      return;
    }

    options.onOutput(chunk, "stdout");
    emittedStdout = true;
    stdoutEndsWithNewline = chunk.endsWith("\n");
  };

  const emitStructuredLine = (line: string): void => {
    if (line === "") {
      return;
    }

    if (emittedStdout && !stdoutEndsWithNewline) {
      emitStdout("\n");
    }
    emitStdout(`${line}\n`);
  };

  child.stdout!.on("data", (chunk) => {
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
        event?: {
          type?: unknown;
          index?: unknown;
          content_block?: { type?: unknown };
          delta?: {
            type?: unknown;
            text?: unknown;
            thinking?: unknown;
          };
        };
        message?: { content?: unknown };
      };

      if (event.type === "stream_event" && event.event && typeof event.event === "object") {
        const streamEvent = event.event;

        if (streamEvent.type === "content_block_start" && typeof streamEvent.index === "number") {
          if (streamEvent.content_block?.type === "thinking") {
            openThinkingBlocks.add(streamEvent.index);
          }
          continue;
        }

        if (streamEvent.type === "content_block_delta") {
          if (streamEvent.delta?.type === "thinking_delta" && typeof streamEvent.delta.thinking === "string") {
            const blockIndex = typeof streamEvent.index === "number" ? streamEvent.index : -1;
            if (!renderedThinkingBlocks.has(blockIndex)) {
              if (emittedStdout && !stdoutEndsWithNewline) {
                emitStdout("\n");
              }
              emitStdout("(thinking) ");
              renderedThinkingBlocks.add(blockIndex);
              openThinkingBlocks.add(blockIndex);
            }

            emitStdout(streamEvent.delta.thinking);
            continue;
          }

          if (streamEvent.delta?.type === "text_delta" && typeof streamEvent.delta.text === "string") {
            sawTextDelta = true;
            lastRenderedAssistantText += streamEvent.delta.text;
            emitStdout(streamEvent.delta.text);
            continue;
          }
        }

        if (streamEvent.type === "content_block_stop" && typeof streamEvent.index === "number") {
          if (openThinkingBlocks.has(streamEvent.index)) {
            openThinkingBlocks.delete(streamEvent.index);
            renderedThinkingBlocks.delete(streamEvent.index);
            if (emittedStdout && !stdoutEndsWithNewline) {
              emitStdout("\n");
            }
          }
          continue;
        }
      }

      if (event.type !== "assistant") {
        continue;
      }

      if (Array.isArray(event.message?.content)) {
        for (const item of event.message.content) {
          if (item === null || typeof item !== "object" || Array.isArray(item)) {
            continue;
          }

          const toolUse = item as { type?: unknown; id?: unknown };
          if (toolUse.type !== "tool_use" || typeof toolUse.id !== "string") {
            continue;
          }

          if (!renderedToolUseIds.has(toolUse.id)) {
            emitStructuredLine(formatClaudeToolUse(toolUse));
            renderedToolUseIds.add(toolUse.id);
          }
        }
      }

      const assistantText = extractTextContent(event.message?.content);
      if (sawTextDelta || assistantText === "" || assistantText === lastRenderedAssistantText) {
        continue;
      }

      if (assistantText.startsWith(lastRenderedAssistantText)) {
        const delta = assistantText.slice(lastRenderedAssistantText.length);
        if (delta !== "") {
          emitStdout(delta);
        }
      } else if (assistantText.length > lastRenderedAssistantText.length) {
        emitStdout(assistantText);
      }

      lastRenderedAssistantText = assistantText;
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
      if (emittedStdout && stdout !== "" && !stdoutEndsWithNewline) {
        emitStdout("\n");
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

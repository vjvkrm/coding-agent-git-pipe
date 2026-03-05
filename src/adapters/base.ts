import { spawn } from "child_process";
import { AdapterInvocation, AgentName, Config } from "../types";

export const PRINT_ADAPTER_COMMANDS: Record<AgentName, string[]> = {
  claude: ["claude", "-p"],
  codex: ["codex", "exec", "--skip-git-repo-check", "-c", 'model_reasoning_effort="medium"'],
  gemini: ["gemini"],
};

export const AUTO_ADAPTER_COMMANDS: Record<AgentName, string[]> = {
  claude: ["claude", "--dangerously-skip-permissions"],
  codex: ["codex", "exec", "--skip-git-repo-check", "-c", 'model_reasoning_effort="medium"'],
  gemini: ["gemini"],
};

function resolveCommand(agentName: AgentName, config: Config): string[] {
  const configured = config.adapters?.[agentName];
  if (Array.isArray(configured) && configured.length > 0) {
    return configured;
  }

  const mode = config.adapter_modes?.[agentName] || "auto";
  return mode === "print" ? PRINT_ADAPTER_COMMANDS[agentName] : AUTO_ADAPTER_COMMANDS[agentName];
}

export function runAdapter(
  agentName: AgentName,
  prompt: string,
  options: {
    cwd?: string;
    config: Config;
    timeoutMs: number;
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  }
): Promise<AdapterInvocation> {
  const cwd = options.cwd || process.cwd();
  const config = options.config;
  const timeoutMs = options.timeoutMs;
  const onOutput = typeof options.onOutput === "function" ? options.onOutput : () => {};

  const commandParts = resolveCommand(agentName, config);
  if (!Array.isArray(commandParts) || commandParts.length === 0) {
    throw new Error(`No adapter command configured for agent=${agentName}`);
  }

  const command = commandParts[0];
  const args = [...commandParts.slice(1), prompt];
  const startedAt = Date.now();
  const child = spawn(command, args, { cwd, env: process.env });

  let stdout = "";
  let stderr = "";
  let combined = "";
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    combined += text;
    onOutput(text, "stdout");
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    combined += text;
    onOutput(text, "stderr");
  });

  return new Promise<AdapterInvocation>((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to start ${agentName}: ${(error as Error).message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      if (timedOut) {
        reject(new Error(`${agentName} timed out after ${timeoutMs}ms`));
        return;
      }

      if (code !== 0) {
        reject(
          new Error(
            `${agentName} exited with code ${code}\n` +
              `command: ${commandParts.join(" ")}\n` +
              `${stderr || stdout || "(no output)"}`
          )
        );
        return;
      }

      resolve({
        agent: agentName,
        command: commandParts,
        args,
        timeoutMs,
        stdout,
        stderr,
        combined,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

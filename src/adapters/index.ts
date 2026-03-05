import { AdapterInvocation, AgentName, Config } from "../types";
import { invokeClaude } from "./claude";
import { invokeCodex } from "./codex";
import { invokeGemini } from "./gemini";

export function invokeAgent(
  agentName: AgentName,
  prompt: string,
  options: {
    cwd: string;
    config: Config;
    timeoutMs: number;
    onOutput: (chunk: string, stream: "stdout" | "stderr") => void;
  }
): Promise<AdapterInvocation> {
  if (agentName === "claude") {
    return invokeClaude(prompt, options);
  }

  if (agentName === "codex") {
    return invokeCodex(prompt, options);
  }

  if (agentName === "gemini") {
    return invokeGemini(prompt, options);
  }

  throw new Error(`Unsupported agent: ${agentName}`);
}

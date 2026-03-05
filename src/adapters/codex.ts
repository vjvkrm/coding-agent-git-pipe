import { AdapterInvocation, Config } from "../types";
import { runAdapter } from "./base";

export function invokeCodex(
  prompt: string,
  options: {
    cwd: string;
    config: Config;
    timeoutMs: number;
    onOutput: (chunk: string, stream: "stdout" | "stderr") => void;
  }
): Promise<AdapterInvocation> {
  return runAdapter("codex", prompt, options);
}

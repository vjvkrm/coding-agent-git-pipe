export type AgentName = "claude" | "codex" | "gemini";
export type TargetName = AgentName | "human" | "stop";
export type NextAction = "plan" | "implement" | "review" | "ask-human" | "done";
export type StepPromptScope = "first_agent" | "plan" | "implement" | "review";

export interface Question {
  id: string;
  text: string;
}

export interface Contract {
  contract_version: "1";
  next_action: NextAction;
  to?: NextAction;
  message: string;
  questions?: Question[];
}

export interface Config {
  routing: Record<NextAction, TargetName>;
  max_hops: number;
  first_agent: AgentName;
  agent_timeout_ms: number;
  max_invalid_contract_retries: number;
  no_progress_hops: number;
  lock_file: string;
  log_dir: string;
  agent_timeouts_ms: Partial<Record<AgentName, number>>;
  adapter_modes: Partial<Record<AgentName, "print" | "auto">>;
  adapters: Partial<Record<AgentName, string[]>>;
  step_prompts: Record<StepPromptScope, string[]>;
}

export interface AdapterInvocation {
  agent: AgentName;
  command: string[];
  args: string[];
  timeoutMs: number;
  stdout: string;
  stderr: string;
  combined: string;
  durationMs: number;
}

export interface OrchestratorResult {
  runId: string;
  hops: number;
  status: "done" | "max-hops";
  logPath: string;
}

export interface RunInput {
  task: string;
  firstAgent?: AgentName | null;
  maxHops?: number | null;
  timeoutMs?: number | null;
  maxInvalidContractRetries?: number | null;
  noProgressHops?: number | null;
  configPath?: string | null;
  cwd?: string;
  runtime?: {
    invokeAgent?: (
      agentName: AgentName,
      prompt: string,
      options: {
        config: Config;
        cwd: string;
        timeoutMs: number;
        onOutput: (chunk: string, stream: "stdout" | "stderr") => void;
      }
    ) => Promise<AdapterInvocation>;
    askHumanInput?: (payload: { message?: string; questions?: Question[] }) => Promise<string>;
    getRepoStateSignature?: (cwd: string) => string | null | Promise<string | null>;
  };
}

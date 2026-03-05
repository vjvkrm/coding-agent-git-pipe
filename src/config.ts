import fs from "fs";
import path from "path";
import { AgentName, Config, NextAction, TargetName } from "./types";

const ALLOWED_TARGETS = new Set<TargetName>(["claude", "codex", "gemini", "human", "stop"]);
const ALLOWED_ACTIONS = new Set<NextAction>(["plan", "implement", "review", "ask-human", "done"]);
const ALLOWED_AGENTS = new Set<AgentName>(["claude", "codex", "gemini"]);

export const DEFAULT_CONFIG: Config = {
  routing: {
    plan: "claude",
    implement: "codex",
    review: "gemini",
    "ask-human": "human",
    done: "stop",
  },
  max_hops: 10,
  first_agent: "claude",
  agent_timeout_ms: 1800000,
  max_invalid_contract_retries: 1,
  no_progress_hops: 3,
  lock_file: ".agentpipe.lock",
  log_dir: ".agentpipe/runs",
  agent_timeouts_ms: {},
  adapter_modes: {},
  adapters: {},
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: unknown): T {
  const merged = { ...base };
  const overrideObj = isPlainObject(override) ? override : {};

  for (const [key, value] of Object.entries(overrideObj)) {
    const baseValue = merged[key as keyof T];
    if (isPlainObject(value) && isPlainObject(baseValue)) {
      (merged as Record<string, unknown>)[key] = deepMerge(
        baseValue as Record<string, unknown>,
        value
      );
      continue;
    }
    (merged as Record<string, unknown>)[key] = value;
  }

  return merged;
}

function validateRouting(config: Config, candidatePath: string): void {
  if (!isPlainObject(config.routing)) {
    throw new Error(`Invalid routing in ${candidatePath}; expected an object`);
  }

  for (const action of Object.keys(config.routing)) {
    if (!ALLOWED_ACTIONS.has(action as NextAction)) {
      throw new Error(`Invalid routing action "${action}" in ${candidatePath}`);
    }
  }

  for (const [action, target] of Object.entries(config.routing)) {
    if (typeof target !== "string" || !ALLOWED_TARGETS.has(target as TargetName)) {
      throw new Error(
        `Invalid routing target for action "${action}" in ${candidatePath}; ` +
          "expected one of claude,codex,gemini,human,stop"
      );
    }
  }
}

function validateTimeouts(config: Config, candidatePath: string): void {
  if (!Number.isInteger(config.agent_timeout_ms) || config.agent_timeout_ms <= 0) {
    throw new Error(`Invalid agent_timeout_ms in ${candidatePath}; expected positive integer`);
  }

  if (
    !Number.isInteger(config.max_invalid_contract_retries) ||
    config.max_invalid_contract_retries < 0
  ) {
    throw new Error(
      `Invalid max_invalid_contract_retries in ${candidatePath}; expected non-negative integer`
    );
  }

  if (!Number.isInteger(config.no_progress_hops) || config.no_progress_hops < 0) {
    throw new Error(`Invalid no_progress_hops in ${candidatePath}; expected non-negative integer`);
  }

  if (!isPlainObject(config.agent_timeouts_ms)) {
    throw new Error(`Invalid agent_timeouts_ms in ${candidatePath}; expected an object`);
  }

  for (const [agent, timeout] of Object.entries(config.agent_timeouts_ms)) {
    if (!ALLOWED_AGENTS.has(agent as AgentName)) {
      throw new Error(
        `Invalid agent_timeouts_ms key "${agent}" in ${candidatePath}; expected claude,codex,gemini`
      );
    }
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new Error(
        `Invalid timeout for agent "${agent}" in ${candidatePath}; expected positive integer`
      );
    }
  }
}

function validatePaths(config: Config, candidatePath: string): void {
  if (typeof config.lock_file !== "string" || config.lock_file.trim() === "") {
    throw new Error(`Invalid lock_file in ${candidatePath}; expected non-empty string`);
  }

  if (typeof config.log_dir !== "string" || config.log_dir.trim() === "") {
    throw new Error(`Invalid log_dir in ${candidatePath}; expected non-empty string`);
  }
}

const ALLOWED_MODES = new Set(["print", "auto"]);

function validateAdapterModes(config: Config, candidatePath: string): void {
  if (!isPlainObject(config.adapter_modes)) {
    throw new Error(`Invalid adapter_modes in ${candidatePath}; expected an object`);
  }

  for (const [agent, mode] of Object.entries(config.adapter_modes)) {
    if (!ALLOWED_AGENTS.has(agent as AgentName)) {
      throw new Error(
        `Invalid adapter_modes key "${agent}" in ${candidatePath}; expected claude,codex,gemini`
      );
    }
    if (typeof mode !== "string" || !ALLOWED_MODES.has(mode)) {
      throw new Error(
        `Invalid mode for agent "${agent}" in ${candidatePath}; expected "print" or "auto"`
      );
    }
  }
}

function validateFirstAgent(config: Config, candidatePath: string): void {
  if (!ALLOWED_AGENTS.has(config.first_agent)) {
    throw new Error(
      `Invalid first_agent in ${candidatePath}; expected one of claude,codex,gemini`
    );
  }
}

export function loadConfig(options: { cwd?: string; configPath?: string | null } = {}): Config {
  const cwd = options.cwd || process.cwd();
  const candidatePath = options.configPath || path.join(cwd, ".agentpipe.json");

  if (!fs.existsSync(candidatePath)) {
    return { ...DEFAULT_CONFIG };
  }

  let parsed: unknown;
  try {
    const raw = fs.readFileSync(candidatePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to read config at ${candidatePath}: ${(error as Error).message}`);
  }

  const config = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, parsed) as unknown as Config;
  if (!Number.isInteger(config.max_hops) || config.max_hops <= 0) {
    throw new Error(`Invalid max_hops in ${candidatePath}; expected positive integer`);
  }
  if (typeof config.first_agent !== "string" || config.first_agent.trim() === "") {
    throw new Error(`Invalid first_agent in ${candidatePath}; expected non-empty string`);
  }

  validateRouting(config, candidatePath);
  validateTimeouts(config, candidatePath);
  validatePaths(config, candidatePath);
  validateAdapterModes(config, candidatePath);
  validateFirstAgent(config, candidatePath);

  return config;
}

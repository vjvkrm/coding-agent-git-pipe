import fs from "fs";
import path from "path";
import { AgentName, BrainstormConfig, Config, DiscussionConfig, NextAction, StepPromptScope, TargetName } from "./types";

const ALLOWED_TARGETS = new Set<TargetName>(["claude", "codex", "gemini", "human", "stop"]);
const ALLOWED_ACTIONS = new Set<NextAction>(["primary", "review", "pair", "ask-human", "done"]);
const ALLOWED_AGENTS = new Set<AgentName>(["claude", "codex", "gemini"]);
const ALLOWED_STEP_PROMPT_SCOPES = new Set<StepPromptScope>(["primary", "review", "pair"]);

export const DEFAULT_CONFIG: Config = {
  routing: {
    primary: "claude",
    review: "codex",
    pair: "gemini",
    "ask-human": "human",
    done: "stop",
  },
  max_hops: 50,
  agent_timeout_ms: 1800000,
  max_invalid_contract_retries: 1,
  no_progress_hops: 3,
  lock_file: ".agentpipe.lock",
  log_dir: ".agentpipe/runs",
  agent_timeouts_ms: {},
  adapter_modes: {},
  adapter_args: {},
  adapters: {},
  step_prompts: {
    primary: [],
    review: [],
    pair: [],
  },
  review_gate: true,
  discussion: {
    enabled: false,
    participants: [],
    max_rounds: 3,
    require_consensus: true,
  },
  brainstorm: {
    max_turns: 20,
    secondary_agent: "codex",
  },
  max_review_iterations: 3,
};

export function createDefaultConfig(): Config {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
}

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

  const primaryTarget = config.routing.primary;
  if (!ALLOWED_AGENTS.has(primaryTarget as AgentName)) {
    throw new Error(
      `Invalid routing target for action "primary" in ${candidatePath}; expected one of claude,codex,gemini`
    );
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

function validateAgentStringArrayMap(
  value: unknown,
  candidatePath: string,
  fieldName: "adapter_args" | "adapters"
): void {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid ${fieldName} in ${candidatePath}; expected an object`);
  }

  for (const [agent, entries] of Object.entries(value)) {
    if (!ALLOWED_AGENTS.has(agent as AgentName)) {
      throw new Error(
        `Invalid ${fieldName} key "${agent}" in ${candidatePath}; expected claude,codex,gemini`
      );
    }

    if (!Array.isArray(entries)) {
      throw new Error(
        `Invalid ${fieldName}.${agent} in ${candidatePath}; expected an array of strings`
      );
    }

    for (const [index, entry] of entries.entries()) {
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new Error(
          `Invalid ${fieldName}.${agent}[${index}] in ${candidatePath}; expected non-empty string`
        );
      }
    }
  }
}

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

function validateStepPrompts(config: Config, candidatePath: string): void {
  if (!isPlainObject(config.step_prompts)) {
    throw new Error(`Invalid step_prompts in ${candidatePath}; expected an object`);
  }

  for (const scope of Object.keys(config.step_prompts)) {
    if (!ALLOWED_STEP_PROMPT_SCOPES.has(scope as StepPromptScope)) {
      throw new Error(
        `Invalid step_prompts key "${scope}" in ${candidatePath}; expected primary,review,pair`
      );
    }
  }

  for (const [scope, prompts] of Object.entries(config.step_prompts)) {
    if (!Array.isArray(prompts)) {
      throw new Error(
        `Invalid step_prompts.${scope} in ${candidatePath}; expected an array of strings`
      );
    }

    for (const [index, prompt] of prompts.entries()) {
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new Error(
          `Invalid step_prompts.${scope}[${index}] in ${candidatePath}; expected non-empty string`
        );
      }
    }
  }
}

function validateDiscussion(config: Config, candidatePath: string): void {
  if (!isPlainObject(config.discussion)) {
    throw new Error(`Invalid discussion in ${candidatePath}; expected an object`);
  }

  if (typeof config.discussion.enabled !== "boolean") {
    throw new Error(`Invalid discussion.enabled in ${candidatePath}; expected a boolean`);
  }

  if (!Array.isArray(config.discussion.participants)) {
    throw new Error(`Invalid discussion.participants in ${candidatePath}; expected an array`);
  }

  for (const [index, participant] of config.discussion.participants.entries()) {
    if (typeof participant !== "string" || !ALLOWED_AGENTS.has(participant as AgentName)) {
      throw new Error(
        `Invalid discussion.participants[${index}] in ${candidatePath}; expected claude, codex, or gemini`
      );
    }
  }

  if (!Number.isInteger(config.discussion.max_rounds) || config.discussion.max_rounds <= 0) {
    throw new Error(`Invalid discussion.max_rounds in ${candidatePath}; expected positive integer`);
  }

  if (typeof config.discussion.require_consensus !== "boolean") {
    throw new Error(`Invalid discussion.require_consensus in ${candidatePath}; expected a boolean`);
  }
}

function validateBrainstorm(config: Config, candidatePath: string): void {
  if (!isPlainObject(config.brainstorm)) {
    throw new Error(`Invalid brainstorm in ${candidatePath}; expected an object`);
  }

  if (!Number.isInteger(config.brainstorm.max_turns) || config.brainstorm.max_turns <= 0) {
    throw new Error(`Invalid brainstorm.max_turns in ${candidatePath}; expected positive integer`);
  }

  if (
    typeof config.brainstorm.secondary_agent !== "string" ||
    !ALLOWED_AGENTS.has(config.brainstorm.secondary_agent as AgentName)
  ) {
    throw new Error(
      `Invalid brainstorm.secondary_agent in ${candidatePath}; expected claude, codex, or gemini`
    );
  }
}

export function loadConfig(options: { cwd?: string; configPath?: string | null } = {}): Config {
  const cwd = options.cwd || process.cwd();
  const candidatePath = options.configPath || path.join(cwd, ".agentpipe.json");

  if (!fs.existsSync(candidatePath)) {
    return createDefaultConfig();
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
  validateRouting(config, candidatePath);
  validateTimeouts(config, candidatePath);
  validatePaths(config, candidatePath);
  validateAdapterModes(config, candidatePath);
  validateAgentStringArrayMap(config.adapter_args, candidatePath, "adapter_args");
  validateAgentStringArrayMap(config.adapters, candidatePath, "adapters");
  validateStepPrompts(config, candidatePath);

  if (typeof config.review_gate !== "boolean") {
    throw new Error(`Invalid review_gate in ${candidatePath}; expected a boolean`);
  }

  validateDiscussion(config, candidatePath);
  validateBrainstorm(config, candidatePath);

  if (!Number.isInteger(config.max_review_iterations) || config.max_review_iterations <= 0) {
    throw new Error(`Invalid max_review_iterations in ${candidatePath}; expected positive integer`);
  }

  return config;
}

export function writeDefaultConfig(options: {
  cwd?: string;
  configPath?: string | null;
  force?: boolean;
} = {}): string {
  const cwd = options.cwd || process.cwd();
  const candidatePath = options.configPath || path.join(cwd, ".agentpipe.json");

  if (fs.existsSync(candidatePath) && !options.force) {
    throw new Error(
      `Config already exists at ${candidatePath}; rerun with --force to overwrite it`
    );
  }

  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, `${JSON.stringify(createDefaultConfig(), null, 2)}\n`, "utf8");
  return candidatePath;
}

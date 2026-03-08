# Developer API Reference

This document covers the programmatic API for embedding `coding-agent-git-pipe` in your own tools, writing custom adapters, and understanding the internal module contracts.

## Table of Contents

- [Quick Start (Programmatic)](#quick-start-programmatic)
- [Core API](#core-api)
  - [runOrchestrator](#runorchestrator)
  - [RunInput](#runinput)
  - [OrchestratorResult](#orchestratorresult)
- [Contract System](#contract-system)
  - [Contract](#contract)
  - [validateContract](#validatecontract)
  - [parseContractOutput](#parsecontractoutput)
  - [CONTRACT_SUFFIX](#contract_suffix)
- [Routing](#routing)
  - [resolveTarget](#resolvetarget)
- [Configuration](#configuration)
  - [Config](#config)
  - [loadConfig](#loadconfig)
  - [writeDefaultConfig](#writedefaultconfig)
  - [step_prompts](#step_prompts)
- [Adapters](#adapters)
  - [Adapter Modes](#adapter-modes)
  - [invokeAgent](#invokeagent)
  - [runAdapter](#runadapter)
  - [Writing a Custom Adapter](#writing-a-custom-adapter)
- [Runtime Utilities](#runtime-utilities)
  - [acquireRunLock](#acquirerunlock)
  - [createRunLogger](#createrunlogger)
  - [resolveTimeoutMs](#resolvetimeoutms)
  - [getRepoStateSignature](#getrepostatesignature)
- [Type Reference](#type-reference)
- [JSONL Log Events](#jsonl-log-events)
- [Testing](#testing)

---

## Quick Start (Programmatic)

```typescript
import { runOrchestrator } from "coding-agent-git-pipe/src/orchestrator";

const result = await runOrchestrator({
  task: "implement JWT refresh token flow",
  firstAgent: "claude",
  maxHops: 5,
  cwd: "/path/to/repo",
});

console.log(result.status); // "done" | "max-hops"
console.log(result.hops);   // number of steps taken
console.log(result.logPath); // path to JSONL log
```

---

## Core API

### `runOrchestrator`

```typescript
function runOrchestrator(input: RunInput): Promise<OrchestratorResult>
```

The main entry point. Runs the full orchestration loop: invoke agent, parse contract, route, repeat.

**Behavior:**
1. Loads config from `.agentpipe.json` (or `input.configPath`).
2. Acquires a lock file to prevent concurrent runs.
3. Maintains logical step threads (`first_agent`, `plan`, `implement`, `review`, and `pair:<origin-scope>`) with opaque adapter session refs when available.
4. Loops: invoke agent -> parse contract -> route to next -> repeat.
5. On `done -> stop`, opens a finish/continue human gate instead of exiting immediately. `continue` resumes the same agent/session.
6. Stops on `finish`, `max_hops`, or unrecoverable error.
7. Logs every event to a JSONL file.
8. Releases lock on exit (including SIGINT/SIGTERM).

**Runtime injection:** All three core behaviors (agent invocation, human input, repo state) can be overridden via `input.runtime` for testing or custom integrations.

---

### `RunInput`

```typescript
interface RunInput {
  task: string;                              // The task description
  firstAgent?: AgentName | null;             // Override first agent (default: config)
  maxHops?: number | null;                   // Override max hops (default: config)
  timeoutMs?: number | null;                 // Override per-agent timeout (default: config)
  maxInvalidContractRetries?: number | null;  // Override retry count (default: config)
  noProgressHops?: number | null;            // Override no-progress guard (default: config)
  configPath?: string | null;                // Path to config file
  cwd?: string;                              // Working directory (default: process.cwd())
  runtime?: {
    invokeAgent?: InvokeAgentFn;             // Custom agent invocation
    askHumanInput?: AskHumanInputFn;         // Custom human input handler
    getRepoStateSignature?: RepoStateFn;     // Custom repo state checker
  };
}
```

**`runtime.invokeAgent`** — Replace the default adapter system. Receives agent name, prompt, and options. Must return an `AdapterInvocation` with captured stdout/stderr.

```typescript
type InvokeAgentFn = (
  agentName: AgentName,
  prompt: string,
  options: {
    config: Config;
    cwd: string;
    timeoutMs: number;
    onOutput: (chunk: string, stream: "stdout" | "stderr") => void;
    sessionRef?: string | null;
  }
) => Promise<AdapterInvocation>;
```

`sessionRef` is adapter-defined and opaque to the orchestrator. Built-in adapters use it to resume native CLI sessions when the underlying tool supports that.

**`runtime.askHumanInput`** — Replace the default readline-based human gate. Receives a message and optional questions. Must return a string response (empty string stops the run).

```typescript
type AskHumanInputFn = (
  payload: { message?: string; questions?: Question[] }
) => Promise<string>;
```

**`runtime.getRepoStateSignature`** — Replace the default git-based repo state check. Returns a string signature or `null` if unavailable. Used by the no-progress guard.

```typescript
type RepoStateFn = (cwd: string) => string | null | Promise<string | null>;
```

---

### `OrchestratorResult`

```typescript
interface OrchestratorResult {
  runId: string;          // UUID for this run
  hops: number;           // Total steps taken
  status: "done" | "max-hops";  // How the run ended
  logPath: string;        // Path to JSONL log file
}
```

---

## Contract System

### `Contract`

The JSON contract that agents must output at the end of every response.

```typescript
interface Contract {
  contract_version: "1";
  next_action: NextAction;
  to?: NextAction;          // Optional routing override (action names, NOT agent names)
  message: string;
  questions?: Question[];   // Required when next_action = "ask-human"
}

type NextAction = "plan" | "implement" | "review" | "pair" | "ask-human" | "done";

interface Question {
  id: string;
  text: string;
}
```

**Key design decision:** The `to` field uses action names (`plan`, `implement`, `review`, `pair`), not agent names (`claude`, `codex`, `gemini`). This keeps agents unaware of each other's identity. The router maps actions to agents via the config.

**Pair semantics:** When `next_action` is `"pair"`, the orchestrator saves the current agent as a return target, routes to the configured pair agent, and automatically returns to the invoking agent after one hop — regardless of what the pair agent sets as its own `next_action`.

**Done semantics:** When `done` resolves to `stop`, the orchestrator opens a human finish/continue gate. `finish` ends the run; `continue` or any non-empty follow-up message resumes the same step thread/session that emitted `done`.

---

### `validateContract`

```typescript
function validateContract(value: unknown): Contract
```

Validates a parsed JSON object against the contract schema. Throws on invalid input.

**Validation rules:**
- `contract_version` must be `"1"`.
- `next_action` must be one of: `plan`, `implement`, `review`, `pair`, `ask-human`, `done`.
- `to` (if present) must be one of: `plan`, `implement`, `review`, `pair`, `ask-human`, `done`.
- `message` must be a non-empty string (whitespace is trimmed).
- `questions` (if present) must be an array of `{ id: string, text: string }`.
- `questions` cannot be empty when `next_action` is `ask-human`.

---

### `parseContractOutput`

```typescript
function parseContractOutput(outputText: string): unknown
```

Extracts the JSON contract from agent output text. Supports two formats:

1. **Fenced JSON** (preferred) — matches `` ```json ... ``` `` anchored to the end of the output. Note: uses lazy matching (`*?`), so with multiple fenced blocks it grabs the first one that reaches the final closing fence — not necessarily the last block. This is a known limitation.
2. **Raw JSON** — entire trimmed output starts with `{` and ends with `}`.

Throws if neither format is found.

---

### `CONTRACT_SUFFIX`

```typescript
const CONTRACT_SUFFIX: string
```

The instruction text appended to every agent prompt. Tells the agent to end its response with a JSON contract block. This is what makes the "illusion" work — agents follow these instructions without knowing they're talking to other agents.

```
---
You must end your response with exactly one JSON block and no text after it:
```json
{
  "contract_version": "1",
  "next_action": "plan | implement | review | pair | ask-human | done",
  "to": "(optional) plan | implement | review | pair | ask-human | done",
  "message": "concise technical handoff for the next step",
  "questions": [{"id":"q1","text":"Only for ask-human"}]
}
```
```

---

## Routing

### `resolveTarget`

```typescript
function resolveTarget(contract: Contract, config: Config): TargetName
```

Determines which agent (or special target) handles the next step.

**Resolution order:**
1. If `contract.to` is set, use it as the action to route.
2. Otherwise, use `contract.next_action`.
3. Look up `config.routing[action]` to get the target.

All actions — including `done` and `ask-human` — are resolved through `config.routing`. The default config maps `done` to `"stop"` and `ask-human` to `"human"`, but these can be overridden.

Returns a `TargetName`: `"claude" | "codex" | "gemini" | "human" | "stop"`.

---

## Configuration

### `Config`

```typescript
interface Config {
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
  adapter_args: Partial<Record<AgentName, string[]>>;
  adapters: Partial<Record<AgentName, string[]>>;
  step_prompts: Record<"first_agent" | "plan" | "implement" | "review" | "pair", string[]>;
  review_gate: boolean;
}
```

### `loadConfig`

```typescript
function loadConfig(options?: {
  cwd?: string;
  configPath?: string | null;
}): Config
```

Loads and validates `.agentpipe.json`. Deep-merges user config over defaults. If no config file exists, returns defaults.

**Defaults:**

| Field | Default |
|-------|---------|
| `routing.plan` | `"claude"` |
| `routing.implement` | `"codex"` |
| `routing.review` | `"gemini"` |
| `routing.pair` | `"claude"` |
| `max_hops` | `20` |
| `first_agent` | `"claude"` |
| `agent_timeout_ms` | `1800000` (30 min) |
| `max_invalid_contract_retries` | `1` |
| `no_progress_hops` | `3` |
| `review_gate` | `true` |
| `adapter_modes` | `{}` (all agents default to `"auto"`) |
| `adapter_args` | `{}` (extra CLI flags appended to the resolved adapter command) |
| `adapters` | `{}` (uses mode-based defaults) |
| `step_prompts` | `{ first_agent: [], plan: [], implement: [], review: [], pair: [] }` |

The CLI command `agent-pipe init` writes this default config shape to `.agentpipe.json` in the target repo.

### `writeDefaultConfig`

```typescript
function writeDefaultConfig(options?: {
  cwd?: string;
  configPath?: string | null;
  force?: boolean;
}): string
```

Writes a starter config file using the current defaults and returns the created path.

- Default path: `<cwd>/.agentpipe.json`
- If the file already exists, it throws unless `force` is `true`
- This is what powers the CLI flow: `agent-pipe init`

### `step_prompts`

`step_prompts` lets you inject hidden prompt instructions by orchestration stage:

- `first_agent` applies to the initial stage and persists through human clarification until the run hands off into a routed `plan`, `implement`, `review`, or `pair` step.
- `plan`, `implement`, `review`, and `pair` apply by routed action, not by agent identity.
- These instructions are prepended to the agent prompt and are not printed to the terminal stream.
- Logical step threads are scoped the same way, so `implement -> review -> implement` resumes the original implement session instead of starting over when the adapter supports session persistence.

Example:

```json
{
  "step_prompts": {
    "first_agent": ["Analyze first and route intentionally."],
    "plan": ["Planning only. Avoid code edits unless explicitly needed."],
    "implement": ["Focus on concrete repo changes and validation."],
    "review": ["Review for correctness, regressions, and missing tests."],
    "pair": ["Provide expert advice and suggestions. Do not modify code directly."]
  }
}
```

### Handoff Behavior

Every agent prompt includes a hidden handoff rubric:

- treat the incoming handoff as the primary continuation state
- when routing again, make `message` a concise technical handoff
- include current state/diagnosis, exact next task, and relevant files/tests/constraints when applicable

This is prompt-shaping only; it improves handoff quality without changing the contract schema.

### `review_gate`

`review_gate` controls whether `implement -> done` is allowed to end the run directly.

- When `true` (default), an `implement` hop that emits `done` is redirected to the configured `review` route first.
- When `false`, `implement -> done` behaves normally and reaches the done gate immediately.
- `review -> done` is never intercepted.

---

## Adapters

### Adapter Modes

Each agent runs in one of two modes, configured via `adapter_modes`:

**`auto` mode (default):**
Agents run with full autonomy — file editing, command execution, tool use.

| Agent | Command |
|-------|---------|
| claude | `claude --dangerously-skip-permissions -p` |
| codex | `codex exec --skip-git-repo-check --json -c model_reasoning_effort="medium"` |
| gemini | `gemini -o stream-json` |

**`print` mode:**
Agents produce text-only output, no tool use or file modifications.

Claude is invoked with `-p` in both built-in modes so it runs non-interactively in a pipe. `auto` mode keeps tool access enabled via `--dangerously-skip-permissions`; `print` mode disables tools with `--tools ""`. Codex uses `--json` in the built-in auto path so `agent-pipe` can render terminal output as events arrive. Gemini uses `-o stream-json` in the built-in auto path for the same reason. Setting print mode for Codex or Gemini will throw an error — use the `adapters` config field to provide a custom command instead.

### `adapter_args`

`adapter_args` appends extra CLI flags to the resolved command for each adapter.

Use this when you want to keep the built-in adapter behavior but set things like:

- model selection
- sandbox or write permissions
- approval / permission mode

Example:

```json
{
  "adapter_args": {
    "claude": ["--model", "opus", "--permission-mode", "auto"],
    "codex": ["--full-auto", "-m", "gpt-5.4"],
    "gemini": ["--model", "gemini-2.5-pro"]
  }
}
```

This is usually preferable to replacing the whole command in `adapters`, because the built-in streaming and session-resume paths still apply.

| Agent | Command |
|-------|---------|
| claude | `claude -p --tools ""` |
| codex | Not supported (use `adapters` override) |
| gemini | Not supported (use `adapters` override) |

**Resolution priority:**
1. `config.adapters[agent]` — explicit base command array (highest priority).
2. `config.adapter_modes[agent]` — selects from built-in print/auto commands.
3. `config.adapter_args[agent]` — appended after the resolved base command.
4. Falls back to `"auto"` mode defaults.

---

### `invokeAgent`

```typescript
function invokeAgent(
  agentName: AgentName,
  prompt: string,
  options: {
    cwd: string;
    config: Config;
    timeoutMs: number;
    onOutput: (chunk: string, stream: "stdout" | "stderr") => void;
  }
): Promise<AdapterInvocation>
```

Dispatches to the appropriate agent adapter. This is the default implementation used when `runtime.invokeAgent` is not provided.

---

### `runAdapter`

```typescript
function runAdapter(
  agentName: AgentName,
  prompt: string,
  options: {
    cwd?: string;
    config: Config;
    timeoutMs: number;
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  }
): Promise<AdapterInvocation>
```

The core adapter implementation. Spawns a child process, streams output, enforces timeout.

**Behavior:**
1. Resolves the command from config (explicit override -> mode-based -> default).
2. Spawns the process with `child_process.spawn`.
3. Passes the prompt as the last CLI argument.
4. Streams stdout/stderr chunks via `onOutput` callback.
5. Captures full stdout, stderr, and combined output.
6. On timeout: sends SIGTERM, then SIGKILL after a 5-second grace period if the process hasn't exited.
7. Rejects on non-zero exit code or spawn error.

**Returns:**

```typescript
interface AdapterInvocation {
  agent: AgentName;
  command: string[];     // The resolved command parts
  args: string[];        // Full args array (command parts + prompt)
  timeoutMs: number;
  stdout: string;        // Full captured stdout
  stderr: string;        // Full captured stderr
  combined: string;      // Interleaved stdout + stderr
  durationMs: number;    // Wall-clock execution time
  sessionRef?: string | null;  // Opaque adapter session token/id for resuming later hops
}
```

---

### Writing a Custom Adapter

To add a new agent, you have three options:

**Option 1: Config override (no code changes)**

```json
{
  "routing": {
    "implement": "codex"
  },
  "adapters": {
    "codex": ["aider", "--yes", "--message"]
  }
}
```

This routes "implement" actions to the "codex" slot but runs `aider` instead.

**Option 2: Runtime injection**

```typescript
import { runOrchestrator } from "coding-agent-git-pipe/src/orchestrator";

const result = await runOrchestrator({
  task: "my task",
  runtime: {
    invokeAgent: async (agentName, prompt, options) => {
      // Your custom logic here
      const output = await myCustomAgent(prompt);
      return {
        agent: agentName,
        command: ["my-agent"],
        args: ["my-agent", prompt],
        timeoutMs: options.timeoutMs,
        stdout: output,
        stderr: "",
        combined: output,
        durationMs: 0,
      };
    },
  },
});
```

**Option 3: Add a new adapter file**

1. Create `src/adapters/myagent.ts`:
```typescript
import { AdapterInvocation, Config } from "../types";
import { runAdapter } from "./base";

export function invokeMyAgent(
  prompt: string,
  options: {
    cwd: string;
    config: Config;
    timeoutMs: number;
    onOutput: (chunk: string, stream: "stdout" | "stderr") => void;
  }
): Promise<AdapterInvocation> {
  return runAdapter("myagent" as any, prompt, options);
}
```

2. Add the agent name to the `AgentName` type in `src/types.ts`.
3. Register it in `src/adapters/index.ts`.
4. Add default commands in `src/adapters/base.ts`.

---

## Runtime Utilities

### `acquireRunLock`

```typescript
function acquireRunLock(params: {
  cwd: string;
  config: Config;
  runId: string;
}): { lockPath: string; release: () => void }
```

Creates an exclusive lock file to prevent concurrent orchestrator runs in the same repo.

**Behavior:**
- Uses `O_EXCL` flag for atomic creation.
- Writes PID, run ID, cwd, and timestamp to the lock file.
- If a lock exists, checks if the owning PID is still alive.
- Reclaims stale locks (dead PID) automatically.
- Throws if another active run holds the lock.
- `release()` is idempotent and safe to call multiple times.
- `release()` verifies the lock's `run_id` before deleting (won't delete another run's lock).

---

### `createRunLogger`

```typescript
function createRunLogger(params: {
  cwd: string;
  config: Config;
  runId: string;
}): { logPath: string; logEvent: (event: Record<string, unknown>) => void }
```

Creates a JSONL logger for the run. Each call to `logEvent` appends a JSON line with a timestamp and run ID.

**Log file location:** `{cwd}/{config.log_dir}/{runId}.jsonl`

---

### `resolveTimeoutMs`

```typescript
function resolveTimeoutMs(
  agentName: AgentName,
  config: Config,
  cliTimeoutMs?: number
): number
```

Resolves the effective timeout for an agent invocation.

**Priority:** CLI override -> `config.agent_timeouts_ms[agent]` -> `config.agent_timeout_ms`.

---

### `getRepoStateSignature`

```typescript
function getRepoStateSignature(cwd: string): string | null
```

Returns a string representing the current git state: `HEAD commit hash + git status --porcelain`. Returns `null` if not a git repo.

Used by the no-progress guard to detect if agents are making changes. If the signature is identical across `no_progress_hops` consecutive steps, the orchestrator escalates to human input.

---

## Type Reference

```typescript
// Agent names (internal routing targets)
type AgentName = "claude" | "codex" | "gemini";

// All possible routing targets
type TargetName = AgentName | "human" | "stop";

// Actions that appear in contracts (agent-facing)
type NextAction = "plan" | "implement" | "review" | "pair" | "ask-human" | "done";

// Question for human gate
interface Question {
  id: string;
  text: string;
}
```

---

## JSONL Log Events

Every run produces a JSONL file at `{log_dir}/{run_id}.jsonl`. Each line is a JSON object with `ts` (ISO timestamp) and `run_id` fields plus event-specific data.

### Event Types

| Event | Fields | When |
|-------|--------|------|
| `run_started` | `cwd`, `first_agent`, `max_hops`, `max_invalid_contract_retries`, `timeout_override_ms`, `no_progress_hops`, `lock_file`, `log_file`, `repo_state_available` | Run begins |
| `step_started` | `step_id`, `agent`, `timeout_ms`, `message` | Before invoking an agent |
| `agent_invocation` | `step_id`, `agent`, `attempt`, `duration_ms`, `timeout_ms`, `command`, `stderr_sample` | After agent returns |
| `contract_retry` | `step_id`, `agent`, `attempt` | Retrying after invalid contract |
| `contract_invalid` | `step_id`, `agent`, `attempt`, `error`, `stdout_sample` | Contract parse/validation failed |
| `step_contract` | `step_id`, `agent`, `parse_attempts`, `contract`, `target` | Valid contract parsed |
| `step_failed` | `step_id`, `agent`, `error` | Agent invocation failed entirely |
| `routing_failed` | `step_id`, `agent`, `contract`, `error` | Router could not resolve target |
| `human_response` | `step_id`, `reason`, `response` | Human provided input. Reason: `ask-human`, `routed-to-human:<action>` (when a non-ask-human action routes to human), `agent-failure`, `routing-error`, `no-progress` |
| `thread_session_started` | `step_id`, `agent`, `thread_key`, `session_ref` | A step thread started or ran without a prior saved session |
| `thread_session_resumed` | `step_id`, `agent`, `thread_key`, `session_ref` | A saved step thread/session was resumed |
| `no_progress_check` | `step_id`, `no_progress_count` | Repo state compared |
| `pair_invoked` | `step_id`, `invoking_agent`, `pair_target` | Agent initiated a pair session |
| `pair_return` | `step_id`, `return_agent` | Pair session ended, returning to invoking agent |
| `review_gate_redirect` | `step_id`, `agent`, `original_action`, `redirected_to` | `implement -> done` was intercepted and routed to `review` |
| `done_gate_opened` | `step_id`, `agent`, `thread_key`, `session_ref` | Agent proposed completion and the finish/continue gate opened |
| `done_gate_finish` | `step_id`, `agent`, `thread_key` | Human chose `finish` |
| `done_gate_continue` | `step_id`, `agent`, `thread_key`, `response` | Human continued with a follow-up that resumes the same session |
| `run_completed` | `status`, `step_id`, `message` | Run finished (`done` or `max-hops`) |
| `signal` | `signal`, `step_id` | SIGINT/SIGTERM received |
| `run_finalized` | _(none)_ | Lock released, cleanup done |

### Example Log

```jsonl
{"ts":"2026-03-05T10:00:00.000Z","run_id":"abc-123","type":"run_started","cwd":"/repo","first_agent":"claude","max_hops":20}
{"ts":"2026-03-05T10:00:00.100Z","run_id":"abc-123","type":"step_started","step_id":1,"agent":"claude","timeout_ms":1800000}
{"ts":"2026-03-05T10:02:30.000Z","run_id":"abc-123","type":"agent_invocation","step_id":1,"agent":"claude","attempt":1,"duration_ms":150000}
{"ts":"2026-03-05T10:02:30.001Z","run_id":"abc-123","type":"step_contract","step_id":1,"agent":"claude","parse_attempts":1,"contract":{"contract_version":"1","next_action":"implement","message":"..."}}
{"ts":"2026-03-05T10:02:30.002Z","run_id":"abc-123","type":"run_completed","status":"done","step_id":3}
{"ts":"2026-03-05T10:02:30.003Z","run_id":"abc-123","type":"run_finalized"}
```

---

## Testing

### Running Tests

```bash
npm test
```

Uses Node.js built-in test runner with `tsx` for TypeScript support.

### Writing Tests with Runtime Injection

The `runtime` parameter on `RunInput` makes testing straightforward. You can stub all external dependencies:

```typescript
import { runOrchestrator } from "../src/orchestrator";
import { Contract } from "../src/types";

// Create a stub that returns canned contracts
function createInvokeStub(queue: Contract[]) {
  let index = 0;
  return async (agentName, prompt, options) => {
    const contract = queue[index++];
    const stdout = `\`\`\`json\n${JSON.stringify(contract)}\n\`\`\``;
    return {
      agent: agentName,
      command: ["mock"],
      args: ["mock"],
      timeoutMs: 1000,
      stdout,
      stderr: "",
      combined: stdout,
      durationMs: 1,
    };
  };
}

// Use it in a test
const result = await runOrchestrator({
  task: "test task",
  cwd: tempDir,
  configPath: configPath,
  runtime: {
    invokeAgent: createInvokeStub([
      { contract_version: "1", next_action: "implement", message: "do it" },
      { contract_version: "1", next_action: "done", message: "done" },
    ]),
    askHumanInput: async () => "human response",
    getRepoStateSignature: () => null,  // disable no-progress guard
  },
});
```

### Test Coverage

Current test files:

| File | Tests |
|------|-------|
| `tests/contract.test.ts` | Valid contract acceptance, invalid target rejection |
| `tests/parser.test.ts` | Fenced JSON extraction, raw JSON, missing block |
| `tests/orchestrator.test.ts` | Full loop (plan->implement->review->done), ask-human pause/resume, retry on invalid contract, max_hops termination, no-progress guard, pair routing with auto-return |

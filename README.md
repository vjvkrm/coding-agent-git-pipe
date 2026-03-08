# coding-agent-git-pipe

A lightweight TypeScript CLI orchestrator that chains autonomous AI coding agents (Claude Code, Codex, Gemini) into automated workflows using a minimal JSON contract.

Each agent thinks it's talking to a human. It's not. It's talking to another agent through this pipe. The agents don't know each other exist — they only see abstract actions (plan, implement, review, pair), never agent names. The orchestrator stays dumb; the agents' autonomy is the feature.

## Table of Contents

- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Usage](#usage)
  - [CLI Commands](#cli-commands)
  - [CLI Flags](#cli-flags)
  - [Using With Fewer Agents](#using-with-fewer-agents)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
  - [Config Reference](#config-reference)
  - [Step Prompts](#step-prompts)
  - [Step Threads and Sessions](#step-threads-and-sessions)
  - [Adapter Modes](#adapter-modes)
  - [Custom Agent Commands](#custom-agent-commands)
- [Contract Schema](#contract-schema)
- [Orchestrator Loop](#orchestrator-loop)
- [Output and Logging](#output-and-logging)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)
- [Developer / API Docs](#developer--api-docs)
- [Design Principles](#design-principles)
- [Why This Is Different From Cursor/IDE Multi-Agent](#why-this-is-different-from-cursoride-multi-agent)

---

## Quick Start

```bash
# Install globally
npm install -g coding-agent-git-pipe

# Initialize a repo once
cd /path/to/repo
agent-pipe init

# Or run directly with npx (no install needed)
npx coding-agent-git-pipe run "implement JWT refresh token flow"

# If installed globally, use either alias
cagp run "add dark mode support"
agent-pipe run "refactor auth module"
```

That's it. The orchestrator will route your task through Claude (plan) -> Codex (implement) -> Gemini (review) by default, streaming each agent's output to your terminal in real time.

---

## Prerequisites

**Node.js 18+** is required.

You need at least one of the following AI coding CLIs installed and authenticated:

| Agent | Install | Auth |
|-------|---------|------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `npm install -g @anthropic-ai/claude-code` | `claude` (follow login prompts) |
| [Codex](https://github.com/openai/codex) | `npm install -g @openai/codex` | Set `OPENAI_API_KEY` env var |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` or see [Gemini CLI docs](https://github.com/google-gemini/gemini-cli) | `gemini` (follow login prompts) |

You do **not** need all three. See [Using With Fewer Agents](#using-with-fewer-agents) to configure routing for your setup.

---

## Installation

### Global install (recommended)

```bash
npm install -g coding-agent-git-pipe
```

This gives you two global commands: `cagp` and `agent-pipe`.

### npx (no install)

```bash
npx coding-agent-git-pipe run "your task here"
```

### From source

```bash
git clone https://github.com/user/coding-agent-git-pipe.git
cd coding-agent-git-pipe
npm install
npm run build
npm link    # makes cagp and agent-pipe available globally
```

### Verify installation

```bash
cagp --version
cagp --help
```

---

## Usage

### CLI Commands

Use `init` once per repo to create a starter config, then use `run` for actual tasks.

```bash
# Create .agentpipe.json in the current repo
agent-pipe init

# Create it in another repo root
agent-pipe init --cwd /path/to/repo

# Overwrite an existing config
agent-pipe init --force
```

Then pass your task as a quoted string:

```bash
# Basic usage
cagp run "implement JWT refresh token flow"

# Both aliases work identically
agent-pipe run "add user authentication with OAuth2"
```

The orchestrator will:
1. Send your task to the first agent (Claude by default)
2. Stream the agent's output to your terminal in real time
3. Parse the agent's routing contract
4. Hand off to the next agent automatically
5. Repeat until done or max hops reached

### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--first-agent <name>` | `claude` | Which agent receives the initial task (`claude`, `codex`, or `gemini`) |
| `--max-hops <n>` | `20` | Maximum routing hops before stopping |
| `--timeout-ms <n>` | `1800000` | Per-agent timeout in milliseconds (default: 30 min) |
| `--max-retries <n>` | `1` | Contract parse retries before escalating to human |
| `--no-progress-hops <n>` | `3` | Ask human if repo unchanged for N consecutive steps (0 = disabled) |
| `--config <path>` | `.agentpipe.json` | Path to config JSON file |
| `--cwd <path>` | Current dir | Working directory (must be a git repo) |
| `--force` | | `init` only. Overwrite an existing config file |
| `-v, --version` | | Show version |
| `-h, --help` | | Show help |

### Examples

```bash
# Start with codex instead of claude, limit to 5 hops
cagp run "add dark mode support" --first-agent codex --max-hops 5

# Longer timeout for complex tasks
agent-pipe run "refactor auth module" --timeout-ms 600000

# Disable no-progress guard (useful for planning-only tasks)
cagp run "analyze codebase architecture" --no-progress-hops 0

# Use a custom config file and different working directory
agent-pipe run "fix login bug" --config ./my-config.json --cwd /path/to/repo
```

### Using With Fewer Agents

You don't need all three agents. Configure `.agentpipe.json` to route all actions to the agent(s) you have:

**Claude only:**

```json
{
  "routing": {
    "plan": "claude",
    "implement": "claude",
    "review": "claude",
    "ask-human": "human",
    "done": "stop"
  },
  "first_agent": "claude"
}
```

**Claude + Codex (no Gemini):**

```json
{
  "routing": {
    "plan": "claude",
    "implement": "codex",
    "review": "claude",
    "ask-human": "human",
    "done": "stop"
  }
}
```

**Codex only:**

```json
{
  "routing": {
    "plan": "codex",
    "implement": "codex",
    "review": "codex",
    "ask-human": "human",
    "done": "stop"
  },
  "first_agent": "codex"
}
```

---

## How It Works

```
You: cagp run "implement JWT refresh token flow"

  Orchestrator -> Claude (plans the approach)
  Claude -> Codex (implements the code, runs tests)
  Codex -> Claude (pair: asks for architecture advice)
  Claude -> Codex (returns with suggestions)
  Codex -> Gemini (reviews the diff, runs linters)
  Gemini -> Claude (requests changes)
  Claude -> Human (asks a question)
  Human -> Claude (answers)
  Claude -> done

You come back to a reviewed implementation.
```

In `auto` mode (default), each agent:
- Reads and writes files in the repo directly
- Runs commands (tests, linters, builds)
- Commits code if needed
- Only outputs a small JSON contract at the end to say "what should happen next"

In `print` mode, agents produce text-only output (planning, analysis, feedback) without modifying the repo.

The repo itself is shared state — agents read code directly from disk, not from messages. This keeps the contract small and agents fast.

---

## Configuration

Create `.agentpipe.json` at your repo root (optional — all fields have sensible defaults):

```bash
agent-pipe init
```

```json
{
  "routing": {
    "plan": "claude",
    "implement": "codex",
    "review": "gemini",
    "pair": "claude",
    "ask-human": "human",
    "done": "stop"
  },
  "max_hops": 20,
  "first_agent": "claude",
  "agent_timeout_ms": 1800000,
  "max_invalid_contract_retries": 1,
  "no_progress_hops": 3,
  "lock_file": ".agentpipe.lock",
  "log_dir": ".agentpipe/runs",
  "review_gate": true,
  "agent_timeouts_ms": {},
  "adapter_modes": {},
  "adapter_args": {},
  "adapters": {},
  "step_prompts": {
    "first_agent": [],
    "plan": [],
    "implement": [],
    "review": [],
    "pair": []
  }
}
```

All fields are optional. Defaults are applied for anything not specified.

Add to your `.gitignore`:

```
.agentpipe.lock
.agentpipe/
```

### Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `routing` | `Record<action, target>` | plan->claude, implement->codex, review->gemini, pair->claude | Maps actions to agents. Targets: `claude`, `codex`, `gemini`, `human`, `stop` |
| `max_hops` | `number` | `20` | Max routing hops before stopping |
| `first_agent` | `string` | `"claude"` | Which agent receives the initial task |
| `agent_timeout_ms` | `number` | `1800000` (30min) | Default per-agent timeout |
| `max_invalid_contract_retries` | `number` | `1` | Retries for invalid contract output |
| `no_progress_hops` | `number` | `3` | Ask human if repo unchanged for N hops (0 = disabled) |
| `lock_file` | `string` | `".agentpipe.lock"` | Lock file path for concurrency protection |
| `log_dir` | `string` | `".agentpipe/runs"` | JSONL log directory |
| `review_gate` | `boolean` | `true` | If enabled, intercepts `implement -> done` and routes that completion through `review` first |
| `agent_timeouts_ms` | `Record<agent, number>` | `{}` | Per-agent timeout overrides |
| `adapter_modes` | `Record<agent, "print"\|"auto">` | `{}` (all default to `auto`) | Per-agent execution mode |
| `adapter_args` | `Record<agent, string[]>` | `{}` | Extra CLI flags appended to the resolved adapter command |
| `adapters` | `Record<agent, string[]>` | `{}` | Per-agent command override |
| `step_prompts` | `Record<scope, string[]>` | all empty arrays | Hidden prompt instructions scoped to `first_agent`, `plan`, `implement`, `review`, or `pair` |

### Step Prompts

Use `step_prompts` when you want to bias behavior by stage without changing the visible task text.

- `first_agent` applies to the initial stage and survives human clarification until the run hands off into a routed `plan`, `implement`, `review`, or `pair` step.
- `plan`, `implement`, `review`, and `pair` apply based on the routed action for the current hop, not the agent name.
- These instructions are injected into the agent prompt invisibly; they do not print to the terminal.

Example:

```json
{
  "step_prompts": {
    "first_agent": ["Analyze first. Route intentionally. Do not implement immediately."],
    "plan": ["Planning only. Prefer decomposition and routing over code edits."],
    "implement": ["Focus on concrete repo changes and validation."],
    "review": ["Review for correctness, regressions, and missing tests."],
    "pair": ["Provide expert advice, suggestions, and approach validation. Do not modify code."]
  }
}
```

### Step Threads and Sessions

`agent-pipe` now keeps a logical thread per step scope instead of treating every hop as a blank one-shot exchange.

- Default thread keys are `first_agent`, `plan`, `implement`, and `review`.
- Pair hops use a separate thread namespace: `pair:<origin-scope>`. That keeps pair advice sessions separate from the invoking step's own session.
- Built-in adapters reuse native CLI session ids when available. When a custom adapter cannot resume natively, `agent-pipe` falls back to prompt replay for continuity.
- When a step resumes, the prompt only includes the new handoff plus turns since that thread last ran. Older context stays in the native CLI session instead of being replayed every time.

### Better Handoffs

Every agent prompt now includes a hidden handoff rubric.

- Agents are told to treat the current handoff as primary task state.
- When they route to another action, they are told to make `message` a concise technical handoff rather than a vague summary.
- The intended shape is: current state or diagnosis, exact next task, and any relevant files, tests, commands, or constraints.
- The handoff stays compact; this is meant to improve precision, not add long prose.

### Review Gate

By default, `agent-pipe` will not let an `implement` step finish the run directly.

- If an `implement` step emits `done`, the orchestrator redirects that completion to the configured `review` route first.
- A `review` step can still emit `done` normally.
- Set `"review_gate": false` if you want to allow `implement -> done` without an automatic review hop.

### Adapter Modes

Each agent can run in one of two modes:

| Mode | Behavior |
|------|----------|
| `auto` (default) | Full autonomous agent with file editing, command execution, tool use |
| `print` | Text-only output, no tool use or file modifications |

The actual commands invoked per mode:

| Agent | `auto` | `print` |
|-------|--------|---------|
| claude | `claude --dangerously-skip-permissions -p` | `claude -p --tools ""` |
| codex | `codex exec --skip-git-repo-check --json ...` | Not supported (use `adapters` override) |
| gemini | `gemini -o stream-json` | Not supported (use `adapters` override) |

Set `"print"` for Claude when you only want text output (e.g., for planning-only steps):

```json
{
  "adapter_modes": {
    "claude": "print"
  }
}
```

### Custom Agent Commands

Override the exact command used for any agent with the `adapters` field. This takes priority over `adapter_modes`.

```json
{
  "adapters": {
    "claude": ["claude", "--dangerously-skip-permissions", "--model", "opus"]
  }
}
```

You can even swap in a completely different tool (e.g., aider) by routing to an agent slot and overriding its command:

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

Use `adapter_args` when you want to keep the built-in adapter behavior but add flags like model selection, sandbox, or permission settings.

Examples:

```json
{
  "adapter_args": {
    "claude": ["--model", "opus", "--permission-mode", "auto"],
    "codex": ["--full-auto", "-m", "gpt-5.4"],
    "gemini": ["--model", "gemini-2.5-pro"]
  }
}
```

This is usually better than a full `adapters` override because built-in streaming and native session-resume behavior stay intact.

---

## Contract Schema

Every agent response must end with a JSON contract. This is how agents tell the orchestrator what should happen next:

```json
{
  "contract_version": "1",
  "next_action": "plan | implement | review | pair | ask-human | done",
  "to": "(optional) plan | implement | review | pair | ask-human | done",
  "message": "concise technical handoff for the next step",
  "questions": [{ "id": "q1", "text": "Only used when next_action=ask-human" }]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `contract_version` | Yes | Always `"1"` |
| `next_action` | Yes | What should happen next |
| `to` | No | Override routing (uses action names, not agent names) |
| `message` | Yes | Concise technical handoff passed to the next step |
| `questions` | Only for `ask-human` | Questions for the human to answer |

**Important:** `to` uses action names (`plan`, `implement`, `review`, `pair`) — never agent names. The routing config maps actions to agents internally. This keeps agents unaware of each other.

### Pair Action

The `pair` action enables pair-programming sessions. When an agent emits `next_action: "pair"`, the orchestrator:

1. Saves the current agent as the "return-to" target.
2. Routes to the configured pair agent (default: `claude`).
3. The pair agent provides advice, suggestions, or approach validation.
4. After the pair agent responds, the orchestrator **automatically returns** to the original invoking agent with the pair agent's response as the message.

The return is forced regardless of what the pair agent sets as its own `next_action`. Nested pair calls are not supported — if the pair agent emits `pair`, it is treated as a normal routing action.

### Done Gate

When a contract resolves to `done -> stop`, the run no longer exits immediately.

1. The agent's completion message is shown through the human gate.
2. You can reply with `finish` to end the run.
3. You can reply with `continue` to enter a second follow-up message prompt.
4. Any other non-empty reply is treated as a direct follow-up and continues immediately.

In all continue cases, the follow-up goes back to the same agent and the same saved step thread/session that emitted `done`.

---

## Orchestrator Loop

1. Start run with task string.
2. Acquire lock file (prevents concurrent runs in the same repo).
3. Invoke first agent with task + contract instructions.
4. Stream stdout/stderr to terminal live (prefixed with agent name).
5. Parse the final JSON contract block from output.
6. Validate contract fields.
7. Route to next target via config routing table.
8. On `pair` action: save return context, route to pair agent, then auto-return after one hop.
9. On target `human` (default for `ask-human`) or failures: pause for human input.
10. On `done -> stop`: open the human finish/continue gate. On `finish`, stop. On `continue`, resume the same step thread/session.
11. Check no-progress guard (git state unchanged for too many steps?).
12. Write JSONL event log per step. Release lock on exit/signals.

The orchestrator maintains a rolling conversation history (last 4 turns) and separate step-thread session state so returning to `implement` or `review` can continue naturally instead of restarting from scratch.

---

## Output and Logging

### Terminal output

Agent output is streamed live to your terminal, prefixed with the agent name:

```
[claude] I'll plan the implementation of JWT refresh tokens...
[claude] The approach will be:
[claude]   1. Create a refresh token model
[claude]   2. Add rotation logic
...
[codex] Implementing the JWT refresh token flow...
[codex:stderr] Running tests...
```

A heartbeat message (`... still working`) appears every 10 seconds if an agent produces no output, so you know the process hasn't hung.

### JSONL logs

Every run produces a detailed JSONL log at `.agentpipe/runs/{runId}.jsonl`. Each line is a timestamped JSON event:

```jsonl
{"ts":"2026-03-05T10:00:00.000Z","run_id":"abc-123","type":"run_started","first_agent":"claude","max_hops":20}
{"ts":"2026-03-05T10:00:00.100Z","run_id":"abc-123","type":"step_started","step_id":1,"agent":"claude"}
{"ts":"2026-03-05T10:02:30.000Z","run_id":"abc-123","type":"step_contract","step_id":1,"contract":{...}}
{"ts":"2026-03-05T10:05:00.000Z","run_id":"abc-123","type":"run_completed","status":"done"}
```

Event types: `run_started`, `step_started`, `thread_session_started`, `thread_session_resumed`, `agent_invocation`, `contract_retry`, `contract_invalid`, `step_contract`, `step_failed`, `routing_failed`, `human_response`, `no_progress_check`, `pair_invoked`, `pair_return`, `review_gate_redirect`, `done_gate_opened`, `done_gate_finish`, `done_gate_continue`, `run_completed`, `signal`, `run_finalized`.

---

## Troubleshooting

### "command not found: claude" (or codex, gemini)

The AI CLI is not installed or not in your PATH. Install it:

```bash
npm install -g @anthropic-ai/claude-code   # Claude
npm install -g @openai/codex                # Codex
```

### "Lock file exists" error

Another `cagp` run is active in this repo, or a previous run crashed without releasing its lock. The orchestrator checks if the PID in the lock is still alive — if the process died, it reclaims the lock automatically. If you're sure no run is active:

```bash
rm .agentpipe.lock
```

### Agent keeps producing invalid contracts

Increase retries: `--max-retries 3`. If persistent, the agent may not be following the contract format. Check the JSONL log for `contract_invalid` events with the raw output.

### "No progress" keeps asking for human input

The no-progress guard triggers when the git repo state (HEAD + working tree) is unchanged for `no_progress_hops` consecutive steps. This often happens during planning-only tasks. Disable it:

```bash
cagp run "analyze this code" --no-progress-hops 0
```

### Agent times out

Default timeout is 30 minutes per agent. For complex tasks:

```bash
cagp run "large refactoring task" --timeout-ms 3600000   # 1 hour
```

Or set per-agent timeouts in config:

```json
{
  "agent_timeouts_ms": {
    "codex": 3600000
  }
}
```

### Run seems stuck / no output

Wait 10 seconds — a heartbeat message will appear if the agent is still running. AI agents can take time on complex tasks, especially in `auto` mode when they're running commands.

---

## Tests

```bash
npm test
```

Uses Node.js built-in test runner with `tsx` for TypeScript support. Tests use runtime injection to stub agent invocations — no real AI CLIs needed.

---

## Project Structure

```
bin/cli.js              CLI entry point (loads built dist)
src/
  cli.ts                Argument parsing and validation
  types.ts              All TypeScript interfaces
  config.ts             Config loader with defaults and validation
  contract.ts           Contract schema validation
  parser.ts             JSON contract extraction from agent output
  router.ts             Action-to-agent routing
  orchestrator.ts       Main run loop
  human-gate.ts         Interactive human input via readline
  runtime.ts            Lock file, JSONL logger, timeout resolution
  git-state.ts          Git repo state detection (HEAD + status)
  adapters/
    index.ts            Agent dispatcher
    base.ts             Spawn + capture logic, mode-based command resolution
    claude.ts           Claude Code adapter (stream-json parsing)
    codex.ts            Codex adapter (JSON line parsing)
    gemini.ts           Gemini adapter (stream-json delta parsing)
tests/
  contract.test.ts      Contract validation tests
  parser.test.ts        Parser extraction tests
  orchestrator.test.ts  End-to-end orchestrator tests
  orchestrator-output.test.ts  Output formatting tests
  adapter-base.test.ts  Base adapter tests
  claude-adapter.test.ts
  codex-adapter.test.ts
  gemini-adapter.test.ts
```

---

## Developer / API Docs

For programmatic usage, custom adapters, runtime injection, and internal module contracts, see **[API.md](./API.md)**.

Quick example — embedding the orchestrator in your own tool:

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
```

---

## Design Principles

1. **Keep the orchestrator dumb.** Logic lives in agent prompts, not the pipe.
2. **Keep the contract small.** A few fields for routing, nothing more.
3. **Repo is shared state.** Agents read code directly. No code payloads in the contract.
4. **Agents are opaque to each other.** No agent names in the contract. Only abstract actions.
5. **Interrupt human only when needed.** On `ask-human`, parse failures, or safety limits.

---

## Why This Is Different From Cursor/IDE Multi-Agent

Cursor and similar IDE tools can spin up multiple sub-agents with custom personas and models. But they can't orchestrate powerful standalone agentic coding CLIs like Claude Code, Codex, or [Gemini CLI](https://github.com/google-gemini/gemini-cli) — each of which is a full autonomous system with its own shell access, tool use, and execution environment.

This project makes those independent CLI agents work together. Each agent runs as its own process with full autonomy over the repo. The orchestrator is just a pipe between them.

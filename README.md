# coding-agent-git-pipe

A lightweight TypeScript CLI orchestrator that chains autonomous AI coding agents (Claude Code, Codex, Gemini) into automated workflows using a minimal JSON contract. Each agent has full repo access, shell execution, and autonomy. The orchestrator just passes messages between them.

## The Idea

Each agent thinks it's talking to a human. It's not. It's talking to another agent through this pipe. The agents don't know each other exist — they only see abstract actions (plan, implement, review), never agent names. The orchestrator stays dumb; the agents' autonomy is the feature.

## Problem

Multi-agent coding in the terminal today means manual copy-paste:

1. Ask Agent A to plan.
2. Copy response.
3. Paste to Agent B to implement.
4. Copy back to Agent C for review.
5. Repeat.

This project automates that loop. The human approves at key decision points instead of relaying messages.

## How It Works

```
You: agent-pipe run "implement JWT refresh token flow"

  Orchestrator -> Claude (plans the approach)
  Claude -> Codex (implements the code, runs tests)
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

## Design Principles

1. **Keep the orchestrator dumb.** Logic lives in agent prompts, not the pipe.
2. **Keep the contract small.** A few fields for routing, nothing more.
3. **Repo is shared state.** Agents read code directly. No code payloads in the contract.
4. **Agents are opaque to each other.** No agent names in the contract. Only abstract actions.
5. **Interrupt human only when needed.** On `ask-human`, parse failures, or safety limits.

## Contract Schema

Each agent response must end with a JSON contract:

```json
{
  "contract_version": "1",
  "next_action": "plan | implement | review | ask-human | done",
  "to": "(optional) plan | implement | review | ask-human | done",
  "message": "task/context for next step",
  "questions": [{ "id": "q1", "text": "Only used when next_action=ask-human" }]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `contract_version` | Yes | Always `"1"` |
| `next_action` | Yes | What should happen next |
| `to` | No | Override routing (uses action names, not agent names) |
| `message` | Yes | Context passed to the next step |
| `questions` | Only for `ask-human` | Questions for the human to answer |

Note: `to` uses action names (`plan`, `implement`, `review`) — never agent names. The routing config maps actions to agents internally.

## Configuration

Create `.agentpipe.json` at repo root:

```json
{
  "routing": {
    "plan": "claude",
    "implement": "codex",
    "review": "gemini",
    "ask-human": "human",
    "done": "stop"
  },
  "max_hops": 10,
  "first_agent": "claude",
  "agent_timeout_ms": 1800000,
  "max_invalid_contract_retries": 1,
  "no_progress_hops": 3,
  "lock_file": ".agentpipe.lock",
  "log_dir": ".agentpipe/runs",
  "agent_timeouts_ms": {},
  "adapter_modes": {
    "claude": "auto",
    "codex": "auto",
    "gemini": "auto"
  },
  "adapters": {}
}
```

All fields are optional. Defaults are applied for anything not specified.

### Adapter Modes

Each agent can run in one of two modes:

| Mode | Behavior |
|------|----------|
| `auto` | Full autonomous agent with file editing, command execution, tool use |
| `print` | Text-only output, no tool use |

Print mode is currently only supported for Claude, which has a distinct print command (`claude -p`). Codex and Gemini do not have built-in print-mode commands — setting `"print"` for them will throw an error. To run them in a restricted mode, provide a custom command via the `adapters` field.

| Agent | `auto` | `print` |
|-------|--------|---------|
| claude | `claude --dangerously-skip-permissions` | `claude -p` |
| codex | `codex exec --skip-git-repo-check ...` | Not supported (use `adapters` override) |
| gemini | `gemini` | Not supported (use `adapters` override) |

Default mode is `auto` (the whole point is autonomous agents). Set `"print"` for Claude when you only want text output:

```json
{
  "adapter_modes": {
    "claude": "print"
  }
}
```

To run other agents in a restricted mode, override their command directly:

```json
{
  "adapters": {
    "claude": ["claude", "--dangerously-skip-permissions", "--model", "opus"]
  }
}
```

Explicit `adapters` entries take priority over `adapter_modes`.

### Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `routing` | `Record<action, target>` | plan->claude, implement->codex, review->gemini | Maps actions to agents |
| `max_hops` | `number` | `10` | Max routing hops before stopping |
| `first_agent` | `string` | `"claude"` | Which agent receives the initial task |
| `agent_timeout_ms` | `number` | `1800000` (30min) | Default per-agent timeout |
| `max_invalid_contract_retries` | `number` | `1` | Retries for invalid contract output |
| `no_progress_hops` | `number` | `3` | Ask human if repo unchanged for N hops (0 = disabled) |
| `lock_file` | `string` | `".agentpipe.lock"` | Lock file path for concurrency protection |
| `log_dir` | `string` | `".agentpipe/runs"` | JSONL log directory |
| `agent_timeouts_ms` | `Record<agent, number>` | `{}` | Per-agent timeout overrides |
| `adapter_modes` | `Record<agent, "print"\|"auto">` | `{}` (all default to `auto`) | Per-agent execution mode |
| `adapters` | `Record<agent, string[]>` | `{}` | Per-agent command override |

## Orchestrator Loop

1. Start run with task string.
2. Acquire lock file (prevents concurrent runs).
3. Invoke first agent with task + contract suffix.
4. Stream stdout/stderr to terminal live.
5. Parse final JSON contract block from output.
6. Validate contract fields.
7. Route to next target via config.
8. On target `human` (default for `ask-human`) or failures: pause for human input.
9. On target `stop` (default for `done`) or `max_hops`: stop.
10. Check no-progress guard (git state unchanged?).
11. Write JSONL events per step. Release lock on exit/signals.

## Local Setup

```bash
npm install
npm run build
npm link
cagp --help
```

## Usage

```bash
# Basic run
agent-pipe run "plan and implement JWT refresh token flow"

# Short alias
cagp run "add dark mode support"

# With options
agent-pipe run "refactor auth module" \
  --first-agent codex \
  --max-hops 5 \
  --timeout-ms 600000 \
  --no-progress-hops 2

# Custom config
agent-pipe run "fix login bug" --config ./my-config.json --cwd /path/to/repo
```

### CLI Flags

| Flag | Description |
|------|-------------|
| `--first-agent <name>` | First agent: `claude`, `codex`, or `gemini` |
| `--max-hops <n>` | Maximum routing hops |
| `--timeout-ms <n>` | Per-agent timeout in milliseconds |
| `--max-retries <n>` | Contract parse retries before escalating |
| `--no-progress-hops <n>` | Ask human if repo unchanged for N steps |
| `--config <path>` | Path to config JSON |
| `--cwd <path>` | Working directory |
| `-v, --version` | Show version |
| `-h, --help` | Show help |

## Tests

```bash
npm test
```

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
    claude.ts           Claude Code adapter
    codex.ts            Codex adapter
    gemini.ts           Gemini adapter
tests/
  contract.test.ts      Contract validation tests
  parser.test.ts        Parser extraction tests
  orchestrator.test.ts  End-to-end orchestrator tests
```

## Why This Is Different From Cursor/IDE Multi-Agent

Cursor and similar IDE tools can spin up multiple sub-agents with custom personas and models. But they can't orchestrate powerful standalone agentic coding CLIs like Claude Code, Codex, or Gemini CLI — each of which is a full autonomous system with its own shell access, tool use, and execution environment.

This project makes those independent CLI agents work together. Each agent runs as its own process with full autonomy over the repo. The orchestrator is just a pipe between them.

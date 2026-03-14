<div align="center">

# agent-pipe

### You wouldn't let one developer write the code and review it themselves. Why are you doing that with AI?

[![npm version](https://img.shields.io/npm/v/agent-pipe)](https://www.npmjs.com/package/agent-pipe)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

```
npm install -g agent-pipe
```

</div>

---

`agent-pipe` (`cagp`) is a tiny CLI that wires Claude, Codex, and Gemini into a real engineering team workflow — plan, discuss, implement, review, iterate — with structured handoffs between models, not copy-paste.

One command. Multiple AI brains. Code that went through an actual review cycle before it lands.

```bash
agent-pipe run "implement JWT refresh token flow" --discuss
```

```
  ┌─ plan & discuss ─────────────────────────────────────────────────────────┐
  │                                                                           │
  │  Codex  →  "Add refresh token rotation with 7-day expiry, blacklisting   │
  │             on logout, and silent re-auth on 401"                         │
  │                                                                           │
  │  Claude →  partial  "How do we handle token revocation across instances?" │
  │  Gemini →  agree    "Solid approach. Add revocation list to the plan."    │
  │                                                                           │
  │  Codex  →  (revised) "Added Redis-backed revocation list to approach"    │
  │  Claude →  agree                                                          │
  │  Gemini →  agree    ✓ consensus reached                                   │
  └───────────────────────────────────────────────────────────────────────────┘

  ┌─ implement ──────────────────────────────────────────────────────────────┐
  │  [codex][primary] Implementing JWT refresh with rotation...              │
  │  [codex][primary] Writing tests...                                       │
  │  [codex][primary] ✓ done — routing to review                            │
  └───────────────────────────────────────────────────────────────────────────┘

  ┌─ review ─────────────────────────────────────────────────────────────────┐
  │  [gemini][review] ↻ request-changes                                      │
  │  │ src/auth/tokens.ts:47  — refresh token not invalidated on rotation    │
  │  │ src/auth/tokens.ts:89  — missing null check before decode             │
  └───────────────────────────────────────────────────────────────────────────┘

  ┌─ fix & re-review ────────────────────────────────────────────────────────┐
  │  [codex][primary] Addressing 2 review comments...                        │
  │  [gemini][review] ✓ approve                                              │
  └───────────────────────────────────────────────────────────────────────────┘

  ✅  done  (7 hops · log: .agentpipe/runs/abc-123.jsonl)
```

---

## Why does this exist?

Every experienced engineering team enforces one rule: **the person who writes the code does not review it alone.** It is the single most effective quality control that exists. Fresh eyes catch what the author's brain smooths over.

We abandoned that rule the moment we started using AI coding agents.

When Claude writes your auth module and Claude reviews it, the same reasoning patterns that introduced the bug are reviewing the bug. It has consistent blind spots — and so does every other model. What looks "complete" to the author always has gaps that a different perspective would catch.

Beyond review, each model genuinely thinks differently. Claude is strong at architecture and planning. Codex is fast, pragmatic, and great at grinding through implementation. Gemini has a huge context window and a different analytical lens. Running all your tasks through one model wastes what the others are good at.

`agent-pipe` fixes both problems. It orchestrates real autonomous coding CLIs into a `plan → discuss → implement → review` loop, with structured JSON contracts as the handoff mechanism. Each agent runs as its own process with full shell access, file editing, and tool use — these aren't personas inside one app. They're independent tools passing work to each other.

---

## What it actually does

```
                                         ┌─────────────┐
  Your task ──────────────────────────▶ │    Plan     │ (primary proposes approach)
                                         └──────┬──────┘
                                                │
                                         ┌──────▼──────┐
                                         │   Discuss   │ (others review + raise concerns)
                                         └──────┬──────┘
                                    revise │         │ consensus
                                           ◀─────────┘
                                                │
                                         ┌──────▼──────┐
                                         │  Implement  │◀──────────────┐
                                         └──────┬──────┘               │
                                      pair │    │ review               │ request-changes
                                           ▼    ▼                      │
                                        Pair  Review ─────────────────▶┘
                                        agent   │ approve
                                                ▼
                                             ✅ Done
```

- **Plan & discuss** is optional (`--discuss`). Skip it for quick tasks.
- **Review** is always enforced when repo state changed (configurable).
- **Review iteration** loops automatically — reviewer flags specific `file:line` issues, implementer fixes them, reviewer re-reviews. Up to `max_review_iterations` cycles.
- **Pair** is advisory: an agent can call in the pair model mid-task for advice, then continue. No routing control.
- **Session continuity**: `primary → review → primary` resumes the same agent session, not a fresh one.
- **Human gates**: The orchestrator pauses for you on `ask-human`, no-progress stalls, and before truly finishing.

---

## Install

```bash
npm install -g agent-pipe
```

You need **Node.js 20+** and at least one of these CLIs installed and authenticated:

| Agent | Install | Auth |
|-------|---------|------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `npm install -g @anthropic-ai/claude-code` | `claude` |
| [Codex](https://github.com/openai/codex) | `npm install -g @openai/codex` | `OPENAI_API_KEY` env var |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | `gemini` |

You do not need all three. See [Using With Fewer Agents](#using-with-fewer-agents).

---

## Get started in 2 minutes

```bash
# 1. Go to your repo
cd /path/to/your-project

# 2. Create a config (edit routing to match the CLIs you actually have)
agent-pipe init

# 3. Run a task
agent-pipe run "add rate limiting to the auth endpoints"

# 4. Run with team discussion first
agent-pipe run "refactor the payment module" --discuss
```

After `init`, open `.agentpipe.json` and set `routing.primary`, `routing.review`, and `routing.pair` to the CLIs you have installed. The defaults (`codex`/`gemini`/`claude`) are just a template.

---

## Interactive mode

Run `agent-pipe` with no arguments in a terminal and you get a REPL — type tasks, see runs, come back for more without reinvoking the CLI each time:

```
$ agent-pipe

  agent-pipe v1.2.0 — interactive mode
  Type a task (with optional flags) or a command.
  Commands: /help, /quit

> add dark mode to the settings page
  ... [runs the full orchestration] ...

> fix the flaky test in auth.test.ts --primary-agent claude --max-hops 5
  ... [runs again] ...

> /quit
Bye!
```

Full CLI flags work inline. `/help` shows usage. Ctrl+D or `/quit` exits.

---

## CLI reference

```bash
agent-pipe run "<task>" [options]
agent-pipe init [options]
agent-pipe          # interactive REPL (TTY only)
```

### Run options

| Flag | Default | Description |
|------|---------|-------------|
| `--primary-agent <name>` | config | Override primary agent: `claude`, `codex`, `gemini` |
| `--discuss` | off | Run plan & discuss phase before implementation |
| `--max-hops <n>` | `50` | Hard cap on routing hops |
| `--timeout-ms <n>` | `1800000` | Per-agent timeout (30 min default) |
| `--max-retries <n>` | `1` | Contract parse retries before asking human |
| `--no-progress-hops <n>` | `3` | Ask human if repo is unchanged for N steps (0 = off) |
| `--ui <mode>` | `auto` | `auto` / `plain` / `tui` — see below |
| `--config <path>` | `.agentpipe.json` | Config file path |
| `--cwd <path>` | cwd | Target repo directory |

### Init options

| Flag | Description |
|------|-------------|
| `--config <path>` | Config output path |
| `--cwd <path>` | Target repo directory |
| `--force` | Overwrite existing config |

### UI modes

| Mode | When | Behavior |
|------|------|----------|
| `auto` | default | TUI in a real terminal, plain text in pipes/CI |
| `plain` | scripts, CI | Plain prefixed lines — `[agent][scope] output` |
| `tui` | force Ink | Live-rendered UI with contract briefs and styled input |

---

## Configuration

```bash
agent-pipe init   # writes .agentpipe.json
```

The generated file has every field with its default value and a comment in the format. The most important thing to set is `routing`:

```json
{
  "routing": {
    "primary": "codex",
    "review": "claude",
    "pair": "gemini",
    "ask-human": "human",
    "done": "stop"
  }
}
```

Everything else is optional — sensible defaults apply.

### Full config reference

| Field | Default | Description |
|-------|---------|-------------|
| `routing` | codex/gemini/claude | Maps actions to agents. **Change this** to match what you have installed. |
| `max_hops` | `50` | Max routing hops before stopping |
| `agent_timeout_ms` | `1800000` | Per-agent timeout (ms) |
| `max_invalid_contract_retries` | `1` | Contract parse retries before human escalation |
| `no_progress_hops` | `3` | Ask human if repo state unchanged for N steps (0 = off) |
| `lock_file` | `.agentpipe.lock` | Prevents concurrent runs in the same repo |
| `log_dir` | `.agentpipe/runs` | JSONL run log directory |
| `review_gate` | `true` | Force `primary → done` through review if repo changed since last review |
| `max_review_iterations` | `3` | Max review → fix → re-review cycles |
| `discussion.enabled` | `false` | Enable plan & discuss phase (or use `--discuss`) |
| `discussion.participants` | `[]` | Agents to include in discussion (empty = infer from routing) |
| `discussion.max_rounds` | `3` | Discussion rounds before deadlock → human |
| `discussion.require_consensus` | `true` | False = partial consensus (no disagreements) is enough |
| `agent_timeouts_ms` | `{}` | Per-agent timeout overrides |
| `adapter_modes` | `{}` | `"auto"` (default) or `"print"` per agent |
| `adapter_args` | `{}` | Extra CLI flags appended to the resolved adapter command |
| `adapters` | `{}` | Full command override per agent |
| `step_prompts` | `{}` | Hidden instructions injected per stage: `primary`, `review`, `pair` |

Add to `.gitignore`:
```
.agentpipe.lock
.agentpipe/
```

### Using with fewer agents

You do not need all three. Route unused actions to the tools you have:

**Claude only:**
```json
{ "routing": { "primary": "claude", "review": "claude", "pair": "claude", "ask-human": "human", "done": "stop" } }
```

**Claude + Codex (no Gemini):**
```json
{ "routing": { "primary": "codex", "review": "claude", "pair": "claude", "ask-human": "human", "done": "stop" } }
```

### Model selection

There is no top-level `model` field. Pass model flags through `adapter_args` — the built-in streaming and session-resume paths stay intact:

```json
{
  "adapter_args": {
    "claude": ["--model", "claude-opus-4-5", "--permission-mode", "auto"],
    "codex": ["--full-auto", "-m", "o4-mini"],
    "gemini": ["--model", "gemini-2.5-pro"]
  }
}
```

### Custom agent commands

Swap any agent slot for a completely different tool:

```json
{
  "routing": { "primary": "codex" },
  "adapters": { "codex": ["aider", "--yes", "--message"] }
}
```

### Step prompts

Inject hidden instructions per orchestration stage — agents receive them in their prompt without you having to repeat them in every task:

```json
{
  "step_prompts": {
    "primary": ["Always write tests alongside implementation."],
    "review": ["Check for missing error handling and untested edge cases."],
    "pair": ["Give concrete advice. Do not modify files directly."]
  }
}
```

---

## How the plan & discuss phase works

Enable with `--discuss` or `"discussion": { "enabled": true }` in config.

Before any code is written:

1. **Propose** — the primary agent reads the task and outputs a structured plan: what to build, how, which files to touch.
2. **Discuss** — each participant (other agents from routing, or your explicit `participants` list) reviews the plan and returns a `sentiment` (agree / disagree / partial) with specific `concerns`.
3. **Consensus** — if everyone agrees (or `require_consensus: false` and no one disagrees), the plan is locked and implementation starts.
4. **Revise** — if there's disagreement, all feedback goes back to the proposer, who revises and re-proposes. Up to `max_rounds` times.
5. **Deadlock** — if consensus isn't reached, you're asked to decide.

The approved plan becomes the implementation task. The primary agent starts with a team-vetted blueprint instead of flying blind.

---

## How review iteration works

Review is not a one-shot gate. When the reviewer returns `request-changes`:

1. The reviewer includes `review_comments` — each one has a `file`, `line`, and `comment`.
2. The orchestrator formats the feedback and routes back to the primary agent automatically.
3. The primary agent addresses the comments and routes back to review.
4. This repeats until `approve` or until `max_review_iterations` is hit.

```
[gemini][review] ↻ request-changes
  src/auth/tokens.ts:47  — refresh token not invalidated on rotation
  src/auth/tokens.ts:89  — missing null check before JWT decode

[codex][primary] Fixing 2 review comments...

[gemini][review] ✓ approve
```

This is what real code review looks like. Not a rubber stamp — an actual back-and-forth until the code is right.

---

## Session continuity

`agent-pipe` maintains one session per agent CLI across the full run. When `primary → review → primary`, Codex resumes where it left off instead of starting from scratch. The same applies to pair hops — all pair calls from the same run reuse the same agent session.

Built-in adapters use native session IDs when the CLI supports them. For Codex, there's a fallback to Codex's local state DB if the session ID is not emitted in stdout.

---

## The contract

Every agent response must end with a JSON block. This is how agents tell the orchestrator what should happen next without knowing who else is in the pipeline:

```json
{
  "contract_version": "1",
  "next_action": "review",
  "message": "Implemented token rotation. Auth middleware updated. Tests pass.",

  // Optional — review phase only
  "review_verdict": "request-changes",
  "review_comments": [
    { "file": "src/auth.ts", "line": 47, "comment": "Token not invalidated on rotation" }
  ],

  // Optional — discuss phase only
  "sentiment": "partial",
  "concerns": ["No revocation strategy for distributed deployments"],
  "proposal": { "summary": "...", "approach": "...", "files": ["src/auth.ts"] },

  // Optional — when agent needs human input
  "next_action": "ask-human",
  "questions": [{ "id": "q1", "text": "Which database should we use for the token store?" }]
}
```

`next_action` uses abstract action names (`primary`, `review`, `pair`, `ask-human`, `done`) — never agent names. The routing config maps actions to agents. Agents don't know which model is on the other end.

---

## Output and logs

### Terminal output

Agent output streams live, prefixed with agent name and scope:

```
[codex][primary] Implementing token rotation logic...
[codex][primary] Running test suite — all 47 tests pass
[claude][pair]   Consider rotating the signing key on token renewal too
[gemini][review] ↻ request-changes | src/auth.ts:47 — token not invalidated
[codex][primary] Fixing 2 comments from review...
[gemini][review] ✓ approve
```

A heartbeat appears every 10 seconds if an agent is running but silent.

### JSONL logs

Every run produces `.agentpipe/runs/{runId}.jsonl` — a timestamped, structured log of every step, contract, human response, routing decision, and timing. Useful for debugging, auditing, and replaying.

```jsonl
{"ts":"...","type":"run_started","primary_agent":"codex","max_hops":50}
{"ts":"...","type":"step_contract","step_id":3,"contract":{"next_action":"review","review_verdict":"request-changes"}}
{"ts":"...","type":"review_approved","step_id":5,"iterations":1}
{"ts":"...","type":"run_completed","status":"done"}
```

---

## Troubleshooting

**`command not found: claude` (or codex, gemini)**
The CLI is not installed. Install it and make sure it is in your `PATH`.

**`Lock file exists` error**
Another run is active, or a previous run crashed. The orchestrator auto-reclaims stale locks (dead PID). If you're sure nothing is running: `rm .agentpipe.lock`

**Agent keeps producing invalid contracts**
Try `--max-retries 3`. If persistent, the model may not be following the contract format. Check `contract_invalid` events in the JSONL log.

**`No progress` keeps prompting**
The no-progress guard fires when git state is unchanged for N consecutive steps. For analysis tasks that don't write code: `--no-progress-hops 0`

**Agent times out**
Default is 30 min. For complex tasks: `--timeout-ms 3600000`. For per-agent control, use `agent_timeouts_ms` in config.

**Discussion keeps ending in deadlock**
Try `"require_consensus": false` — partial consensus (no hard disagreements) is often enough to proceed.

---

## Tests

```bash
npm test
```

Uses Node.js built-in test runner with `tsx`. All external dependencies (agent invocation, human input, git state) are injected at test time — no real AI CLIs needed to run the test suite.

---

## Project structure

```
src/
  cli.ts              Argument parsing, validation, REPL loop, main entry
  orchestrator.ts     Main run loop — phases, routing, review iteration
  discussion.ts       Plan & discuss engine — proposal, consensus, revision
  run-ui.ts           RunSurface — plain and TUI rendering surfaces
  config.ts           Config loader, validator, and defaults
  types.ts            All TypeScript types
  contract.ts         Contract schema validation
  parser.ts           JSON contract extraction from agent output
  router.ts           Action → agent routing
  human-gate.ts       Readline-based human input
  runtime.ts          Lock file, JSONL logger, timeout resolution
  git-state.ts        Git repo state (HEAD + status hash)
  ui.ts               Shared text formatters
  adapters/           Claude, Codex, Gemini adapters + spawn/capture base
  ink/                Ink UI components (REPL prompt, run view, human input)
tests/
  orchestrator.test.ts
  discussion.test.ts
  run-ui.test.ts
  cli.test.ts
  contract.test.ts
  parser.test.ts
  ...
```

---

## Programmatic API

```typescript
import { runOrchestrator } from "agent-pipe/src/orchestrator";

const result = await runOrchestrator({
  task: "add rate limiting to auth endpoints",
  primaryAgent: "codex",
  discuss: true,
  uiMode: "plain",
  cwd: "/path/to/repo",
  runtime: {
    // inject stubs for testing or custom integrations
    invokeAgent: myCustomAgent,
    askHumanInput: async (payload) => "continue",
    getRepoStateSignature: () => null,
  },
});

console.log(result.status);  // "done" | "max-hops"
console.log(result.hops);    // number of steps
console.log(result.logPath); // path to JSONL log
```

See [API.md](./API.md) for the full reference — `RunInput`, `RunSurface`, adapters, runtime injection, and JSONL event types.

---

## Design principles

- **The orchestrator is dumb.** Routing logic lives in agent prompts via the contract, not in the pipe.
- **The contract is small.** Core routing fields only. No code payloads, no file contents.
- **The repo is shared state.** Agents read files directly from disk. The handoff is a task description, not a data transfer.
- **Routing is action-based.** Agents say `review`, not `gemini`. The config maps that to whichever model you have.
- **Interrupt human only when needed.** On `ask-human`, deadlocks, parse failures, or safety limits. Not on every step.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Keep changes focused, update docs when behavior changes, open an issue before large refactors or new adapter ideas.

Bugs, feature requests, and routing/adapter questions: [GitHub Issues](https://github.com/vjvkrm/coding-agent-git-pipe/issues). Include your version, command, relevant `.agentpipe.json` snippets, and JSONL log excerpts if the problem is a contract or handoff failure.

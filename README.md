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

`agent-pipe` (`cagp`) is a tiny CLI that wires Claude, Codex, and Gemini into a real engineering team workflow — brainstorm, implement, review, iterate — with structured handoffs between models, not copy-paste.

Four commands. Two AI brains. Code that went through an actual review cycle before it lands.

```bash
agent-pipe fast "add rate limiting"          # implement + review
agent-pipe fix "login fails with + in email" # diagnose together, then fix + review
agent-pipe build "JWT refresh token flow"    # brainstorm, then implement + review
agent-pipe brainstorm "Redis vs Memcached?"  # brainstorm only, no code
```

```
  ━━ Brainstorm ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Agents: Claude + Codex
  Max turns: 20

  ▸ Both Claude and Codex thinking in parallel...

  turn 1: Claude → "Add refresh token rotation with 7-day expiry, Redis
           revocation list, silent re-auth on 401"
  turn 1: Codex  → "Token rotation + blacklist on logout. Use DB not Redis
           — simpler for this scale"

  ── Turn 2/20 │ Claude ──────────────────────────
  turn 2: Claude → "DB adds latency on every auth check. Redis is O(1)
           lookup. But agree on rotation approach."

  ── Turn 3/20 │ Codex ───────────────────────────
  turn 3: Codex  → "AGREED — Redis for revocation, DB for refresh token
           store. Rotation with 7-day expiry.
           Pros: fast revocation check, simple rotation
           Cons: Redis dependency, need cache invalidation on deploy"

  ✓ Agreed at turn 3

  ━━ Implementation ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  [claude][primary] Implementing JWT refresh with rotation...
  [claude][primary] Writing tests...
  [claude][primary] ✓ done — routing to review

  [codex][review] ↻ request-changes
  │ src/auth/tokens.ts:47  — refresh token not invalidated on rotation
  │ src/auth/tokens.ts:89  — missing null check before decode

  [claude][primary] Fixing 2 review comments...
  [codex][review] ✓ approve

  ✅  done  (8 hops · log: .agentpipe/runs/abc-123.jsonl)
```

---

## Why does this exist?

Every experienced engineering team enforces one rule: **the person who writes the code does not review it alone.** It is the single most effective quality control that exists. Fresh eyes catch what the author's brain smooths over.

We abandoned that rule the moment we started using AI coding agents.

When Claude writes your auth module and Claude reviews it, the same reasoning patterns that introduced the bug are reviewing the bug. It has consistent blind spots — and so does every other model. What looks "complete" to the author always has gaps that a different perspective would catch.

Beyond review, each model genuinely thinks differently. Claude is strong at architecture and planning. Codex is fast, pragmatic, and great at grinding through implementation. Running all your tasks through one model wastes what the others are good at.

`agent-pipe` fixes both problems. It orchestrates real autonomous coding CLIs into a `brainstorm → implement → review` loop, with structured JSON contracts as the handoff mechanism. Each agent runs as its own process with full shell access, file editing, and tool use — these aren't personas inside one app. They're independent tools passing work to each other.

---

## What it actually does

```
                                         ┌──────────────┐
  Your task ──────────────────────────▶ │  Brainstorm  │ (both agents propose in parallel,
                                         │              │  then discuss until agreed)
                                         └──────┬───────┘
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

### Commands

| Command | What happens |
|---------|-------------|
| **`fast`** | Straight to implement + review. No brainstorm. For quick tasks. (`run` is an alias) |
| **`fix`** | Both agents diagnose the bug in parallel, compare notes (max 20 turns), agree on root cause + minimal fix, then implement + review. |
| **`build`** | Both agents brainstorm the design in parallel, discuss until agreed (max 20 turns), then implement + review. For new features and refactors. |
| **`brainstorm`** | Brainstorm only — no implementation. Both agents propose, discuss, output agreed plan with pros/cons. For architecture decisions and design questions. |

### Defaults

- **Primary agent**: Claude (implements)
- **Secondary agent**: Codex (reviews, and brainstorms alongside primary)
- **Max brainstorm/diagnose turns**: 20

### Key behaviors

- **Brainstorm** starts both agents in parallel — no anchoring bias. They converge through terse, agent-to-agent discussion. When one says "AGREED", the plan is locked.
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

# 3. Quick task — implement + review
agent-pipe fast "add rate limiting to the auth endpoints"

# 4. Bug fix — diagnose together, then fix
agent-pipe fix "auth token not refreshing after expiry"

# 5. New feature — brainstorm first, then build
agent-pipe build "add webhook system for payment events"

# 6. Design question — brainstorm only
agent-pipe brainstorm "should we use event sourcing or CRUD for the order system?"
```

After `init`, open `.agentpipe.json` and set `routing.primary` and `routing.review` to the CLIs you have installed. The defaults (`claude`/`codex`) work if you have both.

---

## Interactive mode

Run `agent-pipe` with no arguments in a terminal and you get a REPL:

```
$ agent-pipe

  agent-pipe v1.3.0 — interactive mode
  Commands: fast, fix, build, brainstorm
  Example: fix "auth token not refreshing"
  /help, /quit

> fast add dark mode to the settings page
  ... [runs implement + review] ...

> fix flaky test in auth.test.ts --max-hops 5
  ... [diagnoses + fixes] ...

> brainstorm should we split the monolith into microservices
  ... [brainstorm only] ...

> /quit
Bye!
```

Prefix with the command name. Full CLI flags work inline. `/help` shows usage. Ctrl+D or `/quit` exits.

---

## CLI reference

```bash
agent-pipe fast "<task>" [options]        # implement + review
agent-pipe fix "<bug>" [options]          # diagnose + fix + review
agent-pipe build "<feature>" [options]    # brainstorm + implement + review
agent-pipe brainstorm "<question>" [options]  # brainstorm only
agent-pipe run "<task>" [options]         # alias for fast
agent-pipe init [options]
agent-pipe                                # interactive REPL (TTY only)
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--primary-agent <name>` | `claude` | Override primary agent: `claude`, `codex`, `gemini` |
| `--max-turns <n>` | `20` | Max brainstorm/diagnose turns |
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

The most important thing to set is `routing`:

```json
{
  "routing": {
    "primary": "claude",
    "review": "codex",
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
| `routing` | claude/codex/gemini | Maps actions to agents. **Change this** to match what you have installed. |
| `brainstorm.max_turns` | `20` | Max brainstorm/diagnose discussion turns |
| `brainstorm.secondary_agent` | `"codex"` | Agent that brainstorms alongside primary |
| `max_hops` | `50` | Max routing hops before stopping |
| `agent_timeout_ms` | `1800000` | Per-agent timeout (ms) |
| `max_invalid_contract_retries` | `1` | Contract parse retries before human escalation |
| `no_progress_hops` | `3` | Ask human if repo state unchanged for N steps (0 = off) |
| `lock_file` | `.agentpipe.lock` | Prevents concurrent runs in the same repo |
| `log_dir` | `.agentpipe/runs` | JSONL run log directory |
| `review_gate` | `true` | Force `primary → done` through review if repo changed since last review |
| `max_review_iterations` | `3` | Max review → fix → re-review cycles |
| `agent_timeouts_ms` | `{}` | Per-agent timeout overrides |
| `adapter_modes` | `{}` | `"auto"` (default) or `"print"` per agent |
| `adapter_args` | `{}` | Extra CLI flags appended to the resolved adapter command |
| `adapters` | `{}` | Full command override per agent |
| `step_prompts` | `{}` | Hidden instructions injected per stage: `primary`, `review`, `pair` |

**Legacy fields** (still supported for backward compatibility):

| Field | Default | Description |
|-------|---------|-------------|
| `discussion.enabled` | `false` | Enable legacy plan & discuss phase (use `build` command instead) |
| `discussion.participants` | `[]` | Agents to include in discussion |
| `discussion.max_rounds` | `3` | Discussion rounds before deadlock → human |
| `discussion.require_consensus` | `true` | False = partial consensus is enough |

Add to `.gitignore`:
```
.agentpipe.lock
.agentpipe/
```

### Using with fewer agents

You do not need all three. Route unused actions to the tools you have:

**Claude only:**
```json
{ "routing": { "primary": "claude", "review": "claude", "pair": "claude", "ask-human": "human", "done": "stop" },
  "brainstorm": { "max_turns": 20, "secondary_agent": "claude" } }
```

**Claude + Codex (no Gemini) — the default:**
```json
{ "routing": { "primary": "claude", "review": "codex", "pair": "codex", "ask-human": "human", "done": "stop" } }
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

## How brainstorm works

Used by `build`, `fix`, and `brainstorm` commands.

1. **Parallel proposals** — both agents get the same task simultaneously and propose solutions independently. No anchoring bias.
2. **Back-and-forth** — agents take turns responding to each other. Terse, agent-to-agent style. No fluff or pleasantries.
3. **Agreement** — when one agent starts their response with "AGREED", the discussion ends and the final plan (with pros/cons) is locked.
4. **Max turns** — if agents don't agree within `max_turns` (default 20), the best proposal from the last exchange is used.

For `fix` mode, the prompts are focused on diagnosis: "what's broken, what's the root cause, what's the minimal fix." For `build`/`brainstorm`, they're focused on design: "what's the approach, what are the tradeoffs."

After brainstorm completes:
- **`build`** and **`fix`**: the agreed plan becomes the implementation task. Primary agent implements, secondary reviews.
- **`brainstorm`**: the run ends with the agreed plan. No code changes.

---

## How review iteration works

Review is not a one-shot gate. When the reviewer returns `request-changes`:

1. The reviewer includes `review_comments` — each one has a `file`, `line`, and `comment`.
2. The orchestrator formats the feedback and routes back to the primary agent automatically.
3. The primary agent addresses the comments and routes back to review.
4. This repeats until `approve` or until `max_review_iterations` is hit.

```
[codex][review] ↻ request-changes
  src/auth/tokens.ts:47  — refresh token not invalidated on rotation
  src/auth/tokens.ts:89  — missing null check before JWT decode

[claude][primary] Fixing 2 review comments...

[codex][review] ✓ approve
```

This is what real code review looks like. Not a rubber stamp — an actual back-and-forth until the code is right.

---

## Session continuity

`agent-pipe` maintains one session per agent CLI across the full run. When `primary → review → primary`, Claude resumes where it left off instead of starting from scratch. The same applies to pair hops — all pair calls from the same run reuse the same agent session.

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
[claude][primary] Implementing token rotation logic...
[claude][primary] Running test suite — all 47 tests pass
[gemini][pair]    Consider rotating the signing key on token renewal too
[codex][review]   ↻ request-changes | src/auth.ts:47 — token not invalidated
[claude][primary] Fixing 2 comments from review...
[codex][review]   ✓ approve
```

A heartbeat appears every 10 seconds if an agent is running but silent.

### JSONL logs

Every run produces `.agentpipe/runs/{runId}.jsonl` — a timestamped, structured log of every step, contract, human response, routing decision, and timing. Useful for debugging, auditing, and replaying.

```jsonl
{"ts":"...","type":"run_started","primary_agent":"claude","max_hops":50}
{"ts":"...","type":"brainstorm_parallel_start","primary":"claude","secondary":"codex"}
{"ts":"...","type":"brainstorm_turn","turn":3,"speaker":"codex","agreed":true}
{"ts":"...","type":"brainstorm_phase_completed","mode":"build","hops_used":4,"turns":4}
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

**Brainstorm takes too many turns**
Reduce with `--max-turns 5` for simpler decisions. The default of 20 is generous — most discussions converge within 3-5 turns.

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
  brainstorm.ts       Brainstorm engine — parallel proposals, back-and-forth, agreement
  discussion.ts       Legacy plan & discuss engine (still supported)
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
  taskMode: "build",
  primaryAgent: "claude",
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
- **Routing is action-based.** Agents say `review`, not `codex`. The config maps that to whichever model you have.
- **Brainstorm before you build.** Two independent proposals beat one. Agent-to-agent discussion catches blind spots before a single line of code is written.
- **Interrupt human only when needed.** On `ask-human`, deadlocks, parse failures, or safety limits. Not on every step.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Keep changes focused, update docs when behavior changes, open an issue before large refactors or new adapter ideas.

Bugs, feature requests, and routing/adapter questions: [GitHub Issues](https://github.com/vjvkrm/coding-agent-git-pipe/issues). Include your version, command, relevant `.agentpipe.json` snippets, and JSONL log excerpts if the problem is a contract or handoff failure.

# TODO

## Completed

### Phase 1: Project Setup
- [x] TypeScript toolchain (`typescript`, `tsx`).
- [x] Build and run scripts in `package.json`.

### Phase 2: Core Types and Parsing
- [x] `src/contract.ts` — schema validation and contract types.
- [x] Contract fields: `contract_version`, `next_action`, `to`, `message`, optional `questions`.
- [x] `src/parser.ts` — extract final JSON block from stdout.
- [x] Parser tests for valid/invalid outputs.

### Phase 3: Routing and Config
- [x] `.agentpipe.json` loader with defaults and deep merge.
- [x] `src/router.ts` — `next_action -> target` routing.
- [x] `to` override logic (routes through config, uses action names not agent names).
- [x] Validation for unknown actions/targets.

### Phase 4: Adapters
- [x] `src/adapters/base.ts` — spawn, capture, timeout.
- [x] `src/adapters/claude.ts`, `codex.ts`, `gemini.ts`.
- [x] Configurable command templates per adapter.
- [x] Adapter modes: `auto` (full autonomy) and `print` (text-only), per-agent configurable.

### Phase 5: Orchestrator Loop
- [x] `src/orchestrator.ts` run loop.
- [x] `hop_count` guard (`max_hops`).
- [x] One retry for invalid JSON, then escalate to `ask-human`.
- [x] `step_id` and structured run events.
- [x] Timeout and cancel handling per step.
- [x] Live stdout/stderr streaming.

### Phase 6: Human Gate
- [x] `src/human-gate.ts` with `readline`.
- [x] Render optional `questions[]` clearly.
- [x] Resume routing with human response as next message.

### Phase 7: Safety and Reliability
- [x] Lock file (`.agentpipe.lock`) to prevent concurrent runs.
- [x] Stale lock detection via PID check.
- [x] JSONL logs (`.agentpipe/runs/<run_id>.jsonl`).
- [x] No-progress guard: escalate if repo state unchanged for N consecutive hops.
- [x] Graceful recovery from adapter failure.
- [x] SIGINT/SIGTERM signal handling with lock cleanup.
- [x] Agent identity hidden from contract (agents see actions, not other agent names).

### Phase 8: CLI Commands
- [x] `agent-pipe run "<task>"` / `cagp run "<task>"`.
- [x] `--first-agent`, `--max-hops`, `--timeout-ms`, `--max-retries`, `--no-progress-hops`.
- [x] `--config`, `--cwd` path overrides.
- [x] `--version`, `--help`.

### Phase 9: Verification
- [x] Orchestrator tests: plan->implement->review->done.
- [x] Orchestrator tests: ask-human pause and resume.
- [x] Orchestrator tests: parse-failure retry behavior.
- [x] Orchestrator tests: max_hops termination.
- [x] Orchestrator tests: no-progress guard.
- [x] Parser tests: fenced JSON, raw JSON, missing block.
- [x] Contract tests: valid contract, invalid target.

---

## Remaining

### Phase 10: Release Prep
- [ ] Add `LICENSE` (MIT).
- [ ] Add `CONTRIBUTING.md`.
- [ ] Publish first npm prerelease.

### Phase 11: Hardening
- [ ] Parser: handle multiple JSON blocks in output (grab last one, not first).
- [ ] Pipe prompt via stdin instead of CLI argument (avoid `ARG_MAX` overflow on long prompts).
- [ ] Accept non-zero exit codes if agent produced valid output + contract.
- [ ] Add `--dry-run` flag to preview routing without invoking agents.
- [ ] Add `cagp replay <run_id>` to replay a logged run.

### Phase 12: Ecosystem
- [ ] Support additional agents (Aider, Copilot CLI, custom scripts).
- [ ] Plugin system for custom adapters (load from config path).
- [ ] Web dashboard to visualize run logs and agent handoffs.
- [ ] GitHub Action for running agent-pipe in CI.

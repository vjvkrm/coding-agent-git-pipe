# Changelog

All notable changes to this project will be documented in this file.

## 1.3.1 - 2026-04-15

### Fixed
- **Multi-line paste auto-submits**: Pasting text containing newlines into the REPL or human gate input no longer auto-submits each line. Newlines are now collapsed into spaces before processing. Affects both Ink TUI input (`SingleLineTextBox` via `InputOnly`) and the plain readline-based human gate.
- **Ctrl+C in REPL during a running task**: Pressing Ctrl+C while a task is running now cancels the run and returns to the REPL prompt instead of exiting the entire process. At the prompt itself, Ctrl+C clears the line and re-prompts.

## 1.3.0 - 2026-04-14

### Added
- **Task mode commands**: Four new CLI commands replace the old `run --discuss` workflow:
  - `agent-pipe fast "task"` — implement + review, no brainstorm. (`run` is an alias for backward compatibility)
  - `agent-pipe fix "bug"` — both agents diagnose the bug in parallel, discuss to agree on root cause and minimal fix, then implement + review.
  - `agent-pipe build "feature"` — both agents brainstorm the design in parallel, discuss until agreed, then implement + review.
  - `agent-pipe brainstorm "question"` — brainstorm only, no implementation. Outputs agreed plan with pros/cons.
- **Brainstorm engine** (`src/brainstorm.ts`): New module replacing the discussion model for day-to-day use. Both agents receive the task simultaneously, propose independently (no anchoring bias), then go back-and-forth in terse agent-to-agent discussion until one says "AGREED" or max turns is reached.
- **`--max-turns` flag**: Override the brainstorm/diagnose turn limit from the CLI (default: 20).
- **`brainstorm` config block**: `brainstorm.max_turns` (default 20) and `brainstorm.secondary_agent` (default "codex") in `.agentpipe.json`.
- **REPL command prefixes**: Interactive mode now recognizes `fast`, `fix`, `build`, `brainstorm` as prefixes. Example: `fix "auth token not refreshing"`.
- **New JSONL events**: `brainstorm_parallel_start`, `brainstorm_parallel_done`, `brainstorm_turn`, `brainstorm_phase_completed`.

### Changed
- **Default routing**: Primary agent is now `claude` (was `codex`), review agent is now `codex` (was `gemini`). This reflects the most common two-agent setup.
- **REPL banner**: Now shows available commands (`fast`, `fix`, `build`, `brainstorm`) with an example.
- **`--discuss` flag**: Still works for backward compatibility, but only applies when using the `fast` command. For new usage, prefer `build` or `brainstorm` commands.

### Deprecated
- The `--discuss` flag and `discussion.enabled` config are now legacy. They still work but the brainstorm-based commands (`build`, `fix`, `brainstorm`) are the recommended workflow.

## 1.2.1 - 2026-03-16

### Fixed
- **REPL input rendering**: Replaced the Ink-based REPL prompt with Node's built-in `readline`. The previous Ink + `ink-text-input` implementation was rendering each keystroke on a new line in VS Code and other terminals due to unreliable TTY/cursor-control detection in Ink 6. The REPL now uses `readline` for the prompt — copy-paste, arrow keys, and backspace all work correctly. The banner, `/help`, `/quit`, Ctrl+D, and inline flags are unchanged.

## 1.2.0 - 2026-03-14

### Added
- **Interactive REPL mode**: Running `agent-pipe` with no arguments in a TTY now launches an interactive prompt powered by Ink. Type tasks with any `run` flags inline and press Enter; the orchestrator runs and the prompt returns. Commands: `/help`, `/quit` (also `/exit`, `/q`), Ctrl+D.
- **TUI rendering mode** (`--ui tui|plain|auto`): New `--ui` CLI flag and `uiMode` field in `RunInput`. `auto` (default) uses Ink when both stdin and stdout are a TTY, otherwise falls back to plain text. The TUI surface renders live agent output, compact contract briefs (routing action + review verdict icon + message snippet), and a styled Ink human-input prompt.
- **`uiMode` in `RunInput`**: Programmatic callers can now pass `uiMode: "plain"` to suppress Ink rendering when embedding the orchestrator in their own tooling.
- **`discussion` block in default init config**: `agent-pipe init` now writes the full `discussion` object to `.agentpipe.json` with `enabled: false` and all fields visible, so users can enable discuss mode without looking up docs.
- **CLI input validation**: All `run` flags (`--max-hops`, `--timeout-ms`, `--max-retries`, `--no-progress-hops`, `--primary-agent`, `--ui`) are now validated before the orchestrator starts; errors are reported immediately with a clear message.
- **New Ink components**: `src/ink/` directory with `ReplApp`, `InputOnly`, `RunView`, `AgentOutput`, `HumanInput`, `SingleLineTextBox`, `Spinner`, and `normalizeSingleLineInput`.
- **New tests**: `tests/run-ui.test.ts` (surface rendering, contract extraction, UI mode resolution), `tests/ink-single-line-text-box.test.ts` (component tests), `tests/cli.test.ts` (argument parsing, REPL tokenizer, validation).

### Changed
- `printHelp` now returns a string via `helpText()` so it can be shown inline in REPL mode via `/help`.
- Running `agent-pipe` with no arguments in a non-TTY (pipe, CI) still prints help and exits — no change to scripted usage.

## 1.1.0 - 2026-03-11

### Added
- **Plan & discuss phase**: Agents now discuss and agree on an approach before implementing. Primary proposes, participants review with `sentiment` and `concerns`, iterate until consensus or human escalation. Enable with `--discuss` flag or `discussion.enabled` in config.
- **Iterative code review**: Reviewers can return `review_verdict: "request-changes"` with `review_comments` containing specific `file`, `line`, and `comment` for each issue. The orchestrator auto-routes back to primary for fixes, then re-reviews — up to `max_review_iterations` cycles.
- **Contract v2 fields** (all optional, backward-compatible):
  - `sentiment`: agree | disagree | partial | neutral
  - `concerns`: array of technical concerns
  - `proposal`: { summary, approach, files? }
  - `review_verdict`: approve | request-changes | reject
  - `review_comments`: [{ file?, line?, comment }]
  - `confidence`: 0-1 score
- **Config**: `discussion` object (`enabled`, `participants`, `max_rounds`, `require_consensus`), `max_review_iterations`.
- **CLI**: `--discuss` flag to enable discussion from the command line.
- **New module**: `src/discussion.ts` — plan, discuss, consensus checking, revision loop, human escalation.
- **New JSONL events**: `discussion_phase_started`, `discussion_phase_completed`, `plan_phase_started`, `plan_phase_completed`, `discussion_round_started`, `discussion_feedback`, `discussion_consensus`, `discussion_deadlock`, `proposal_revision_started`, `proposal_revised`, `review_iteration_redirect`, `review_approved`.
- **24 new tests**: contract v2 field validation (14), discussion engine (6), review iteration (3), discussion integration (1).

### Changed
- Review step prompt guidance now instructs agents to include `review_verdict` and `review_comments` in their contracts.
- `CONTRACT_SUFFIX` now shows optional `review_verdict` and `review_comments` fields.

## 1.0.1 - 2026-03-09

### Changed
- Simplified orchestration around `primary`, `pair`, and `review`.
- Increased the default `max_hops` from `20` to `50`.
- Clarified onboarding so `routing.primary`, `routing.pair`, and `routing.review` are treated as starter defaults that users should customize.

### Fixed
- Reused one logical session per agent across the full run, including pair hops from different stages.
- Improved Codex session recovery when `codex exec --json` does not emit a session id in stdout.
- Switched resumed Codex runs onto the JSON streaming path to avoid noisy raw stderr output.
- Made pair steps advisory-only at runtime by ignoring pair-step `next_action` and `to` values and using only the returned `message`.
- Added clearer pair-step prompt instructions so the pair agent returns advice for the caller instead of attempting to choose global routing.

### Docs
- Updated README and API docs to reflect the `primary` / `pair` / `review` model, per-agent session reuse, pair semantics, and current config defaults.

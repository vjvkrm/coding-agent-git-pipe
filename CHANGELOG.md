# Changelog

All notable changes to this project will be documented in this file.

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

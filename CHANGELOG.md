# Changelog

All notable changes to this project will be documented in this file.

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

# Quick Task: Configure GSD for Kimchi on a clean machine

**Date:** 2026-04-27
**Branch:** gsd/quick/1-let-s-assume-we-have-a-clean-gsd-envirom

## What Changed

- Rewrote the configuration prompt to use `kimchi` as the provider key
  (replacing the old `aie` name) throughout `models.json`, `settings.json`,
  and both the global and project-level `PREFERENCES.md` files.
- Sourced the project-level preferences from the actual
  `oc_salesanalyzer_control/.gsd/PREFERENCES.md` on the reference machine,
  replacing the earlier global-only preferences:
  - `research` / `subagent` → `kimchi/nemotron-3-super-fp4`
  - `planning` / `validation` / `auto_supervisor` → `kimchi/claude-opus-4-6`
  - `execution` / `completion` → `kimchi/kimi-k2.5`
  - `discuss` / `execution_simple` → `kimchi/minimax-m2.5`
  - `dynamic_routing` disabled (matches project setting)
  - Pre-dispatch lint/git-add hook reproduced verbatim
  - Post-milestone quality-audit hook reproduced verbatim (model updated
    to `kimchi/claude-opus-4-6`)
- Synced model IDs to those actually used by the project (`minimax-m2.5`,
  `claude-opus-4-6`) — the registry now contains both `claude-opus-4-7`
  (session default) and `claude-opus-4-6` (project planning model).
- Split preferences into two layers: global `~/.gsd/preferences.md`
  (skills, git, budget baseline) and project `.gsd/PREFERENCES.md`
  (all model routing and hooks) — matching how GSD merges them.
- Updated verification step to check that `kimchi/` appears on ≥9 lines
  in the project PREFERENCES and that `defaultProvider === "kimchi"`.

## Files Modified

- `.gsd/quick/1-let-s-assume-we-have-a-clean-gsd-envirom/configure-gsd-for-kimchi.prompt.md` (rewritten)
- `.gsd/quick/1-let-s-assume-we-have-a-clean-gsd-envirom/1-SUMMARY.md` (this file, updated)

## Verification

- Cross-checked every model ID in the prompt against
  `/Users/leonkuperman/LKDev/CAST/oc_salesanalyzer_control/.gsd/PREFERENCES.md`
  (source of truth) — all phase assignments match exactly.
- Confirmed `kimchi` provider key replaces `aie` in all four locations:
  `models.json` provider block, `settings.json` defaultProvider,
  global preferences tier_models, project preferences phase refs.
- Confirmed the `claude-opus-4-7` session default is still in the
  registry (used by `settings.json defaultModel`) even though the project
  routes planning/validation to `claude-opus-4-6`.
- No code on this machine was modified — deliverable is the prompt artifact.

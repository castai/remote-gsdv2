# Quick Task: Configure GSD for Kimchi on a clean machine

**Date:** 2026-04-27
**Branch:** gsd/quick/1-let-s-assume-we-have-a-clean-gsd-envirom

## What Changed

- Wrote a self-contained prompt that, when pasted into a fresh GSD session,
  configures the Kimchi (`aie`) OpenAI-compatible provider, collects the
  API key via `secure_env_collect`, writes `~/.gsd/agent/models.json` and
  `~/.gsd/agent/settings.json`, and writes `~/.gsd/preferences.md` so
  auto-mode behaves identically to this machine.
- Captured the full 5-model registry as it exists today
  (`claude-opus-4-7`, `claude-sonnet-4-6`, `nemotron-3-super-fp4`,
  `minimax-m2.7`, `kimi-k2.5`) including context windows, max tokens,
  reasoning flag, and cost table.
- Pinned every auto-mode phase (`research`, `planning`, `execution`,
  `execution_simple`, `completion`, `subagent`, `auto_supervisor`) to
  real registry IDs with explicit fallbacks. Documented the divergence
  from the reference machine's stale `openai-codex/gpt-5.4` placeholders
  and explained how to mirror byte-for-byte if needed.
- Included a 4-check verification block (registry shape + key length +
  default model + live `/setup llm --probe`) and explicit secret-handling
  rules (no echo, no `.env`, `chmod 600`).

## Files Modified

- `.gsd/quick/1-let-s-assume-we-have-a-clean-gsd-envirom/configure-gsd-for-kimchi.prompt.md` (new)
- `.gsd/quick/1-let-s-assume-we-have-a-clean-gsd-envirom/1-SUMMARY.md` (this file)

## Verification

- Cross-checked the reference data against live files on this machine:
  - `~/.gsd/agent/models.json` (provider `aie`, baseUrl `https://llm.kimchi.dev/openai/v1`, 5 models)
  - `~/.gsd/agent/settings.json` (`defaultProvider: aie`, `defaultModel: claude-opus-4-7`)
  - `~/.gsd/preferences.md` (mode, skills, auto_supervisor, dynamic_routing, notifications, git, budget)
- Confirmed the slash-command surface referenced in the prompt
  (`/gsd help`, `/gsd setup llm --probe`, `/gsd init`, `/gsd auto`)
  exists in `~/.gsd/agent/extensions/gsd/commands/catalog.js`.
- Confirmed `secure_env_collect` accepts `dotenv` destination with a
  custom `envFilePath`, which is what the prompt instructs.
- Reviewed `preferences-reference.md` to confirm the `models` schema
  (string vs object-with-fallbacks vs provider-qualified) used in the
  emitted preferences file is valid.
- No code on this machine was modified — the deliverable is a portable
  prompt artifact only.

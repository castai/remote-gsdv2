# Prompt — Configure GSD for Kimchi (parity with oc_salesanalyzer_control)

> Paste the section between the `---BEGIN PROMPT---` / `---END PROMPT---`
> markers into a fresh GSD session on a clean machine. The agent should
> execute it end-to-end. It will (1) ask for the Kimchi API key via the
> secure secret-collection flow, (2) write the model registry under the
> `kimchi` provider key, (3) write global settings, (4) write the
> project-level `.gsd/PREFERENCES.md` for oc_salesanalyzer_control, and
> (5) verify the result so auto-mode behaves identically to the reference
> machine.
>
> Generated from a snapshot of this machine on 2026-04-27.
> Reference machine: macOS, GSD pi (`~/.gsd/agent/`), provider `kimchi`
> pointing at `https://llm.kimchi.dev/openai/v1`, default session model
> `claude-opus-4-7`. Project: `oc_salesanalyzer_control`.

---BEGIN PROMPT---

You are configuring a brand-new GSD installation so it matches an existing
reference machine for the **oc_salesanalyzer_control** project. Treat this
as a single quick task. Do not ask the user clarifying questions unless
something below cannot be performed — just execute the steps in order.

## What you are setting up

A single OpenAI-compatible provider called **`kimchi`** (the Kimchi proxy
at `https://llm.kimchi.dev/openai/v1`) with five models, a global
`settings.json` pointing at that provider, a global `~/.gsd/preferences.md`
with base skill preferences, and a project-level `.gsd/PREFERENCES.md`
inside `oc_salesanalyzer_control` that routes every auto-mode phase to the
correct model. After this prompt finishes, `/gsd help` should work and
`/gsd auto` must be able to run without further model configuration.

## Step 1 — Confirm GSD is installed and locate the agent dir

```bash
ls -d ~/.gsd/agent 2>/dev/null && ls ~/.gsd/agent/models.json ~/.gsd/agent/settings.json 2>/dev/null
```

If `~/.gsd/agent` does not exist, stop and tell the user to install GSD
first (`brew install gsd-pi` or equivalent) and re-run this prompt.
Otherwise continue.

## Step 2 — Collect the Kimchi API key securely

You **must** use the harness `secure_env_collect` tool. Do **not** ask the
user to paste the key into chat, do **not** echo it, do **not** write it
to any tracked `.env` file.

Call `secure_env_collect` with:

- `destination: "dotenv"`
- `envFilePath: "~/.gsd/agent/.kimchi.env"` (private, lives under
  `~/.gsd/agent` which is outside any git repo)
- `keys`:
  - `key: "KIMCHI_API_KEY"`
  - `required: true`
  - `hint: "64-char hex string from your Kimchi/AIE dashboard"`
  - `guidance`:
    - "Sign in at https://kimchi.dev (or your team's AIE portal)."
    - "Open Settings → API Keys → Create or copy an existing key."
    - "Paste it into the prompt — it will never be echoed."

After the tool returns, source the file to load the key into the current
shell environment for step 3. Never print the value.

```bash
set -a; source ~/.gsd/agent/.kimchi.env; set +a
```

## Step 3 — Write the model registry (`~/.gsd/agent/models.json`)

If `~/.gsd/agent/models.json` already exists, back it up first:

```bash
cp ~/.gsd/agent/models.json \
   ~/.gsd/agent/models.json.bak.$(date +%Y%m%d%H%M%S) 2>/dev/null || true
```

Write the file using `envsubst` so the key is never echoed. The provider
key is `kimchi`:

```bash
cat > /tmp/models_template.json << 'TEMPLATE'
{
  "providers": {
    "kimchi": {
      "baseUrl": "https://llm.kimchi.dev/openai/v1",
      "apiKey": "${KIMCHI_API_KEY}",
      "api": "openai-completions",
      "models": [
        {
          "id": "claude-opus-4-7",
          "name": "Claude Opus 4.7",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 1000000,
          "maxTokens": 128000,
          "cost": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 }
        },
        {
          "id": "claude-opus-4-6",
          "name": "Claude Opus 4.6",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 1000000,
          "maxTokens": 128000,
          "cost": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
        },
        {
          "id": "nemotron-3-super-fp4",
          "name": "Nemotron 3 Super",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 1000000,
          "maxTokens": 32000,
          "cost": { "input": 0.3, "output": 0.75, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "minimax-m2.5",
          "name": "MiniMax M2.5",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 197000,
          "maxTokens": 32000,
          "cost": { "input": 0.3, "output": 1.2, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "kimi-k2.5",
          "name": "Kimi K2.5",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 262000,
          "maxTokens": 32000,
          "cost": { "input": 0.6, "output": 3, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
TEMPLATE
envsubst '${KIMCHI_API_KEY}' < /tmp/models_template.json > ~/.gsd/agent/models.json
rm /tmp/models_template.json
chmod 600 ~/.gsd/agent/models.json
```

## Step 4 — Set the default provider/model in `~/.gsd/agent/settings.json`

Preserve all existing keys; only upsert `defaultProvider` and
`defaultModel`:

```bash
node -e '
const fs=require("fs"), p=require("os").homedir()+"/.gsd/agent/settings.json";
const cur=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{};
cur.defaultProvider="kimchi"; cur.defaultModel="claude-opus-4-7";
fs.writeFileSync(p, JSON.stringify(cur,null,2)+"\n");
console.log("settings.json updated");
'
```

## Step 5 — Write global preferences (`~/.gsd/preferences.md`)

This sets the base skill preferences that apply across all projects:

```markdown
---
version: 1
mode: team
always_use_skills:
  - debug-like-expert
skill_discovery: suggest
skill_staleness_days: 60
notifications:
  enabled: false
  on_complete: false
  on_milestone: false
  on_attention: false
  on_error: false
  on_budget: false
git:
  auto_push: false
  merge_strategy: squash
  isolation: branch
budget_ceiling: 0
budget_enforcement: warn
token_profile: quality
---

# GSD Skill Preferences

See `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full
field documentation and examples.
```

## Step 6 — Write the project-level preferences

Locate the `oc_salesanalyzer_control` project directory and confirm `.gsd/`
exists inside it:

```bash
ls <path-to-oc_salesanalyzer_control>/.gsd/PREFERENCES.md 2>/dev/null \
  && echo "exists" || echo "will create"
```

Write `.gsd/PREFERENCES.md` inside the project root (create `.gsd/` if
needed). This file routes every auto-mode phase to the correct `kimchi`
model and includes the lint/git hooks and the post-milestone audit hook:

```markdown
---
version: 1
models:
  research: kimchi/nemotron-3-super-fp4
  planning: kimchi/claude-opus-4-6
  discuss: kimchi/minimax-m2.5
  execution: kimchi/kimi-k2.5
  execution_simple: kimchi/minimax-m2.5
  completion: kimchi/kimi-k2.5
  validation: kimchi/claude-opus-4-6
  subagent: kimchi/nemotron-3-super-fp4
  auto_supervisor: kimchi/claude-opus-4-6
dynamic_routing:
  enabled: false
  tier_models:
    light: kimchi/nemotron-3-super-fp4
    standard: kimchi/kimi-k2.5
    heavy: kimchi/claude-opus-4-6
  budget_pressure: false
verification_commands:
  - uv run ruff check src/ tests/ --no-fix
  - uv run ruff format --check src/ tests/
verification_auto_fix: true
verification_max_retries: 1
pre_dispatch_hooks:
  - name: enforce-lint-and-git-add
    before:
      - complete-slice
    action: modify
    prepend: |
      BEFORE completing this slice, you MUST run these checks and fix any issues:

      1. Run `uv run ruff check src/ tests/ --no-fix` — if violations exist, fix them with `uv run ruff check --fix src/ tests/` then `uv run ruff format src/ tests/`, then re-run the check to confirm zero violations.
      2. Run `git status --short` — if any `??` (untracked) files exist that are part of this slice's deliverables (source files, test files, config files, docs), run `git add` on them BEFORE the completion commit. Never leave slice deliverables untracked.
      3. Run `uv run ruff format --check src/ tests/` — if any files need formatting, run `uv run ruff format src/ tests/`.

      Do NOT skip these steps. The completion is invalid if lint fails or deliverables are untracked.
post_unit_hooks:
  - name: milestone-quality-audit
    after:
      - complete-milestone
    prompt: |
      You are running a post-milestone quality and cost audit for milestone {milestoneId}.

      Read the audit instructions from .gsd/prompts/milestone-audit.md and execute them fully.

      The milestone ID is {milestoneId}. The integration branch is master.

      Execute all three phases: gather evidence, evaluate 6 dimensions, write the ASSESSMENT artifact.
    model: kimchi/claude-opus-4-6
    artifact: ASSESSMENT.md
    max_cycles: 1
---

# GSD Skill Preferences

- Always use these skills when relevant:
  - debug-like-expert → `/Users/leonkuperman/.agents/skills/debug-like-expert/SKILL.md`
```

## Step 7 — Verify

Run all checks and report the output:

```bash
# 1. Provider key is kimchi, key is set (length only — never the value)
node -e '
const m=require(require("os").homedir()+"/.gsd/agent/models.json");
const p=m.providers.kimchi;
if (!p) { console.error("ERROR: kimchi provider not found"); process.exit(1); }
console.log("baseUrl:", p.baseUrl);
console.log("apiKey length:", (p.apiKey||"").length, p.apiKey?.startsWith("\${")?"UNSUBSTITUTED — re-run step 2":"ok");
console.log("models:", p.models.map(x=>x.id).join(", "));
'

# 2. Default model
node -e '
const s=require(require("os").homedir()+"/.gsd/agent/settings.json");
const ok = s.defaultProvider==="kimchi" && s.defaultModel==="claude-opus-4-7";
console.log("defaultProvider:", s.defaultProvider, ok?"✓":"✗ expected kimchi");
console.log("defaultModel:", s.defaultModel, ok?"✓":"✗ expected claude-opus-4-7");
'

# 3. Global preferences
head -5 ~/.gsd/preferences.md

# 4. Project preferences — all phase refs should say kimchi/
grep "kimchi/" <path-to-oc_salesanalyzer_control>/.gsd/PREFERENCES.md | wc -l
# Expected: 9 or more lines

# 5. Live probe (consumes a few tokens)
gsd /setup llm --probe 2>&1 | tail -20 || true
```

If the live probe fails with an auth error, the API key was not substituted
correctly — re-run step 2 and step 3.

## Done

When all checks pass, tell the user:

> "Kimchi provider configured under the `kimchi` key. Default session
> model: `claude-opus-4-7`. The oc_salesanalyzer_control project routes
> auto-mode phases to: research → `nemotron-3-super-fp4`, planning/validation
> → `claude-opus-4-6`, execution/completion → `kimi-k2.5`,
> discuss/execution_simple → `minimax-m2.5`, subagent → `nemotron-3-super-fp4`.
> Run `/gsd auto` inside the project directory to start."

---END PROMPT---

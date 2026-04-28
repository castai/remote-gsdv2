# Prompt — Configure GSD for Kimchi (parity with reference machine)

> Paste the section between the `---BEGIN PROMPT---` / `---END PROMPT---`
> markers into a fresh GSD session on a clean machine. The agent should
> execute it end-to-end. It will (1) ask for the Kimchi API key via the
> secure secret-collection flow, (2) write the model registry, (3) write
> global preferences, and (4) verify the result so auto-mode behaves
> identically to the reference machine.
>
> Generated from a snapshot of this machine on 2026-04-27.
> Reference machine: macOS, GSD pi (`~/.gsd/agent/`), provider `aie`
> pointing at `https://llm.kimchi.dev/openai/v1`, default session model
> `claude-opus-4-7`.

---BEGIN PROMPT---

You are configuring a brand-new GSD installation so it matches an existing
reference machine. Treat this as a single quick task. Do not ask the user
clarifying questions unless something below cannot be performed — just
execute the steps in order.

## What you are setting up

A single OpenAI-compatible provider called **`aie`** (the Kimchi proxy at
`https://llm.kimchi.dev/openai/v1`) with five models, plus global GSD
preferences that route every auto-mode phase through that provider. After
this prompt finishes, `/gsd help` should work and `/gsd auto` must be able
to run without further model configuration.

## Step 1 — Confirm GSD is installed and locate the agent dir

Run:

```bash
ls -d ~/.gsd/agent 2>/dev/null && ls ~/.gsd/agent/models.json ~/.gsd/agent/settings.json 2>/dev/null
```

If `~/.gsd/agent` does not exist, stop and tell the user to install GSD
first (`brew install gsd-pi` or equivalent) and re-run this prompt.
Otherwise continue.

## Step 2 — Collect the Kimchi API key securely

You **must** use the harness `secure_env_collect` tool. Do **not** ask the
user to paste the key into chat, do **not** echo it, do **not** write it
to `.env`. The key needs to live inside `~/.gsd/agent/models.json` under
`providers.aie.apiKey`, so collect it as an environment variable first
and then stamp it into the JSON in step 3.

Call `secure_env_collect` with:

- `destination: "dotenv"`
- `envFilePath: "~/.gsd/agent/.kimchi.env"` (a private file, gitignored
  by virtue of living under `~/.gsd/agent`)
- `keys`:
  - `key: "KIMCHI_API_KEY"`
  - `required: true`
  - `hint: "64-char hex string from your Kimchi/AIE dashboard"`
  - `guidance`:
    - "Sign in at https://kimchi.dev (or your team's AIE portal)."
    - "Open Settings → API Keys → Create or copy an existing key."
    - "Paste it into the prompt — it will never be echoed."

After the tool returns, read `~/.gsd/agent/.kimchi.env` to grab the value
into a shell variable for step 3 (`source` it). Never print the value.

## Step 3 — Write the model registry (`~/.gsd/agent/models.json`)

If `~/.gsd/agent/models.json` already exists and contains a different
provider, back it up to `models.json.bak.<timestamp>` before overwriting.

Write this file verbatim, substituting `${KIMCHI_API_KEY}` with the value
loaded from the env file in step 2. Use a heredoc + `envsubst` or a small
Node one-liner — do **not** echo the key into the terminal.

```json
{
  "providers": {
    "aie": {
      "baseUrl": "https://llm.kimchi.dev/openai/v1",
      "apiKey": "${KIMCHI_API_KEY}",
      "api": "openai-completions",
      "models": [
        {
          "id": "claude-opus-4-7",
          "name": "Claude Opus 4.7 by AIE",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 1000000,
          "maxTokens": 128000,
          "cost": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 }
        },
        {
          "id": "claude-sonnet-4-6",
          "name": "Claude Sonnet 4.6 by AIE",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 1000000,
          "maxTokens": 128000,
          "cost": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
        },
        {
          "id": "nemotron-3-super-fp4",
          "name": "Nemotron 3 Super by AIE",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 1000000,
          "maxTokens": 32000,
          "cost": { "input": 0.3, "output": 0.75, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "minimax-m2.7",
          "name": "MiniMax M2.7 by AIE",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 197000,
          "maxTokens": 32000,
          "cost": { "input": 0.3, "output": 1.2, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "kimi-k2.5",
          "name": "Kimi K2.5 by AIE",
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
```

After writing, `chmod 600 ~/.gsd/agent/models.json` (the file holds the
API key in plaintext — same as on the reference machine).

## Step 4 — Set the default provider/model in `~/.gsd/agent/settings.json`

Merge these two keys into the existing `settings.json` (create the file
if it doesn't exist):

```json
{
  "defaultProvider": "aie",
  "defaultModel": "claude-opus-4-7"
}
```

If the file already has other keys (e.g. `defaultThinkingLevel`,
`quietStartup`), preserve them — only upsert `defaultProvider` and
`defaultModel`. Do this with a Node one-liner so existing keys aren't
clobbered:

```bash
node -e '
const fs=require("fs"),p=require("os").homedir()+"/.gsd/agent/settings.json";
const cur=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{};
cur.defaultProvider="aie"; cur.defaultModel="claude-opus-4-7";
fs.writeFileSync(p, JSON.stringify(cur,null,2)+"\n");
'
```

## Step 5 — Write global preferences (`~/.gsd/preferences.md`)

Write this file verbatim. It pins every auto-mode phase to
`claude-opus-4-7` (matching the reference machine), enables dynamic
routing across the three available reasoning tiers, and keeps the same
notification / git / budget posture.

```markdown
---
version: 1
mode: team
always_use_skills:
  - debug-like-expert
models:
  research: claude-opus-4-7
  planning: claude-opus-4-7
  execution:
    model: claude-opus-4-7
    fallbacks:
      - claude-sonnet-4-6
  execution_simple: claude-sonnet-4-6
  completion: claude-opus-4-7
  subagent:
    model: claude-sonnet-4-6
    fallbacks:
      - claude-opus-4-7
skill_discovery: suggest
skill_staleness_days: 60
auto_supervisor:
  model: claude-opus-4-7
  soft_timeout_minutes: 20
  idle_timeout_minutes: 10
  hard_timeout_minutes: 30
budget_ceiling: 0
budget_enforcement: warn
notifications:
  on_complete: false
  on_milestone: false
  on_attention: false
  enabled: false
  on_error: false
  on_budget: false
git:
  auto_push: false
  merge_strategy: squash
  isolation: branch
dynamic_routing:
  enabled: true
  escalate_on_failure: true
  tier_models:
    light: minimax-m2.7
    standard: claude-sonnet-4-6
    heavy: claude-opus-4-7
token_profile: quality
---

# GSD Skill Preferences

See `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full
field documentation and examples.
```

> **Note on parity:** the reference machine's `preferences.md` literally
> contains `openai-codex/gpt-5.4` everywhere. That is a stale placeholder
> — the registry has no such model, and auto-mode silently falls back to
> the session default (`claude-opus-4-7`). The preferences above route
> phases to real registry IDs so behavior is **identical in practice**
> and explicit on paper. If you want byte-for-byte parity with the stale
> file, replace every `claude-opus-4-7` / `claude-sonnet-4-6` /
> `minimax-m2.7` value above with the literal string `openai-codex/gpt-5.4`
> — but be aware that breaks `/gsd setup model` validation.

## Step 6 — Verify

Run these checks and report the output. All must pass:

```bash
# 1. Provider + key wired up (key length only, never the value)
node -e '
const m=require(require("os").homedir()+"/.gsd/agent/models.json");
const p=m.providers.aie;
console.log("baseUrl:", p.baseUrl);
console.log("apiKey length:", (p.apiKey||"").length, p.apiKey?.startsWith("${")?"UNSUBSTITUTED":"ok");
console.log("models:", p.models.map(x=>x.id).join(", "));
'

# 2. Default model set
node -e '
const s=require(require("os").homedir()+"/.gsd/agent/settings.json");
console.log("defaultProvider:", s.defaultProvider);
console.log("defaultModel:", s.defaultModel);
'

# 3. Preferences parse
head -20 ~/.gsd/preferences.md

# 4. Live probe (real network call — uses a few tokens)
gsd /setup llm --probe 2>&1 | tail -20  || true
```

Then run `/gsd help` inside GSD itself to confirm command discovery
works. If the probe fails with an auth error, the API key was pasted
incorrectly — re-run step 2.

## Done

When all six steps pass, tell the user:

> "Kimchi provider configured. Default model: `claude-opus-4-7`.
> Auto-mode is wired through `aie/claude-opus-4-7` with sonnet fallback,
> matching the reference machine. Run `/gsd init` in any project to
> bootstrap `.gsd/`, then `/gsd auto` to start a milestone."

---END PROMPT---

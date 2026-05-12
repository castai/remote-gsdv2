# Native GSD Provider for Multica

## Reader and purpose

**Reader:** an engineer reviewing whether Multica should support GSD as a native provider, starting on this local machine and later running the Multica daemon inside a remote GSD pod.

**Post-read action:** decide whether this implementation plan is sound, identify design gaps, and approve or revise the first spike.

## Executive summary

Multica already has the right high-level shape for this integration. Its server owns issues, agents, runtimes, and task queues; its daemon runs on a user-controlled machine and invokes local AI coding CLIs. A remote GSD pod is also a user-controlled execution machine. The clean integration is therefore not to make Multica control a tmux session directly, but to make the Multica daemon able to run `gsd` as one of its provider CLIs.

The recommended path is:

1. Add a first-class `gsd` provider backend to Multica.
2. Prove it locally on this machine with the Multica daemon spawning `gsd` headlessly.
3. After local proof, install/start the Multica daemon inside the remote GSD pod.
4. Let each pod register with Multica as a remote runtime named for its project.

Do **not** adapt the existing `pi` provider unless a temporary wrapper is needed for a throwaway spike. The current Multica `pi` provider assumes an older CLI contract that does not match the installed `gsd` command.

## Current architecture fit

### Multica execution model

Multica separates coordination from execution:

- The Multica server stores board state, issues, agents, runtimes, task queue state, transcripts, and usage.
- A Multica daemon runs on an execution machine.
- The daemon detects installed provider CLIs.
- Each detected provider registers as a runtime.
- The daemon claims tasks for a runtime, invokes the provider CLI, streams progress/messages, and reports completion or failure.

This is already compatible with a remote GSD pod because the pod is a persistent execution machine with a repo checkout, credentials, tools, and durable home/workspace storage.

### Remote GSD execution model

The remote GSD project provisions a Kubernetes pod with:

- `gsd` installed globally.
- A persistent `/home/gsd` PVC.
- A project workspace under `/home/gsd/workspace/<project>`.
- Git/GitHub credentials and model/auth config staged into the PVC.
- A long-lived tmux session for interactive use.

For Multica integration, the pod should additionally run the Multica daemon. The daemon should invoke `gsd` as a headless CLI process when Multica assigns work to a GSD-backed agent.

## Important distinction: provider process vs interactive session

The first implementation should target headless provider execution:

```text
Multica task → Multica daemon → gsd -p --mode json → streamed result
```

It should **not** try to drive the existing interactive tmux session:

```text
Multica task → tmux send-keys into existing `gsd` TUI
```

Driving tmux is brittle:

- hard to recover from partial input or modal UI state;
- hard to parse output reliably;
- hard to distinguish agent progress from terminal noise;
- poor failure semantics;
- poor concurrency semantics.

A headless `gsd` process is observable, testable, and matches Multica’s existing daemon/provider model.

The interactive tmux session should remain available for humans to attach, steer, or inspect the pod. It should not be the execution transport for Multica tasks.

## Why a native `gsd` provider instead of reusing `pi`

Multica already has a provider named `pi`, but its command contract does not match current GSD.

The existing `pi` backend assumes a command shape like:

```bash
pi -p --mode json \
  --session <path> \
  --provider <name> \
  --model <id> \
  --tools read,bash,edit,write,grep,find,ls \
  --append-system-prompt <text> \
  <prompt>
```

Current GSD exposes a command shape like:

```bash
gsd -p --mode json \
  --model <provider/model> \
  --tools read,bash,edit,write,lsp \
  <prompt>
```

And for GSD headless commands:

```bash
gsd headless --json --resume <id> <command>
```

The installed command on this machine is `gsd`, not `pi`. Current `gsd --help` does not advertise prompt-mode flags such as `--session`, `--provider`, or `--append-system-prompt`.

A compatibility wrapper named `pi` could translate some flags, but that would hide real differences and make resume/session behavior ambiguous. A first-class provider makes the mismatch explicit and gives Multica a clean place to encode GSD-specific behavior.

## Recommended design

### Provider identity

Use provider name:

```text
gsd
```

User-facing label:

```text
GSD
```

Initial runtime mode remains Multica’s existing local daemon mode. A GSD runtime running inside a Kubernetes pod is still “local” from Multica’s daemon perspective: the daemon is local to the execution environment and invokes a local CLI. A separate cloud-runtime abstraction can come later if needed.

### Backend command

Initial command shape:

```bash
gsd -p --mode json \
  --model <model> \
  --tools read,bash,edit,write,lsp \
  <prompt>
```

If `model` is omitted, let GSD choose its configured default.

Start with a conservative tool allowlist:

```text
read,bash,edit,write,lsp
```

This matches the core coding-agent needs while avoiding early questions around browser, macOS UI, external MCP integrations, or secret collection inside an unattended Multica task.

Interactive tools such as user questions and secure secret collection should be treated as a later design problem. If a Multica task needs human input, the preferred behavior is to fail or block with a clear message rather than hang waiting for an unavailable interactive channel.

### Custom arguments

Allow custom arguments, but block flags required for the daemon protocol.

Suggested blocked flags:

```text
-p
--print
--mode
--no-session
```

Consider blocking `--tools` in the first spike so the provider has predictable tool exposure. It can be opened later once the provider is stable.

### System prompt / instructions

Multica’s provider interface has a `SystemPrompt` field. Current GSD prompt mode does not advertise an `--append-system-prompt` flag.

Recommended first-pass behavior:

- Fold Multica’s system prompt and task prompt into one final user prompt.
- Use clear delimiters.
- Preserve Multica’s existing context construction as much as possible.

Example prompt envelope:

```text
You are being run by Multica as the agent assigned to this task.

<multica_system_instructions>
...
</multica_system_instructions>

<task>
...
</task>
```

If GSD later exposes a supported system-prompt append flag, move the instructions there.

### JSON event parsing

Current GSD JSON mode emits line-delimited JSON events. Observed events include:

```json
{"type":"session","id":"...","cwd":"..."}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start", "message": {...}}
{"type":"message_update", "assistantMessageEvent": {"type":"text_delta", "delta":"..."}}
{"type":"message_end", "message": {"usage": {...}}}
{"type":"turn_end", "message": {"usage": {...}}, "toolResults": []}
{"type":"agent_end", "messages": [...]}
```

Map events into Multica’s provider event model:

| GSD event | Multica message/result mapping |
|---|---|
| `session` | capture `id` as provider session ID; emit status if useful |
| `agent_start` | status `running` |
| `message_update` / `text_delta` | stream assistant text |
| `message_update` / `thinking_delta` | stream thinking event if present |
| `message_update` / `toolcall_start` | start tool-use event |
| `message_update` / `toolcall_delta` | accumulate partial tool arguments |
| `message_update` / tool-call end event | finalize tool-use event |
| tool-result event, if present | stream tool-result event |
| `turn_end.message.usage` | accumulate token usage |
| `error` | mark failed and stream error |
| process timeout | mark timeout |
| nonzero process exit | mark failed unless already classified |

The existing `pi` backend parser is close enough to use as a starting point, but GSD tool-call event parsing should be tested with real fixtures.

### Token usage

GSD usage appears under message usage fields such as:

```json
{
  "input": 48391,
  "output": 5,
  "cacheRead": 0,
  "cacheWrite": 0,
  "totalTokens": 48396
}
```

Map to Multica usage fields:

```text
input      → InputTokens
output     → OutputTokens
cacheRead  → CacheReadTokens
cacheWrite → CacheWriteTokens
```

Use `message.model` as the usage key if present. Fall back to the configured model, then to `gsd` or `unknown`.

### Session semantics

GSD prompt mode emits a session ID, so the backend should capture and return it.

Exact resume is the unresolved part. Current prompt-mode help advertises `--continue`, not arbitrary `--resume <id>`. Headless command mode advertises `--resume <id>`, but headless mode is oriented around GSD commands such as `auto`, `next`, and `status`, not arbitrary Multica task prompts.

Recommended first-pass behavior:

- Capture session IDs from GSD output.
- Return them to Multica for persistence.
- If Multica passes a prior session ID, use best-effort directory-scoped resume with `gsd -c -p --mode json ...`.
- Limit concurrency to 1 during the spike to avoid “most recent session” ambiguity.

Document capability as:

```text
Session resume: best-effort, directory-scoped; exact arbitrary session resume not yet proven for prompt mode.
```

Do not claim exact resume until there is a supported GSD prompt-mode command for it.

## Implementation plan

### Slice 1: Backend implementation

Add a native GSD provider backend to Multica.

Work:

- Add a `gsd` backend implementing Multica’s provider backend interface.
- Build current GSD-compatible args.
- Spawn `gsd` with configured working directory and environment.
- Parse JSONL stdout.
- Stream text, tool events, status, errors, and usage.
- Return final status, output, error, duration, session ID, and usage.

Acceptance criteria:

- A direct backend test can execute a trivial prompt through `gsd`.
- JSON parser tests cover text output, usage, session ID capture, and failure.
- Arg builder tests prove required protocol flags cannot be overridden by custom args.

### Slice 2: Provider registration and daemon detection

Wire the provider into Multica’s provider registry and daemon config.

Work:

- Add `gsd` to the provider factory.
- Add a launch header for display/debugging.
- Detect `gsd` on `PATH`.
- Support environment overrides:
  - `MULTICA_GSD_PATH`
  - `MULTICA_GSD_MODEL`
- Register a runtime when `gsd` is present.

Acceptance criteria:

- Starting the daemon on this machine registers a `gsd` runtime.
- The runtime appears online in Multica.
- Setting `MULTICA_GSD_PATH` changes the executable used.
- Setting `MULTICA_GSD_MODEL` changes the default model used by the provider.

### Slice 3: Model discovery

Expose GSD models to Multica.

Work:

- Run `gsd --list-models` from Multica’s model discovery path.
- Parse output conservatively.
- Provide a fallback if parsing fails.

Acceptance criteria:

- Multica can display available GSD models or a safe default.
- Model selection passes through to `gsd --model <id>`.
- Unknown/empty model values do not prevent task execution.

Open question:

- Whether `gsd --list-models` has a machine-readable output format. If not, parse text output carefully and keep fallback behavior.

### Slice 4: Local end-to-end proof

Run Multica locally and prove that a task executes through GSD.

Work:

- Start Multica’s local dependencies.
- Start the Multica server/web app.
- Start the daemon with GSD enabled and concurrency set to 1.
- Create a GSD-backed agent.
- Assign a trivial read-only task.
- Assign a safe file-edit task in a disposable workspace.

Suggested local environment:

```bash
MULTICA_GSD_PATH="$(command -v gsd)"
MULTICA_GSD_MODEL="openai-codex/gpt-5.4"
MULTICA_DAEMON_MAX_CONCURRENT_TASKS=1
MULTICA_WORKSPACES_ROOT="$HOME/multica_workspaces_gsd"
```

Acceptance criteria:

- Runtime appears as online.
- Task moves queued → dispatched/running → completed.
- Transcript streams text output.
- Tool activity is visible enough to debug.
- Usage is recorded.
- Completion/failure state is correct.
- Workdir/session ID are persisted in task state.

### Slice 5: Frontend polish and provider metadata

Make GSD visible and understandable in the UI.

Work:

- Add provider label `GSD`.
- Add icon or acceptable fallback.
- Add provider formatting in transcripts/runtime lists if needed.
- Update capability metadata/docs if the project tracks provider capability tables.

Acceptance criteria:

- Users can distinguish GSD from Pi and other providers.
- Provider display does not look broken in runtime lists, agent creation, or transcripts.
- Session resume capability is described accurately as best-effort if surfaced.

### Slice 6: Remote pod integration

After local proof, install and run the Multica daemon inside the remote GSD pod.

Work in the remote GSD deployment:

- Install Multica CLI in the image.
- Add Helm values for Multica integration.
- Add secret support for Multica auth/token material.
- Inject daemon configuration through environment variables.
- Start the Multica daemon in a separate tmux session or supervised background process.
- Keep the existing interactive `gsd` tmux session unchanged.

Suggested Helm values shape:

```yaml
multica:
  enabled: false
  serverURL: ""
  appURL: ""
  token: ""
  workspaceID: ""
  daemonDeviceName: ""
  runtimeName: ""
  maxConcurrentTasks: 1
  workspacesRoot: "/home/gsd/multica_workspaces"
  gsdModel: "openai-codex/gpt-5.4"
```

Suggested daemon environment in the pod:

```bash
MULTICA_SERVER_URL=<server URL>
MULTICA_WORKSPACE_ID=<workspace ID, if required by CLI flow>
MULTICA_GSD_PATH=/usr/local/bin/gsd
MULTICA_GSD_MODEL=openai-codex/gpt-5.4
MULTICA_DAEMON_DEVICE_NAME=gsd-<project>
MULTICA_AGENT_RUNTIME_NAME="Remote GSD - <project>"
MULTICA_DAEMON_MAX_CONCURRENT_TASKS=1
MULTICA_WORKSPACES_ROOT=/home/gsd/multica_workspaces
```

Recommended process layout in the pod:

```text
tmux session: gsd              # existing interactive shell/TUI session
tmux session: multica-daemon   # daemon logs and lifecycle visibility
```

Acceptance criteria:

- Pod registers as a Multica runtime.
- Runtime name identifies the project/pod.
- Multica task executes inside the pod.
- Pod restart preserves relevant home/workspace state.
- Existing `connect.sh` workflow still works.
- Daemon logs are inspectable from tmux or file.

## Testing strategy

### Unit tests

Cover:

- arg building;
- blocked custom args;
- session event parsing;
- text delta parsing;
- tool-call event parsing;
- usage accumulation;
- error event classification;
- timeout/nonzero exit classification.

### Integration tests

Run real `gsd` on a harmless prompt:

```text
Respond with exactly: OK. Do not use tools.
```

Expected:

- final output `OK`;
- status `completed`;
- session ID captured;
- usage captured.

Run a safe tool-using prompt in a temporary directory:

```text
Create GSD_PROVIDER_SMOKE_TEST.md containing one sentence, then report the file path.
```

Expected:

- file exists;
- transcript contains useful progress/tool evidence;
- final output describes the change.

### Local Multica end-to-end test

Run through the actual daemon and UI/API:

- daemon detects GSD;
- runtime registers;
- agent assigned to runtime;
- issue/task executes;
- result appears in Multica;
- failure modes are visible.

### Remote pod smoke test

After local success:

- deploy pod with Multica daemon enabled;
- confirm runtime online;
- run read-only task;
- run safe file-edit task;
- restart pod;
- confirm daemon/runtimes recover.

## Risks and mitigations

### Risk: exact session resume is not available in prompt mode

Mitigation:

- mark resume as best-effort initially;
- set concurrency to 1;
- use stable per-issue workdirs;
- revisit if GSD exposes exact prompt-mode resume.

### Risk: unattended GSD asks the user a question

Mitigation:

- avoid interactive tools in first provider allowlist;
- add explicit instruction to fail/block clearly when user input is required;
- later design a bridge from GSD question events to Multica comments or task blocked state.

### Risk: custom args break daemon protocol

Mitigation:

- block protocol-defining flags;
- test arg filtering;
- log final command shape without secrets.

### Risk: working directory and repo semantics differ between Multica and remote GSD

Mitigation:

- prove locally with Multica’s default workdir model first;
- for the pod, choose explicit `MULTICA_WORKSPACES_ROOT` on the PVC;
- avoid sharing one mutable checkout across concurrent tasks until locking semantics are understood.

### Risk: provider detection registers too many local tools

Mitigation:

- during spike, configure environment so only GSD is detected or selected;
- consider adding a daemon provider allowlist if Multica does not already have one.

### Risk: token/auth handling inside pod is underspecified

Mitigation:

- keep Multica auth as Kubernetes Secret data;
- never pass tokens inline in shell history;
- follow the existing remote GSD secret staging pattern;
- document token rotation and pod restart behavior.

## Decisions proposed for review

1. **Provider name:** use `gsd`, not `pi`.
2. **Execution mode:** use `gsd -p --mode json` for Multica tasks.
3. **Interactive tmux:** keep it for human use only; do not use it as the task transport.
4. **Resume:** implement best-effort resume only in the first spike.
5. **Concurrency:** set daemon and GSD-backed agent concurrency to 1 until workdir/session behavior is proven.
6. **Pod architecture:** run the Multica daemon in the pod; do not run the full Multica server per pod.
7. **Tool allowlist:** start conservative, then expand.

## Open questions for reviewer

1. Should the first backend fold Multica system instructions into the user prompt, or should we require/introduce a supported GSD system-prompt flag?
2. Is best-effort `gsd -c` resume acceptable for the first pass, or should exact resume block the provider?
3. Should Multica add a provider allowlist for daemon startup to avoid detecting every installed CLI?
4. Should GSD tasks run in Multica-created per-task workdirs, or should the remote pod integration point them at the existing project checkout?
5. How should GSD requests for human input map into Multica: task failure, blocked issue state, comment prompt, or supervised mode?
6. Should remote pod daemon logs live in tmux only, file only, or both?

## Recommended first spike

Build only the local native provider path:

```text
Native GSD provider in Multica daemon, proven on this machine.
```

Definition of done:

- `gsd` provider is detected locally.
- Multica registers an online GSD runtime.
- A GSD-backed agent can execute a read-only task.
- A GSD-backed agent can execute a safe file-edit task.
- Output streams into the Multica transcript.
- Usage and session ID are captured.
- Failures produce actionable error messages.
- Parser and arg-builder tests pass.

Only after this spike should we modify the remote GSD image/chart to run the Multica daemon inside the pod.

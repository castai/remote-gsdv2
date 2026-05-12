# GSD + Jira Control Plane — Design Discussion

**Status:** Draft for team review
**Audience:** Engineers and stakeholders who will evaluate, refine, and potentially build this
**Action after reading:** Push back on framing, surface unstated constraints, agree (or disagree) on v1 scope

---

## What this document is

This is the current shape of a design that emerged from several rounds of stepping back and asking "what are we actually trying to build." It captures both *what we landed on* and *what we considered and rejected*, because the alternatives matter for evaluating whether this is the right call.

It is not a finished implementation plan. It is the snapshot of thinking before we commit to building.

---

## The problem we're trying to solve

We have:

- **GSD v2** — a single-agent execution discipline that decomposes work into milestones → slices → tasks, with verification gates, durable artifacts (`.gsd/`), and an auto-mode loop that runs until human input is needed.
- **Remote GSD pods** — persistent Kubernetes pods that run GSD with PVC-backed state. Agents keep working when humans disconnect; tmux + VS Code tunnel for human attach.
- **Jira** — existing source of truth for project work in our environment. Already integrated with GSD via a per-project skill (proven on the salesanalyzer board).

What we're missing:

1. **A way to know when a human needs to engage** with an agent running auto-mode in a pod. Currently you have to attach and look.
2. **A way to answer questions and steer the agent without dropping to a terminal.** GSD has structured interaction points (`ask_user_questions`, `grill-me`) that emit well-formed questions, but the only way to respond is via the TUI.
3. **A portfolio view across multiple pods/projects.** Each pod is isolated; there's no cross-project picture of what's in flight, what's stuck, what needs review.
4. **A discipline-aware view of GSD work.** Jira's native states (To Do / In Progress / Done) don't reflect where a milestone actually is in the GSD lifecycle.

The unifying observation: **all four needs are about visibility and lightweight interaction, not about replacing GSD's orchestration or Jira's project management.**

---

## What we considered and rejected

### Rejected: Integrate with Multica

Multica is a multi-agent kanban tool with a daemon-per-machine model. We seriously considered building a native `gsd` provider for Multica so each remote GSD pod could be a Multica runtime. Detailed plan in `dossier/multica-gsd-provider-plan.md`.

We rejected it because:

- **Two orchestration loops fighting.** Both Multica's daemon and GSD's auto-mode want to be *the* orchestrator. Making them coexist requires reducing GSD to single-turn `gsd -p` calls, which throws away the GSD discipline (milestones, slices, verification gates).
- **Adds a second source of truth.** Jira is already where work lives. Multica would compete with it.
- **The Multica capabilities we actually wanted are small** (agent-as-assignee, attention queue, comment-trigger). Most of Multica's value (web UI, board, comments, autopilots, Postgres) duplicates Jira.

### Rejected: Build a kanban of issues

A natural first instinct: build a kanban board where cards are individual issues or tasks. We rejected this because:

- Tasks are too granular. A milestone has dozens of tasks; a portfolio has hundreds. Boards collapse under that load.
- Jira already gives you an issue-level kanban. Replicating it adds nothing.
- The interesting unit of human attention is *the milestone*, not the task. Humans don't want to track 200 task cards; they want to know which of their 10 milestones need them.

### Rejected: Tmux-driven Multica integration

Briefly considered: have Multica drive the existing interactive tmux session in each pod. Rejected because tmux automation is brittle, hard to recover from modal state, hard to parse output reliably, and produces poor failure semantics. The interactive tmux session is for humans; the automation surface should be structured (events and write APIs), not keystroke-driven.

---

## The reframe: a kanban of GSD lifecycle phases

The shift that made the design click: **the board's columns are GSD lifecycle phases. The cards are milestones. The hierarchy below a card is GSD's hierarchy, expressed in Jira's native types.**

### Columns are phases

```
Discussing  →  Researching  →  Planning  →  Executing  →  Validating  →  Done
```

These match what GSD actually does. A column called "Planning" tells you something useful; a column called "In Progress" doesn't. Phase transitions are *real handoffs* — each one is a moment where responsibility shifts (often between human and agent).

Two pieces of state are orthogonal to phase:

- **Attention badges** — Blocked, Errored, Awaiting Verification, Awaiting Validation, Question Pending. A milestone in any column can be in any attention state. Phase says *where it is*; attention says *whether it needs you right now*.
- **Card colour** — encodes attention urgency, not phase. Red = blocking auto-mode. Amber = awaiting human review. Blue = informational. Grey = healthy/in-flight. Colour means "do I need to do something."

### Error boundaries are an attention state, not a column

GSD can stop for several reasons:

- **Recoverable runtime errors** (rate limits, transient network, expired auth) — pod should retry with backoff before escalating.
- **GSD state inconsistencies** (DB-filesystem drift, journal corruption, lock contention) — needs human inspection; auto-retry won't fix it.
- **Hard model errors** (malformed output, agent loop producing garbage) — requires human judgment about retry / replan / abort.

A milestone that errored during Executing is *still in Executing*, just stopped. The card shows the Errored badge and drills down into a typed error view (because the human action differs by error type).

### Hierarchy maps to Jira's native types

| GSD concept | Jira representation |
|---|---|
| Milestone | Epic |
| Slice | Story (or custom "Slice" issue type if available) |
| Task | Subtask of the Story |
| Depends-on | Native Jira link |
| Supersedes (DECISIONS.md) | Jira "replaces" or "duplicates" link |
| Validates requirement R001 | Custom field "Requirements Validated" on the slice/milestone |
| Surfaced from M001/S03 | Jira "discovered while working on" link |

Requirements (`REQUIREMENTS.md`) are not Jira issues. They're contracts — a parallel structure that gets *referenced* from issues via custom field. They aren't workable items.

### Source of truth, explicitly

Two sources, each authoritative for a different thing:

- **`.gsd/` artifacts in git** are the source of truth for *what* a milestone is — context, plan, summaries, decisions, knowledge, requirements. Jira holds *links* to these artifacts (custom field "GSD Artifact URL"), not copies.
- **Jira** is the source of truth for *who* — milestone assignment (the human owner) and which pod is executing (custom field "Executor").

Phase transitions flow one direction only: GSD pod observes a state change → publishes an event → reflector updates Jira. Humans editing Jira phase manually is not supported (Jira phase is reflective only). Humans changing *assignment* in Jira does flow back to the pod, but that's a different field.

This avoids the "two sources of truth, perpetually syncing" problem. There is no content sync — there are git URLs and event-driven status reflection.

### Atomic milestone assignment

One human owner, one executor pod, per milestone. This isn't arbitrary — it matches GSD's actual constraints:

- GSD's `.gsd/gsd.db` is a single-writer SQLite WAL. Two pods on the same `.gsd/` directory race.
- GSD's auto-mode lock (`.gsd/auto.lock`) assumes one auto-mode process per repo.
- Milestone reassessment, replan, and reopen semantics assume a single executor of record.

Consequences:

- **Multiple milestones can share a pod** — the pod queues them. This matches `gsd queue` and is fine.
- **Multiple pods per project, with disjoint milestones**, is fine and is how you scale (more pods, more milestones in flight, each isolated).
- **Two pods on the same milestone is broken.** The design must prevent this, not just discourage it.
- **Humans inspecting via the dashboard is fine** because the dashboard is read-only on `.gsd/` (it reads git or the event stream, never the live DB).
- **Humans triggering writes** (Pause Auto, Reassign, Answer Question) must go through the pod's own write API so the writes serialize through GSD's single writer.

---

## What humans actually need from this

The dashboard's job is to surface *moments where a human needs to pay attention*. Everything else is noise.

The eight types of human-attention events:

1. A milestone in Discussing has questions or a draft brief awaiting review.
2. A plan is ready for approval (Planning → Executing handoff).
3. Auto-mode is blocked on a question, gate, or judgment call.
4. A slice has finished automated verification and needs UAT.
5. A milestone is awaiting validation/audit (all slices done, success criteria need sign-off).
6. A task or slice failed its verification (different from a crash — the agent thinks it's done and the verification disagrees).
7. Autonomous decisions accumulating without review (`made_by: agent` entries in DECISIONS.md).
8. Something has been stuck for too long (time-based escalation).

What's deliberately *not* on this list: progress updates, "agent is working," tool calls, intermediate file edits, token spend. These are noise. The dashboard is **quiet by default and loud only when one of the eight fires.**

---

## Current architecture shape

```
┌──────────────────────────────────────────────────────────────┐
│                          Jira                                │
│  Milestones-as-Epics, Slices-as-Stories, Tasks-as-Subtasks  │
│  Custom fields: GSD Artifact URL, Pod, Phase, Attention      │
│  Phase changes reflected in via webhook bridge               │
└────────────────────────▲─────────────────────────────────────┘
                         │ (reflects phase changes only)
                ┌────────┴────────┐
                │ Jira reflector  │  (subscribes to Redis,
                │  (small worker) │   writes to Jira API)
                └────────▲────────┘
                         │
              ┌──────────┴──────────┐
              │   Redis pub/sub     │
              │  (events, state,    │
              │   transient only)   │
              └─▲────────▲────────▲─┘
                │        │        │
        ┌───────┘        │        └────────┐
        │                │                 │
┌───────┴─────┐  ┌──────┴──────┐  ┌────────┴──────────┐
│  Pod #1     │  │  Pod #2     │  │  Dashboard backend│
│  ┌─────────┐│  │  ┌─────────┐│  │  - subscribes     │
│  │  GSD    ││  │  │  GSD    ││  │  - serves JSON    │
│  └─────────┘│  │  └─────────┘│  │    to frontend    │
│  ┌─────────┐│  │  ┌─────────┐│  │  - relays writes  │
│  │ sidecar ├┼──┘  │ sidecar ├┘  │    to pod APIs    │
│  └─────────┘│     └─────────┘   └────────▲──────────┘
│  ┌─────────┐│     ┌─────────┐            │
│  │write API├┼──┐  │write API├┐           │ HTTP poll
│  └─────────┘│  │  └─────────┘            │ (2-5s)
│  ┌─────────┐│  │  ┌─────────┐   ┌────────┴──────────┐
│  │ VS Code ││  │  │ VS Code ││  │  Frontend (SPA)   │
│  │ tunnel  ││  │  │ tunnel  ││  │                   │
│  └────▲────┘│  │  └────▲────┘│  │  - Attention queue│
└───────┼─────┘  └───────┼─────┘  │  - Board view     │
        │ direct browser │        │  - Steering view  │
        │ link from      │        │  - Q&A surface    │
        │ dashboard      │        │  - Open VS Code   │
        └────────────────┘        └───────────────────┘
```

### Components

**Per-pod additions** (the existing pod is unchanged; these are additive):

- **Sidecar.** Tails `.gsd/journal/*.jsonl` and `.gsd/activity/*.jsonl`, polls `STATE.md`, publishes structured events to Redis. Does not touch GSD's DB or files. Sidecar approach (rather than modifying GSD itself) lets us build this on top of unmodified GSD pods initially; we can move publishing into GSD core later if there are limits.
- **Write API.** Small HTTP server on the pod accepting structured commands (answer question, pause auto, resume, abort slice, reassign). Translates commands into GSD CLI invocations or `.gsd/` writes, **serialized through GSD's single writer** so the single-writer constraint is never violated. This is the most subtle component — it's the boundary that protects GSD's correctness.

**Central services:**

- **Redis** for the event stream (pod → dashboard/Jira) and the command bus (dashboard → pod).
- **Dashboard backend** — subscribes to Redis, exposes JSON API for the frontend, relays write requests to pod APIs. Stateless.
- **Jira reflector** — separate worker that subscribes to Redis and writes phase/attention changes to Jira. Decoupled from the dashboard so Jira slowness or outages don't affect the dashboard.
- **Frontend** — SPA, polls the dashboard backend every 2-5s. SSE/websockets can come later if polling feels laggy.

### Event flow (the high-value path: Q&A)

1. Agent in auto-mode on Pod #1 hits an `ask_user_questions` call.
2. GSD writes the question to its journal/activity stream.
3. Sidecar sees it, publishes "M001 awaiting answer: <question>, options: [A, B, C]" to Redis.
4. Dashboard backend receives it; surfaces in the attention queue with the question text and options.
5. Human opens the dashboard, sees the attention badge, clicks the question, picks an option.
6. Dashboard backend sends the answer to Pod #1's write API.
7. Write API injects the answer into the running agent's input channel (serialized through the single writer).
8. Agent continues. Sidecar publishes "running" status.
9. Dashboard updates.

The whole round-trip needs to feel snappy — if a click takes 30s to register, the experience is broken.

### Live view and shell access

Two distinct interaction modes:

- **Structured controls in the dashboard.** Pause Auto, Resume, Abort Slice, Reassign Milestone, Answer Question, Send Steering Hint. All go through the pod's write API. Buttons and forms, not commands.
- **Free-form shell access via existing VS Code tunnel.** The dashboard provides a "Open VS Code" button per pod that opens `https://vscode.dev/tunnel/<name>` in a new tab. Full editor and terminal experience for power users who need to hand-edit or debug. Inherits the pod's GitHub OAuth.

Deliberately *not* mixing the two. Web-tty embedded in the dashboard was considered; rejected because mixing structured controls with free-form shell creates two paradigms in one surface. Clear split: structured stuff in the dashboard, shell stuff in VS Code.

### Steering view

A per-pod view in the dashboard that shows:

- Current unit (M/S/T identifier)
- Recent journal entries (last N rule firings)
- Current tool calls / activity
- Last assistant message or status line
- Steering input box (sends `/gsd steer` text via the write API)

Same Redis stream the dashboard already consumes; the steering view is a filtered, richer rendering of one pod's events.

---

## Why this is better than what we considered

1. **Respects GSD's discipline instead of fighting it.** Earlier framings tried to translate GSD into someone else's model. This one makes GSD's model *the* model.
2. **The "human attention" framing is product-real.** Knowing when long-running agents need you is a problem people actually have. The solution (event stream + attention queue + structured response surface) is concrete and bounded.
3. **The scope is finite.** A sidecar + a write API + a dashboard backend + a frontend + a reflector worker + Redis. Days-to-weeks of work for the first useful version, depending on v1 scope.
4. **Doesn't compete with anything.** Jira keeps doing what Jira does. GSD keeps doing what GSD does. The dashboard is purely additive — turn it off and the existing system works as before.
5. **No content sync, no second database for artifacts.** Git is the database for content. Redis is the bus for transient state. Jira holds links and assignment. Nothing duplicates.

---

## v1 scope options

Three honest reads on what v1 should be:

### Minimum Useful (recommended starting point)

- Sidecar publishing events to Redis
- Dashboard backend + frontend with **attention queue view only**
- Q&A round-trip working end-to-end
- VS Code tunnel link per pod
- **No Jira integration at all in v1**

This is the most valuable starting point because Q&A-from-browser is the unique value. It works without Jira integration. Could ship this and have it be useful immediately. Learn from using it before building more.

### Pragmatic v1

- Everything in Minimum Useful, plus:
- Board view (six phase columns)
- Minimal Jira reflection: when a phase changes, update a Jira custom field. No Jira-driven actions yet.

### Full v1

- Everything in Pragmatic v1, plus:
- Steering view per pod
- Structured controls (Pause Auto, Resume, Reassign)
- Jira webhook for assignment changes triggering pod-side acknowledgment

**Recommendation: ship Minimum Useful first.** Q&A-from-browser changes the daily experience; everything else is nice but doesn't change the fundamental loop. Ship it, use it, learn what you actually miss, then build outward.

---

## Open questions for the team

These are real questions, not rhetorical. Pushback welcome.

1. **Is "Minimum Useful" actually the right v1?** Or does the board view need to be there from day one to make the project legible to stakeholders? (Internal-tool legibility matters when securing time/budget for v2.)
2. **Where does the dashboard backend run?** Same cluster as the pods (cluster-internal networking), separate machine, or in one of the existing pods? Leaning toward dedicated pod in the same cluster.
3. **Auth model for v1.** GitHub OAuth (matches VS Code tunnel), Jira OAuth (matches assignment ground truth), or a shared dashboard secret for initial deployment? Leaning GitHub OAuth for shortest path; Jira OAuth probably matters by v2.
4. **Custom Jira issue type for slices, or use Story?** Custom is cleaner (slices don't count as Stories in sprint metrics) but requires Jira admin permissions on each project. Story is the pragmatic choice if custom types are friction.
5. **How does the sidecar reach Redis?** Cluster-internal (Redis in the same namespace) or a managed Redis (Cloud Memorystore / Redis Cloud)? Trade-off: ops simplicity vs cost vs latency.
6. **Question-answer schema.** GSD's `ask_user_questions` produces structured options. `grill-me` may produce more open-ended prompts. The dashboard needs both. What's the minimum response format that covers both without being clumsy?
7. **What happens when a pod goes offline mid-milestone?** Show "executor offline" on the card. But what's the *recovery path*? Auto-reassign? Manual reassignment? Hold until the pod returns?
8. **Time-based escalation.** "Stuck too long" is one of the attention triggers. What's "too long" for each phase? Probably configurable, but needs sensible defaults.

---

## Known risks

- **Pod write API correctness.** This is the boundary that protects GSD's single-writer constraint. Bugs here cause `.gsd/` corruption. Needs careful design and testing.
- **Q&A latency.** A 4-hop async round-trip (dashboard → pod API → GSD input → agent continues → sidecar → dashboard) has to feel fast. If it doesn't, the product fails on its most important use case.
- **Sidecar event coverage.** Picking the right subset of GSD events to publish is a design problem. Over-publishing makes Redis noisy and the dashboard busy. Under-publishing misses state changes.
- **Jira impedance.** Custom fields, parent/child rules, workflow transitions, permissions — Jira is opinionated. The reflector will have edge cases. Worth a half-day spike on a real Jira project before committing to the full design.
- **GSD itself evolving.** GSD's journal/activity/event schemas are still evolving. The sidecar will need to track changes. Keeping the sidecar approach (rather than modifying GSD core) makes this less coupled, but doesn't eliminate it.

---

## What this isn't

To be explicit about non-goals:

- **Not a project-management replacement.** Jira does that.
- **Not a real-time agent monitor.** The pod's tmux session and VS Code tunnel are for that. The dashboard is event-driven, not stream-driven.
- **Not a multi-agent coordination tool.** One pod per milestone, one human owner. Coordination happens at hand-off, not within milestones.
- **Not a board for tasks.** Tasks are too granular. They live in Jira under their parent Story for completionist auditing but don't appear on the board.
- **Not a replacement for Multica or any other tool.** It's a control plane for our specific GSD + remote-pod + Jira setup.

---

## Next steps

If the team agrees with the direction:

1. **Half-day Jira spike** — create one milestone-as-epic with two slices-as-stories on a real project, do phase transitions, see what breaks. De-risks the Jira impedance question early.
2. **Sidecar prototype** — write a sidecar that publishes GSD events to a local Redis from one pod. Validates that the event stream is rich enough to drive the dashboard.
3. **Q&A end-to-end spike** — minimal write API on one pod, minimal frontend that surfaces one question and submits an answer. Validates the most important latency path.
4. **Then decide v1 scope** based on what those three spikes reveal.

If the team disagrees with the direction — the open questions section is where to start the conversation.

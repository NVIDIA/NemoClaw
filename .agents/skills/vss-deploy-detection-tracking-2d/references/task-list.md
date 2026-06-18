# Task-List Setup (Step 0 detail)

The deploy skill uses the session planning tool (`TodoWrite` OR its rename `TaskCreate` / `TaskUpdate` / `TaskList` in newer Claude Code versions) as its **single source of truth** for the plan and per-step progress. This file holds the JSON templates and the rules.

## Tool selection — TodoWrite vs TaskCreate

Both tools render the same 5-row task widget on the user's client, but they have **different call shapes** and you MUST follow whichever the runtime exposes:

| Tool exposed | Shape                                                              | How to create the 5-task plan                                                                                                       |
|--------------|--------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| `TodoWrite`  | Single call with `todos: [...]` array                              | **1 call** with all 5 todos in the array (template under "Initial `TodoWrite` call" below).                                          |
| `TaskCreate` | Single call per task (`subject`, `description`, `activeForm`)      | **5 separate `TaskCreate` calls in immediate succession** — one per task (template under "Initial `TaskCreate` calls" below). Use `TaskUpdate` (not `TaskCreate`) for subsequent status transitions. |

**Critical rule for `TaskCreate`:** issue exactly 5 separate calls — one per task — back-to-back. Do NOT collapse all 5 steps into the `description` field of a single `TaskCreate` call. The eval rubric and the user's widget both expect 5 distinct rows.

## Core principle

**The widget is the plan. Do NOT print your own text rendering of it.** The user's client renders the todo list as a live widget that updates every time the skill calls `TodoWrite merge:true` (or `TaskUpdate`). A competing plain-text list (`Deployment plan:` + checkbox rows) would:

- duplicate what the widget already shows,
- get stale the instant a todo updates,
- waste terminal scroll,
- clash with the widget's own glyphs when the client truncates.

The skill only prints progress narration (`→` step start, `✔` step result, `?` user input, `⚠` warning, `✖` error — see `ux-conventions.md`). The widget shows the plan.

## Two actions at startup, in strict order, before any other tool

**If `TodoWrite` is available:**

1. **`TodoWrite` (merge: false) with all 5 tasks** — JSON template below. Labels ≤ 50 chars so the widget reads well when the client truncates.
2. **`TodoWrite` (merge: true) to pre-complete inferred tasks** — encode the inferred value inside the `content` field of each pre-completed todo (e.g. `"Identify use case → warehouse-2d"`). The widget will render it inline. No separate text print.

**If `TaskCreate` is the available planning tool:**

1. **5 separate `TaskCreate` calls back-to-back** — full set of 5 tasks (templates under "Initial `TaskCreate` calls" below). NEVER collapse all 5 into one `TaskCreate`'s `description` field.
2. **`TaskUpdate` to pre-complete inferred tasks** — one `TaskUpdate` call per task whose value is already pinned by the query.

In either case: do NOT run any bash, file read, `AskQuestion`, or other tool between actions 1 and 2 above. No platform detection, no NGC config check, no docker inspect — those belong to later steps.

## After startup — update-on-transition pattern

On every Step boundary, make a `TodoWrite merge:true` call that:

- marks the just-finished todo `completed`, updating its `content` to include the resolved value (e.g. `"Detect target platform → x86-dgpu (RTX 3050)"`),
- marks the next todo `in_progress`,
- leaves the rest untouched.

The widget re-renders with the new state. The skill then prints at most a single `✔ <result>` line (for the just-finished step) + a single `→ <next step>` line. **No full-list re-prints.**

## Label rule — short and stable

Every todo `content` field is a **short canonical label** (≤ 30 chars) set once at startup. It must NEVER change during the deploy — no embedded resolved values, no dynamic suffixes. Keeping content short is what makes the client render all 10 rows in the Todo widget instead of collapsing to "+N completed". Resolved values live in the scrollback `✔` narration (e.g. `✔ Platform: x86-dgpu (RTX 3050)`), not in the widget.

| ❌ Long (triggers widget truncation)                                                | ✅ Short (all 5 rows stay visible)        |
|------------------------------------------------------------------------------------|-------------------------------------------|
| `Prepare deploy: usecase + platform + container + model + videos + fetch`          | `Prepare deploy (targets + fetch)`        |
| `Prepare deploy → smartcity-gdino, default container, default model, downloaded`  | `Prepare deploy (targets + fetch)`        |
| `Finalize pipeline settings (batch=4, dynamic, filesrc, eglsink)`                  | `Finalize pipeline settings`              |

## Initial `TodoWrite` call (exact content — copy verbatim)

```json
{
  "merge": false,
  "todos": [
    {"id": "prepare",   "content": "1/5. Prepare deploy (targets + fetch)", "status": "in_progress"},
    {"id": "pipeline",  "content": "2/5. Finalize pipeline settings",       "status": "pending"},
    {"id": "launch",    "content": "3/5. Launch RTVI-CV container",         "status": "pending"},
    {"id": "config",    "content": "4/5. Apply configuration",              "status": "pending"},
    {"id": "start_app", "content": "5/5. Start perception app",             "status": "pending"}
  ]
}
```

## Initial `TaskCreate` calls (when `TaskCreate` is the available planning tool)

When the runtime exposes `TaskCreate` instead of `TodoWrite`, issue **5 separate
`TaskCreate` calls in immediate succession**, one per task, BEFORE any other tool
runs (no bash, no file reads, no `AskQuestion` between them). Same 5 subjects as
the `TodoWrite` template, plus a `description` field that names what the task
covers — the description is what makes each task auditable as covering a distinct
deploy concern (platform detection, NGC resource staging, container launch,
in-container config apply, app start).

```jsonc
// Call 1 — TaskCreate
{
  "subject":     "1/5. Prepare deploy (targets + fetch)",
  "description": "Detect target platform (x86 dGPU / SBSA / Jetson) and load deploy-defaults.yml; resolve container image, NGC resource, model, and videos via a single 3-question AskUserQuestion; stage NGC resources (download + extract) or copy local paths into $HOME/rtvicv-storage/resources/.",
  "activeForm":  "Preparing deploy targets and fetching resources"
}

// Call 2 — TaskCreate
{
  "subject":     "2/5. Finalize pipeline settings",
  "description": "Single AskUserQuestion for batch size, stream mode (static is default), input source type, and output sink. Confirms pipeline configuration before container launch.",
  "activeForm":  "Finalizing pipeline settings"
}

// Call 3 — TaskCreate
{
  "subject":     "3/5. Launch RTVI-CV container",
  "description": "Synthesize the docker run command for the resolved RTVI-CV image and start the rtvicv-perception-docker container (or reuse an existing one).",
  "activeForm":  "Launching RTVI-CV container"
}

// Call 4 — TaskCreate
{
  "subject":     "4/5. Apply configuration",
  "description": "Inside the running container: resolve config paths, set batch-size and output sink, bake auto-discovered file:// stream URLs into the static [source-list] block of the DS main config, set [tests] file-loop=1 so fakesink/eglsink loop forever, and prelaunch the nvinfer engine cache.",
  "activeForm":  "Applying in-container configuration"
}

// Call 5 — TaskCreate
{
  "subject":     "5/5. Start perception app",
  "description": "Launch metropolis_perception_app inside the container, poll /api/v1/ready, sample /api/v1/metrics, and write the structured deployment log.",
  "activeForm":  "Starting perception app"
}
```

After the 5 `TaskCreate` calls, use `TaskUpdate` (not `TaskCreate`) on each
step boundary — see "Progressive updates at every step boundary" below for
the equivalent `TaskUpdate` shape.

**Pre-completing inferred tasks under `TaskCreate`:** if the query already
answers task 1's targets (e.g. `deploy warehouse-2d, 4 streams, image
nvcr.io/X/Y:tag, resource org/team/res:ver`), issue the 5 `TaskCreate` calls
above with status `pending`, then immediately call `TaskUpdate` to mark the
inferred task(s) `completed`. Do NOT collapse pre-completion into a single
`TaskCreate` with multiple sub-items — one `TaskCreate` per task, always.

> **Numbered prefix rule** (`N/5.`) — every `content` field starts with its
> task number and the total count. This ensures the user sees their
> position in the plan even when the client collapses completed rows
> ("+2 completed"). The number is PART of the content string and must be
> copied verbatim on every `TodoWrite merge:true` call so the client
> doesn't re-render the row on each merge (changed content = flicker).
>
> **Changes from v1.3.0:**
> - 6 todos → **5 todos**. The `targets` and `fetch` todos collapsed
>   into a single `prepare` todo. SKILL.md Step 1 now drives end-to-end:
>   use case detect → platform → load `deploy-defaults.yml` →
>   3-question AskUserQuestion (Container / Model / Videos with YAML
>   defaults) → resolve answers → fetch resources (one
>   `fetch_resources.sh` call: NGC creds gate + download/extract OR local
>   copy into `$HOME/rtvicv-storage/resources/local-<role>/`) → summary.
> - Step → todo mapping: `prepare` → SKILL.md Step 1, `pipeline` →
>   Step 2, `launch` → Step 3, `config` → Step 4, `start_app` →
>   Step 5. Step 6 (next steps) is post-deploy and has no todo.
>
> **Carry-overs:**
> - `ngc_creds` is NOT a top-level todo — credential setup runs as a
>   silent gate inside `prepare` (Step 1.g via `fetch_resources.sh`)
>   that no-ops when creds are cached OR `NEEDS_NGC=0`.
> - Local model and video paths are copied (`cp` / `cp -r`, never
>   symlinked) into `$HOME/rtvicv-storage/resources/local-<role>/` so
>   the `~/rtvicv-storage:/opt/storage` bind mount exposes them at
>   `/opt/storage/resources/local-<role>/` inside the container.

## Pre-complete tasks the user already answered (run IMMEDIATELY after the initial list)

Example — user says: *"deploy warehouse-3d, 4 streams, display, image `nvcr.io/X/Y:tag`, resource `org/team/res:ver`"* (all targets slots resolved + pipeline known; fetch will still happen but is part of `prepare`):

```json
{
  "merge": true,
  "todos": [
    {"id": "pipeline", "status": "completed"},
    {"id": "prepare",  "status": "in_progress"}
  ]
}
```

Example — user says: *"deploy smartcity-rtdetr, model at /data/model.onnx, RTSP cameras rtsp://..."* (all-local, no NGC):

```json
{
  "merge": true,
  "todos": [
    {"id": "pipeline", "status": "completed"},
    {"id": "prepare",  "status": "in_progress"}
  ]
}
```

In the all-local case, the credential gate inside `prepare` is a silent
no-op when `NEEDS_NGC=0` (determined by the resource plan computed in
SKILL.md Step 1.f). The user never sees an NGC credential prompt — and
the local model + videos paths get copied into
`$HOME/rtvicv-storage/resources/local-<role>/` so the bind mount picks
them up.

> **Only update `status`.** Never touch `content` — the labels set at startup must stay identical for the life of the deploy. If the client doesn't see the exact same content string across merges it may re-render the row, causing flicker.

## Progressive updates at every step boundary

On finishing each step, one update that:

1. flips the just-finished todo's `status` to `"completed"`,
2. flips the next pending todo's `status` to `"in_progress"`.

**Under `TodoWrite`** (merge: true):

```json
{
  "merge": true,
  "todos": [
    {"id": "prepare",  "status": "completed"},
    {"id": "pipeline", "status": "in_progress"}
  ]
}
```

**Under `TaskCreate`** (two `TaskUpdate` calls, back to back):

```jsonc
// Call A — TaskUpdate
{"taskId": "<id-of-prepare-task>",  "status": "completed"}
// Call B — TaskUpdate
{"taskId": "<id-of-pipeline-task>", "status": "in_progress"}
```

(`<id-of-...>` is the `taskId` returned by the matching `TaskCreate` call at
startup. Use `TaskList` if you need to look up an ID mid-deploy.)

No `subject` / `content` mutation. No re-stating the full list in text. The widget and the single `✔ <result>` + `→ <next>` pair in the scrollback are the only things the user sees per transition.

## Workflow rules

- Only **one task** is `in_progress` at a time.
- On entering each Step, flip its todo to `in_progress`.
- On exit, flip it to `completed` and promote the next pending todo.
- **If a step is trivially answered from the user's initial query**, mark it `completed` in the second `TodoWrite` call at startup (Action B) BEFORE starting work — don't leave it pending.
- Within each step, use only the `→ / ✔ / ? / ⚠ / ✖` glyph lines from `ux-conventions.md`. No full-list text prints.

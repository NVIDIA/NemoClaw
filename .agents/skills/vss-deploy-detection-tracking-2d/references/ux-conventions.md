# UX Conventions (what the user sees)

A deploy runs across **5 user-visible steps** and 2-4 minutes (or 15+ min on first-time TRT engine build). The agent's terminal output IS the user interface. This file defines the visual vocabulary so that output is scannable, non-redundant, and self-explanatory.

> **The 5 steps are the todo widget.** Internal substep labels (`1.b`, `4.a`,
> `5.b.2`, `T3`, etc.) are model-facing only — never let them appear in
> `→` / `✔` / `?` / `⚠` / `✖` lines, box titles, or any user-visible text.
> Describe the action directly instead.
>
> See `deploy-vss-detection-tracking-2d.md` § "User-facing announcements —
> never include substep notation" for the canonical rule and full example table.

## Six-glyph vocabulary (use exactly these)

| Glyph | When to use | Example |
|---|---|---|
| `→` | **Step start** — announce what's about to happen. One line, no trailing `...` | `→ Detect target platform` |
| `✔` | **Step done** — include the result inline | `✔ Platform: x86-dgpu (RTX 3050)` |
| `ℹ` | **Default in effect** — announce a value being applied + its alternatives, so the user can interrupt and override. See SKILL.md § Announce-before-applying. | `ℹ stream_add_delay: 20s (default) — alternatives: 5s / 10s / 0s  \|  interrupt to switch.` |
| `?` | **Needs user input** — always followed by a grouped block (see below); used only when a decision is truly undecidable without input | `? I need 2 inputs from you:` |
| `⚠` | **Warning** — the deploy continues but the user should know | `⚠ GPU has only 8 GB VRAM — batch=8 may OOM, recommend batch=4` |
| `✖` | **Error** — hard failure, skill stops | `✖ Docker image arch (arm64) does not match platform (x86-dgpu)` |

**`ℹ` vs `?`:** `ℹ` applies a default without blocking (user can interrupt
to override); `?` blocks waiting for user input. Prefer `ℹ` whenever a
reasonable default exists — only use `?` for values that can't be
defaulted (credentials, truly ambiguous multi-candidate picks, hard
errors).

The plain-text plan (printed once at Step 0) uses a slightly different glyph set because it's a static list, not a progress stream: `☐` pending, `▶` in-progress, `✔` completed. See `task-list.md`.

## The three things the user MUST see per step

1. **Step start**: one `→` line, terse, **using the todo label** (so the user always knows where in the 5-step plan they are). Never use SKILL.md's internal step number — write `→ Finalize pipeline settings`, not `→ Step 2 — Pipeline settings`.
2. **Step result**: one `✔` line on success with the **resolved, releasable value** (what model, what videos dir, what image, what path was chosen, what cache outcome occurred), OR a `?` block if user input is needed, OR `⚠` / `✖` if something went wrong.
3. **The Todo widget flipping** (happens automatically when the skill calls `TodoWrite merge:true` with the new state).

Anything else is optional. If a step is fast and has nothing interesting to show, a single `→ …` line that's immediately followed by its `✔ …` line is fine — but the `✔` should still carry a concrete value, not a generic "done".

## What to show / tell the user (transparency contract)

**Rule of thumb: the user must always be able to answer two questions from the scrollback alone:**

1. *What step is the skill on right now?* → the most recent `→` line answers this.
2. *What concrete artifact is being used?* → the most recent set of `✔` lines answers this.

Every substantive decision shows up as a `✔ <what>: <value>` line:

| Concept | How it shows up |
|---|---|
| Use case picked | `✔ Use case: warehouse-2d` |
| Platform detected | `✔ Platform: x86-dgpu (RTX 3050)` |
| Docker image confirmed | `✔ Docker image: vss-rt-cv:3.2.0 (amd64 matches x86-dgpu)` |
| Resource plan finalized | `✔ Resource plan:` + `    • model → NGC (...)` + `    • videos → NGC (...)` |
| NGC creds (or skipped) | `✔ NGC credentials: reusing existing config (org=...)` or `✔ NGC credentials: not needed (all sources local)` |
| Pipeline settings | `✔ Pipeline: batch=4, dynamic, filesrc, eglsink (delay 10s)` |
| Download / copy done | `    ✔ <ref>: downloaded (2.3 GB)` / `    ✔ videos: staged at resources/local-videos` |
| Model selected from scan | `    ✔ model: <model-basename> (1 of 1 found)` or `(selected from 3 candidates)` |
| Videos dir selected from scan | `    ✔ videos: /opt/storage/resources/.../nv-warehouse-4cams (4 .mp4 files)` |
| Container launched | `✔ Container: launched rtvicv-perception-docker` |
| Engine cache outcome | `    ✔ Engine cache: HIT_EXACT for batch=4 (skipped ~3 min build)` |
| App started + streams added | `✔ App: started, REST on :9000` + `[1/4] Adding id=Camera ... ✓` |

> **Never hide a concrete choice behind a generic message.** `✔ Configuration applied` by itself is too vague — follow it with the indented list of what was applied (model path, batch size, sink type, tile grid, engine cache outcome). The user should be able to diff two deploys by reading the scrollback.

### Per-todo `✔` exit checklist (releasable info)

Each of the 5 todos must close with a `✔` block that carries the
concrete artifacts produced. The user should be able to copy the line
into a bug report or a reuse-this-deploy note without further questions.

| Todo | `✔` exit must include |
|---|---|
| `1/5. Prepare deploy (targets + fetch)` | use case, platform + GPU + VRAM, image full ref, model NGC ref + filename, videos NGC ref + dir name, each marked `(default\|custom)` and `(cached\|fetched\|staged-local)` |
| `2/5. Finalize pipeline settings`       | every value: `batch=N, <stream_mode>, <input_type>, <output_sink>, delay=Xs` — single line; suffix overrides with `*` |
| `3/5. Launch RTVI-CV container`         | container name, branch (launched/reused/restarted/parallel), image short-ref, REST port |
| `4/5. Apply configuration`              | concrete edits: batch-size touch points modified, ONNX path written, sink type, engine cache outcome (HIT_EXACT / HIT_LARGER_BATCH / MISS_BUILD / built-in-Xmin) |
| `5/5. Start perception app`             | REST URL, deployment-log path, engine artifact path, streams active, `nvidia-smi`/`collect_metrics.sh` snapshot (GPU%/MEM%/per-stream FPS) |

If any of those values is unknown or hasn't been resolved when the step
ends, that's a bug — fix the upstream resolution rather than printing a
sloppy `✔ Step done.`.

## Heartbeats for long waits — keep the concrete value visible

For any wait > 20s (NGC download, TRT engine build, REST /ready poll), emit a heartbeat line every 15-20s that **restates what the skill is waiting on**, not just "still waiting":

```
→ Downloading vss-warehouse-app-data:v3.1.0-03052026 (2.3 GB est)
    … 450 MB / 2.3 GB — 30s elapsed
    … 1.1 GB / 2.3 GB — 75s elapsed
    ✔ Downloaded vss-warehouse-app-data (2.3 GB final)

→ Build TensorRT engine for <model-basename> (batch=4, ~3-5 min on RTX 3050)
    … building engine for <model-basename> — 60s elapsed
    … building engine for <model-basename> — 180s elapsed
    ✔ Engine built: engines/<model-basename>_b4.engine

→ Polling /api/v1/ready
    … waiting for pipeline (pgie initializing) — 15s elapsed
    … waiting for pipeline (engine loaded, starting sources) — 30s elapsed
    ✔ REST ready — ds-ready: YES
```

The heartbeat **names the asset** (ONNX filename, resource ref, model-engine-file path) every time, so the user can glance at any moment and know what the skill is crunching on.

## What NOT to print

- **Don't narrate routine commands** — no "Running `uname -m`...", "Checking `~/.ngc/config`...", "Inspecting `docker manifest`...". The user doesn't care about the plumbing.
- **Don't re-print the plan between steps** — the Todo widget already shows state. The plan is printed exactly once at Step 0.
- **Don't print method before result** — "Platform: x86-dgpu" is better than "Detecting platform via uname and nvidia-smi" followed later by "Platform: x86-dgpu". Collapse them into a single `✔ Platform: …` on completion. If detection takes >3s, print a `→ Detect platform` line first so the user sees *something* while they wait.
- **Don't restate the inputs the user just gave** — "You chose eglsink. Confirming eglsink..." is noise. The Todo widget + pre-completion marks already captured it.
- **Don't print ASCII separators** (`---`, `═══`) — they clutter the scroll. Only the box-drawing borders (`┌─...─┐` / `└─...─┘`) used by the per-step exit boxes are allowed.

## User-input block — one shape only

Whenever multiple inputs are needed, print ONE grouped block with a `?` header, a blank line, and a numbered list. Don't scatter prompts across multiple turns.

```
? I need 2 inputs from you before continuing:

  1. Docker image reference (e.g. nvcr.io/<org>/<repo>:<tag>)
     — must be the x86/amd64 build, no '-sbsa-' suffix.

  2. NGC warehouse app-data resource (format: org/team/resource:version)
     — covers the RT-DETR ONNX + warehouse test videos.

(Paste both, one per line, in your next reply.)
```

Rules:

- Header line starts with `? ` (question glyph + space).
- Each input has a 2-line entry: name + constraint hint on the second line (indented 5 spaces after the number).
- Final line in parens tells the user how to reply.
- If only ONE input is needed, use a single-line form: `? Paste the RTVI-CV docker image reference (e.g. nvcr.io/<org>/<repo>:<tag>).`

## Step transition — one box per step exit

Between Step N done and Step N+1 starting, the user sees a fixed-width box
containing the `✔ <key>  <value>` lines for that step, followed by a single
`→ <next step>` line. See SKILL.md § "Universal box format" for geometry
(width 128, centered title, light box-drawing chars, blank-line separators
between groups).

```
┌─────────────────────────────────────────────────────── Deploy targets ───────────────────────────────────────────────────────┐
│                                                                                                                              │
│   ✔ Use case    smartcity-gdino                                                                                              │
│   ✔ Platform    x86-dgpu (RTX 3050, 8 GB VRAM)                                                                               │
│   ✔ Image       <DEFAULT_IMAGE>                                                                                              │
│   ✔ NGC creds   reusing ~/.ngc/config (mode 0600)                                                                            │
│                                                                                                                              │
│   ✔ Model       <DEFAULT_MODEL_BASENAME>                                                                                     │
│                 from  <DEFAULT_MODEL_NGC_REF>                                                                                │
│                                                                                                                              │
│   ✔ Videos      <DEFAULT_VIDEOS_BASENAME>                                                                                    │
│                 from  <DEFAULT_VIDEOS_NGC_REF>                                                                               │
│                                                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
→ Step 2: Pipeline configuration
```

The box is the receipt; the `→` line is the sign-post to the next step.

> **No intermediate substep boxes.** Platform detection and YAML
> defaults loading happen during Step 1 but do NOT get their own
> boxes — they fold into the single Step 1 "Deploy targets" exit box
> shown above. See SKILL.md § "Universal box format" for the full
> rule (which substep flows fold into which exit box, and which
> multi-box flows like Step 5 plan/result/summary or Step 6 per-
> action boxes are legitimate).

## Progress heartbeat — when to stop

See [Heartbeats for long waits](#heartbeats-for-long-waits--keep-the-concrete-value-visible)
above for the canonical heartbeat format with worked examples.
**Stop printing the heartbeat the moment the step resolves (`✔` or `✖`).**

## Final deploy receipt — the "Perception Application — Results" box

The Step 5 Results box (`┌─── Perception Application — Results ───┐`)
is the only post-launch receipt — it's the user's at-a-glance summary
of what's running. Templates and field set live in `start-app.md`.
Same universal box format (light box-drawing chars, 128-char width,
centered title) as every other Step 1-5 exit box — see SKILL.md
§ "Universal box format". **Do NOT add a second "deployment summary"
box afterward** — it would just duplicate the Results box content.

## Worked example — first 3 steps with the conventions applied

After `TodoWrite` + pre-completion, user sees:

```
Deployment plan:
  ✔ Identify use case → warehouse-2d (from query)
  ▶ Detect target platform
  ☐ Verify RTVI-CV docker image arch
  ☐ Set up / reuse NGC credentials
  ☐ Gather NGC resource references for warehouse-2d
  ✔ Finalize pipeline settings → batch=2, static, filesrc, eglsink (from query)
  ☐ Download or reuse NGC resources
  ☐ Launch (or reuse) the RTVI-CV container
  ☐ Apply warehouse-2d configuration inside the container
  ☐ Start metropolis_perception_app (REST at :9000)

✔ Platform: x86-dgpu (RTX 3050)
⚠ RTX 3050 has 8 GB VRAM — batch=2 is fine, >=8 streams may OOM.
→ Verify RTVI-CV docker image arch

? I need 2 inputs from you before continuing:

  1. Docker image reference (e.g. nvcr.io/<org>/<repo>:<tag>)
     — must be the x86/amd64 build, no '-sbsa-' suffix.

  2. NGC warehouse app-data resource (format: org/team/resource:version)

(Paste both, one per line, in your next reply.)
```

That's 17 lines for "plan + platform detection + image-arch step open". Compare to the earlier transcript which used ~40 lines for the same journey with two plan re-prints.

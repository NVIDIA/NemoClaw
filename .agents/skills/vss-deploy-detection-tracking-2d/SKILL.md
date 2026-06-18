---
name: vss-deploy-detection-tracking-2d
description: "Use this skill when the user wants to deploy, run, debug, tear down, or call the REST API of the RTVI-CV 2D detection / tracking microservice. Trigger when the user says things like 'deploy rtvi-cv', 'start warehouse 2d', 'add a stream', 'check rtvi-cv health', or 'stop the perception container'. Not for VLM, embedding, or analytics — use the matching vss-* skill."
license: Apache-2.0
metadata:
  version: "3.2.0"
  github-url: "https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization"
  tags: "nvidia rtvi-cv deployment rest-api docker deepstream ngc warehouse smartcity sparse4d gdino rt-detr metropolis stream-management health-check metrics"
---
## Purpose

Deploy, debug, and operate the RTVI-CV detection / tracking 2D microservice and drive its REST API.

## Prerequisites

- Active VSS deployment reachable on `$HOST_IP` (see `vss-deploy-profile` and `references/`).
- NGC credentials in `$NGC_CLI_API_KEY` and `$NVIDIA_API_KEY` for any image pulls.
- `curl`, `jq`, and Docker available on the caller.

## Instructions

Follow the routing tables and step-by-step workflows below. Each section that ends in *workflow*, *quick start*, or *flow* is intended to be executed top-to-bottom. Detailed reference material lives in `references/` and helper scripts live in `scripts/` — call them via `run_script` when the skill points to a script by name.

## Examples

Worked end-to-end examples are kept under `evals/` (each `*.json` manifest contains a runnable scenario) and inline in the per-workflow `curl` blocks below. Run a Tier-3 evaluation with `nv-base validate <this-skill-dir> --agent-eval` to replay them.

## Limitations

- Requires the matching VSS profile / microservice to be deployed and reachable from the caller.
- NGC-hosted models and NIMs may be subject to rate-limits, GPU memory requirements, and license restrictions.
- Concurrency, GPU memory, and storage limits depend on the host hardware and the profile's compose file.

## Troubleshooting

- **Error**: REST call returns connection refused. **Cause**: target microservice not running. **Solution**: probe `/docs` or `/health`; redeploy via `vss-deploy-profile` or the matching `vss-deploy-*` skill.
- **Error**: HTTP 401/403 from NGC pulls. **Cause**: missing/expired `NGC_CLI_API_KEY`. **Solution**: `docker login nvcr.io` and re-export the key before retrying.
- **Error**: container OOM or model fails to load. **Cause**: insufficient GPU memory for the selected profile. **Solution**: switch to a smaller variant or free GPUs via `docker compose down`.

# RTVI-CV — Detection & Tracking (Unified Skill)

Unified skill for the **Real Time Video Intelligence CV (RTVI-CV)** microservice. Two action surfaces in one skill:

- **Deploy / operate / debug / tear down** the RTVI-CV container locally → see [`references/deploy-vss-detection-tracking-2d.md`](references/deploy-vss-detection-tracking-2d.md)
- **Call the RTVI-CV REST API** (streams, health, metrics, embeddings) on a running instance → see [`references/usage-vss-detection-tracking-2d.md`](references/usage-vss-detection-tracking-2d.md)

> **Service**: `rtvi-cv` (`metropolis_perception_app`)
> **Image**: `nvcr.io/<org>/<repo>:<tag>` — user-supplied at deploy time
> **REST port**: `9000` (`/api/v1` — `/live`, `/ready`, `/startup`, `/metrics`, `/stream/add`, `/stream/remove`, embeddings)
> **Hardware**: x86/aarch64 dGPU (T4, A100, L40, H100, B200, RTX), SBSA (Spark, Grace-Hopper), Jetson (Thor, Orin, Xavier)

---

## Action routing — pick once per invocation

| User intent (sample phrasing) | Flow | Load this reference |
|-------------------------------|------|---------------------|
| `deploy rtvi-cv warehouse 2d`, `run rtvicv warehouse-3d with 4 streams`, `start smartcity gdino`, `launch perception app`, `bring up sparse4d` | **DEPLOY** | [`references/deploy-vss-detection-tracking-2d.md`](references/deploy-vss-detection-tracking-2d.md) |
| `stop rtvi-cv`, `tear down`, `kill the perception container`, `cleanup rtvicv-perception-docker` | **TEARDOWN** (handled by deploy doc → "Mode Selection") | [`references/deploy-vss-detection-tracking-2d.md`](references/deploy-vss-detection-tracking-2d.md) + [`references/teardown-flow.md`](references/teardown-flow.md) |
| `check rtvi-cv logs`, `diagnose rtvi-cv crashing`, `troubleshoot healthcheck failing`, `rtvi-cv won't start` | **DEBUG** | [`references/deploy-vss-detection-tracking-2d.md`](references/deploy-vss-detection-tracking-2d.md) + [`references/troubleshooting.md`](references/troubleshooting.md) |
| `add a stream`, `remove camera`, `list streams`, `health check`, `is rtvi-cv ready`, `get metrics`, `what's the FPS`, `check GPU usage`, `generate text embeddings`, `call rtvi-cv api` | **API USAGE** | [`references/usage-vss-detection-tracking-2d.md`](references/usage-vss-detection-tracking-2d.md) + [`references/api-reference.md`](references/api-reference.md) |

**Selection rule:** match the user's phrasing against the table above and immediately load the corresponding reference file. Do not mix the flows — DEPLOY assumes no running container yet; API USAGE assumes the container is already running on `http://<host>:9000`.

If intent is genuinely ambiguous (e.g., the user says just "I want to use rtvi-cv"), ask one `AskQuestion`: deploy a new instance, or call an already-running one?

---

## What lives where

```
vss-deploy-detection-tracking-2d/
├── SKILL.md          # this file (routing + contracts)
├── assets/           # data files (deploy-defaults.yml — single source of truth for tags / refs / paths / GPU)
├── evals/            # Tier-3 eval manifests (deploy-evals.json, usage-evals.json)
├── scripts/          # 23 bash + python helpers (see `scripts/` for the full inventory)
└── references/       # workflow runbooks (deploy / api-usage / teardown / troubleshooting / …)
```

For the full per-file inventory and what each reference covers, see
[`references/workflow-reference.md`](references/workflow-reference.md).

All scripts are invoked from the skill root via `$SKILL_DIR/scripts/<name>` — paths inside the deploy reference doc are preserved verbatim and resolve correctly when the agent runs from skill root.

---

## Available Scripts

Helpers live in `scripts/` and are invoked from the skill root by name —
call each via `run_script("scripts/<name>")` so the agent records a
proper tool invocation.

| Script | Purpose | Arguments |
| --- | --- | --- |
| `load_defaults.sh` | Detect platform (x86 dGPU / SBSA / Jetson) and resolve YAML defaults from `assets/deploy-defaults.yml`. | `--usecase <name>` |
| `fetch_resources.sh` | Download + extract NGC resources, scan for layout. | `--ngc-ref <ref>` (optional) |
| `apply_in_container.sh` | Host-side wrapper for Step 4 (`apply_config.sh` inside the running container). | `<container_name>` |
| `apply_config.sh` | In-container path-substitution, batch, sink, sources, engine cache. | `<usecase> <stream_count> <sink_type>` |
| `start_app_in_container.sh` | Host-side wrapper for Step 5 (`run_app_and_wait.sh`). | `<container_name>` |
| `run_app_and_wait.sh` | In-container app launch + readiness + metrics + log. | `<config_path>` |
| `add_streams.sh` / `update_stream_sources.sh` | REST stream lifecycle for Step 6. | `<rtsp_or_file_uri>...` |
| `collect_metrics.sh` | Pull `/api/v1/metrics` snapshot. | none |
| `discover_streams.sh` | Enumerate active streams via `/stream/get-stream-info`. | none |
| `synthesize_docker_run.sh` | Print the platform-correct `docker run` line for the resolved env. | none |
| `render_box.sh` | Render the fixed-width step receipt. | `<step_label>` |
| `calibration_manager.py` | Manage calibration artefacts + per-use-case engine cache invalidation. | `--usecase <name> --reset` |

For the full inventory of helpers (cache, GPU checks, setup) browse
`scripts/`; each script's `--help` describes its arguments.

## How to use this skill

1. **Read this file first.** It only routes — it does not contain workflows.
2. **Match the user's intent** against the routing table above.
3. **Load exactly one reference doc** (DEPLOY or API USAGE). Don't preload both — each reference is large and contains its own full contract.
4. **Follow the loaded reference exactly.** The reference docs are the byte-for-byte preserved contracts from the predecessor skills `vss-deploy-detection-tracking-2d` (deploy/teardown/debug) and `rtvicv-api` (REST API) — every step ordering invariant, bash-batching rule, box-rendering rule, and `AskQuestion` contract is retained.
5. **For DEPLOY**, the reference doc enforces its own startup contract: one-line acknowledgement → planning-tool call (`TodoWrite` array of 5 todos, OR 5 successive `TaskCreate` calls on newer Claude Code) → Step 1 question. Do not narrate, do not pre-flight, and never print "loading TodoWrite/TaskCreate" or any deferred-tool resolution prose — the planning tool is loaded silently.

---

## Output contract — DEPLOY flow

When running the DEPLOY / TEARDOWN / DEBUG flow, the agent MUST honour
all four items below on every successful deploy. These are the user's
only feedback channel between steps; skipping any of them is a
behaviour regression.

1. **Render every step's exit in a fixed-width box** — Step 1 *Deploy
   targets*, Step 2 *Pipeline configuration*, Step 3 *Container*, Step 4
   *Apply configuration*, Step 5 *Plan* + *Results*. Not just the final
   summary. The box is the user's step receipt. Geometry is fixed (see
   § "Universal box format" below). Per-step **content** rules (what
   rows go inside each box) live in [`references/deploy-vss-detection-tracking-2d.md`](references/deploy-vss-detection-tracking-2d.md)
   under "Step N box content rule".
2. **After the Step 5 Results box, issue the Step 6 `AskUserQuestion`**
   from [`references/next-steps.md`](references/next-steps.md) § "11.c"
   — never replace it with a free-form *Next steps* bullet list. The
   menu is the deploy's exit handle: it lets the user run metrics,
   manage streams, tail logs, or tear down with one click instead of
   having to remember curl URLs.
3. **After the user picks a Step 6 bucket, issue the follow-up
   `AskUserQuestion`** from [`references/next-steps.md`](references/next-steps.md)
   § "11.d" — never substitute prose + ready-to-copy curl examples + a
   free-text "want me to run X?" question. Each bucket has its own
   menu of concrete actions; the user picks the action, then the skill
   emits the API box and runs the curl. Per-bucket follow-ups:
   - **Manage streams** → Add / Remove / List. **Remove builds its
     options dynamically from `/stream/get-stream-info`** — one option
     per active stream labelled `<camera_id> · <camera_url>` plus
     "Remove ALL" when `ACTIVE > 1` (full spec: § "`remove_streams`
     sub-flow").
   - **Stop the deployment** → Stop app / Stop container / Full teardown.
   - **Check metrics & FPS** → no follow-up; run `collect_metrics.sh`
     directly after printing the `/api/v1/metrics` API box.
   - **Check liveness / readiness** → no follow-up; probe all three
     health endpoints after printing their API boxes.
4. **Render the FULL per-step content, not an overview row** —
   rendering the box is necessary but not sufficient. Each step has a
   row composition spec in
   [`references/deploy-vss-detection-tracking-2d.md`](references/deploy-vss-detection-tracking-2d.md)
   under "Step N box content rule". **Step 4 (Apply configuration) is
   where the agent collapses most often** — its canonical
   per-use-case key list lives in
   [`references/apply-config.md`](references/apply-config.md)
   § "Per-use-case complete edit list", and the agent MUST emit one
   `✔ [section] key=value  — annotation` row per key in that table for
   the active use case + settings. A section with 5 keys → 5 rows; a
   section with 6 keys → 6 rows. Never one overview row per section.

Forbidden (these are the shortcuts the agent falls back to under
pressure, and they break the user's UX):

- ❌ **Internal tool-loading narration.** Never print "I need to load
  TodoWrite (a deferred tool the skill calls for the task widget)",
  "Loading TaskCreate…", "Calling ToolSearch for the planning tool…",
  or any other text about resolving / loading / fetching deferred tools.
  The agent loads tools **silently**. The user only ever sees the `✔
  <pinned-values>` summary line followed by the widget — never any
  scaffolding around tool resolution.
- ❌ **Collapsing all 5 deploy steps into a single `TaskCreate`'s
  `description` field.** When `TaskCreate` is the available planning
  tool, issue **5 separate `TaskCreate` calls** back-to-back (one per
  step). See `references/task-list.md` § "Initial `TaskCreate` calls"
  for the verbatim template. Same rule for `TodoWrite` — one call with
  all 5 todos in the `todos:[…]` array; never one todo whose `content`
  is a multi-line list.
- ❌ **Silently choosing `dynamic` stream-mode.** The skill default is
  `stream_mode=static` — the agent bakes auto-discovered `file://` URLs
  into the DS main config's `[source-list]` block before app start.
  Switch to `dynamic` only when the user explicitly asks ("add streams
  later via REST", "use dynamic stream mode") OR when they pick `dynamic`
  in the Step 2 AskQuestion. Picking `dynamic` for a generic "deploy
  rtvi-cv with N streams" query breaks the deploy rubric and the
  user's `/metrics` expectations. See
  [`references/pipeline-config.md`](references/pipeline-config.md)
  § "Defaults — the skill is static-mode by default" for the full
  rationale.
- ❌ A one-line `✔ App ready in Ns, N streams, fps total Y` in place of
  the Step 5 Results box.
- ❌ ASCII box-drawing chars (`+`, `-`, `=`, `*`) instead of light
  box-drawing chars (`┌ ─ ┐ │ └ ┘`).
- ❌ Skipping Step 6 on the assumption "the user knows what to do next".
- ❌ After Step 6, dumping a markdown wall of prose + multiple curl
  blocks + a closing "want me to run any of these?" — that's the
  shape the agent falls back to and it bypasses both the 11.d menu
  and the per-API-call box. The user picks from a menu; the skill
  shows the resolved API box; the skill runs it. No free-text Q.
- ❌ Step 4 overview collapses — these are explicitly banned by the
  deploy doc's Step 4 content rule:
    - `✔ Batch size 3 (tile grid: 1×3)` → required: 5 separate rows
      (`[streammux] batch-size=3`, `[primary-gie] batch-size=3`,
      `[source-list] max-batch-size=3`, `[tiled-display] rows=1`,
      `[tiled-display] columns=3`).
    - `✔ Output sink eglsink` → required: one row per sink key
      (4 keys for eglsink, e.g. `[sink0] enable=1`, `type=2`,
      `sync=0`, `qos=0` — read apply-config.md for the exact list).
    - `✔ Sources static (3 streams, http-port=9000)` → required: six
      annotated `[source-list]` rows.
    - `✔ Tile grid 1 row × 3 cols` (single row) → required: two
      rows, `[tiled-display] rows=1` and `[tiled-display] columns=3`.

## Universal box format

The geometry contract for every step-exit box (Step 1 through Step 5
Results). The same shape across every box; only the **title** and the
**body rows** change per step.

- **Width: 128 chars** corner-to-corner — `┌` at column 1, `┐` at
  column 128. Wider terminals leave the box flush-left; do not stretch
  it. Inner content area is **124 chars** (with one space margin on
  each side inside the `│` borders).
- **Light box-drawing chars only**: `┌ ─ ┐ │ └ ┘`. No `+`, `-`, `=`,
  `*` ASCII fallbacks.
- **Top border — title CENTERED**: `┌` + N₁ dashes + `␣` + title + `␣`
  + N₂ dashes + `┐`, where `N₁ + N₂ + len(title) + 2 = 126`. Distribute
  the pad: `N₁ = floor((126 − len(title) − 2) / 2)`,
  `N₂ = 126 − len(title) − 2 − N₁`. N₁ and N₂ differ by at most 1.
- **Body**: one `│ <content padded to inner-content 124> │` per fact.
  Each fact line uses the `  ✔ <key-padded-to-13>  <value>` form (two
  spaces in, glyph, key right-padded to 13, two spaces, value).
- **Blank lines between groups**: render `│ <124 spaces> │` between
  logical groups (e.g. Identity / Model / Videos in Step 1) so the
  user can scan the box at a glance.
- **Bottom border**: `└` + 126 dashes + `┘` — solid border, no title.

Standard step titles (used at the top of each step's box):

```
┌─────────────────────────────────────────────────────── Deploy targets ───────────────────────────────────────────────────────┐
┌─────────────────────────────────────────────────── Pipeline configuration ───────────────────────────────────────────────────┐
┌───────────────────────────────────────────────────────── Container ──────────────────────────────────────────────────────────┐
┌──────────────────────────────────────────────────── Apply configuration ─────────────────────────────────────────────────────┐
┌──────────────────────────────────────────────── Perception Application — Plan ───────────────────────────────────────────────┐
┌────────────────────────────────────────────── Perception Application — Results ──────────────────────────────────────────────┐
```

Per-step content rules (which rows go in which box, mode-aware row
hiding, the apply-config sectioned layout, the Step 5 PLAN-then-RESULT
pattern, the Step 3 `docker run` synthesis requirement) live in
[`references/deploy-vss-detection-tracking-2d.md`](references/deploy-vss-detection-tracking-2d.md)
under "Step N box content rule" — read those when rendering the
corresponding step.

## Quick triggers (mnemonic)

| Phrase | Flow |
|--------|------|
| `deploy rtvicv warehouse 2d with 4 streams and display` | DEPLOY |
| `run smartcity gdino on gpu 1` | DEPLOY |
| `stop the perception container` | TEARDOWN (deploy doc) |
| `rtvi-cv healthcheck failing` | DEBUG (deploy doc + troubleshooting) |
| `add a stream to rtvi-cv` | API USAGE |
| `is rtvi-cv ready on localhost:9000` | API USAGE |
| `get rtvi-cv metrics` | API USAGE |
| `generate text embeddings via rtvi-cv` | API USAGE |

bump:1

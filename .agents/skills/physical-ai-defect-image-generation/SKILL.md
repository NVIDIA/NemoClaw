---
name: physical-ai-defect-image-generation
description: >-
  Use when the user wants to orchestrate defect image generation, run associated setup, or handle outputs on OSMO. The Day 0 path handles cold-start with USD-to-ROI, image-edit augmentation, and AnomalyGen to create initial PCBA datasets. The Day 1 path performs inference and labeling on real images. This skill helps with first-time asset setup, creation of finetuning checkpoints, and configuring deployment.

  Trigger keywords: defect image generation, dig workflow, dig pipeline, defect image detection workflow, aoi pipeline, aoi anomalygen, usd2roi anomalygen, day 0 pcba, day 1 pcba, day 1 real-photo alignment, day 1 manual roi, metal surface anomaly, glass defect, anomalygen finetune, setup_pcb, setup_metal, setup_glass, setup_pretrained, dig setup, dig datasets, dig pretrained checkpoint, dig image-edit endpoint.
version: "1.0.0"
license: CC-BY-4.0 AND Apache-2.0
tools:
  - Read
  - Shell
metadata:
  owner: NVIDIA
  service: physical-ai-data-factory
  version: 1.0.0
  reviewed: 2026-05-30
  author: NVIDIA
  tags:
    - physical-ai
    - defect-image-generation
    - aoi
    - anomalygen
    - usd2roi
---

# Physical AI Defect Image Generation Workflow Orchestrator


## Table of Contents

- [Supported Flows](#supported-flows)
- [Disambiguation](#disambiguation-handle-vague-requests-before-committing) (full table in `references/disambiguation.md`)
- [Step 0: Select Flow, Cookbook, and Gather Inputs](#step-0-select-flow-cookbook-and-gather-inputs)
- [Common Preconditions](#common-preconditions-all-flows) (long-form in `references/preconditions.md`)
- [Flow walkthroughs](#flow-walkthroughs) (one entry per flow; details in `references/flows/`)
- [OSMO Monitoring](#osmo-monitoring)
- [Supporting files](#supporting-files)

End-to-end orchestration of defect image generation, augmentation, and labeling pipelines for AOI (Automated Optical Inspection) datasets. Every flow has a canonical OSMO workflow YAML in `assets/configs/` that chains all steps non-interactively. Use-case cookbooks in `assets/cookbooks/` provide PCBA usd2roi/image-edit configs and AnomalyGen training configs for PCBA, metal surface, and glass inspection. This skill governs flow selection, data handoffs, and submit commands; component internals live in each component's `SKILL.md`.

## Supported Flows

| Flow | Entry point | OSMO YAML | Steps | Use cases |
|------|-------------|-----------|-------|-----------|
| **Day 0 — Texture Defects** | CAD scene USD (`pcba_target.yaml` ships in the cookbook) | `texture_defect_generation_day0.yaml` | usd2roi (scan_grid + per-cell ROI crops) → image-edit augmentation (`nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL`) → finetune-or-passthrough → infer (anomalygen labels inline, **including missing-component**) | PCBA |
| **Day 0 — Good Image** *(usd2roi + Image-Edit)* | CAD scene USD + per-board `pcba_target.yaml` / `day0_image.yaml` / `day0_crop.yaml` | `good_image_generation.yaml` | usd2roi-render (scan_grid + per-cell ROI crop) → Qwen Image-Edit (OVSL2SL appearance transfer) | PCBA clean-image set (ChangeNet golden halves, finetune positives, real-photo pairing) |
| **Day 0 — Structural Defects** | CAD scene USD + per-board `pcba_target.yaml` | `structural_defect_generation.yaml` | isaac-render (pose defects: shift / tombstone / sideflip) + per-component crop (single pod) → Qwen Image-Edit (OVSL2SL lighting transfer; pose geometry preserved) | PCBA pose-defect set; ChangeNet defect halves |
| **Day 1 — Infer + Label (real-photo alignment, DEFAULT)** | CAD-derived USD + real PCBA photo (both ship in `datasets/pcb/assets`) | `texture_defect_generation_day1_real_alignment.yaml` | usd2roi day-1 render → MI register → per-ROI crop → yq-render config → finetune-or-passthrough → infer (anomalygen labels inline) | **Default PCBA Day 1.** Raw AOI screenshot of any usd2roi-supported board |
| **Day 1 — Infer + Label (manual ROI)** | Pre-captured clean images + ROI masks (NGC artifact or user upload) | `texture_defect_generation_day1_manual_roi.yaml` | yq-render config → finetune-or-passthrough → infer (anomalygen labels inline) | Metal surface, glass (no USD/real-photo flow); PCBA **only when user explicitly asks** for pre-captured ROI experimentation |
| **Finetune Only** | Labeled anomaly URL artifact | `finetune.yaml` | yq-render config → finetune (validate_dataset → prep_testcase → torchrun) | Any use case; produces checkpoint for Day 0 or Day 1. Requires raw training data under `<dig_url_root>/datasets/<usecase>/raw` (see `assets/configs/setup/setup_<usecase>.yaml`). |

All flows run on OSMO. Day 0 flows require `image_edit_endpoint` (Qwen Image-Edit OVSL2SL — existing URL or local deploy from `references/nim/`); Finetune Only has no external endpoints.

### Pick the right workflow for the user's defect class

| Defect class | Workflow | Mechanism |
|---|---|---|
| Clean / good / scan-grid / `normal_img + cad_mask` pairs | `good_image_generation.yaml` | usd2roi-render + Qwen Image-Edit |
| Texture defects (solder bridge, scratch, discoloration) **AND missing-component** (handled natively by AnomalyGen, NOT structural) | `texture_defect_generation_day0.yaml` | Qwen Image-Edit + AnomalyGen AMP/SDG |
| Structural / pose defects (tombstone, shift, sideflip) | `structural_defect_generation.yaml` | IsaacSim pose perturbation |
| Day 1 inference + labeling on a real image | `texture_defect_generation_day1_real_alignment.yaml` (PCBA default) or `texture_defect_generation_day1_manual_roi.yaml` (metal/glass; PCBA only when user explicitly asks for pre-captured ROI / skip-alignment) | usd2roi day-1 registration (real-alignment) or direct inference (manual-ROI) |

ChangeNet golden/defect pairs: submit `good_image_generation.yaml` + `structural_defect_generation.yaml` with the same `--set name=` (two-submission pairing convention).

> **Day 0 and Day 1 share the same downstream shape**: a Jinja-gated `finetune-job` (omitted when `use_pretrained_checkpoint=true`) feeding `anomaly-infer`. Day 0 prepends `usd2roi-render` + `augment-image-edit`; Day 1 starts from `<dig_url_root>/datasets/<usecase>/raw`. Per-stage detail: each flow's walkthrough.

### User intent → knob mapping

**Every OV flow is two-stage**: `crop_max_emit=N` caps the *final* per-cell crops (stage 2); `render_patches=N` caps *raw* scan-grid patches (stage 1, each yielding multiple crops). **DO NOT auto-map "generate N images" → `render_patches=N`** (wrong stage). `crop_max_emit` does not exist on `structural_defect_generation.yaml` (one crop per component — use `render_patches`) or `texture_defect_generation_day1_real_alignment.yaml` (narrow via the cookbook's `crop.classes` whitelist). Full knob table, smoke-test recipes, defaults, caveats: `references/knob_mapping.md`.

### Structural-defect sizing (no `crop_max_emit` knob exists)

Structural output is **non-linear in `render_patches`** — doubling frames adds ~1.6–1.7× crops, not 2×. Don't use `crop_max_emit` (no effect) or `render_patches=0` (fails). Validated yield table + target-size formula: `references/flows/structural_defect_generation.md` §"Sizing the output". For ambiguous "generate N images", surface the calibration table via `AskUserQuestion`.

---

## Disambiguation: handle vague requests before committing

Underspecified prompts ("generate me some images", "run the PCBA flow", "give me defects") **must not** be resolved by silently assuming a flow / usecase / knob mapping. When intent is ambiguous, pause and present candidate interpretations via `AskUserQuestion` (2–4 mutually exclusive options) before submitting. Disambiguate the load-bearing choices: **which flow, which use case, what stage a count refers to, finetune vs. passthrough**.

Settled defaults you should NOT disambiguate: PCBA Day 1 → real-alignment; board → `0603_H100`; image-edit endpoint → local cluster service (`references/nim/`); `use_pretrained_checkpoint=true`; Day 1 real-alignment `default_spatial_dependency=cad` (fall back to `free` only when CAD masks are unavailable, see `references/flows/texture_defect_generation_day1_real_alignment.md`).

**`dig_url_root` is the one exception — NO silent default.** First-time (no memory entry), MUST elicit via `AskUserQuestion` before any submit / `osmo data upload` / `preflight_urls.sh`. `s3://osmo-workflows/dig` is a *suggestion to confirm*, never auto-picked (~80 GB+ lands there). Later runs may reuse the remembered value silently. See Step 0 + memory rules (§4).

**Full trigger table, prompt construction, and when-NOT-to-ask exceptions: `references/disambiguation.md`** — load before assembling `AskUserQuestion` options for any vague request.

---

## Step 0: Select Flow, Cookbook, and Gather Inputs

**Before this step**, if the request is vague (e.g. "generate me images", "run the PCBA flow", "give me defects"), pause and run the disambiguation cheat sheet above — present candidate interpretations via `AskUserQuestion` and let the user pick. Don't auto-pick a load-bearing default the user didn't actually choose.

### First-time gate

If memory has no entries for this user, ASK the up-front preference questions in ONE `AskUserQuestion` call BEFORE any preflight / `osmo` / `kubectl` / `osmo data upload`, save to memory (§4), then proceed. Bundle:

- **`dig_url_root`** — MUST be elicited, not auto-picked. Offer `s3://osmo-workflows/dig` as a confirmable suggestion; else user provides their own OSMO-supported storage prefix. ~80 GB+ lands here. No escape hatch other than memory-recall of a previously confirmed value.
- **Default OSMO `--pool`** — candidates from `osmo profile list` → `pool.accessible`.
- **Pod-template confirmation** — only when `osmo config show POD_TEMPLATE` returns 403 (§2 has the exact question).
- **Image-edit endpoint** — Day 0 only: Option A (existing URL) vs Option B (deploy local NIM).

Subsequent conversations read these silently from memory. Per-flow choices (use case, checkpoint vs finetune, board, knobs) are asked each time — see below.

### Preflight ordering (after the first-time gate)

Run §1 `preflight_credentials.sh` → §2 `preflight_pod_template.sh` → §3 `preflight_urls.sh <flow> <usecase>` → §4 generate the run stamp. **Cadence**: §1 and §2 are once-per-conversation gates with cross-conversation memory caching (see §4a in `references/preconditions.md`) — skip when memory records them as already verified / user-confirmed. §3 runs before every submit (varies by flow). §4 is the agent's job — fresh `$STAMP` per submit.

Pod-template enforcement is two layers: the pre-submit `preflight_pod_template.sh` gate (§2) plus an in-pod runtime preflight on every OV + training task (fails fast on missing `/usr/share/nvidia/nvoptix.bin` or `/dev/shm` < 16 GiB). Runtime failure despite §2 passing → template was patched out → route to `physical-ai-infrastructure-setup-and-resilient-scaling`. Missing creds / URL artifacts → offer to submit `setup/setup_<case>.yaml` + `setup/setup_pretrained.yaml` first.

Then ask the user in one message — per-flow choices only (the first-time gate above already covered `dig_url_root`, pool, pod-template, and endpoint preferences; pull those from memory):

1. **Use case** — PCBA (use Day 0 + pcb cookbook), metal surface (Day 1 + metal_surface cookbook), glass (Day 1 + glass cookbook), or custom?
2. **Checkpoint available?** — If yes (`use_pretrained_checkpoint=true`), use `<dig_url_root>/models/<usecase>` and provide `checkpoint_step`. If no, finetune from `<dig_url_root>/datasets/<usecase>/raw`.
3. **Local-NIM pool capacity check** (Day 0 Option B only) — before `kubectl apply`, check `Total Capacity` via `physical-ai-infrastructure-setup-and-resilient-scaling`. `Total Capacity < 2` cannot host NIM + DIG concurrently → ask user to add GPUs or switch to Option A. `image_edit_model` is always `nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL`, never generic `qwen-image-edit`.
4. **Save user preferences to memory** — after the first-time gate (and after any submit diverging from a documented default), persist load-bearing choices (`dig_url_root`, OSMO pool, default board, image-edit endpoint, pod-template state, osmo-admin role). **Never save** `image_edit_model` (constant — saving invites drift) or ephemeral state (STAMP, one-off `anomaly_types_json`). Full table: **`references/preconditions.md` §4a "Memory rules"**. Read relevant memories at the start of every new conversation and apply silently.

Review the relevant flow reference before asking — most values have sensible defaults. Day 1 routing: PCBA defaults to `real_alignment`; metal/glass have no USD flow so always `manual_roi`; don't ask the user "manual or real-alignment?" for PCBA unless they explicitly ask to skip alignment.

---

## Common Preconditions (all flows)

Quick reference. Long-form: `references/preconditions.md`.

1. **OSMO credentials + tokens** — once per conversation. **If a `.env` exists in the workspace, source it first** (`set -a; . ./.env; set +a`) so `HF_TOKEN` is exported. Run `scripts/preflight_credentials.sh`; authoritative check is the OSMO cred `hf-token` is provisioned (images are public on `nvcr.io/nvidia/` — no registry cred needed). Pass `--no-probe` in restricted-egress shells. See `references/preconditions.md` §1.
2. **Pod template** — once per conversation, with cross-conversation memory caching (see Step 0 §6). Skip when memory records the cluster verified / user-confirmed / 409-skipped. Otherwise run `scripts/preflight_pod_template.sh` and branch on exit code (0=verified / 1=patch via infra skill / 2=ask-user (HTTP 403) / 3=skip (HTTP 409) / 4=env-fix). Full branching prose and prompts in `references/preconditions.md` §2.
3. **Required URL artifacts** — before every submit. Run `DIG_URL_ROOT=<dig_url_root> scripts/preflight_urls.sh <flow> <usecase> [variant]`. If anything is missing, **stop and submit the relevant `setup/setup_<case>.yaml` + `setup/setup_pretrained.yaml` first** (the OSMO setup workflows) — see `references/setup.md`. **Never download assets locally to work around a problem; if setup fails on credentials, ask the user to rectify them and re-submit on OSMO.** Per-flow checklist:

   | Flow | Use case | Required URL artifacts under `<dig_url_root>` |
   |---|---|---|
   | Day 0 — Texture Defects | PCBA | `models/pretrained`, `models/pcb`, `datasets/pcb/raw`, `datasets/pcb/assets` |
   | Day 0 — Good Image | PCBA | `datasets/pcb/assets` only |
   | Day 0 — Structural Defects | PCBA | `datasets/pcb/assets` only |
   | Day 1 | Metal surface | `models/pretrained`, `models/metal_surface`, `datasets/metal_surface/raw` |
   | Day 1 | Glass | `models/pretrained`, `models/glass`, `datasets/glass/raw` |
   | Day 1 real-photo alignment | PCBA | Day 1 PCBA plus `datasets/pcb/assets` |
   | Finetune Only | Any | `models/pretrained`, `datasets/<usecase>/raw` |

   Built-in `usecase` values are `pcb`, `metal_surface`, `glass`. See `references/preconditions.md` §3.

4. **Name stamping** — regenerate `$STAMP=$(cat /proc/sys/kernel/random/uuid | cut -c1-8)` before every submit and pass `--set name=<flow>-$STAMP`. Production YAMLs ship no `name` default. See `references/preconditions.md` §4.
5. **Glass case (UC3) — Roboflow zip** — only for `setup_glass.yaml`. Upload `mobile_screen.zip` to an OSMO URL prefix first; pass `--set uc3_zip_url_root=<prefix>`. Full procedure: `references/setup.md` §"Glass case (UC3)".

---

## Flow walkthroughs

Each flow's full walkthrough — group diagrams, prerequisites, submit-command variants, data handoffs, per-stage troubleshooting — lives under `references/flows/`. The agent should read the matching file before submitting any flow it hasn't run in the current conversation.

| Flow | Workflow YAML | Walkthrough |
|---|---|---|
| **Day 0 — Texture Defects (PCBA)** | `assets/configs/texture_defect_generation_day0.yaml` | `references/flows/texture_defect_generation_day0.md` |
| **Day 0 — Good Image (PCBA)** | `assets/configs/good_image_generation.yaml` | `references/flows/good_image_generation.md` |
| **Day 0 — Structural Defects (PCBA)** | `assets/configs/structural_defect_generation.yaml` | `references/flows/structural_defect_generation.md` |
| **Day 1 — Infer + Label (real-photo alignment, default PCBA)** | `assets/configs/texture_defect_generation_day1_real_alignment.yaml` | `references/flows/texture_defect_generation_day1_real_alignment.md` |
| **Day 1 — Infer + Label (manual ROI, metal/glass + PCBA experimentation)** | `assets/configs/texture_defect_generation_day1_manual_roi.yaml` | `references/flows/texture_defect_generation_day1_manual_roi.md` |
| **Finetune Only** | `assets/configs/finetune.yaml` | `references/flows/finetune.md` |

### Cross-flow invariants

- `use_pretrained_checkpoint=true` (default) → passthrough against `models/<usecase>`. Set to `false` to insert an in-pod `finetune-job` group (cookbook yq-patched in-pod, no pre-submit render step).
- Day 0 emits per-cell `crop/<MATERIAL>/<cell>/...` trees; Day 1 emits per-ROI crops registered against the USD; structural emits flat per-component crops.
- Shipped per-usecase `checkpoint_step` + `anomaly_types_json` defaults: see `references/preconditions.md` §"Shipped checkpoint and `anomaly_types_json` defaults".

---

## OSMO Monitoring

**Load `references/monitoring.md` before any `osmo workflow submit`, `osmo workflow query`, or `osmo workflow logs` action in this skill.** It defines the polling cadence, task-status interpretation, log-pull escalation thresholds, failure-classification routing, and what to surface to the user vs. silently retry. Do not assemble a post-submit watch loop or status summary from memory — re-read it on the first such action of every conversation.

```bash
osmo workflow query <workflow_id> --format-type json | jq '{status, tasks: [.groups[].tasks[] | {name, status, exit_code}]}'
osmo workflow logs <workflow_id> -t <task_name> -n 200
osmo data download <dig_url_root>/runs/<name>/anomaly ./output/anomaly-<name>/
```

Monitoring discipline: `references/monitoring.md`. Retrieval: `references/output_retrieval.md`. Presentation: `references/output_rendering.md`. Gotchas: `references/troubleshooting.md`.

---

## Response Template

For "show me the plan / recipe" requests, emit your final response with these labeled sections (so nothing truncates mid-recipe):

**Workflow:** `<flow name>` → `assets/configs/<yaml>`

**Preflights:** `scripts/preflight_credentials.sh`; `scripts/preflight_urls.sh <0|1|finetune> <usecase> [variant]`

**Required URL Artifacts under `<dig_url_root>`:** enumerate per Common Preconditions §3 for the chosen flow.

**Submit Command:**

```bash
STAMP=$(cat /proc/sys/kernel/random/uuid | cut -c1-8)
osmo workflow submit assets/configs/<yaml> --pool <pool> \
  --set name=<flow>-$STAMP dig_url_root=<root> usecase=<usecase> \
        image_edit_endpoint=<endpoint> image_edit_model=nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL \
        checkpoint_step=<step> 'anomaly_types_json=<types>'
```

**Monitoring:** load `references/monitoring.md` before running the submit; apply its polling cadence + log-pull thresholds after `osmo workflow submit` returns a workflow id.

**Output Location:** `<dig_url_root>/runs/<flow>-$STAMP/anomaly/` (per-flow override: see flow walkthrough).

---

## Supporting files

Full inventory — workflow YAMLs, cookbooks, scripts table, references, evals, component skills — in **`references/contents.md`**. Top-level dirs: `assets/configs/`, `assets/cookbooks/`, `scripts/`, `references/`, `evals/`.

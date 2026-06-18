---
name: physical-ai-video-data-augmentation
description: >-
  Use when running video data augmentation and auto-labeling workflows on OSMO:
  flow selection, preflight, submit-time interpolation, monitoring, and output
  retrieval. Trigger keywords: video data augmentation, data enrichment, auto
  labeling, VDA demo, OSMO workflow, pseudo labeling.
license: CC-BY-4.0 AND Apache-2.0
metadata:
  owner: NVIDIA
  service: data
  version: 1.0.0
  reviewed: '2026-05-26'
  author: NVIDIA
  tags:
    - physical-ai
    - video-data-augmentation
    - auto-labeling
    - cosmos
---

# Physical AI Video Data Augmentation Workflow Orchestrator

Default workflow skill for VDA execution on OSMO. It owns flow selection,
preflight, cache readiness, inference-path decisions, submit-time interpolation,
monitoring, and output retrieval. Component skills are consult-only.

## Purpose

Run the end-to-end VDA workflow safely and reproducibly from preflight to output
download.

Do NOT use this skill for container-internal tuning-only questions.

## Prerequisites

Confirm these before running preflight or any submit. Missing required secrets
surface as `USER_INPUT_REQUIRED:` from `scripts/preflight_credentials.sh`.

| Requirement | How it is satisfied | Used for |
|---|---|---|
| NGC API key (optional) | `NGC_API_KEY`, `NGC_CLI_API_KEY`, or compatible `nvapi-*` token in `NVIDIA_API_KEY`/`OPENAI_API_KEY`/`VLM_API_KEY`/`LLM_API_KEY` | Optional for `nvcr_io` credential refresh and NGC REST scope probe; default VDA image refs are validated via workflow registry probes |
| Hugging Face token | `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`), or a cached token at `~/.cache/huggingface/token` | Creates the OSMO `hf_token` credential; pulls gated Cosmos/SeedVR weights |
| OSMO CLI access | `osmo` on `PATH`, logged in, with a default profile and a registered DATA credential profile matching `storage_url` | Submitting/monitoring workflows and listing/downloading objects |
| GPU pool | At least one `ONLINE` pool in `osmo pool list --mode free`; `POD_TEMPLATE` carries GPU toleration/selectors | Scheduling setup + worker tasks |

Optional (only for the strict NGC org/team probe): `NGC_ORG` + `NGC_TEAM`
(or `NGC_CLI_ORG` / `NGC_CLI_TEAM`). External VLM/LLM endpoint keys are validated
separately, not by preflight.

Key handling rule: `nvapi-*` tokens are first-class inputs for `nvcr_io`.
Never reject by token prefix alone; use workflow registry probe results as
source of truth.

## Instructions

1. Select the workflow (`auto_labeling`, `augmentation_and_al`, `e2e`,
   `e2e_super_resolution`) from user intent.
2. Provide a tentative execution-time overview before starting run actions.
3. Run preflight and readiness checks before submit.
4. Derive submit-time values from the active dataset backend (never guess
   `storage_url`).
5. Submit the workflow with explicit interpolation values and monitor to completion.
6. Retrieve outputs, provide side-by-side comparison evidence for augmented
   flows, and summarize task outcomes.

Use `run_script(...)` for script execution. Canonical examples:

```python
run_script("bash scripts/preflight_credentials.sh --workflow assets/configs/osmo/augmentation_and_al.yaml")
run_script("python3 scripts/pre_submit_guard.py --workflow assets/configs/osmo/auto_labeling.yaml")
run_script("bash scripts/prepare_demo_assets.sh /srv/sdg/data/vda_inputs")
```

## Available Scripts

Use script-level `--help` for exact arguments.

| Script | Role |
|---|---|
| `scripts/preflight_credentials.sh` | Secrets/control-plane preflight and workflow image access checks |
| `scripts/pre_submit_guard.py` | Submit-time interpolation, cache, and dataset safety checks |
| `scripts/prepare_demo_assets.sh` | Demo video pull + flatten for default demo path |
| `scripts/generate_configs.py` | Setup-time config and cookbook projection generation |
| `scripts/cosmos_worker.sh` | Augmentation worker execution |
| `scripts/pl_original_worker.sh` | Original-video auto-labeling worker execution |
| `scripts/pl_augmented_worker.sh` | Augmented-video auto-labeling worker execution |
| `scripts/osmo_barrier.py` | Multi-node barrier synchronization |
| `scripts/stage_run_artifacts.sh` | Local mirror of full run output + input video |
| `scripts/render_side_by_side.sh` | Side-by-side comparison render from local artifacts |

## Supported Flows

| Flow | OSMO YAML | Group sequence | Typical use |
|---|---|---|---|
| `augmentation_and_al` | `assets/configs/osmo/augmentation_and_al.yaml` | setup -> augmentation -> auto_labeling_augmented | Augment one or more videos, then auto-label augmented outputs |
| `auto_labeling` | `assets/configs/osmo/auto_labeling.yaml` | setup -> auto_labeling | Label original videos only |
| `e2e` | `assets/configs/osmo/e2e.yaml` | setup -> (auto_labeling_original + augmentation) -> auto_labeling_augmented | Throughput-first path |
| `e2e_super_resolution` | `assets/configs/osmo/e2e_super_resolution.yaml` | setup -> auto_labeling_original -> augmentation -> auto_labeling_augmented | Sequential path with SR gate before augmentation |

Legacy alias `assets/configs/osmo/augmentation_and_pl.yaml` remains for
backwards compatibility.

### Pick the right workflow for the user's request

| User intent | Workflow |
|---|---|
| "Label my source videos" / "PL-only" / "no augmentation" | `auto_labeling` |
| "Create augmented videos and label them" | `augmentation_and_al` |
| "Run the full pipeline quickly" | `e2e` |
| "Run full pipeline, but gate on SR-enhanced originals first" | `e2e_super_resolution` |

## Disambiguation: handle vague requests before committing

Default to autonomy: ask only when missing information blocks execution.

### Autonomous defaults (do NOT ask)

- If dataset source is absent, run VDA demo path (`scripts/prepare_demo_assets.sh`)
  and continue with `dataset=vda-demo`.
- If flow is not explicitly requested, default to `augmentation_and_al`.
- If endpoint mode is unspecified, default to in-cluster persistent NIM reuse and
  automatic NIM deploy/repair when unhealthy.
- If cache is missing, run `setup_model_cache.yaml`, rerun pre-submit guard, and
  continue automatically on success.
- After any stage completes successfully, continue to the next stage immediately.
  Do not pause with "Ready when you are" or equivalent approval prompts.

### Triggers that should pause for disambiguation

| Missing input | Why it matters | Ask |
|---|---|---|
| `USER_INPUT_REQUIRED` from preflight | Required secret is missing | Ask one concise unblock question for exactly the missing value(s) |
| Storage backend prefix cannot be derived from the active dataset/upload root | Wrong scheme causes runtime storage auth mismatch | "What is the backend-native root prefix for this run?" |
| No ONLINE GPU pool/platform can be selected | Workflow cannot schedule setup/workers | "Which GPU pool/platform should this run target?" |

### When NOT to disambiguate

- Do not ask for cookbook unless user explicitly asks to change scene profile.
- Do not offer external endpoints by default.
- Do not ask A/B cache strategy questions; default is automatic cache setup.
- Do not ask to scale down existing NIMs; this is forbidden.
- Do not invent, scrape, or generate random videos when input is missing.
- Do not use non-VDA demo sources (for example Carline adaptation assets) unless
  the user explicitly requests a different dataset.

## Step 0: Select Flow and Gather Inputs

### Input video policy (non-negotiable)

- Always preserve user-provided video inputs (dataset URL, local path, or upload
  folder) as first-class and preferred.
- Never replace an explicit user video with demo assets or any other source.
- If no video input is provided, default to VDA demo assets via
  `scripts/prepare_demo_assets.sh` (HF dataset flow) without asking extra
  source-selection questions.
- If the user explicitly mentions an input video or dataset, prefer and use that
  input instead of demo assets.
- Use only VDA demo assets (`nvidia/video-data-augmentation-demo`) for the
  default demo path.
- Never propose arbitrary web clip downloads or placeholder videos
  unless the user explicitly requests that behavior.

Collect only missing values:

1. Dataset source (prefer explicit user-provided `dataset_url` or local upload
   folder; otherwise default to VDA demo assets and proceed).
2. Flow (`auto_labeling`, `augmentation_and_al`, `e2e`, `e2e_super_resolution`);
   default to `augmentation_and_al` when unspecified.
3. OSMO `gpu_platform` for all VDA resources (auto-select an ONLINE platform
   when unambiguous; ask only when no valid option exists).
4. Endpoint mode (default in-cluster NIM reuse/deploy unless explicitly
   overridden).

Do not guess `gpu_platform` (for example `microk8s`). Use the exact current
platform label shown by `osmo pool list --mode free` (for example `gpu`).

Generate run stamp before each submit:

```bash
STAMP=$(cat /proc/sys/kernel/random/uuid | cut -c1-8)
RUN_ID="run-$STAMP"
```

## Execution Time Overview (required before run)

Before running any mutating command (`osmo credential set`, NIM install/repair,
cache workflow submit, or target VDA workflow submit), provide a short ETA
overview to the user.

Keep it concise (one short paragraph or 4-6 bullets) and include:

- whether this looks like a **cold start** (NIM/cache missing) or **warm start**
  (NIM/cache already healthy),
- major phases with approximate durations,
- a total expected range for the selected workflow.

Baseline ranges (from observed MicroK8s + OSMO runs):

| Phase | Typical duration |
|---|---|
| Credentials + preflight | ~1-2 min |
| NIM deploy/download/warmup (if needed) | ~10-15 min |
| Demo assets download/upload (if demo path) | ~1-3 min |
| Model cache population (if needed) | ~15-25 min |
| Workflow submit + queue/start | ~1-3 min |

Workflow runtime ranges after submit:

| Flow | Typical runtime |
|---|---|
| `auto_labeling` | ~6-15 min |
| `augmentation_and_al` | ~20-35 min |
| `e2e` | ~22-40 min |
| `e2e_super_resolution` | ~25-45 min |

Cold-start end-to-end runs are commonly ~45-80 min; warm-start runs are usually
~20-45 min depending on flow and video length.

## Common Preconditions (all flows)

1. **Credential and control-plane preflight**

   ```bash
   bash scripts/preflight_credentials.sh --workflow assets/configs/osmo/<mode>.yaml
   ```

   Restricted egress:

   ```bash
   bash scripts/preflight_credentials.sh --no-probe --workflow assets/configs/osmo/<mode>.yaml
   ```

   Preflight does not require a workload-local `.env`. Runtime interpolation is
   driven by submit-time values (`dataset`, `run_id`, `gpu_platform`, `video`,
   `storage_url`, `skills_dir`) supplied in one `--set-string` list.

   Passing `--workflow` validates pull access for the active workflow image refs
   (`workflow.groups[].tasks[].image`) using anonymous bearer access with
   credential fallback when provided.
   If replacement NGC/HF secrets are provided in env, preflight refreshes
   existing `nvcr_io` / `hf_token` automatically when present. Use `--refresh` to force
   overwrite even when no new env secrets were supplied:

   ```bash
   bash scripts/preflight_credentials.sh --workflow assets/configs/osmo/<mode>.yaml --refresh
   ```

   If output contains `USER_INPUT_REQUIRED:`, ask one concise unblock question
   and stop.

   On workflow image `401/403`, report registry access failure after probe
   checks on the listed image refs; do not claim a key family (for example
   `nvapi-*`) is categorically unsupported.

2. **Storage interpolation policy**

   `storage_url` must be derived from the actual dataset/upload backend for the
   current run.

   ```text
   dataset_url=azure://storiondevxah69/osmo-workflows/datasets/vda-demo
   storage_url=azure://storiondevxah69/osmo-workflows
   dataset=vda-demo
   ```

   Never silently default to stale `s3://` values on non-S3 backends.

3. **Inference policy (non-negotiable)**

   - Reuse healthy in-cluster persistent NIM endpoints by default.
   - If missing/unhealthy, deploy automatically — this is a prerequisite, not a
     user decision. Do NOT pause to ask; run the install with the VDA allow-list:

   ```bash
   export NIM_SERVICES="qwen3-vl qwen25-14b"
   skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/inference-nim-operator/scripts/install.sh
   ```

   - See `references/nim/README.md` for full endpoint docs and health checks.
   - External endpoints are opt-in only (explicit request or explicit URLs); only
     then skip the in-cluster deploy.
   - Never infer external mode from credential presence.
   - Never scale down/delete existing NIMs to free GPUs.

4. **Readiness guard**

   ```bash
   osmo pool list --mode free
   osmo config show POD_TEMPLATE
   python3 scripts/pre_submit_guard.py --workflow assets/configs/osmo/<mode>.yaml
   ```

5. **Cache auto-remediation**

   If `pre_submit_guard.py` reports cache failure, default action is to run:

   ```bash
   osmo workflow submit assets/configs/osmo/setup_model_cache.yaml \
     --set-string storage_url=<backend-prefix> path=data
   ```

   Then rerun `pre_submit_guard.py` and submit the target VDA flow only after it
   passes. Ask user only when backend/prefix is ambiguous or cache setup fails.

6. **Scheduling policy**

   VDA templates schedule setup and workers on `gpu_platform` (no `system` pool
   dependency for user workloads).

## Submit (all flows)

Every flow uses the same submit shape; only the workflow YAML changes. Choose the
YAML for the requested flow, then run the command below. Full per-flow walkthroughs
(stage matrix and flow details) live in the linked references.

| Flow | Workflow YAML | Walkthrough |
|---|---|---|
| Augmentation + auto-labeling | `assets/configs/osmo/augmentation_and_al.yaml` | `references/flows/augmentation_and_al.md` |
| Auto-labeling only | `assets/configs/osmo/auto_labeling.yaml` | `references/flows/auto_labeling.md` |
| E2E (parallel) | `assets/configs/osmo/e2e.yaml` | `references/flows/e2e.md` |
| E2E (super-resolution gated) | `assets/configs/osmo/e2e_super_resolution.yaml` | `references/flows/e2e_super_resolution.md` |

```bash
SKILLS_DIR="$(cd "$(git rev-parse --show-toplevel)/skills/physical-ai-video-data-augmentation" && pwd)"
STAMP=$(cat /proc/sys/kernel/random/uuid | cut -c1-8)
osmo workflow submit assets/configs/osmo/<flow>.yaml \
  --pool <pool> \
  --set-string \
    dataset=<dataset> \
    run_id=run-$STAMP \
    storage_url=<backend-prefix> \
    gpu_platform=<gpu-platform> \
    video=<video-stem> \
    cosmos_model_cache_url=<backend-prefix>/data/models/cosmos_transfer \
    auto_labeling_model_cache_url=<backend-prefix>/data/models/auto_labeling \
    skills_dir="$SKILLS_DIR"
```

Compatibility note:
- Use exactly one `--set-string` flag and pass all the key/value pairs after it.
- Do not repeat `--set`/`--set-string` flags in the same command; some OSMO builds
  only honor the last occurrence.
- Do not mix `--set` and `--set-string` in one submit command.
- Pass explicit `*_model_cache_url` values to avoid nested-template interpolation
  differences across OSMO environments.
- Do not brute-force permutations of flags. Use this shape directly.

Common optional overrides (append key/value pairs to the same `--set-string` list):

```bash
cookbook=<scene_profile> \
vlm_url=<openai_base_url> \
llm_url=<openai_base_url> \
cosmos_model_cache_url=<url> \
auto_labeling_model_cache_url=<url>
```

The auto-labeling-only flow has no augmentation stage, so it omits
`cosmos_model_cache_url` at runtime; passing it is harmless and keeps one submit
shape across flows.

## OSMO Monitoring

```bash
# Workflow status + task states
osmo workflow query <workflow_id> --format-type json \
  | jq '{status, tasks: [.groups[].tasks[] | {name, status, exit_code}]}'

# Logs for a specific task
osmo workflow logs <workflow_id> --task <task_name> -n 200

# Output retrieval
osmo data list --no-pager <output_url>
osmo data download <output_url> <local_dir>/
```

For completion artifacts, always mirror the full run output into workspace:

```bash
ROOT="$(git rev-parse --show-toplevel)"
RUN_LOCAL_DIR="$ROOT/media/vda/runs/<run_id>"
mkdir -p "$RUN_LOCAL_DIR"
osmo data download "<storage_url>/datasets/<dataset>-outputs/<run_id>/" "$RUN_LOCAL_DIR/"
```

For runs expected to exceed two minutes, send heartbeat updates at least every
two minutes. For media evidence, emit one standalone `MEDIA:<absolute-path>`
line per message bubble.

Execution continuity requirement:

- Heartbeats must report progress while continuing work; they are status updates,
  not permission prompts.
- Do not stop between green stages waiting for approval.
- Pause only on blocking failures or explicit user stop/redirect.
- If submit fails on interpolation, rerun once with the same canonical single-flag
  shape and corrected values; do not loop through ad-hoc flag experiments.

MEDIA formatting is strict:

- Emit exactly one line: `MEDIA:/absolute/path/to/file.mp4`
- Keep `MEDIA:` contiguous on a single line (never split across lines).
- No extra text in the same bubble.
- No code fences, bullets, or quotes around the directive.
- If render fails: retry once from a stable workspace path, then emit PNG fallback.

## Post-Run Comparison Evidence (required for augmented flows)

Applies to `augmentation_and_al`, `e2e`, and `e2e_super_resolution` after a
successful run.

Required completion output (do not stop at raw output URLs):

1. Stage full outputs + input video into workspace-local path:

   ```bash
   bash scripts/stage_run_artifacts.sh \
     --storage-url <storage_url> --dataset <dataset> --run-id <run_id> --video <video>
   ```

2. Render side-by-side from that local run copy:

   ```bash
   bash scripts/render_side_by_side.sh \
     --run-local-dir "<repo>/media/vda/runs/<run_id>" --dataset <dataset> --video <video>
   ```

3. Emit MEDIA from the local run copy and include:
   - augmentation summary from `<run_local_dir>/setup_b0/configs/manifest.yaml`
     (`sampled_vars` for `<video>_aug0`)
   - auto-labeling summary from `<run_local_dir>/outputs/pseudo_labeled_augmented/<video>_aug0`
   - for `e2e` / `e2e_super_resolution`, original-label summary from
     `<run_local_dir>/outputs/pseudo_labeled/<video>`

If `ffmpeg` is unavailable, emit input and augmented MEDIA from the same local
run copy and still provide augmentation + auto-labeling summaries.

For demo runs (no user video provided), explicitly state that input came from
`nvidia/video-data-augmentation-demo`.

## Supporting files

Use these canonical locations:

- Workflows: `assets/configs/osmo/*.yaml`
- Runtime scripts: `scripts/*.sh`, `scripts/*.py`
- Flow walkthroughs: `references/flows/*.md`
- Setup and triage: `references/setup.md`, `references/troubleshooting.md`
- Images and endpoint policy: `references/container-images.md`, `references/nim/README.md`
- Cookbook tuning: `assets/cookbooks/TUNING_GUIDE.md`

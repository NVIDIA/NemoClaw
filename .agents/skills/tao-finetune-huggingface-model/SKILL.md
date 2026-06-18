---
name: tao-finetune-huggingface-model
description: >
  Fine-tune any HuggingFace CV / VLM / LLM model on local NVIDIA GPUs inside an
  NGC PyTorch container. Use when the user wants to fine-tune a HuggingFace
  model (full or LoRA), train a vision / VLM / LLM model end-to-end, generate a
  reproducible HF training pipeline, smoke-test a HuggingFace model locally
  before scale-up, push a fine-tuned model to the HF Hub with a model card, or
  emit a self-contained rerun skill for an existing HuggingFace finetune.
  Supports image classification, object detection, semantic / instance /
  panoptic segmentation, depth estimation, image-text-to-text VLM (SFT / LoRA),
  and LLM SFT / DPO / GRPO. Six-step workflow: inspect and qualify, hardware
  and NGC image, research, generate and smoke, train + eval + infer, push and
  emit rerun skill.
license: Apache-2.0
tags:
  - finetuning
  - huggingface
  - nvidia-tao
  - computer-vision
  - training
compatibility: Requires docker + nvidia-container-toolkit, NVIDIA GPU (driver ≥ 545, ≥ 24 GB VRAM for ≤3B models), ~40 GB free disk. Optional credentials (loaded from `~/.config/tao/.env` by the SessionStart hook) — HF_TOKEN is read only when the model/dataset is gated or `push_to_hub` is on; WANDB_API_KEY and WANDB_PROJECT only when WandB logging is enabled.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash Write WebFetch
---
<!--
Copyright (c) 2026, NVIDIA CORPORATION.  All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->


# tao-finetune-huggingface-model

Local NVIDIA GPU fine-tuning for HuggingFace models, grounded in live-fetched
documentation with curated references as a fallback safety net. One NGC
container, a small set of focused scripts, one push to HF Hub. Behavior is
governed by the rules in this file — follow them, do not improvise.

**Order of authority (highest first):** (1) user input → (2) live research
(model card, HF repo example, author script, task docs, paper — always fetched,
Step 3) → (3) curated `references/*.md` (fallback when live research is silent) →
(4) training-data memory (last resort, suspect). On conflict, live research wins
for the specific model + current API. See `references/core-rules.md` for the
full order and conflict-resolution rules.

---

## Inputs

**Required:**
- `model_id` — HuggingFace model ID, e.g. `google/vit-base-patch16-224`

**Conditional credentials (loaded by the SessionStart hook from `~/.config/tao/.env`):**
- `HF_TOKEN` — only when the model/dataset is **gated** (read) or `push_to_hub` is on (write); public + `push_to_hub: false` runs don't need it. The agent never reads the value — only checks presence with `[ -n "$HF_TOKEN" ]`.
- `WANDB_API_KEY`, `WANDB_PROJECT` — only when WandB is enabled; set `WANDB_MODE=disabled` to opt out.

**Dataset — exactly one:**
- `dataset_id` — HuggingFace dataset ID *(source: `hf`)*
- `local_dataset_path` — local folder or file *(source: `local`)*; optional `local_dataset_format` ∈ {auto, imagefolder, coco, voc, jsonl, arrow, parquet, csv} (default auto-detect).
- *(omit)* — agent recommends popular datasets *(source: `recommend`)*

**Optional (have defaults):** `task_type` (auto-detected); `n_train=10000`,
`n_eval=1000`, `n_epochs=3`, `lora_r=16`; `output_dir=./output/<model_short_name>`;
`hf_model_repo` (push target; if unset and HF_TOKEN has write access,
auto-derived as `<whoami>/<model_short_name>-finetuned`); `push_to_hub=True`
(set `False` to skip); `skip_baseline=False` (skip zero-shot baseline eval).

**Optional deliverables (off by default):** `emit_progress_log` →
`output_dir/PROGRESS.md` (per-step ✅/⚠️/❌ journal); `emit_report` →
`reports/report.{pdf,html}` with curves & samples; `emit_unit_tests` →
`tests/` with fake-data heterogeneous-batch tests.

All values live in `output_dir/config.yaml`. Never hardcode in Python.

---

## Execution platform

This skill orchestrates *what* to run; the platform skills own *how* (read them
first, do not redraft their conventions here):
[`tao-setup-nvidia-gpu-host`](../../platform/tao-setup-nvidia-gpu-host/SKILL.md)
(GPU host runtime — driver 580, CUDA Toolkit 13.0, NVIDIA Container Toolkit
1.19.0), [`tao-run-on-docker`](../../platform/tao-run-on-docker/SKILL.md)
(`docker run` flags, NGC auth, `--gpus`, mounts, env passthrough,
`--ipc=host`/`--shm-size`, error modes), and
[`tao-run-on-local-docker`](../../platform/tao-run-on-local-docker/SKILL.md)
(local Docker job preflight — daemon reachable, GPU smoke).

**Default platform:** `local-docker` — build a one-off image
(`run-<short>:latest`) and run it on the local Docker daemon. Ask only if the
user needs a different backend (Brev, Lepton/SLURM/Kubernetes). See
`references/execution-platform.md` for that path plus the alternate-backend
routing, the GPU-runtime preflight, the credentials policy, and the `docker run`
conventions.

---

## References — fallback safety net

Curated `references/*.md` are consulted **only** when live research is silent,
ambiguous, or unavailable; live docs always win for the specific model + current
API. The workflow steps below link the file each step needs directly. Before
falling back, log the live source you tried and why it was insufficient (in
`config.yaml` `notes:`, and PROGRESS.md if enabled). `[FETCH LIVE]` markers in
`cv-scripts.md` / `vlm-scripts.md` are a research checklist, not code to inline —
if a block has no Step 3 finding, refetch the listed URL.

See `references/reference-index.md` for the complete index — every always-on
reference plus the three opt-in ones gated by a flag (`progress-tracking.md` ←
`emit_progress_log`, `testing.md` ← `emit_unit_tests`, `reporting.md` ←
`emit_report`), each with its per-step role.

---

## Core rules

The non-negotiable behaviors. Full text in `references/core-rules.md`.
**Short version:**

- **Your HF-library knowledge is outdated.** Fetch live docs before writing any
  ML code; never generate trainer args / collator / transforms from memory (Step 3).
- **Smoke-test on real data with `--max_steps 1`** before any full run.
- **Never silently substitute** model_id, dataset_id, or training_method — stop and ask.
- **Error recovery is minimal-change.** OOM → halve batch, double grad_accum,
  enable gradient checkpointing (don't switch to LoRA without approval); NaN →
  reduce LR 10×; flat loss → inspect collator; same error 3× → stop and ask.
- **Dataset columns verified BEFORE the collator.** Rename → `prepare_data.py`;
  restructuring → stop and ask.
- **Hardware sizing (bf16):** ≤3B → 24 GB, 7–13B → 80 GB, 30B+ → multi-GPU or
  LoRA on 1× 80 GB, 70B+ → 8× 80 GB or LoRA. Won't fit + no LoRA request → ask.

`references/core-rules.md` has the full enumeration (hallucinated imports,
never-without-approval list, full error-recovery + hardware-sizing tables).

---

## Workflow — 6 steps

Single pass, sequential. Each step has a clear gate before the next begins.

### Step 1 — Inspect & qualify

Decide whether to proceed at all. **1a. Probe model** and **1b. Probe dataset**
via two CPU-only `python:3.12-slim` containerized probes (no host Python
prereqs): the model probe reports `model_type`, `architectures`, `tags`, head
counts; the dataset probe verifies loadability + column schema. Detect `task`
from `architectures` + `tags` + card body (card silent on
`AutoModelFor...` → `references/model-discovery.md`, log under `notes:`). For
`source = recommend`, present 3–5 picks from
`references/dataset-recommendations.md`; for `source = local`, use
`references/dataset-sources.md` loaders. **1c. Accept/reject**, **1d. walk
`references/compat-workarounds.md`** recording matches in `config.yaml`
`applicable_workarounds:`, then **1e. write the `config.yaml` skeleton**.

See `references/step1-probes.md` for the full probe scripts + `docker run`
invocations, the Docker-daemon preflight, prerequisites (`MODEL_ID`, optional
`DATASET_ID`/`HF_TOKEN`, `OUTPUT_DIR` default `./output/<model_short_name>`
bind-mounted by Steps 4–5), dataset-column verification + rename rule, the full
reject criteria, compat-walk detail, the exact skeleton, and `.probe` cleanup.

**Gate:** `config.yaml` exists with model, dataset, task, applicable_workarounds.
Do not proceed if any field is missing.

---

### Step 2 — Hardware audit & NGC image

Verify Docker + GPU + disk, pick the NGC PyTorch image live, finalize
hardware-dependent compat rules. **2a. Audit (hard gate)** via
`tao-setup-nvidia-gpu-host --check-only` (driver branch 580, CUDA Toolkit 13.0,
NVIDIA Container Toolkit 1.19.0); on failure ask to authorize the install, then
re-run; soft-warn on `< 100 GB` free disk; check only the credentials this run
needs; **do not proceed to Step 4 on a hard-fail**; record `gpu_count`,
`gpu_name`, `driver_major`, `vram_gb_per_gpu`. **2b. Pick NGC image (live)** —
highest-versioned PyTorch NGC image with `Min driver ≤ driver_major` and
container CUDA `≤` host CUDA Toolkit (never reject for an `aN`/`bN`/`rcN`
suffix); WebFetch fail → `references/hardware-container.md` fallback. **2c.
Re-evaluate** `hw`-dependent compat rules. **2d. Model-fit check** — bf16
`param_bytes ≈ 2×param_count`; if > 60% of `vram_gb_per_gpu × 1e9`, recommend
LoRA.

See `references/hardware-audit-ngc.md` for the full audit script, the soft-warn
+ `MIN_DISK_GB` override, live-selection rules, the support-matrix WebFetch URL,
the `24.09-py3` / SDPA+GQA `attn_implementation: "eager"` fallback, and the
`could not select device driver` failure note.

**Gate:** `config.yaml` has `ngc_image`, `gpu_count`, `gpu_name`, `driver_major`,
`vram_gb_per_gpu`. Hardware-dependent compat fixes are recorded.

---

### Step 3 — Research the recipe

Fetch the live recipe — the agent's `transformers`/`trl`/`peft` memory is
suspect, so Step 3 is non-negotiable. Walk `references/research-priorities.md`
in priority order (Priority 1 → 6).
Stop once you have, for the detected task: the `AutoModel` / processor class,
train + eval transforms, collator, `compute_metrics`, and hyperparameter hints
(LR, batch size, epochs, scheduler). Record findings in `meta/recipe.md` and
append source URLs to `config.yaml: research_sources:`. If a slot has no live
finding, fall back to the matching scaffold (`cv-scripts.md` /
`vlm-scripts.md`) and log "fallback to scaffold — no live source for <slot>"
under `notes:`. Conflict-resolution rules: `references/research-priorities.md`.

**Gate:** every required slot above is filled, with a source URL or an explicit
scaffold-fallback note.

---

### Step 4 — Generate project & smoke-test

Write all scripts, build the image, prepare data, run a 1-step smoke on real
data (one `docker build`, two `docker run`s).

**4a. Generate project files** in `output_dir/` — `config.yaml`, `Dockerfile`,
`requirements.txt`, `prepare_data.py`, `train.py`, `run_eval.py` (eval script
**MUST** be `run_eval.py`, never `evaluate.py` — collides with HF `evaluate`),
`infer.py`, `merge_lora.py` for VLM-LoRA, `.gitignore`. Authority order: Step 3
live research → scaffold reference (`cv-scripts.md` / `vlm-scripts.md`) for
**structure only**, never their `[FETCH LIVE]` blocks. Apply each
`applicable_workarounds` entry as a Dockerfile block, requirements pin, config
override, or runtime env var. Every generated `.py` begins with the NVIDIA
Apache-2.0 `#`-comment copyright header (emitter must fail otherwise). If
`emit_unit_tests: true`, also generate `tests/` per `references/testing.md`. See
`references/project-scaffold.md` for the full file table, the exact copyright
header, and the Dockerfile template (deps → compat → code layer order).

**4b. Build, prepare, smoke** — `docker build -t run-<short>:latest .`, then run
`references/docker-runs.md` §1 (build), §2 (prepare_data), §3 (smoke,
`--smoke --max_steps 1`); §3 lists the smoke pass criteria (no exception, loss
finite, `grad_norm > 0` at step 1). If `emit_unit_tests: true`, also run
`pytest tests/` inside the container. Any failure → STOP.

**4c. Preflight summary** — print the boxed `─ PREFLIGHT ─` summary (reference
URL, dataset columns, push_to_hub repo, wandb monitoring, ngc_image, hardware,
smoke result) and verify every field is filled before launching full training.
Exact format: `references/project-scaffold.md`.

**Gate:** project files written, image built, smoke PASSED, preflight has no
blank fields.

---

### Step 5 — Train, evaluate, infer

Run in order, all commands in `references/docker-runs.md`: **5a** baseline eval
(§4, skip if `skip_baseline: true`), **5b** full training detached (§5), **5c**
LoRA merge (§6, only VLM-with-LoRA), **5d** post-train eval (§7), **5e**
inference 5 samples (§8). Multi-GPU: prepend `torchrun --nproc_per_node=$gpu_count`
to `python train.py`. Watch `docker logs -f hft_train`: loss should drop within
10-20 steps (flat → stop; NaN → reduce LR; OOM → halve batch; full recovery in
`references/core-rules.md` + `references/error-playbook.md`). If
`emit_report: true`, run `report.py` after Step 5e per `references/reporting.md`.

**Gate:** all of — `checkpoints/final/` (or `checkpoints/merged/` for LoRA)
exists; `reports/eval_results.json` has a numeric primary metric;
`reports/baseline_results.json` exists (unless skipped);
`reports/inference_samples/` has 5 samples; wandb URL shows descending loss.

---

### Step 6 — Push & emit rerun skill

Publish the run and make it reproducible without re-research.

**6a. Push to HF Hub** — use `references/hub-push.md` (pushes weights merged or
final, a generated model card `README.md`, `results/{eval,baseline}_results.json`,
`config.yaml`, `Dockerfile`, `requirements.txt`, `inference_samples/*.jpg`, and
`report.{pdf,html}` if `emit_report: true`). Skip iff `push_to_hub: false` is
explicit in `config.yaml`.

**6b. Emit rerun skill** at `<output_dir>/skills/run-<short>/SKILL.md` per
`references/pipeline-skill-template.md`. Every `<placeholder>` must be a real
value (literal placeholders are a bug); include the full YAML (`license`,
`compatibility`, `metadata`, `allowed-tools`) and the NVIDIA copyright notice in
an HTML comment immediately after the closing `---`, as in that template; an
emitter must fail unless the emitted `SKILL.md` contains those fields and the
copyright comment.

**Gate (Done criteria):** all of — Step 5 gate met; HF Hub repo exists at the
resolved URL with weights + card + `results/` (unless `push_to_hub: false`);
`<output_dir>/skills/run-<short>/SKILL.md` exists with no `<placeholder>` left,
with metadata + copyright HTML comment per `pipeline-skill-template.md`.

**Final message to user** — terse, with direct URLs: wandb URL; HF Hub URL;
primary metric baseline → fine-tuned (Δ); path to `reports/inference_samples/`;
path to `<output_dir>/skills/run-<short>/SKILL.md`.

---

## Error playbook

On a known runtime error, consult `references/error-playbook.md` before
redesigning anything — its symptom → minimal-fix table covers NGC ENTRYPOINT,
SDPA+GQA, `transformers>=4.51` regression, numpy 2.x ABI, Albumentations bbox,
PEFT + gradient_checkpointing, SmolVLM SDPA, LoRA target-regex, missing CV
augmentation, OOM at step 0, and more. When a row fires twice across runs, lift
it into `references/compat-workarounds.md` with a `detect` rule, auto-applied in
Step 1d before the error can fire.

---

## Communication style

Terse: no filler, no restating the request; always include direct Hub + wandb
URLs; on error state what went wrong, why, what you changed (no menus, no
"Option A/B/C" when the answer is clear — act). Full text:
`references/core-rules.md`.

## Example pipelines

- [tao-rerun-convnext-cifar10](references/tao-rerun-convnext-cifar10.md) — facebook/convnext-tiny-224 on cifar10 (image-classification, 10 classes, subset 5000/1000).
- [tao-rerun-detr-cppe5](references/tao-rerun-detr-cppe5.md) — facebook/detr-resnet-50 on cppe-5 (object-detection, 5 classes, subset 800/200).
- [tao-rerun-segformer-foodseg103](references/tao-rerun-segformer-foodseg103.md) — nvidia/mit-b0 on EduardoPacheco/FoodSeg103 (semantic segmentation, 103 classes + background, subset 1000/200).
- [tao-rerun-smolvlm-vqav2](references/tao-rerun-smolvlm-vqav2.md) — HuggingFaceTB/SmolVLM-256M-Instruct on merve/vqav2-small (image-text-to-text VLM LoRA, subset 500/100, 5 epochs).

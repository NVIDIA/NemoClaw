---
name: tao-run-deft-aoi
description: >
  Run the full DEFT AOI improvement loop for NVIDIA TAO VisualChangeNet / ChangeNet PCB inspection models:
  baseline evaluate, RCA, ingestion of customer-supplied pre-generated AnomalyGen images, k-NN mining,
  retraining, and deployment gating until FAR / recall KPI targets are met. EA variant — does not run
  AnomalyGen inline; the customer pre-generates synthetic NG/OK pairs out-of-band and the loop ingests them.
  Use for prompts like "run the DEFT loop", "fine-tune until FAR below 0.1% at recall=100%", or "improve my AOI
  ChangeNet model with RCA and pre-generated synthetic defects"; do not use for standalone TAO training,
  one-off inference, generic anomaly generation, or RCA-only analysis.
license: Apache-2.0 AND CC-BY-4.0
compatibility: Requires docker + nvidia-container-toolkit. Workflows declare additional requirements.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash Write Task
tags:
- application
- workflow
- deft
- aoi
- loop
---

# Skill: tao-run-deft-aoi

## When to Use This Skill

Use this skill when the user wants an agent to run the full DEFT AOI improvement loop for an NVIDIA TAO VisualChangeNet / ChangeNet PCB inspection model: baseline evaluation, RCA, ingestion of pre-generated synthetic defects, data mining, retraining, and deployment gating until a KPI target is met. AnomalyGen is **not** run inline in this EA variant — the customer pre-generates NG/OK pairs out-of-band and places them under `<workspace>/augmentation/anomalygen/`.

- "Run the DEFT loop"
- "Fine-tune until FAR < 0.1% at recall=100%"
- "Improve my AOI ChangeNet model using RCA and synthetic defects"
- "Iterate training until false accept rate meets the target"

Do not use this skill for a single standalone TAO training run, one-off inference, generic anomaly generation, or RCA-only analysis. Use the relevant agent directly when the user asks for only that step.

## Base Model

The loop operates on **NVIDIA TAO Visual ChangeNet** classify with the **NVIDIA C-RADIOv2-B** backbone, fine-tuned end-to-end. The architecture is defined in `specs/baseline_spec.yaml` — that file is the source of truth. All pretrained weights come from HuggingFace (`HF_TOKEN` required); `NGC_API_KEY_*` only gate container pulls. ChangeNet backbone resolution + the staged-file/HF-URL fallback for `model.backbone.pretrained_backbone_path` are owned by `references/visual-changenet.md`. SigLIP for k-NN mining is owned by `references/tao-mine-aoi-images.md`. **No AnomalyGen-side checkpoints are required in this EA variant** — pre-generated synthetic pairs are ingested directly from `<workspace>/augmentation/anomalygen/{reconstructed_image,original_image}/`; see Pipeline step 3 in `references/pipeline.md`.

## Train AutoML Policy

DEFT AOI owns the iterative data-improvement loop, retraining cadence, and KPI
checkpoint selection. For this workflow only, bypass model-level AutoML even
when the underlying Visual ChangeNet model metadata has `automl_enabled: true`.
Invoke every Visual ChangeNet train stage, including baseline and iteration
retrain, with the run override `automl_policy: off` / plain training. This is a
workflow-level override only; do not change model metadata, and do not apply this
policy to other workflows.

## Launch Intake

After the user confirms they want to run this workflow, ask which supported
platform they intend to run on. Generate the platform choices with:

```bash
${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/list_tao_platforms.py \
  --skill-bank ${TAO_SKILL_BANK_PATH:-~/tao-skills-external} --format text
```

After platform selection, run:

```bash
${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/list_tao_platforms.py \
  --skill-bank ${TAO_SKILL_BANK_PATH:-~/tao-skills-external} \
  --platform <platform> --format text
```

Ask only for credentials relevant to that platform, plus model-specific
credentials required by the selected workflow.

## Agent Behavior

> **There is exactly one user gate: pre-flight confirmation.** Print the Pre-Flight Summary
> (see *Pre-Flight Summary* in `references/pre-flight.md`), then STOP and wait for the user to type "go", "yes",
> "looks good", or similar explicit approval. Do not launch any side-effecting step
> (`docker run`, training, SDG, mutations under `${RESULTS_DIR}/`) before that approval —
> reading specs, listing files, `docker image inspect`, and populating the summary table
> are fine. **"Autonomous" describes behavior *after* this gate, not before it.** Do not
> skip the gate even if the user's original prompt sounded urgent ("just run it", "go
> ahead") — the summary itself is the artifact they need to see before approving.
>
> **After the gate, the skill is fully autonomous.** Run the entire loop without asking
> for confirmation. Do not pause between steps. Do not ask "want me to continue?" — just
> continue. Only stop if a step fails with an unrecoverable error or a hard-stop gate
> fires. Print a one-line status update at each step milestone so the user can follow
> progress.

## Workflow

Execute the loop in this order. Full detail lives in the reference files cited per step.

1. **Pre-Flight.** Run every check in `references/pre-flight.md`. Resolve workspace, specs, CSVs, checkpoints, container images, stage the pre-gen pool once, and print the Pre-Flight Summary. Hard stop on any missing input.
2. **Baseline.** If `deft_state.json` already has `iterations.baseline.stage_completed == "train"` and a `best_ckpt_path` pointing at an existing file (the upstream `tao-run-automl-deft-pipeline` pre-seeds these from its Phase 1 AutoML winner — see its Phase 1 → Phase 2 handoff), **skip the train sub-step** and resume at `inference -> evaluate` against the pre-seeded checkpoint. Otherwise run `train -> inference -> evaluate` by invoking the `tao-skill-bank:tao-train-visual-changenet` skill. Either way, then `rca` by invoking `tao-skill-bank:tao-analyze-gaps-visual-changenet`. Read `references/visual-changenet.md` and `references/tao-analyze-gaps-visual-changenet.md` first for DEFT-loop-specific args (mounts, output dirs, `deft_state.json` updates).
3. **Iterate.** For each iteration up to `max_iterations`, execute Pipeline steps 1-7 in `references/pipeline.md`. Between every step, re-read `results/loop_log.jsonl` tail + `results/deft_state.json` from disk — disk is canonical.
4. **Stop** when the KPI target is met, `max_iterations` is reached, or a hard-stop gate fires (silent-drop, AMP allocation mismatch, train/val leakage). Never auto-retry hard stops.
5. **Render** `results/DEFT_Loop_Report.html` after each completed iteration (and once more at loop end) by spawning the `reporter` subagent (`agents/reporter.md`). Per-stage renders are not done — every stage already appends one line to `loop_log.jsonl`, which is enough for a tail-watching user; the HTML render carries an iteration's worth of state and one render per iteration keeps the per-loop token cost roughly linear in iteration count, not in stage count. Do not render inline.

All pipeline stages run inline in the parent context — the parent invokes the underlying `tao-skill-bank:*` skills directly via the Skill tool, layering DEFT-loop conventions on top via the matching `references/*.md` file. The **only** delegated work is HTML report rendering, handled by the `reporter` subagent in a fresh context so an end-of-loop render is never silently dropped when the parent's context is saturated.

#### Defaults

Set only when the user does not supply them; never ask about a parameter with a default. Full list in `references/pre-flight.md`.

- `max_iterations`: 3 — `top_k_per_target`: 5 — `min_similarity`: 0.9 (cosine cutoff)
- `training_epochs`: `num_epochs` from `specs/baseline_spec.yaml`, else 20
- workspace root: user prompt, else `~/workspace`

## Reference Map

| Reference | Owns |
|---|---|
| `references/pre-flight.md` | Pre-Flight checks 1-11, full defaults list, Pre-Flight Summary template + the one user gate. Workspace/spec/CSV/checkpoint/image resolution, `.env` + `versions.yaml` credential resolution, GPU memory sanity (batch_size ≤ 16 on 48GB / ≤ 8 on 24GB), one-shot pre-gen staging, leakage check. |
| `references/pipeline.md` | Pipeline steps 1-7 + Augmentation Pool. RCA → route (pre-gen single-bucket promote-all-gaps, `filter_by_label: false`, no AG fanout) → read cached manifest → k-NN mine (`top_k_per_target`, `min_similarity 0.9`, no SDG bypass) → assemble CSV → validate → fine-tune (`automl_policy: off`). Source-pool assembly, per-iter mining bounds, 14-column / 4-mandatory-column CSV schema, baseline skip-train logic. |
| `references/stage-execution.md` | Available Scripts table, Stage Reference Modules (stage→skill map), path-rule invariant, SKILL/INLINE/AGENT stage types, post-stage check, report artifacts, `agents/reporter.md` spawn contract. |
| `references/state-logging.md` | `deft_state.json` + `loop_log.jsonl` contracts, one entry per stage, `seq = last_seq + 1` from disk (disk canonical, never `echo`/inline `jq`), per-iteration + loop-end render cadence, loop-end sequence (`log_stage` → `align_token_usage` → render → `prepare_inference_spec`), stop conditions. |
| `references/prepare-for-inference.md` | `best_model.json` + `best_model_inference_spec.yaml` contract and consumer workflow. |
| `references/REPORT_RENDERING.md` | Template fill rules followed by `agents/reporter.md`. |
| `references/SCRIPT_USAGE.md` | `run_script()` vs direct `python`, absolute-path resolution. |

Read the relevant reference at the start of each stage, then act. If a reference file is missing, stop and ask the user to reinstall the plugin — do not substitute generic shell commands.

## Data Contract

Inputs (all paths under `<workspace>` unless absolute):

```text
<workspace>/
├── .env                                     # NGC_API_KEY (nvcr.io/* image pulls), HF_TOKEN (HuggingFace pre-flight pulls). No AnomalyGen credentials required — this EA variant ingests pre-generated pairs.
├── specs/baseline_spec.yaml                 # ChangeNet train/eval spec
├── train/base/
│   ├── training_set.csv                     # seed training rows; ChangeNet 14-column siamese schema
│   └── validation_set.csv                   # held-out rows; checked for leakage against every train CSV
├── kpi/
│   ├── images/                              # KPI test images (real data only — no generated images here)
│   └── testing_set.csv                      # labels live in the CSV
├── augmentation/
│   ├── mining_pool/
│   │   ├── mining_pool.csv                  # append-only production-line samples; paths relative to this dir
│   │   └── images/                          # source images referenced by mining_pool.csv (e.g. *_SolderLight.jpg)
│   └── anomalygen/                          # customer-supplied pre-generated synthetic pairs (this EA variant does not run AnomalyGen)
│       ├── reconstructed_image/             # NG images (will become ChangeNet input_path); flat dir of *.jpg or *.png
│       ├── original_image/                  # OK partner images, same stems as reconstructed_image/ (will become ChangeNet golden_path)
│       └── defect_spec.jsonl                # OPTIONAL — one entry per defect_type if defect-type accounting is wanted in deft_state.json
│                                            # Stems in reconstructed_image/ and original_image/ must match 1-to-1; extensions may differ.
└── results/run_<YYYYMMDD_HHMMSS>/           # created/resumed by this workflow (= ${RESULTS_DIR})
```

**ChangeNet CSV schema (VCN).** Mandatory columns: `input_path`, `golden_path`, `label`, `object_name` (siamese change-detector — a row without `golden_path` is unusable). Preserve `boardname`, scores, and provenance fields when present. TAO builds the full image path as `{images_dir}/{input_path}/{object_name}_{light}{image_ext}` — `input_path` is a directory, not a file.

## Output Layout

Relative to `<workspace>`:

```text
results/run_<YYYYMMDD_HHMMSS>/               # = ${RESULTS_DIR}
├── deft_state.json                          # current resume snapshot (schema: references/deft_state.json)
├── loop_log.jsonl                           # append-only stage log; single source of truth
├── DEFT_Loop_Report.html                    # re-rendered after every stage by agents/reporter.md
├── best_model.json                          # inference handoff metadata (see references/prepare-for-inference.md)
├── best_model_inference_spec.yaml           # ready-to-run TAO inference spec built from training config
├── iter${ITER}_summary.md                   # ≤300-word per-iteration summary
├── synth_pool/                              # built ONCE at Pre-Flight step 10 via scripts/prestage_pregen.py
│   ├── manifest.json                        # paths + counts for the loop to reference
│   ├── images/synth_{ng,ok}/                # ChangeNet-staged pre-gen pairs (single copy, shared across iters)
│   ├── sdg_rows.csv                         # 14-col + provenance + filepath; the SDG half of source_pool
│   ├── source_pool.{csv,parquet}            # real (mining_pool) + sdg unified pool with provenance
│   ├── source_embeddings.parquet            # written only when --embed-with-siglip was passed to prestage_pregen.py
│   └── source_embed.log                     # data-services log for the source embedding (if run)
├── baseline/
│   ├── train/                               # TAO train output: model_epoch_<EEE>_step_<SSS>.pth × N, status.json, experiment.yaml, train.log
│   ├── inference/{best_val,latest}/         # per-checkpoint inference.csv + KPI plots from scripts/analyze_kpi.py
│   └── rca_results/<TS>/                    # kpi_gaps.parquet, threshold.txt, weak_samples_breakdown.txt
└── iter${ITER}/
    ├── routing_results/<TS>/                # mining_gaps.parquet, anomalygen_gaps.parquet, routing_summary.txt
    ├── anomalygen/                          # per-iter bookkeeping (just records the synth_pool/manifest.json path)
    │   └── ingest_summary.json              # per-iter audit: which synth_pool manifest was reused, counts at iter start
    ├── mining_filter/
    │   ├── mining_pool.csv                  # top-K-per-target k-NN survivors from synth_pool/source_pool (synth + real subject to same filter)
    │   ├── knn_summary.csv                  # candidate_count, kept_count, rejected_count, similarity_threshold=0.9
    │   ├── target_embeddings.parquet        # embeddings of weak-target images (per-iter — targets change each iter)
    │   └── mining_summary.txt               # per-label breakdown emitted by mining container
    ├── dataset/
    │   ├── train_combined_iter${ITER}.csv
    │   └── train_combined_iter${ITER}_provenance.csv  # source ∈ {base_train, previous_iter_train, mining_pool}
    ├── train/                               # TAO train output for iter${ITER}
    ├── inference/{best_val,latest}/
    └── rca_results/<TS>/                    # next iteration's RCA reads inference/{best_val|latest}/inference.csv
```

A previous combined CSV's rows already include every prior contribution — assemble iter N+1 from `train_combined_iter${N}.csv` plus the new `mining_filter/mining_pool.csv`, not from `train/base/training_set.csv` again.

## Safety & Gating

- **One user gate.** The Pre-Flight Summary in `references/pre-flight.md` is the only confirmation point. Stop and wait for explicit approval before any side-effecting step; autonomous after.
- **Path rule.** Every stage writes absolute host paths under `${RESULTS_DIR}/iter${ITER}/`; reject any config with `output: /results/...` or any path outside `<workspace>`. See *Invariants* in `references/stage-execution.md`.
- **Disk is canonical.** Re-read `loop_log.jsonl` tail + `deft_state.json` before every stage; append exactly one `loop_log.jsonl` entry per stage via `scripts/log_stage.py` (never `echo`/inline `jq`). See `references/state-logging.md`.
- **Hard stops, never auto-retried:** missing/empty/unpaired pre-gen dirs, missing or zero-row `mining_pool.csv`, mid-run pre-gen mutation, train/val leakage (mid-iteration and post-assembly checks), silent-drop, AMP allocation mismatch, CSV validation failure, missing reference file.
- **No SDG bypass.** Synthetic rows go through the same k-NN as real rows; the loop never launches an SDG/AnomalyGen container in this EA variant.

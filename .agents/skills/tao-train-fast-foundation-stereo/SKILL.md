---
name: tao-train-fast-foundation-stereo
description: Real-time stereo depth estimation using FastFoundationStereo (FFS), the distilled bp2 commercial variant of
  FoundationStereo. Predicts disparity maps from stereo image pairs with ~10× lower latency than full FoundationStereo. Use
  when training, evaluating, exporting, or running inference for a TAO FastFoundationStereo (FFS) model. Trigger phrases
  include "train fast stereo", "real-time stereo disparity", "FastFoundationStereo", "distilled stereo depth".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- stereo
- depth
- estimation
- realtime
- distilled
---

# Depth Net Fast Stereo

Real-time stereo depth estimation using **FastFoundationStereo (FFS)** — the bp2 commercial distilled variant of FoundationStereo. Predicts disparity maps from rectified stereo image pairs with per-layer pruned widths for real-time inference.

The mono / stereo / fast-stereo skills share the unified TAO `depth_net` CLI; FFS is selected via `model.model_type: FastFoundationStereo`. FFS differs from `FoundationStereo` only in pruned per-layer widths and a serialized forward path; everything else (entrypoint, action verbs, dataset classes, deploy chain) is identical to `depth-net-stereo`.

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, TensorRT `inference`), read `references/tao-deploy-fast-foundation-stereo.md` first. The deploy spec template lives at `references/spec_template_deploy.yaml`.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Two Use Cases

FFS ships with a pre-trained bp2 commercial checkpoint (`model_best_bp2_serialize.pth`).

1. **Raw deploy** — use the bp2 ckpt as-is. Skip `train`; run `inference` / `evaluate` / `export` / `gen_trt_engine` directly with the bp2 file as the action's checkpoint.
2. **Finetune on user data** — set `train.pretrained_model_path` to the bp2 file, train on user data, then verify + deploy on the resulting ckpt. The full 7-action sequence (train → evaluate pyt → inference pyt → export → gen_trt_engine → inference deploy → evaluate deploy) is supported.

## Workflow

### Prerequisites — data accessibility

Your dataset (left + right images + GT disparity for train / evaluate, left + right only for inference) must be reachable from inside the container:
- **SDK runner**: place files at the S3 paths the runner resolves (`S3_TRAIN` / `S3_EVAL` placeholders shown in the spec overrides).
- **Direct `docker run`** (e.g. local testing): mount the host dataset root read-only at the same in-container path:

```
docker run ... -v <host_data_root>:<host_data_root>:ro <container> ...
```

The same accessibility requirement applies to the `<output_dir>` written by all actions, and to the bp2 checkpoint path.

### Step 1 — Annotation file

Per-line annotation file referenced by `data_sources[*].data_file`. Schema is identical to `depth-net-stereo`:

| Columns | Format | Use |
|---|---|---|
| 2 | `<left> <right>` | Stereo inference (no GT) |
| 3 | `<left> <right> <disparity>` | Stereo with GT |
| 4 | `<left> <right> <disparity> <occlusion_mask>` | Stereo with GT and occlusion mask |

Generate via `depth_net convert` if needed; see the `depth-net-stereo` skill for `convert_spec.yaml` template.

### Step 2 — Pair `model_type` and `dataset_name` based on your data

Use `model_type: FastFoundationStereo` for FFS. The `dataset_name` choice mirrors the stereo skill — pick the dataset-specific class when your layout matches a registered one, otherwise `GenericDataset`.

| Data category | `model_type` | `dataset_name` |
|---|---|---|
| Middlebury | `FastFoundationStereo` | `Middlebury` |
| KITTI | `FastFoundationStereo` | `Kitti` |
| ETH3D | `FastFoundationStereo` | `Eth3d` |
| FSD synthetic | `FastFoundationStereo` | `FSD` |
| IsaacReal synthetic | `FastFoundationStereo` | `IsaacRealDataset` |
| Crestereo synthetic | `FastFoundationStereo` | `Crestereo` |
| Other / non-canonical | `FastFoundationStereo` | `GenericDataset` |

For inference with 2-column annotations (left + right, no GT), use `dataset_name: GenericDataset` regardless of layout.

### Step 3 — Set the bp2 distilled width overrides

FFS requires 15 model-section width override fields whose values match the bp2 commercial checkpoint exactly. Omitting any field falls back to TAO defaults that do **not** match the bp2 ckpt and produce shape-mismatch errors at forward time.

```yaml
model:
  model_type: FastFoundationStereo
  encoder: vitl
  hidden_dims: [128]                    # 1-layer GRU; NOT [128,128,128]
  n_gru_layers: 1                       # bp2 single-GRU
  corr_radius: 4
  corr_levels: 2
  n_downsample: 2
  valid_iters: 8
  max_disparity: 192                    # bp2 commercial; NOT 416 (full FS default)
  volume_dim: 28                       # bp2 ckpt invariant; NOT 32 (full FS default)
  mixed_precision: false                # see references/parameters.md
  gwc_feature_normalize: true           # see references/parameters.md

  # 15 bp2 distilled width overrides — copy as-is
  motion_encoder_widths: [56, 96, 16, 12]
  motion_encoder_final: 48
  gru_hidden: 60
  gru_gating_conv_widths: [100, 168]
  disp_head_input_dim: 60
  disp_head_intermediate: 36
  disp_head_pwconv1_widths: [212, 244]
  mask_widths: [32, 16]
  stem_2_widths: [12, 16]
  spx_2_gru_widths: [16, 12, 16, 24]
  spx_gru_out: 9
  classifier_mid: 14
  cnet_conv04_widths: [60, 48]
  cam_mid_channels: 8
  cost_agg_conv_patch_padding: [0, 0, 0]
```

The spec templates at `references/spec_template_*.yaml` carry this block as the canonical source.

### Step 4 — Write spec yaml from the spec overrides

Copy the action block from `references/spec-overrides.md` (per-action Python override dicts plus the shared `FFS_MODEL_BLOCK`). Replace:
- `model.model_type: FastFoundationStereo` (already set)
- `dataset.<...>.data_sources[*].dataset_name` from Step 2
- `dataset.<...>.data_sources[*].data_file` with the path from Step 1
- For raw deploy use cases (no train): set `<action>.checkpoint` to the bp2 file path
- For finetune use cases: set `train.pretrained_model_path` to the bp2 file path

**Chained train → next action checkpoint path**: For local Docker chaining (no SDK runner), the trained checkpoint lives at `<train.results_dir>/<task>/dn_model_latest.pth` — Lightning `ModelCheckpoint` nests under the task name. Example: `train.results_dir: /workspace/results/finetune/train` produces `/workspace/results/finetune/train/train/dn_model_latest.pth`. Use that nested path for the next action's `<action>.checkpoint`. SDK-runner deploys resolve this automatically via `parent_job_id` — see `references/parent-model-inference.md`.

Shape consistency: `crop_size` in `dataset.test_dataset.augmentation.crop_size` should match `export.input_height` / `input_width` for end-to-end pyt-vs-deploy comparability — see `references/tao-deploy-fast-foundation-stereo.md`'s shape table.

### Step 5 — Run

```
docker run --gpus 'device=0' --shm-size 16G --ipc=host \
  --user $(id -u):$(id -g) \
  -v <data_root>:<data_root>:ro \
  -v <output_dir>:<output_dir> \
  -v <bp2_ckpt_dir>:<bp2_ckpt_dir>:ro \
  <container> \
  depth_net <action> -e <spec.yaml>
```

Without `--user $(id -u):$(id -g)` the container writes outputs as `nobody:nogroup`, blocking host-side cleanup / retry.

For the local bind-mount `__pycache__` caveat (QA / development only — clearing stale `.pyc` files that shadow patched source), see `references/troubleshooting.md` → "Local bind-mount tip".

### Step 6 — Verify

- Container exit code 0
- `status.json` `kpi` block populated
- For `train`: inspect per-step `train_loss` directly (the entrypoint reports `Execution status: PASS` even when loss is NaN)
- For `evaluate`: rely on `epe` / `bp1` / `bp2` / `bp3` / `d1` / `rmse` (the evaluator also emits `abs_rel` / `sq_rel` / `rmse_log` which are non-meaningful for stereo)
- For `inference`: artifacts under `results_dir`
- **KPI namespace difference between pyt and deploy**: pyt `evaluate` writes the metric set under `kpi.val/epe`, `kpi.val/bp1`, etc. (namespaced by Lightning's `val/` prefix). Deploy `evaluate` (TRT engine path) writes the same metric set under `kpi.epe`, `kpi.bp1`, etc. (no `val/` prefix). Downstream verification scripts that read `status.json` need to handle both shapes.
- **Validate drift on your own dataset**: if you compare TAO FFS deploy (`gen_trt_engine` + TRT `evaluate`) against the upstream FFS deploy path on the same input, expect a small residual mean_abs disparity drift (TAO export graph + TRT 10.13 interaction; not improvable at the source-code level). The exact magnitude is dataset and hardware dependent — measure on your own data and decide whether the drift is acceptable for your downstream task.

### 7-action deploy flow

```
train (optional)            → finetuned ckpt
evaluate (pyt)              → PyT eager EPE / bp on val GT
inference (pyt)             → PyT eager disparity samples (visual sanity)
export                      → static fp32 ONNX (recommended at 480×736 or 320×736)
gen_trt_engine             → fp16 TRT engine on static ONNX path
inference (deploy)         → TRT disparity samples
evaluate (deploy)          → TRT EPE / bp drift vs PyT eager fp32
```

Skip `train` for raw-bp2 deploy. The remaining 6 actions (or the 4 deploy-only verbs starting from `export`) cover both use cases.

Full TAO Deploy reference: [tao-deploy-fast-foundation-stereo](references/tao-deploy-fast-foundation-stereo.md).

## Training Requirements

- **Valid `dataset_name` values for stereo `data_sources`** (case-insensitive): `FSD`, `IsaacRealDataset`, `Crestereo`, `Middlebury`, `Eth3d`, `Kitti`, `GenericDataset`
- **Monitoring metric:** val/loss

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| evaluate | dataset.test_dataset.data_sources | eval_dataset | data_file: annotations.txt + dataset_name | Yes |
| inference | dataset.infer_dataset.data_sources | inference_dataset | data_file: annotations.txt + dataset_name | Yes |
| train | dataset.train_dataset.data_sources | train_datasets | data_file: annotations.txt + dataset_name | Yes |
| train | dataset.val_dataset.data_sources | eval_dataset | data_file: annotations.txt + dataset_name | Yes |

Data source overrides are **mandatory for every action**. Each `data_sources` entry needs both `data_file` and `dataset_name`. The `model.*` width fields from Step 3 are also mandatory. See `references/spec-overrides.md` for the complete per-action override dicts (train finetune, raw-bp2 evaluate / inference / export) and the shared `FFS_MODEL_BLOCK`.

## Eval Dataset

Optional. Val dataset configured via `dataset.val_dataset.data_sources` (each entry needs `data_file` and `dataset_name`).

## Parameters, Metrics, Hardware

See `references/parameters.md` for the full parameter glossary (`model.*` / `dataset.*` / `train.*` knobs including `max_disparity: 192`, `gwc_feature_normalize: true`, `mixed_precision: false`, `volume_dim: 28`, `valid_iters`, `save_raw_pfm`), the evaluation-metric table (`epe` / `bp1` / `bp2` / `bp3` / `d1` / `rmse` are meaningful; `abs_rel` / `sq_rel` / `rmse_log` are not), multi-GPU / multi-node spec keys, and hardware requirements.

## Export / TRT Defaults

`export` always emits a **fp32 ONNX** regardless of `model.mixed_precision`; the fp16 vs fp32 selection happens at `gen_trt_engine` via `gen_trt_engine.tensorrt.data_type`. Recommended TRT precision for FFS-bp2 is `fp16` on the static-shape ONNX path (lowest drift). The dynamic-shape path supports both `fp32` (default; static-fp32 parity) and `fp16` (latency-critical multi-resolution; higher drift, may NaN under some checkpoint states — fall back to fp32 if observed).

See `references/export-trt-defaults.md` for the full TRT/ONNX defaults and the four-way export use-case matrix (`export.batch_size` × `export.dynamic_hw`; dynamic H/W is FFS-only). See `references/tao-deploy-fast-foundation-stereo.md` for the deployment matrix and static-vs-dynamic shape guidance.

## Troubleshooting

See `references/troubleshooting.md` for error patterns and fixes, including `shape mismatch` at forward (missing width override), missing `gwc_feature_normalize` (TAO Core too old), `dynamic_hw: true` warning on FS / mono export, `Key 'encoder' not in 'StereoBackBone'`, missing `dataset_name` in `data_sources`, negative disparity, larger-than-expected disparity drift (missing `max_disparity: 192`), `depth_net_stereo: not found`, decorative pyt-eval `crop_size`, the cosmetic `Failed to import SAM3` warning, and silent dynamic-deploy stride-incompatibility.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this skill, not in `config.json`. Generated runners should apply the mappings with SDK helpers before `create_job()`. See `references/parent-model-inference.md` for the full per-action spec-field → inference-function mapping table.

For `parent_model` or `parent_model_folder`, pass the upstream train / export / AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. For raw-bp2 use cases without a parent train job, set the `<action>.checkpoint` field explicitly to the bp2 file path. Do not patch generated runner scripts to guess checkpoint paths.

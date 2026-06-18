---
name: tao-train-foundation-stereo
description: Stereo depth estimation using FoundationStereo. Predicts disparity maps from stereo image pairs for 3D
  reconstruction. Use when training, evaluating, exporting, or running inference for a TAO FoundationStereo model. Trigger
  phrases include "train stereo depth", "FoundationStereo", "stereo disparity estimation", "3D reconstruction from stereo".
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
---

# Depth Net Stereo

Stereo depth estimation using FoundationStereo architecture. Predicts disparity maps from stereo image pairs for 3D reconstruction.

Uses pretrained Depth Anything v2 and EdgeNeXt encoders. Set `model.stereo_backbone.depth_anything_v2_pretrained_path` and `model.stereo_backbone.edgenext_pretrained_path`.

The mono and stereo skills both invoke the unified TAO `depth_net` CLI inside the container; the mono/stereo family is selected via `model.model_type` (e.g., `FoundationStereo`).

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference`), read `references/tao-deploy-foundation-stereo.md` first. The deploy spec template lives in this skill's `references/spec_template_deploy.yaml`.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Workflow

### Prerequisites — data accessibility

Your dataset (left + right images + GT disparity) must be reachable from inside the container:
- **SDK runner**: place files at the S3 paths the runner resolves (the `S3_TRAIN` / `S3_EVAL` placeholders shown in **Typical Spec Overrides**). The runner handles S3 → container-path mounting transparently.
- **Direct `docker run`** (e.g. local testing): mount the host dataset root read-only at the same in-container path:

```
docker run ... -v <host_data_root>:<host_data_root>:ro <container> ...
```

The same accessibility requirement applies to the `<output_dir>` written by all actions.

### Step 1 — Annotation file

Per-line annotation file referenced by `data_sources[*].data_file`:

| Columns | Format | Use |
|---|---|---|
| 2 | `<left> <right>` | Stereo inference (no GT) |
| 3 | `<left> <right> <disparity>` | Stereo with GT |
| 4 | `<left> <right> <disparity> <occlusion_mask>` | Stereo with GT and occlusion mask |

If you already have one, point to it. Otherwise generate via `depth_net convert`:

```
depth_net convert -e <convert_spec.yaml>
```

`convert_spec.yaml` template (stereo):

```yaml
data_root: <directory whose immediate children are scene folders that contain your image+depth files; convert walks data_root recursively but expects per-scene subdirectories at one level below>
image_dir_pattern: [<substring matching left image paths>]
right_dir_pattern: [<substring matching right image paths>]
depth_dir_pattern: [<substring matching GT disparity paths>]
nocc_dir_pattern: []                 # optional, occlusion mask paths
image_extension: '.png'  # always include the leading dot
depth_extension: '.png'  # form must match image_extension (the swap is a substring replace)
nocc_extension: ''
split_ratio: 0.0        # 0.0/1.0 = test-only; 0.8 = 80/20 train+val
```

`convert` walks `data_root` recursively, selects paths whose path-string contains *all* substrings in `image_dir_pattern` (AND-filter), then derives right / depth / mask paths by replacing `image_dir_pattern[0]` with the corresponding pattern's first element plus extension swap. Inspect your dataset's directory layout and identify the substrings distinguishing left, right, and GT (e.g. `im0` vs `im1` vs `disp0GT` for Middlebury).

### Step 2 — Pair `model_type` and `dataset_name` based on your data

Prefer the dataset-specific class when your layout matches a supported one — it applies class-specific path conventions, evaluation crops, and (where applicable) occlusion-mask handling. Fall back to `GenericDataset` only for layouts that do not match any registered class.

| Data category | `model_type` | `dataset_name` |
|---|---|---|
| Middlebury data | `FoundationStereo` | `Middlebury` |
| KITTI data | `FoundationStereo` | `Kitti` |
| ETH3D data | `FoundationStereo` | `Eth3d` |
| FSD synthetic data | `FoundationStereo` | `FSD` |
| IsaacReal synthetic data | `FoundationStereo` | `IsaacRealDataset` |
| Crestereo synthetic data | `FoundationStereo` | `Crestereo` |
| Other / non-canonical layout | `FoundationStereo` | `GenericDataset` |

See **Training Requirements → Formats** for the full registered-class list. The same `dataset_name` value applies across train and evaluate actions (all of which use 3-column or 4-column annotations with GT disparity). The deploy-side `evaluate` action follows the same rule — see `references/tao-deploy-foundation-stereo.md`. For inference with 2-column annotations (left + right, no GT), use `dataset_name: GenericDataset` regardless of data layout — the dataset-specific classes (`Middlebury` / `Kitti` / `Eth3d` / `FSD` / `IsaacRealDataset` / `Crestereo`) require 3-column input and reject 2-column annotations at the dataloader level. For inference with 3-column annotations (left + right + GT), the dataset-specific class is fine.

### Step 3 — Write spec yaml from Typical Spec Overrides

Copy the action block from `references/foundation-stereo-spec-overrides.md` (per-action `spec_overrides`, mandatory data sources). Replace:
- `model.model_type` from Step 2 (typically `FoundationStereo`)
- `dataset.<...>.data_sources[*].dataset_name` from Step 2
- `dataset.<...>.data_sources[*].data_file` with the path from Step 1
- For deploy-side `evaluate`: enforce `dataset.test_dataset.batch_size: 1` (see `references/tao-deploy-foundation-stereo.md`).

Shape consistency: the `crop_size` in `dataset.test_dataset.augmentation.crop_size` should match `export.input_height` / `input_width` so the trained-model evaluator and the deploy-side TensorRT evaluator operate at the same shape — see `references/foundation-stereo-troubleshooting.md`.

### Step 4 — Run

```
docker run --gpus 'device=0' --shm-size 16G --ipc=host \
  --user $(id -u):$(id -g) \
  -v <data_root>:<data_root>:ro \
  -v <output_dir>:<output_dir> \
  <container> \
  depth_net <action> -e <spec.yaml>
```

Without `--user $(id -u):$(id -g)` the container writes outputs as `nobody:nogroup`, blocking host-side cleanup / retry.

### Step 5 — Verify

- Container exit code 0
- `status.json` `kpi` block populated
- For `train`: inspect per-step `train_loss` directly (the entrypoint reports `Execution status: PASS` even when loss is NaN)
- For `evaluate`: rely on `epe` / `bp1` / `bp2` / `bp3` / `d1` / `rmse` (the evaluator also emits `abs_rel` / `sq_rel` / `rmse_log` which are non-meaningful for stereo — see `references/foundation-stereo-parameters.md`)
- For `inference`: artifacts under `results_dir`

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference`), read `references/tao-deploy-foundation-stereo.md` first. Deploy spec templates live in this skill's `references/` folder with the `spec_template_deploy_*.yaml` prefix.

## Training Requirements

- **Valid `dataset_name` values for stereo `data_sources`** (case-insensitive): `FSD`, `IsaacRealDataset`, `Crestereo`, `Middlebury`, `Eth3d`, `Kitti`, `GenericDataset`
- **Monitoring metric:** val/loss

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| evaluate | dataset.test_dataset.data_sources | eval_dataset | data_file: annotations.txt + dataset_name | Yes |
| inference | dataset.infer_dataset.data_sources | inference_dataset | data_file: annotations.txt + dataset_name | Yes |
| quantize | dataset.train_dataset.data_sources | train_datasets | data_file: annotations.txt + dataset_name | Yes |
| quantize | dataset.val_dataset.data_sources | eval_dataset | data_file: annotations.txt + dataset_name | Yes |
| quantize | dataset.quant_calibration_dataset.images_dir | train_datasets | images.tar.gz | No |
| train | dataset.train_dataset.data_sources | train_datasets | data_file: annotations.txt + dataset_name | Yes |
| train | dataset.val_dataset.data_sources | eval_dataset | data_file: annotations.txt + dataset_name | Yes |

### Typical Spec Overrides

Data source overrides are **mandatory for every action** — the agent MUST construct data source paths from the Per-Action Dataset Requirements table above and include them in `spec_overrides`. Each `data_sources` entry is a dict with **two mandatory fields**: `data_file` and `dataset_name`.

See `references/foundation-stereo-spec-overrides.md` for the full per-action `spec_overrides` blocks (train, evaluate, export, gen_trt_engine, inference, quantize) with `S3_TRAIN` / `S3_EVAL` placeholders.

## Eval Dataset

Optional. Val dataset configured via `dataset.val_dataset.data_sources` (each entry needs `data_file` and `dataset_name`).

## Important Parameters

Key defaults: `model.model_type` = `FoundationStereo` (only selectable type); `model.encoder` (top-level, not under `stereo_backbone`) schema default `vitl` but **FS small NGC ckpt requires `vits`, override explicitly**; `model.max_disparity` default 416; `train.optim.lr` default 1e-4; `train.precision` fp32 (recommended) or fp16 (no bf16); `export.batch_size` default `-1`. The `workers` field name is `workers`, not `num_workers`.

See `references/foundation-stereo-parameters.md` for the full parameter glossary (all `model.*`, `dataset.*`, `train.*`, `export.*` fields with defaults and ranges) and the **Evaluation Metrics** reference (which `epe` / `bp*` / `d1` / `rmse` to trust and why `abs_rel` / `sq_rel` / `rmse_log` are non-meaningful for stereo).

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |
| `train.num_nodes` | Number of nodes | 1 |
| `train.distributed_strategy` | `ddp` or `fsdp` | `ddp` |

Same DDP/FSDP behavior as depth-net-mono. Multi-node requires `WORLD_SIZE`, `NODE_RANK`, `MASTER_ADDR`, `MASTER_PORT` env vars.

## Export / TRT Defaults

TRT data types FP32 / FP16. Static-shape ONNX (`export.batch_size: 1`) and batch-only dynamic ONNX (`export.batch_size: -1`) both support `fp16`; height and width are always pinned to the trace shape (H/W-dynamic engines are not supported — build separate engines per (H, W)). For the NGC release (576×960), set `export.batch_size: 1`, `export.opset_version: 17`, `export.on_cpu: True`.

See `references/foundation-stereo-export-trt-hardware.md` for the full export / TRT defaults (the opset-vs-`on_cpu` pairing rules, determinism notes, `on_cpu` GPU-memory thresholds) and the **Hardware** requirements. See `references/tao-deploy-foundation-stereo.md` for the three supported deploy paths and the validation table.

Full TAO Deploy reference: [tao-deploy-foundation-stereo](references/tao-deploy-foundation-stereo.md).

## Error Patterns

Common issues: disparity overflow (reduce `model.max_disparity`); missing pretrained paths (set both `model.stereo_backbone.depth_anything_v2_pretrained_path` and `model.stereo_backbone.edgenext_pretrained_path`); `Key 'encoder' not in 'StereoBackBone'` (`encoder` is top-level `model.encoder`); `Key 'dataset_name' is not in struct` (each `data_sources` entry needs both `data_file` and `dataset_name`); `bash: exec: depth_net_stereo: not found` (entrypoint is `depth_net`, no suffix).

See `references/foundation-stereo-troubleshooting.md` for the full error patterns plus the pyt-vs-deploy `crop_size` discussion (the pyt `evaluate` path runs at native image resolution and ignores `crop_size`, with the Middlebury resolution guidance) and the **Shape consistency** rule.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in MD, not in `config.json`. Generated runners read these mappings and apply them with SDK helpers before `create_job()` (mirrors the old microservices `infer_params.py` flow). For `parent_model` / `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`; the SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.

See `references/foundation-stereo-spec-param-inference.md` for the full per-action inference-mapping table (train / evaluate / inference / export / gen_trt_engine / quantize, including the train pretrained-path link/destination and resume-checkpoint mappings).

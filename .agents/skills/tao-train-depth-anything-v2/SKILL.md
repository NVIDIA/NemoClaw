---
name: tao-train-depth-anything-v2
description: Monocular depth estimation using Metric Depth Anything v2 or Relative Depth Anything architectures. Predicts
  per-pixel depth from single RGB images. Use when training, evaluating, exporting, or running inference for a TAO
  monocular depth model. Trigger phrases include "train monocular depth", "DepthAnything v2", "metric depth from single
  image", "monocular depth estimation".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- monocular
- depth
- estimation
---

# Depth Net Mono

Monocular depth estimation using Metric Depth Anything v2 or Relative Depth Anything architectures. Predicts per-pixel depth from single RGB images.

Pretrained checkpoint loading varies by model variant and use case — see the **Pretrained checkpoint loading — use case matrix** in `references/parameters.md`.

The mono and stereo skills both invoke the unified TAO `depth_net` CLI inside the container; the mono/stereo family is selected via `model.model_type` (full parameter glossary in `references/parameters.md`).

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference`), read `references/tao-deploy-depth-anything-v2.md` first. The deploy spec template lives in this skill's `references/spec_template_deploy.yaml`.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Workflow

### Prerequisites — data accessibility

Your dataset (RGB images + GT depth files) must be reachable from inside the container:
- **SDK runner**: place files at the S3 paths the runner resolves (the `S3_TRAIN` / `S3_EVAL` placeholders shown in the spec overrides). The runner handles S3 → container-path mounting transparently.
- **Direct `docker run`** (e.g. local testing): mount the host dataset root read-only at the same in-container path:

```
docker run ... -v <host_data_root>:<host_data_root>:ro <container> ...
```

The same accessibility requirement applies to the `<output_dir>` written by all actions.

### Step 1 — Annotation file

Per-line annotation file referenced by `data_sources[*].data_file`:

| Columns | Format | Use |
|---|---|---|
| 1 | `<image>` | Mono inference (no GT) |
| 2 | `<image> <gt_depth>` | Mono with GT |

If you already have one, point to it. Otherwise generate via `depth_net convert`:

```
depth_net convert -e <convert_spec.yaml>
```

`convert_spec.yaml` template:

```yaml
data_root: <directory whose immediate children are scene/sample folders that contain your image+depth files; convert walks data_root recursively but expects per-scene subdirectories at one level below>
image_dir_pattern: [<substring matching left/RGB image paths>]
depth_dir_pattern: [<substring matching GT depth paths>]
image_extension: ''     # optional .endswith filter, e.g. '.jpg'
depth_extension: ''     # optional, swapped during depth derivation, e.g. '.png'
split_ratio: 0.0        # 0.0/1.0 = test-only; 0.8 = 80/20 train+val
```

`convert` walks `data_root` recursively, selects paths whose path-string contains *all* substrings in `image_dir_pattern` (AND-filter), then derives the depth path by replacing `image_dir_pattern[0]` with `depth_dir_pattern[0]` and `image_extension` with `depth_extension`. Inspect your dataset's directory layout and identify the substring distinguishing RGB images from depth files (e.g. `rgb_` vs `sync_depth_`).

`data_root` must point at the parent that contains the per-scene subdirectories (e.g. for NYU eval, use `/data/nyu_v2/eval/test`, not `/data/nyu_v2/eval/test/bathroom` — the latter limits the walk to a single scene). Always include the leading dot in `image_extension` / `depth_extension` (e.g. `'.jpg'` not `'jpg'`); the substring swap is form-sensitive and a mismatch silently corrupts derived paths.

### Step 2 — Pair `model_type` and `dataset_name` based on your data

Default — generic class for each task:

| Data category | `model_type` | `dataset_name` |
|---|---|---|
| Disparity-encoded data (pixels) | `RelativeDepthAnything` | `RelativeMonoDataset` |
| Metric depth (meters) | `MetricDepthAnything` | `MetricMonoDataset` |
| Mono inference (no GT, any image) | matches train choice | `RelativeMonoDataset` or `MetricMonoDataset` |

Dataset-specific class — switch when the data needs preprocessing the generic class does not perform:

| Special case | `model_type` | `dataset_name` | What the class adds |
|---|---|---|---|
| NYU `sync_depth_*.png` (raw uint16 millimetres) — relative | `RelativeDepthAnything` | `NYUDV2Relative` | mm→m unit conversion + Eigen evaluation crop |
| NYU `sync_depth_*.png` (raw uint16 millimetres) — metric | `MetricDepthAnything` | `NYUDV2` | same |

Using a generic class on data that requires unit conversion (e.g. raw NYU uint16 PNGs) results in an empty valid mask and silent `train_loss = NaN`. Match the class to your data's encoding.

### Step 3 — Write spec yaml from the spec overrides

Copy the action block from `references/spec-overrides.md`. Replace:
- `model.model_type` from Step 2
- `dataset.<...>.data_sources[*].dataset_name` from Step 2
- `data_sources[*].data_file` with the path from Step 1 (S3 path under SDK runner, host path for direct docker)
- For metric finetune: additionally apply the **Metric Variant Finetuning Recipe** in `references/finetuning.md`.

For mono training set `train.precision: fp32` (recommended) or `bf16` (Ampere SM80+, alternative).

### Step 4 — Run

```
docker run --gpus 'device=0' --shm-size 16G --ipc=host \
  --user $(id -u):$(id -g) \
  -v <data_root>:<data_root>:ro \
  -v <output_dir>:<output_dir> \
  <container> \
  depth_net <action> -e <spec.yaml>
```

Without `--user $(id -u):$(id -g)` the container writes outputs as `nobody:nogroup`, blocking host-side cleanup and retry.

### Step 5 — Verify

- Container exit code 0
- `status.json` `kpi` block populated
- For `train`: inspect per-step `train_loss` directly — the entrypoint reports `Execution status: PASS` even when `train_loss = NaN` (see the **Sanity-run PASS criteria** in `references/finetuning.md`)
- For `evaluate` / `inference`: artifacts under `results_dir`

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference`), read `references/tao-deploy-depth-anything-v2.md` first. Deploy spec templates live in this skill's `references/` folder with the `spec_template_deploy_*.yaml` prefix.

## Training Requirements

- **Valid `dataset_name` values for mono `data_sources`** (case-insensitive): `ThreeDVLM`, `FSD`, `NvCLIP`, `IssacStereo`, `Crestereo`, `Middlebury`, `NYUDV2`, `NYUDV2Relative`, `RelativeMonoDataset`, `MetricMonoDataset`. `NYUDV2` carries metric depth GT (meters) — pair with `MetricDepthAnything`; `NYUDV2Relative` is the same data with relative-depth conventions — pair with `RelativeDepthAnything`.
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

### Spec Overrides

Data source overrides are **mandatory for every action** — construct the data source paths from the Per-Action Dataset Requirements table above and include them in `spec_overrides`; each `data_sources` entry is a dict with the two mandatory fields `data_file` and `dataset_name`. See `references/spec-overrides.md` for the full per-action `train` / `evaluate` / `export` / `inference` / `quantize` override blocks and the precision recommendations.

## Eval Dataset

Optional. Val dataset configured via `dataset.val_dataset.data_sources` (each entry needs `data_file` and `dataset_name`).

## Important Parameters

Full parameter glossary (`model.*`, `train.*`, `dataset.*`, `export.*`, `inference.*` fields with options, defaults, and sources) plus the **Pretrained checkpoint loading — use case matrix** live in `references/parameters.md`. Key starting points: `model.model_type` (default `MetricDepthAnything`), `model.encoder` (default `vitl`), `train.optim.lr` (default 1e-4, AdamW), `train.precision` (`fp32` recommended), `dataset.{train,val,test,infer}_dataset.augmentation.crop_size` (default `[518, 518]`).

## Finetuning Recipes

Relative and Metric variant finetuning recipes — including required spec keys, the metric `dataset.{normalize_depth, min_depth, max_depth}` block required in both train AND export specs, trainer-enforced defaults (`clip_grad_norm: 0.1`, `warmup_steps: 20`, `weight_decay: 1e-4`), sanity-run overrides, and the **Sanity-run PASS criteria** for catching silent `train_loss = NaN` — are in `references/finetuning.md`. Both recipes use `train.optim.lr: 5e-6` with `LambdaLR` (the AdamW default `1e-4` is too aggressive when finetuning from a converged/pretrained backbone).

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |
| `train.num_nodes` | Number of nodes | 1 |
| `train.distributed_strategy` | `ddp` or `fsdp` | `ddp` |

- `ddp` with activation checkpointing: `find_unused_parameters=False`
- `ddp` without: `find_unused_parameters=True`
- `fsdp` forces precision to FP16

**Multi-node env vars** (set by orchestrator): `WORLD_SIZE`, `NODE_RANK`, `MASTER_ADDR`, `MASTER_PORT`, `NUM_GPU_PER_NODE`.

## Export / TRT Defaults

- TRT data types: FP32, BF16 (Ampere SM80+). FP16 is not supported for the ViT-L mono backbone.
- Recommended TRT precision: `bf16`. Use `fp32` if BF16 hardware is unavailable.

Full TAO Deploy reference: [tao-deploy-depth-anything-v2](references/tao-deploy-depth-anything-v2.md).

## Hardware

Minimum 1 GPU(s), recommended 2 GPU(s). 24GB+ VRAM per GPU. ViT-Large encoder is memory intensive. Use `fp32` (recommended) or `bf16` (Ampere SM80+, alternative) for training. Activation checkpointing is available for larger inputs.

## Error Patterns

Common failure signatures and fixes — depth range mismatch, missing pretrained weights, `Key 'encoder' not in 'MonoBackBone'`, missing `dataset_name`, `depth_net_mono: not found`, metric variant hyperparameter sourcing, and the export refuse-to-overwrite ONNX error — are documented in `references/troubleshooting.md`.

## Spec Param / Parent Model Inference

Model-specific inference mappings (the full `depth_net_mono.config.json` per-action spec-field → inference-function table, plus `parent_model` / `parent_job_id` resolution guidance) are in `references/spec-param-inference.md`. These mappings belong in MD, not in `config.json`; generated runners should read that reference and apply the mappings with SDK helpers before `create_job()`.

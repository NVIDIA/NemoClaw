---
name: tao-train-dino
description: DINO (DETR with Improved DeNoising Anchor Boxes) for 2D object detection. Transformer-based detector with
  denoising training, multi-scale features, and optional distillation support. Use when training, evaluating, exporting,
  distilling, quantizing, or running inference for a TAO DINO detector. Trigger phrases include "train DINO", "DETR object
  detection", "TAO 2D detection", "DINO with distillation".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- object
- detection
---

# DINO

DINO (DETR with Improved DeNoising Anchor Boxes) for 2D object detection. Transformer-based detector with denoising training, multi-scale features, and optional distillation support.

Uses pretrained backbone weights (e.g. ResNet-50 ImageNet). Set `model.pretrained_backbone_path` for backbone-only or `train.pretrained_model_path` for full model.

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and
TensorRT `inference`), read `references/tao-deploy-dino.md` first. Deploy spec templates live
in this skill's `references/` folder with the `spec_template_deploy_*.yaml`
prefix.

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json` (with `schemas/manifest.json` listing actions); each schema emits a matching `references/spec_template_<action>.yaml`. See `references/sdk_orchestration.md` for the full dataclass-schema, spec-template, data-sources, and parent-model inference details used by SDK orchestration.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

The agent MUST read this section before generating any training or AutoML script for DINO.

- **Dataset type:** object_detection
- **Formats:** coco, coco_raw
- **Accepted dataset intents:** training, evaluation, testing, calibration
- **Monitoring metric:** val_mAP50

**Required datasets — MUST resolve both:**

| Dataset | Required | Why |
|---|---|---|
| Train dataset URI | Yes | Training data (COCO format) |
| Validation dataset URI | **Yes — ALWAYS** | DINO unconditionally builds a val dataloader. Omitting `val_data_sources` causes `FileNotFoundError` at startup regardless of the metric or workflow. If the user has no separate eval split, reuse the train URI. |

**Required inputs before generating any training spec:**

1. **Train dataset URI** — S3 path to COCO-format training data
2. **Validation dataset URI** — S3 path to COCO-format val data (can be same as train)
3. **`num_classes`** — How many object classes? Default 91 (COCO). Must be >= `max(category_id) + 1`. Too low causes `CUDA error: device-side assert triggered`.

Resolve these from the user request or the default profile below. Prompt only
for values that are still missing after applying the profile rules.

**Bankable local default profile for DINO AutoML smoke runs:**

Use this profile only when the user asks to run DINO AutoML and does not provide
dataset or class-count inputs. This profile is intentionally small and local to
this skill bank; it is for smoke/iteration runs, not a production benchmark.
Do not search previous runners, logs, session state, shell history, or the home
directory to recover these values.

```python
DINO_AUTOML_PROFILE = {
    "train_dataset_uri": "s3://nvcf-storage-handling/data/tao_od_synthetic_subset_train_no_convert",
    "validation_dataset_uri": "s3://nvcf-storage-handling/data/tao_od_synthetic_subset_val_no_convert",
    "object_classes": 4,
    "dataset_num_classes": 5,
    "image_archive": "images.tar.gz",
    "annotation_file": "annotations.json",
    "max_recommendations": 10,
    "train_num_epochs": 10,
    "train_checkpoint_interval": 10,
    "train_validation_interval": 1,
    "train_num_gpus": 1,
}
```

If the user supplies any dataset URI or class-count value, prefer the user value
and ask for any remaining required DINO value. Do not partially mix a user's
custom dataset with this profile's class count unless the user confirms it.

**Do not prompt for image layout for the standard DINO dataset.** The standard
TAO DINO dataset artifact is `images.tar.gz` plus `annotations.json`. Use
`images.tar.gz` in the remote `image_dir` spec override. The SDK downloads the
archive and rewrites the runtime spec to the extracted folder named after the
archive stem (`images.tar.gz` -> `images`). Only deviate if the user explicitly
provides a different image artifact name.

## Spec Overrides, Datasets, and Parameters

Data source overrides are **mandatory for every action** — DINO's `config.json` has empty `data_sources` because the runner cannot auto-resolve array-of-objects spec keys. The agent MUST build data source paths and include them in `spec_overrides`.

See `references/spec_overrides.md` for: the per-action dataset requirements table; the mandatory `spec_overrides` blocks for `train`, `evaluate`, `export`, `gen_trt_engine`, `inference`, `quantize`, and `distill`; checkpoint resolution via `parent_model` inference and the `results_dir/train/dino_model_latest.pth` fallback; the COCO dataset format and `images.tar.gz` archive-stem rules; per-action data-source layouts; the full **Important Parameters** list (num_classes, backbone and its supported values, lr/lr_backbone, num_epochs, lr_steps, num_queries, batch_size); **Default Values** (num_epochs 10, batch_size 4, learning_rate 2e-4, lr_backbone 2e-5, num_classes 91, backbone resnet_50); **Evaluate Defaults**; **Export Defaults** (input 640x640, opset 17, trt_data_types [FP32, FP16, INT8], trt_workspace_size_mb 1024); and **Hardware** guidance (1 GPU minimum, 4 recommended, 24GB+ A100). Full TAO Deploy reference: [tao-deploy-dino](references/tao-deploy-dino.md).

When generating an `evaluate` spec, carry forward the winning AutoML rec's structural model settings (`model.backbone`, `model.num_queries`, `model.dropout_ratio`, `dataset.num_classes`) so the checkpoint shape matches the evaluation model.

## Error Patterns

Common failures include CUDA OOM, `num_select < num_queries * num_classes`, spec/schema merge errors, dataset-smaller-than-batch, `return_interm_indices` vs `num_feature_levels` mismatch, `FileNotFoundError` on images or missing val data, `CUDA device-side assert` from low `num_classes`, S3 inputs not downloaded, and evaluate checkpoint not found at the result root. See `references/troubleshooting.md` for each error pattern and its fix.

## AutoML / HPO Notes

AutoML runs training — all **Training Requirements** above apply, and the no-input case uses `DINO_AUTOML_PROFILE`. Do not inspect previous AutoML runs to infer dataset URIs, `num_classes`, recommendation count, or interval settings. Use explicit `metric="mAP50"` with `direction="maximize"` and a custom `metric_extractor` reading `Validation mAP50` rather than `metric="kpi"`. See `references/automl.md` for the recommended metric extractor, hyperparameter list, `custom_param_ranges`, the `train.optim.weight_decay` note, and the backbone-constraint guidance.

## Optional: running via the TAO SDK

The SDK `script_runner` orchestration, S3 I/O wrapping, AutoML internals, spec-template generation, the data-sources gap, the `config.json` `inputs` declarations, and the full per-action spec-param / parent-model inference mapping table are documented in `references/sdk_orchestration.md`. Skip this when running locally with `docker run`.

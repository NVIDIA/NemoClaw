---
name: tao-finetune-cosmos-embed
description: >-
  Cosmos-Embed1 video-text embedding for text-to-video retrieval, video-to-video search, semantic deduplication, and
  fine-tuning. Use when the user asks to "fine-tune Cosmos-Embed1", "run cosmos-embed inference", "export Cosmos-Embed1",
  "embed videos", or "search videos with text".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit, the published Cosmos-Embed TAO container from versions.yaml, and a HuggingFace token when downloading pretrained `nvidia/Cosmos-Embed1-*` weights.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash
tags:
- video
- vision-language
- vlm
- multimodal
- retrieval
- embedding
- cosmos
- fine-tuning
---

# Cosmos-Embed

Cosmos-Embed1 is a joint video-text embedder for text-to-video retrieval, video-to-video search, zero-shot/kNN classification, and semantic deduplication. The packaged CLI is `cosmos-embed1` and supports `train`, `evaluate`, `inference`, and `export`.

Container image and per-action commands are in `references/skill_info.yaml`. Compact starting specs are in `references/spec_template_*.yaml`.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Quick Start

Use the published Cosmos-Embed container declared by `references/skill_info.yaml`
and resolved through `versions.yaml`. Do not build from the private
Cosmos-Embed1 source tree for normal skill use; build from source only when
developing the container itself.

```bash
TAO_SKILL_BANK_PATH="${TAO_SKILL_BANK_PATH:-$PWD}"
COSMOS_EMBED_IMAGE="${COSMOS_EMBED_IMAGE:-$(
  python "$TAO_SKILL_BANK_PATH/scripts/resolve_tao_image.py" \
    --skill-bank "$TAO_SKILL_BANK_PATH" \
    --model cosmos-embed \
    --action train \
    --format json |
  python -c 'import json,sys; print(json.load(sys.stdin)["image"])'
)}"
docker pull "$COSMOS_EMBED_IMAGE"
```

Expected local workspace layout:

```text
workspace/
├── data/
│   ├── msrvtt_test_1k.json
│   └── video/
│       ├── video7020.mp4
│       └── ...
├── model/
│   └── Cosmos-Embed1-224p/        # optional if using HF repo id
├── specs/
│   ├── train.yaml
│   ├── evaluate.yaml
│   ├── inference.yaml
│   ├── export_onnx.yaml
│   └── export_hf.yaml
└── results/
```

Use these Docker options for all actions unless the local Docker/platform skill gives a stricter environment-specific command:

```bash
TAO_SKILL_BANK_PATH="${TAO_SKILL_BANK_PATH:-$PWD}"
COSMOS_EMBED_IMAGE="${COSMOS_EMBED_IMAGE:-$(
  python "$TAO_SKILL_BANK_PATH/scripts/resolve_tao_image.py" \
    --skill-bank "$TAO_SKILL_BANK_PATH" \
    --model cosmos-embed \
    --action train \
    --format json |
  python -c 'import json,sys; print(json.load(sys.stdin)["image"])'
)}"
RUN_ROOT="${RUN_ROOT:-$PWD}"
DOCKER_COMMON=(
  --rm --gpus all --ipc=host --network=host
  --shm-size=64g
  --ulimit memlock=-1
  --ulimit stack=67108864
  -e HF_TOKEN
  -v "$RUN_ROOT/data:/data:ro"
  -v "$RUN_ROOT/model:/model"
  -v "$RUN_ROOT/specs:/specs:ro"
  -v "$RUN_ROOT/results:/results"
)
```

Train:

```bash
docker run "${DOCKER_COMMON[@]}" "$COSMOS_EMBED_IMAGE" \
  cosmos-embed1 train -e /specs/train.yaml results_dir=/results
```

Evaluate:

```bash
docker run "${DOCKER_COMMON[@]}" "$COSMOS_EMBED_IMAGE" \
  cosmos-embed1 evaluate -e /specs/evaluate.yaml results_dir=/results
```

Inference:

```bash
docker run "${DOCKER_COMMON[@]}" "$COSMOS_EMBED_IMAGE" \
  cosmos-embed1 inference -e /specs/inference.yaml \
  'inference.query.input_texts=["a man is singing on stage"]' \
  inference.k=5 \
  results_dir=/results
```

Export ONNX:

```bash
docker run "${DOCKER_COMMON[@]}" "$COSMOS_EMBED_IMAGE" \
  cosmos-embed1 export -e /specs/export_onnx.yaml \
  export.checkpoint=/results/train/cosmos_embed1_model_latest.pth \
  export.onnx_file=/results/export/cosmos_embed1_combined.onnx \
  results_dir=/results
```

Export HuggingFace format:

```bash
docker run "${DOCKER_COMMON[@]}" "$COSMOS_EMBED_IMAGE" \
  cosmos-embed1 export -e /specs/export_hf.yaml \
  export.checkpoint=/results/train/cosmos_embed1_model_latest.pth \
  export.hf_output_dir=/results/export_hf/cosmos_embed1_hf \
  results_dir=/results
```

## Smoke Overrides

For a small functional check, keep the same specs and override the expensive knobs:

```bash
train.max_iter=1
train.validation_iter=2
train.checkpoint_iter=1
train.optim.optim=adamw
dataset.train_dataset.batch_size=1
dataset.val_dataset.batch_size=1
dataset.train_dataset.workers=0
dataset.val_dataset.workers=0
```

If no local Cosmos-Embed1 pretrained checkpoint or HuggingFace token is available, set `model.pretrained_model_path=null` for a plumbing-only smoke train. The model quality is meaningless in that mode, but the train/evaluate/inference/export action paths can still be exercised.

For evaluation and inference smoke tests on a tiny subset:

```bash
evaluate.callbacks.embedding_visualization=false
evaluate.callbacks.max_eval_samples=8
dataset.test_dataset.batch_size=1
dataset.test_dataset.workers=0
inference.k=2
dataset.inference_dataset.batch_size=1
dataset.inference_dataset.workers=0
```

## Data Format

The MSR-VTT path expects a local video glob and a JSON metadata file:

```yaml
dataset:
  train_dataset:
    dataset_type: msrvtt
    mp4_urls: /data/video/*.mp4
    metadata: /data/msrvtt_test_1k.json
```

List-format metadata rows must include at least `video` and `caption`:

```json
{"video_id": "video7020", "video": "video7020.mp4", "caption": "a woman creating a fondant baby and flower"}
```

The dataset loader derives the video id from the local `.mp4` filename and filters to videos present in the metadata. If a run finds zero videos, check that `mp4_urls` points to a container-local glob and that metadata `video` names match the filenames.

## Model Weights

- Local HF directory: mount it under `/model` and set `model.pretrained_model_path=/model/Cosmos-Embed1-224p`.
- HuggingFace repo: set `model.pretrained_model_path=nvidia/Cosmos-Embed1-224p` and pass `HF_TOKEN` if access is gated.
- Fine-tuned checkpoint: downstream actions default to `/results/train/cosmos_embed1_model_latest.pth`.

Variants:

| Variant | Resolution | Frames | Embedding dim |
|---|---:|---:|---:|
| `Cosmos-Embed1-224p` | 224 x 224 | 8 | 256 |
| `Cosmos-Embed1-336p` | 336 x 336 | 8 | 768 |
| `Cosmos-Embed1-448p` | 448 x 448 | 8 | 768 |

Keep `model.network.embed_dim`, `model.input_hw`, and `model.network.spatial_resolution` aligned with the selected variant.

## Important Parameters

| Parameter | Notes |
|---|---|
| `train.num_gpus` | `1` for single GPU, `>1` auto-launches `torchrun`, `-1` auto-detects visible GPUs. |
| `train.max_iter` | Main training length. Use `1` only for smoke testing. |
| `train.optim.optim` | `fused_adamw` is faster when available; `adamw` is safer for smoke and portability. |
| `model.lora.enabled` | Enables LoRA. Set `model.network.visual_encoder.transformer_engine=false` when LoRA is on. |
| `model.lora.lora_rank` | LoRA rank. Start with `8`; try `4`, `8`, or `16` for manual or AutoML-style sweeps. |
| `model.lora.lora_alpha` | LoRA scaling factor. Start with `16`; keep near `2 * lora_rank` unless experiments show otherwise. |
| `model.lora.lora_dropout` | LoRA dropout. Start with `0.1`; sweep `0.0`, `0.05`, and `0.1` for small datasets. |
| `model.lora.bias` | Bias policy: `none`, `all`, or `lora_only`. Keep `none` unless intentionally training biases. |
| `model.lora.use_rslora` / `use_dora` | Optional LoRA variants. Enable one at a time and record the setting with the checkpoint. |
| `model.lora.target_modules` | Optional module-name patterns for LoRA injection. Leave empty for the default ViT + Q-Former attention/MLP targets. |
| `model.lora.modules_to_save` | Optional modules to keep fully trainable alongside LoRA. Leave empty unless preserving a task-specific head. |
| `evaluate.load_dataset_pkl` / `save_dataset_pkl` | Cache evaluation embeddings. |
| `inference.load_dataset_pkl` / `save_dataset_pkl` | Cache the search database for repeated retrieval. |
| `export.mode` | `video`, `text`, `combined`, or `huggingface`. |
| `export.on_cpu` | Recommended for export to avoid device mismatch issues. |

### LoRA and AutoML Notes

For parameter-efficient fine-tuning, set `model.lora.enabled=true` and keep
`model.network.visual_encoder.transformer_engine=false`; TAO Core's
Cosmos-Embed1 config notes that PEFT cannot inject adapters into Transformer
Engine layers. Treat the LoRA fields above as the first candidate parameters
for manual tuning or AutoML-style search before unfreezing larger model blocks.
Avoid changing `target_modules` or `modules_to_save` unless the user explicitly
needs custom adapter placement.

## S3 Staging

The Cosmos-Embed1 CLI consumes local paths and Python globs, not raw `s3://.../*.mp4` URIs. For S3-backed runs, first stage a subset or full dataset to the execution host/container filesystem, then use local paths such as `/data/video/*.mp4` in the spec.

Recommended S3 layout for staged MSR-VTT data:

```text
s3://bucket/path/cosmos-embed/msrvtt-subset/
├── msrvtt_test_1k.json
└── video/
    ├── video7020.mp4
    └── ...
```

After downloading/syncing that prefix into the mounted `data/` directory, use the same Docker commands above.

## Outputs

```text
results/
├── train/
│   ├── cosmos_embed1_model_latest.pth
│   ├── cosmos_embed1_model_<iter>.pth
│   └── experiment.yaml
├── evaluate/
│   ├── metrics.json
│   └── experiment.yaml
├── inference/
│   ├── results.json
│   └── experiment.yaml
├── export/
│   ├── cosmos_embed1_combined.onnx
│   └── export_config.yaml
└── export_hf/
    └── cosmos_embed1_hf/
```

## Known Pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `MSRVTTDataset: 0 videos found` | `mp4_urls` is not a local glob or metadata filenames do not match videos. | Mount data into the container and set `mp4_urls=/data/video/*.mp4`. |
| HF download/auth failure | Missing or invalid `HF_TOKEN`, or model agreement not accepted. | Accept the model terms and pass `-e HF_TOKEN`. |
| LoRA injection failure | Transformer Engine visual encoder is enabled. | Set `model.network.visual_encoder.transformer_engine=false`. |
| ONNX/HF export complains about missing components | Export checkpoint is partial or adapter-only. | Use a full checkpoint or configure pretrained visual/text sources before export. |
| CUDA OOM | Batch/resolution too high for the GPU. | Reduce batch size, use 224p, enable LoRA, or use more GPUs. |

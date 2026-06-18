---
name: tao-generate-image-grounding
description: "Two-step image grounding pipeline: extracts referring expressions from (image, caption) pairs and grounds them
  to pixel-space bounding boxes via a VLM. Use when the user wants to ground captions to bboxes, generate phrase-grounded
  annotations, auto-label images for grounding, or run the image_grounding pipeline. Triggers include 'image grounding',
  'phrase grounding', 'ground captions', 'auto-label image grounding', 'image_grounding'."
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit + at least one VLM endpoint (Gemini API key or OpenAI-compatible).
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash Write
tags:
  - image
  - grounding
  - bounding-boxes
  - auto-label
  - vlm
  - 2d-grounding
---

# Image Grounding Pipeline

Turn `(image, caption)` pairs into per-image grounded annotations: cleaned captions, referring expressions with character spans, and pixel-space bounding boxes for each expression. A single VLM (Gemini or any OpenAI-compatible endpoint) handles both steps.

## Purpose

Generate phrase-grounded training data for referring-expression and grounding models. The VLM acts as a "teacher" annotator: Step 0 extracts referring expressions from the caption while looking at the image; Step 1 returns one bbox set per expression for each image.

## Pipeline Architecture

```
Step 0: Expression extraction  → VLM cleans caption, extracts referring expressions + char spans
Step 1: Phrase grounding       → VLM returns pixel bboxes + scores per expression
```

Steps are individually selectable via `workflow.steps`. Each step writes a per-sample checkpoint to `step_<N>_*/.ckpt/<sample_id>.json` and skips already-processed records on re-run. Set `workflow.force_reprocess: true` to ignore checkpoints and reprocess from scratch.

## Instructions

### Initial setup

When a user wants to run this pipeline, walk through these steps:

1. **Input JSONL**: Ask for the JSONL path. Each line must be one object like `{"image_path": "...", "caption": "..."}`. `image_path` can be absolute or relative.
2. **Image root**: If any `image_path` values are relative, set `data.image_root` to the directory they should resolve from.
3. **API access**: Ask the user which VLM endpoint they want to use. Present these five options and act on the choice:
   1. **Gemini** — set `vlm.backend: "gemini"`; require `GOOGLE_API_KEY` (env var or `vlm.gemini.api_key`).
   2. **NIM** (e.g. `https://inference-api.nvidia.com/v1`) — set `vlm.backend: "openai"`; collect `base_url`, `model_name`, and `api_key`.
   3. **TAO inference microservice** (self-hosted, OpenAI-compatible). Confirm whether the server is already running:
      - **Running** — collect `base_url`, `model_name`, and (optionally) `api_key`; set `vlm.backend: "openai"`.
      - **Not running** — guide the user through the `skills/applications/tao-run-inference-service` skill, which stands up a local TAO inference microservice with an OpenAI-compatible API. Before promising a specific model, check `skills/applications/tao-run-inference-service/references/service.yaml` for `valid_network_arch_config_basenames`. Once the server is up, collect `base_url`, `model_name`, and (optionally) `api_key`; set `vlm.backend: "openai"`.
   4. **vLLM** (self-hosted, OpenAI-compatible). Confirm whether the server is already running:
      - **Running** — collect `base_url`, `model_name`, and (optionally) `api_key`; set `vlm.backend: "openai"`.
      - **Not running** — follow [references/vllm_server.md](references/vllm_server.md) to install and launch a vLLM server, then collect `base_url`, `model_name`, and (optionally) `api_key`; set `vlm.backend: "openai"`.
   5. **Custom** (any other OpenAI-compatible endpoint) — set `vlm.backend: "openai"`; collect `base_url`, `model_name`, and (optionally) `api_key`.

   If the user has no endpoint and does not want to set one up, stop and help resolve API access first.
4. **Workflow steps**: Choose one of:
   - Full pipeline: `["0", "1"]`
   - Expression extraction only: `["0"]`
   - Grounding only: `["1"]`, which requires existing step-0 output at `results_dir/step_0_expression_extraction/annotations.jsonl`
5. **Resume vs fresh run**: By default, the workflow reuses checkpoints and skips completed records. To reprocess everything, set `image_grounding.workflow.force_reprocess=true`.

### Running the pipeline

The pipeline runs inside the TAO Toolkit container via the `auto_label` CLI:

```bash
auto_label generate -e /path/to/spec.yaml \
    results_dir=/results \
    image_grounding.data.input_jsonl=/data/captions.jsonl \
    image_grounding.data.image_root=/data/images \
    image_grounding.vlm.gemini.api_key=$GOOGLE_API_KEY
```

Generate a default spec: `auto_label default_specs results_dir=/results module_name=auto_label`, then set `autolabel_type: "image_grounding"`. All fields support Hydra dot-notation overrides on the command line.

See [references/configuration.md](references/configuration.md) for the full YAML structure, all parameters, model/endpoint setup, and error patterns.

### Recommended pilot workflow

1. Run on 5-10 images with both steps
2. Inspect `step_0_expression_extraction/annotations.jsonl` — are `cleaned_caption` and `expressions[]` accurate? Are the right noun phrases captured?
3. Inspect `step_1_grounding/annotations.jsonl` — do the bboxes in `expressions[].instances[]` look right? Are confidence scores reasonable?
4. If quality is insufficient, switch the VLM to a stronger model (e.g. `gemini-2.5-pro`) or raise `media_resolution`/`max_output_tokens`, then re-run with `force_reprocess=true`.
5. Scale to the full dataset once satisfied.

## Configuration

Key configuration fields (full reference in [references/configuration.md](references/configuration.md)):

| Field | Default | Description |
|-------|---------|-------------|
| `workflow.steps` | `["0","1"]` | Which pipeline steps to execute (`"0"` = expressions, `"1"` = grounding) |
| `workflow.max_workers` | `4` | Parallel threads per step (watch API rate limits) |
| `workflow.force_reprocess` | `false` | Ignore per-sample checkpoints and reprocess from scratch |
| `vlm.backend` | `"gemini"` | `"gemini"` or `"openai"` (OpenAI-compatible endpoint) |
| `data.input_jsonl` | required | Path to input JSONL with `image_path` + `caption` per line |
| `data.image_root` | `""` | Optional prefix for resolving relative `image_path` entries |

## Inputs

A single JSONL file at `data.input_jsonl`. One JSON object per line:

| Field | Required | Description |
|-------|----------|-------------|
| `image_path` | yes | Absolute path, or relative path resolved against `data.image_root` |
| `caption` | yes | Free-text caption for the image |
| `image_id` | no | Stable identifier; auto-derived from the filename if missing |
| `width`, `height` | no | Image dimensions in pixels; default to `1920×1080` for bbox clamping if missing |

## Outputs

All outputs go to `results_dir/`:

- `step_0_expression_extraction/annotations.jsonl` — per-record output enriched with `cleaned_caption` and `expressions[]` (each with `text`, `expression_id`, `char_span`, `noun_chunk`, empty `instances[]`).
- `step_1_grounding/annotations.jsonl` — same records with `expressions[].instances[]` filled in (each instance has `bbox: [x1,y1,x2,y2]` in pixel space, `score` in `[0.0, 1.0]`, and `bbox_id`).
- `results_dir/annotations.jsonl` — copy of the last step's output for convenience.
- `step_<N>_*/.ckpt/<sample_id>.json` — per-sample checkpoints used for resume.

## Prerequisites

- **Container**: `nvcr.io/nvidia/tao/tao-toolkit:6.26.3-pyt`
- **API access**: At least one VLM endpoint (Gemini API key or OpenAI-compatible endpoint capable of image input)

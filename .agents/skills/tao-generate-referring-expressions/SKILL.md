---
name: tao-generate-referring-expressions
description: "Four-step image referring-expression pipeline: turns images plus KITTI bounding-box labels into region
  descriptions, scene captions, grounded referring expressions, and (optionally) verified expressions via VLM distillation. Use
  when the user wants to generate referring-expression annotations from images with KITTI labels, build region descriptions,
  produce grouped grounding phrases tied to bboxes, run a double-check verification pass on grounding expressions, auto-label
  traffic / scene images for referring datasets, or run the image_referring_expression pipeline. Triggers include 'referring
  expression', 'region description', 'KITTI labels', 'spatial relationship annotation', 'auto-label image referring expression',
  'image_referring_expression'."
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit + at least one VLM endpoint (Gemini API key or OpenAI-compatible).
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
tags:
  - image
  - referring-expression
  - kitti
  - bounding-boxes
  - auto-label
  - vlm
allowed-tools: Read Bash Write
---

# Image Referring Expression Pipeline

Generate referring-expression and grounding annotations from images with KITTI-format bounding box labels. A single VLM (Gemini or any OpenAI-compatible endpoint) runs four steps: per-object region descriptions, holistic image captions, grouped grounding expressions tied to bboxes, and an optional double-check verification pass.

## Purpose

Transform `(image, KITTI labels)` pairs into a unified `annotations.jsonl` containing rich, grounded referring expressions. The VLM acts as a "teacher" annotator: Steps 0-1 see the image; Step 2 groups Step 0 outputs into grouping phrases with bbox lists; Step 3 (optional) re-examines those bboxes against the image and corrects mismatches.

## Pipeline Architecture

```
Step 0: Region expression  ──┐
                              ├──▶  Step 2: Grounding expression  ──▶  [Step 3: Double check]
Step 1: Image caption  ──────┘                                                   (optional)
```

- **Step 0 (region_expr)** — VLM emits one short discriminative phrase per KITTI bbox (`bbox_2d`, `type`, `color`, `description`).
- **Step 1 (image_caption)** — VLM emits a holistic, location-agnostic scene caption.
- **Step 2 (grounding_expr)** — VLM groups Step 0 objects into grouping phrases and returns one bbox list per group, optionally using Step 1's caption as extra context.
- **Step 3 (double_check)** — VLM re-checks each Step 2 bbox against the image; bad matches are removed, slightly-off boxes get tightened.

Steps 0 and 1 run in parallel within a single thread pool (they only depend on the seed records). Each step writes its own `step_<N>_*/annotations.jsonl` and skips already-processed images on re-run unless `workflow.force_reprocess: true`.

## Instructions

### Initial setup

When a user wants to run this pipeline, walk through these steps:

1. **Images**: Ask for `data.image_dir`, the directory containing `.jpg`, `.jpeg`, or `.png` images.
2. **KITTI labels**: Ask for `data.kitti_label_dir`, the directory containing one `.txt` label file per image. Each label line must use KITTI format: `<type> <truncated> <occluded> <alpha> <bbox_left> <bbox_top> <bbox_right> <bbox_bottom> ...`. Lines with fewer than 8 fields are silently skipped. Set this even for Step 1-only runs because Steps 0 and 2 require it.
3. **Resume from existing annotations**: If the user already has a unified `annotations.jsonl` from a previous run, set `data.input_annotations_jsonl` to that file instead of seeding from `data.image_dir` and `data.kitti_label_dir`.
4. **API access**: Ask the user which VLM endpoint they want to use. Present these five options and act on the choice:
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
5. **Workflow steps**: Choose one of:
   - Full pipeline: `["0", "1", "2", "3"]`
   - No caption generation: `["0", "2", "3"]`, where Step 2 falls back to image-only context
   - No verification: `["0", "1", "2"]`
   - Custom subset: any supported subset of steps
6. **Output format**: Choose one of:
   - `jsonl`: unified schema only
   - `legacy`: byte-compatible `.txt.stepN` files only
   - `both`: writes both formats and is the default for downstream tooling

### Running the pipeline

The pipeline runs inside the TAO Toolkit container via the `auto_label` CLI:

```bash
auto_label generate -e /path/to/spec.yaml \
    results_dir=/results \
    image_referring_expression.data.image_dir=/data/images \
    image_referring_expression.data.kitti_label_dir=/data/labels \
    image_referring_expression.vlm.gemini.api_key=$GOOGLE_API_KEY
```

Generate a default spec: `auto_label default_specs results_dir=/results module_name=auto_label`, then set `autolabel_type: "image_referring_expression"`. All fields support Hydra dot-notation overrides on the command line.

See [references/configuration.md](references/configuration.md) for the full YAML structure, all parameters, model/endpoint setup, and error patterns.

### Recommended pilot workflow

1. Run on 5-10 images with all four steps.
2. Inspect `step_0_region_expr/annotations.jsonl` — are object types, colors, and discriminating phrases accurate?
3. Inspect `step_2_grounding_expr/annotations.jsonl` — are objects grouped sensibly, and do bbox coordinates match the described groups?
4. Inspect `step_3_double_check/annotations.jsonl` — were mismatched bboxes removed or tightened? Are any new errors introduced (rare)?
5. If quality is insufficient, switch the VLM to a stronger model (e.g. `gemini-2.5-pro` or a larger Qwen3-VL endpoint), raise `media_resolution` / `max_output_tokens`, then re-run with `workflow.force_reprocess=true`.
6. Scale to the full dataset once satisfied.

## Configuration

Key configuration fields (full reference in [references/configuration.md](references/configuration.md)):

| Field | Default | Description |
|-------|---------|-------------|
| `workflow.steps` | `["0","1","2","3"]` | Which steps to execute (`0`=region_expr, `1`=image_caption, `2`=grounding_expr, `3`=double_check) |
| `workflow.max_workers` | `4` | Parallel threads per step (watch API rate limits) |
| `workflow.force_reprocess` | `false` | Ignore cached per-step outputs and reprocess from scratch |
| `workflow.output_format` | `"jsonl"` (set to `"both"` in the default spec) | `"jsonl"`, `"legacy"`, or `"both"` |
| `vlm.backend` | `"gemini"` | `"gemini"` or `"openai"` (OpenAI-compatible endpoint) |
| `data.image_dir` | required | Directory of input images (`.jpg` / `.jpeg` / `.png`) |
| `data.kitti_label_dir` | required (unless resuming) | Directory of KITTI-format `.txt` label files |
| `data.input_annotations_jsonl` | `""` | Optional pre-seeded `annotations.jsonl` (skips KITTI seeding) |

## Inputs

Two ways to seed the pipeline:

1. **Image directory + KITTI labels** (default). Set `data.image_dir` and `data.kitti_label_dir`. The orchestrator walks the image directory, reads the matching `<stem>.txt` KITTI file, parses bboxes (fields 0 + 4-7), reads each image's `width`/`height` via PIL, and writes a `seed_annotations.jsonl` to `results_dir/`.
2. **Pre-seeded annotations JSONL** (resume / pre-computed regions). Set `data.input_annotations_jsonl` to a file with one `{"image_id", "image_path", "width", "height", "kitti_bboxes": [...]}` object per line.

## Outputs

All outputs go to `results_dir/`:

- `seed_annotations.jsonl` — initial per-image records (unless `input_annotations_jsonl` was supplied).
- `step_0_region_expr/annotations.jsonl` — adds `regions[]` (each with `bbox`/`bbox_2d`, `type`, `color`, `description`).
- `step_1_image_caption/annotations.jsonl` — adds `caption` (string).
- `step_2_grounding_expr/annotations.jsonl` — adds `expressions[]` (each `{text, instances: [{bbox: [x1,y1,x2,y2]}]}`).
- `step_3_double_check/annotations.jsonl` — same shape as Step 2, with bboxes removed/updated.
- `results_dir/annotations.jsonl` — copy of the last completed step's output.
- When `workflow.output_format` is `"legacy"` or `"both"`, each step also writes byte-compatible `step_<N>_*/labels/<stem>.txt.stepN` files for the original 2d-data-engine tooling.

## Prerequisites

- **Container**: `nvcr.io/nvidia/tao/tao-toolkit:6.26.3-pyt`
- **API access**: At least one VLM endpoint (Gemini API key or OpenAI-compatible endpoint capable of image input)
- **PIL / Pillow**: Required to read image dimensions during seeding (already present in the TAO container)

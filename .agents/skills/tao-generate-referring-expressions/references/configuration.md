# Image Referring Expression — Full Configuration Reference

## Complete YAML Structure

Generate a default experiment spec with `auto_label default_specs results_dir=/results module_name=auto_label`, then set `autolabel_type: "image_referring_expression"`.

```yaml
results_dir: ???                        # Required — output directory
autolabel_type: "image_referring_expression"

image_referring_expression:
  # --- VLM (vision-language model, used for all four steps) ---
  vlm:
    backend: "gemini"                   # "gemini" or "openai"
    gemini:
      api_key: ""                       # Or set GOOGLE_API_KEY env var
      model: "gemini-3.1-flash-lite-preview"
      media_resolution: "MEDIA_RESOLUTION_HIGH"   # LOW / MEDIUM / HIGH
      temperature: 0.3
      max_output_tokens: 8192
      timeout: 120
    openai:                             # For OpenAI-compatible endpoints (NIM, vLLM, etc.)
      api_key: ""
      base_url: ""                      # e.g. "https://inference-api.nvidia.com/v1" — no /chat/completions
      model_name: ""                    # e.g. "Qwen/Qwen3-VL-235B-A22B-Instruct"
      temperature: 0.7
      max_tokens: 4096
      timeout: 60

  # --- Workflow ---
  workflow:
    steps: ["0", "1", "2", "3"]         # 0=region_expr, 1=image_caption, 2=grounding_expr, 3=double_check
    max_workers: 4                      # Parallel threads per step
    force_reprocess: false              # Ignore cached step outputs
    output_format: "both"               # "jsonl", "legacy", or "both"

  # --- Input data ---
  data:
    image_dir: ???                      # Directory of input images (.jpg / .jpeg / .png)
    kitti_label_dir: ???                # Directory of KITTI-format .txt label files
    input_annotations_jsonl: ""         # Optional: pre-seeded annotations.jsonl to resume from
```

## Key Configuration Decisions

| Decision | Config field | Guidance |
|----------|-------------|----------|
| Which steps to run | `workflow.steps` | Start with all (`["0","1","2","3"]`). Drop `"1"` to skip the holistic caption (Step 2 falls back to image-only context). Drop `"3"` for fast iteration without verification. Run `["0"]` first when tuning region-description prompts |
| Caption vs no caption | include / exclude `"1"` | When Step 1 is included, Step 2 receives the holistic caption as extra context. When omitted, Step 2 still runs using the image and Step 0 region descriptions alone |
| VLM provider | `vlm.backend` | `"gemini"` for Google Gemini models, `"openai"` for any OpenAI-compatible endpoint (NIM, vLLM, etc.) |
| Parallelism | `workflow.max_workers` | Higher = faster but watch API rate limits. Start with 4, drop to 1-2 if you hit 429s. Steps 0 and 1 also run in parallel with each other when both are enabled — this can double the API load on a single endpoint |
| Resume vs restart | `workflow.force_reprocess` | `false` reuses each step's existing `annotations.jsonl` (and `labels/` legacy files). Set `true` to regenerate everything |
| Resume from prior run | `data.input_annotations_jsonl` | Point at an existing unified `annotations.jsonl` to skip the KITTI seeding pass |
| Output format | `workflow.output_format` | `"jsonl"` for the unified schema only; `"legacy"` for byte-compatible 2d-data-engine `.txt.stepN` files only; `"both"` (recommended) emits both |
| Image resolution | `vlm.gemini.media_resolution` | Use `MEDIA_RESOLUTION_HIGH` for accurate bbox-to-object matching in Steps 0/2/3. Lower resolutions are cheaper but degrade localization |
| Output truncation | `vlm.gemini.max_output_tokens` / `vlm.openai.max_tokens` | Step 0 (one entry per object) and Step 2 (one line per group) can be long; raise this if you see parse failures |

## Model / Endpoint Configuration

### Gemini (default)

Set the API key via environment variable or config:
```bash
export GOOGLE_API_KEY=your_key_here
```
Or in the YAML: `image_referring_expression.vlm.gemini.api_key: "your_key"`.

Recommended model assignments:
- **For all steps**: `gemini-2.5-flash` (fast, good enough for most images) or `gemini-2.5-pro` (better at small / cluttered objects and at the Step 3 verification pass).

Temperature guidance:
- Region & grounding (Steps 0, 2, 3): 0.2-0.3 for stable, factual output.
- Caption (Step 1): 0.3-0.5 for slightly more natural phrasing.

### OpenAI-compatible endpoints

For NVIDIA Inference API, vLLM-served Qwen3-VL, NIM endpoints, etc.:
```yaml
image_referring_expression:
  vlm:
    backend: "openai"
    openai:
      base_url: "https://inference-api.nvidia.com/v1"   # no /chat/completions
      model_name: "gcp/google/gemini-3-flash-preview"
      api_key: "your_key"
      temperature: 0.3
      max_tokens: 8192
```

For self-hosted models, the pipeline accepts any endpoint that speaks the OpenAI chat-completions API. Two common ways to provision one:

1. **`skills/applications/tao-run-inference-service` skill** — workflow for standing up a TAO inference microservice locally. Should support Cosmos, Qwen, and Gemma. Check that skill's `references/service.yaml` `valid_network_arch_config_basenames` for the current model list.
2. **Bring-your-own deployment** — vLLM, NIM, or any other OpenAI-compatible server.
```yaml
image_referring_expression:
  vlm:
    backend: "openai"
    openai:
      base_url: "http://localhost:8000/v1"
      model_name: "Qwen/Qwen3-VL-8B-Instruct"   # must match vLLM --served-model-name
      api_key: "EMPTY"                      # vLLM ignores it but the SDK requires non-null
      temperature: 0.3
      max_tokens: 4096
      timeout: 300
```

## All Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `workflow.steps` | `["0","1","2","3"]` | Pipeline steps to execute (`0`=region_expr, `1`=image_caption, `2`=grounding_expr, `3`=double_check) |
| `workflow.max_workers` | `4` | Thread pool size for parallel API calls within each step |
| `workflow.force_reprocess` | `false` | Ignore cached step outputs and reprocess from scratch |
| `workflow.output_format` | `"jsonl"` (set to `"both"` in the default spec) | Output format: `"jsonl"`, `"legacy"`, or `"both"` |
| `vlm.backend` | `"gemini"` | VLM backend: `"gemini"` or `"openai"` |
| `vlm.gemini.api_key` | `""` | Gemini API key (or set `GOOGLE_API_KEY` env var) |
| `vlm.gemini.model` | `"gemini-3.1-flash-lite-preview"` | Gemini model name |
| `vlm.gemini.media_resolution` | `"MEDIA_RESOLUTION_HIGH"` | Image resolution sent to Gemini (LOW/MEDIUM/HIGH) |
| `vlm.gemini.temperature` | `0.3` | VLM sampling temperature |
| `vlm.gemini.max_output_tokens` | `8192` | Maximum tokens in Gemini response |
| `vlm.gemini.timeout` | `120` | Request timeout in seconds |
| `vlm.openai.api_key` | `""` | API key for OpenAI-compatible endpoint |
| `vlm.openai.base_url` | `""` | Base URL of the OpenAI-compatible endpoint (no `/chat/completions` suffix) |
| `vlm.openai.model_name` | `""` | Model name to send in the OpenAI request |
| `vlm.openai.temperature` | `0.7` | OpenAI-compatible sampling temperature |
| `vlm.openai.max_tokens` | `4096` | Maximum tokens in the OpenAI-compatible response |
| `vlm.openai.timeout` | `60` | Request timeout in seconds |
| `data.image_dir` | (required) | Directory of input images (`.jpg` / `.jpeg` / `.png`) |
| `data.kitti_label_dir` | (required unless resuming) | Directory of KITTI-format `.txt` label files (one per image, matched by stem) |
| `data.input_annotations_jsonl` | `""` | Optional unified `annotations.jsonl` to seed the pipeline; bypasses KITTI seeding |

## Input KITTI Label Schema

One line per object, space-separated, with at least 8 fields. Lines with fewer than 8 fields are silently skipped.

```
<type> <truncated> <occluded> <alpha> <bbox_left> <bbox_top> <bbox_right> <bbox_bottom> [<height> <width> <length> <x> <y> <z> <rotation_y> <score>]
```

- `<type>` (field 0) — string class name (`car`, `pedestrian`, `truck`, ...). Used by Step 0 prompts and Step 2 grouping.
- `<bbox_left> <bbox_top> <bbox_right> <bbox_bottom>` (fields 4-7) — pixel-space `[x1, y1, x2, y2]`.
- All remaining fields are accepted but ignored.

Bboxes are normalized to a `0-1000` coordinate scale before being sent to the VLM in Step 0 and Step 2, then converted back to pixel coordinates in the output records.

## Resume Schema (`data.input_annotations_jsonl`)

When supplied, each line must have at least:

```json
{
  "image_id": "stem-of-image-filename",
  "image_path": "/abs/or/relative/path/to/image.jpg",
  "width": 1920,
  "height": 1080,
  "kitti_bboxes": [[x1, y1, x2, y2, "type"], ...],
  "source": "image_referring_expression",
  "pipeline_steps": []
}
```

This is exactly the format produced by the default seeding pass (`results_dir/seed_annotations.jsonl`).

## Output Layout

```
results_dir/
├── seed_annotations.jsonl                     # initial per-image records (skipped if resuming)
├── annotations.jsonl                          # copy of the last completed step's output
├── step_0_region_expr/
│   ├── annotations.jsonl                      # adds regions[] to each record
│   └── labels/<stem>.txt.step0                # legacy 2d-data-engine format (when output_format != "jsonl")
├── step_1_image_caption/
│   ├── annotations.jsonl                      # adds caption to each record
│   └── labels/<stem>.txt.step1
├── step_2_grounding_expr/
│   ├── annotations.jsonl                      # adds expressions[] to each record
│   └── labels/<stem>.txt.step2
└── step_3_double_check/
    ├── annotations.jsonl                      # expressions[] with bboxes removed/updated
    └── labels/<stem>.txt.step3
```

Each output record carries:

- `image_id`, `image_path`, `width`, `height` — preserved from the seed.
- `kitti_bboxes` — original parsed KITTI rows (`[x1, y1, x2, y2, type]`).
- `regions[]` (after Step 0) — `{bbox: [x1,y1,x2,y2], bbox_2d: [..], type, color, description}` per object.
- `caption` (after Step 1) — holistic, location-agnostic scene caption.
- `expressions[]` (after Step 2 and updated by Step 3) — `{text, instances: [{bbox: [x1,y1,x2,y2]}, ...]}`.
- `pipeline_steps[]` — list of step names that have processed this record.
- `source` — set to `"image_referring_expression"`.

## Error Patterns

| Error | Cause | Fix |
|-------|-------|-----|
| `GOOGLE_API_KEY` not set | Gemini API key missing | `export GOOGLE_API_KEY=your_key` or set `image_referring_expression.vlm.gemini.api_key` in the YAML |
| 429 / rate limit errors | Too many parallel API calls (made worse when Steps 0+1 run in parallel against the same endpoint) | Reduce `workflow.max_workers`, or use different endpoints for Steps 0 and 1 |
| `image_referring_expression: no input records` | `data.image_dir` is empty / not a directory, and no `input_annotations_jsonl` was supplied | Confirm `data.image_dir` exists and contains `.jpg` / `.jpeg` / `.png` files |
| Step 0 produces empty `regions[]` for every image | KITTI label files missing or malformed (each line needs at least 8 space-separated fields) | Verify `data.kitti_label_dir` and that each `<stem>.txt` matches the image stem; check the first few label lines |
| `failed to build query: 'type'` warning in Step 2 | KITTI line missing the `type` field (field 0) | Fix the offending label file; lines with fewer than 8 fields are silently skipped |
| Truncated / unparseable VLM output (Step 0 or Step 2) | Response cut off before the end of the array / before all group lines were emitted | Raise `vlm.gemini.max_output_tokens` / `vlm.openai.max_tokens`; lower `temperature`; for very large images split into smaller batches |
| Step 2 grouping looks wrong even though Step 0 was good | VLM cannot localize at the requested resolution | Raise `media_resolution` to `MEDIA_RESOLUTION_HIGH`; consider a stronger model |
| Step 3 introduces new errors | Verification model is too aggressive | Disable Step 3 (drop `"3"` from `workflow.steps`) or switch to a stronger model |
| Re-runs skip everything | Each step's `annotations.jsonl` already exists | Set `image_referring_expression.workflow.force_reprocess=true` to regenerate |
| Legacy `.txt.stepN` files missing | `workflow.output_format` is `"jsonl"` | Set `workflow.output_format=both` (or `legacy`) |
| Unknown `autolabel_type` | YAML missing or wrong `autolabel_type` | Set `autolabel_type: "image_referring_expression"` at the top of the spec |

# Image Grounding — Full Configuration Reference

## Complete YAML Structure

Generate a default experiment spec with `auto_label default_specs results_dir=/results module_name=auto_label`, then set `autolabel_type: "image_grounding"`.

```yaml
results_dir: ???                        # Required — output directory
autolabel_type: "image_grounding"

image_grounding:
  # --- VLM (vision-language model, used for both steps) ---
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
      base_url: ""                      # e.g. "https://inference-api.nvidia.com/v1" — no /chat/completions suffix
      model_name: ""                    # e.g. "Qwen/Qwen3-VL-235B-A22B-Instruct"
      temperature: 0.7
      max_tokens: 4096
      timeout: 60

  # --- Workflow ---
  workflow:
    steps: ["0", "1"]                   # "0" = expression extraction, "1" = phrase grounding
    max_workers: 4                      # Parallel threads per step
    force_reprocess: false              # Ignore cached per-sample checkpoints

  # --- Input data ---
  data:
    input_jsonl: ???                    # Path to input JSONL (image_path + caption per line)
    image_root: ""                      # Optional prefix for relative image_path entries
```

## Key Configuration Decisions

| Decision | Config field | Guidance |
|----------|-------------|----------|
| Which steps to run | `workflow.steps` | Start with both (`["0","1"]`). Drop `"1"` to inspect extracted expressions before grounding; drop `"0"` to re-ground using existing step-0 output |
| VLM provider | `vlm.backend` | `"gemini"` for Google Gemini models, `"openai"` for any OpenAI-compatible endpoint (NIM, vLLM, etc.) |
| Parallelism | `workflow.max_workers` | Higher = faster but watch API rate limits. Start with 4, drop to 1-2 if you hit 429s |
| Resume vs restart | `workflow.force_reprocess` | `false` reuses per-sample checkpoints under `step_<N>_*/.ckpt/`. Set `true` to redo everything |
| Image path resolution | `data.image_root` | Leave empty if `image_path` entries are absolute. Otherwise set to the directory the relative paths are anchored to |
| Bounding box quality | `vlm.gemini.media_resolution` | Use `MEDIA_RESOLUTION_HIGH` for accurate pixel-space bboxes. Lower resolutions are cheaper but degrade localization |
| Output truncation | `vlm.gemini.max_output_tokens` / `vlm.openai.max_tokens` | If you see "could not parse response" warnings, raise this — Step 1 returns one bbox dict per expression and can be long |

## Model / Endpoint Configuration

### Gemini (default)

Set the API key via environment variable or config:
```bash
export GOOGLE_API_KEY=your_key_here
```
Or in the YAML: `image_grounding.vlm.gemini.api_key: "your_key"`.

Recommended model assignments:
- **For both steps**: `gemini-2.5-flash` (fast, good enough for most images) or `gemini-2.5-pro` (better localization on small/cluttered objects).

Temperature guidance:
- Expression extraction (Step 0): 0.2-0.3 for stable, factual phrases.
- Phrase grounding (Step 1): 0.2-0.3 — bbox prediction should be deterministic.

### OpenAI-compatible endpoints

For self-hosted models, the pipeline accepts any endpoint that speaks the OpenAI chat-completions API. Two common ways to provision one:

1. **`skills/applications/tao-run-inference-service` skill** — workflow for standing up a TAO inference microservice locally. Should support Cosmos, Qwen, and Gemma. Check that skill's `references/service.yaml` `valid_network_arch_config_basenames` for the current model list.
2. **Bring-your-own deployment** — vLLM, NIM, or any other OpenAI-compatible server.
```yaml
image_grounding:
  vlm:
    backend: "openai"
    openai:
      base_url: "http://your-endpoint:8000/v1"
      model_name: "Qwen/Qwen3-VL-235B-A22B-Instruct"
      api_key: "EMPTY"
      temperature: 0.3
      max_tokens: 8192
```

## All Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `workflow.steps` | `["0","1"]` | Pipeline steps to execute (`"0"` = expression extraction, `"1"` = phrase grounding) |
| `workflow.max_workers` | `4` | Thread pool size for parallel API calls |
| `workflow.force_reprocess` | `false` | Ignore per-sample checkpoints and reprocess from scratch |
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
| `data.input_jsonl` | (required) | Path to input JSONL with `image_path` + `caption` fields |
| `data.image_root` | `""` | Optional prefix used to resolve relative `image_path` entries |

## Input JSONL Schema

One JSON object per line. Required and optional fields:

| Field | Required | Description |
|-------|----------|-------------|
| `image_path` | yes | Absolute path or relative path resolved against `data.image_root` |
| `caption` | yes | Free-text caption used as the basis for expression extraction |
| `image_id` | no | Stable identifier; auto-derived from the filename when missing |
| `width`, `height` | no | Image dimensions in pixels; default to `1920×1080` for bbox clamping when missing |

Any additional fields are passed through unchanged to the output records.

## Output Layout

```
results_dir/
├── annotations.jsonl                          # copy of the last step's output
├── step_0_expression_extraction/
│   ├── annotations.jsonl                      # cleaned_caption + expressions[]
│   └── .ckpt/<sample_id>.json                 # per-sample resume checkpoints
└── step_1_grounding/
    ├── annotations.jsonl                      # expressions[].instances[] filled in
    └── .ckpt/<sample_id>.json
```

Each output record carries:

- `cleaned_caption` — the caption after Step 0 normalizes "we can see...", "there is...", etc.
- `expressions[]` — one entry per referring expression, with `text`, `expression_id`, `char_span: [start, end]`, `noun_chunk`, and `instances[]`.
- `expressions[].instances[]` — populated in Step 1 with `bbox: [x1, y1, x2, y2]` (pixel-space, clamped to image dims), `score` in `[0.0, 1.0]`, and `bbox_id`.
- `pipeline_steps[]` — list of step names that have processed this record.
- `source` — set to `"image_grounding"`.

## Error Patterns

| Error | Cause | Fix |
|-------|-------|-----|
| `GOOGLE_API_KEY` not set | Gemini API key missing | `export GOOGLE_API_KEY=your_key` or set `image_grounding.vlm.gemini.api_key` in the YAML |
| 429 / rate limit errors | Too many parallel API calls | Reduce `workflow.max_workers` (try `1` or `2`) |
| `Could not parse response for <id>` | VLM returned non-JSON or truncated output | Raise `vlm.gemini.max_output_tokens` / `vlm.openai.max_tokens`; lower `temperature`; for very long expression lists, split the input or use a stronger model |
| `Step 0: no input records at <path>` | `data.input_jsonl` is empty or unreachable | Verify the path; check the JSONL has at least one valid line |
| `Step 1: no step-0 output at <path>` | Re-ran with only `["1"]` but step 0 was never run | Run with `["0","1"]` first, or supply an existing `step_0_expression_extraction/annotations.jsonl` |
| Empty `instances[]` for every expression | Image not found at `image_path`, or VLM cannot localize | Confirm `data.image_root` resolves; test the image path manually; raise `media_resolution` to `MEDIA_RESOLUTION_HIGH` |
| Bboxes look correct but are clipped to `1920×1080` | `width`/`height` missing in input JSONL | Add the true `width` and `height` fields to each input record |
| Re-runs skip everything | Per-sample checkpoints exist under `.ckpt/` | Set `image_grounding.workflow.force_reprocess=true` to ignore them |
| Unknown `autolabel_type` | YAML missing or wrong `autolabel_type` | Set `autolabel_type: "image_grounding"` at the top of the spec |

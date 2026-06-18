# Video Reasoning Annotation — Full Configuration Reference

## Complete YAML Structure

Generate a default experiment spec with `auto_label default_specs results_dir=/results module_name=auto_label`, then set `autolabel_type: "video_reasoning_annotation"`.

```yaml
results_dir: ???                        # Required — output directory
autolabel_type: "video_reasoning_annotation"

video_reasoning_annotation:
  # --- VLM (vision-language model, for steps 0/1a/1b/1c) ---
  vlm:
    backend: "gemini"                   # "gemini" or "openai"
    gemini:
      api_key: ""                       # Or set GOOGLE_API_KEY env var
      model: "gemini-3.1-flash-lite-preview"
      media_resolution: "MEDIA_RESOLUTION_LOW"  # LOW / MEDIUM / HIGH
      temperature: 0.3
      max_output_tokens: 8192
      timeout: 120
    openai:                             # For OpenAI-compatible endpoints (e.g., Qwen via vLLM)
      base_url: ""
      model_name: ""
      api_key: ""
      temperature: 0.7
      max_tokens: 4096

  # --- LLM (text-only, for steps 1c/2/3) ---
  llm:
    backend: "gemini"
    gemini:
      api_key: ""                       # Or set GOOGLE_API_KEY env var
      model: "gemini-3.1-flash-lite-preview"
      temperature: 0.3
      max_output_tokens: 8192
      timeout: 120

  # --- Workflow ---
  workflow:
    steps: ["0", "1a", "1b", "1c", "2", "3", "4"]
    mode: "auto"                        # "auto" | "anomaly" | "normal"
    max_workers: 4                      # Parallel threads per step
    max_video_length_sec: 300           # Skip videos longer than this
    chunk_duration_options: [5, 10, 15, 20, 30]
    max_chunks: 10
    highlight_before_sec: 3.0           # Clip window for Step 1c
    highlight_after_sec: 3.0
    long_video_threshold_sec: 60
    long_video_sample_fps: 0.5
    long_video_max_frames: 60
    qa_types: ["mcq", "bcq", "open_qa", "causal_linkage", "temporal_localization", "temporal_event_desc", "scene_description", "event_summary"]

  # --- Input data ---
  data:
    video_root: ""                      # Directory (walked recursively for .mp4/.avi/.mov/.mkv)
    input_jsonl_files: []               # JSONL files with {"video_path": "..."} per line
    filter_field: null                  # Boolean field to filter JSONL entries

  license: ""                           # Optional: written to metadata.license in step 4 outputs (e.g. "CC-BY-4.0")
  description_extra: ""                 # Optional: extra text appended to per-task descriptions in step 4 metadata
  prompts_module: ""                    # Dotted import path to custom prompts module
```

## Key Configuration Decisions

| Decision | Config field | Guidance |
|----------|-------------|----------|
| Which steps to run | `workflow.steps` | Start with all (`["0","1a","1b","1c","2","3","4"]`). Drop `"0"` for curated datasets, `"1c"` for normal-only videos |
| Anomaly vs normal | `workflow.mode` | `"auto"` lets Step 0 classify each video. Use `"anomaly"` or `"normal"` when the dataset is pre-split |
| VLM provider | `vlm.backend` | `"gemini"` for Google Gemini models, `"openai"` for any OpenAI-compatible endpoint (vLLM, NIM, etc.) |
| LLM provider | `llm.backend` | Same as VLM. Steps 2-3 are text-only — a lighter/cheaper model is often sufficient |
| Parallelism | `workflow.max_workers` | Higher = faster but watch API rate limits. Start with 4, increase if no throttling |
| Video length limit | `workflow.max_video_length_sec` | Videos exceeding this are skipped. Default 300s (5 min) |
| Custom prompts | `prompts_module` | Leave empty for general-purpose defaults. Set to a module path for domain-specific prompts |
| Output metadata | `license`, `description_extra` | Step 4 emits one `<task>.json` per task type in the `tao-vl-reason-v1.0` envelope. `license` populates `metadata.license`; `description_extra` is appended to the per-task description string. `media_root` mirrors `data.video_root` automatically |

## Model / Endpoint Configuration

### Gemini (default)

Set the API key via environment variable or config:
```bash
export GOOGLE_API_KEY=your_key_here
```
Or in the YAML: `video_reasoning_annotation.vlm.gemini.api_key: "your_key"`.

Recommended model assignments:
- **VLM (Steps 0/1)**: `gemini-3.1-flash` or `gemini-3.1-pro` — needs video understanding
- **LLM (Steps 2/3)**: `gemini-3.1-flash` (Gemini backend) or `gemma-4-31b` served via a local deployment — text-only, cheaper/self-hosted model works. For self-hosting, see the `skills/applications/tao-run-inference-service` skill (should support Cosmos, Qwen, and Gemma) or any vLLM/NIM endpoint you bring yourself.

Temperature guidance:
- Captioning (Steps 0/1): 0.2-0.3 for factual accuracy
- QA generation (Step 3): 0.3-0.5 for some diversity in question phrasing

### OpenAI-compatible endpoints

For self-hosted models, the pipeline accepts any endpoint that speaks the OpenAI chat-completions API. Two common ways to provision one:

1. **`skills/applications/tao-run-inference-service` skill** — workflow for standing up a TAO inference microservice locally. Should support Cosmos, Qwen, and Gemma. Check that skill's `references/service.yaml` `valid_network_arch_config_basenames` for the current model list.
2. **Bring-your-own deployment** — vLLM, NIM, or any other OpenAI-compatible server.

Either way, the YAML wiring is the same:

```yaml
video_reasoning_annotation:
  vlm:
    backend: "openai"
    openai:
      base_url: "http://your-endpoint:8000/v1"
      model_name: "Qwen/Qwen3-VL-235B-A22B-Instruct"
      api_key: "your_key"
      temperature: 0.3
      max_tokens: 4096
```

## All Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `workflow.steps` | `["0","1a","1b","1c","2","3","4"]` | Which pipeline steps to execute |
| `workflow.mode` | `"auto"` | Video classification mode: auto, anomaly, or normal |
| `workflow.max_workers` | `4` | Thread pool size for parallel API calls |
| `workflow.max_video_length_sec` | `300` | Skip videos longer than this (seconds) |
| `workflow.chunk_duration_options` | `[5,10,15,20,30]` | Candidate chunk durations (auto-selected per video) |
| `workflow.max_chunks` | `10` | Maximum chunks per video |
| `workflow.highlight_before_sec` | `3.0` | Seconds before anomaly moment for highlight clip |
| `workflow.highlight_after_sec` | `3.0` | Seconds after anomaly moment for highlight clip |
| `workflow.qa_types` | `["mcq","bcq","open_qa","causal_linkage","temporal_localization","temporal_event_desc","scene_description","event_summary"]` | QA formats to generate. Each maps to a prompt key in `prompts.py` (anomaly + normal variants for most types; `scene_description` and `event_summary` are mode-agnostic) |
| `vlm.gemini.media_resolution` | `MEDIA_RESOLUTION_LOW` | Video resolution sent to Gemini (LOW/MEDIUM/HIGH) |
| `vlm.gemini.temperature` | `0.3` | VLM sampling temperature |
| `llm.gemini.temperature` | `0.3` | LLM sampling temperature |
| `license` | `""` | Written to `metadata.license` in step 4 outputs (e.g. `"CC-BY-4.0"`) |
| `description_extra` | `""` | Extra text appended to per-task descriptions in step 4 metadata |
| `prompts_module` | `""` | Custom prompts module (dotted import path) |

## Error Patterns

| Error | Cause | Fix |
|-------|-------|-----|
| `GOOGLE_API_KEY` not set | Gemini API key missing | `export GOOGLE_API_KEY=your_key` or set in config YAML |
| 429 / rate limit errors | Too many parallel API calls | Reduce `workflow.max_workers` |
| Video skipped (too long) | Video exceeds `max_video_length_sec` | Increase the limit or trim videos |
| Empty captions | VLM failed to process video | Check video format, try higher `media_resolution`, increase `timeout` |
| Step 1c skipped for all videos | All videos classified as "normal" | Expected when `mode=normal`. For mixed datasets, use `mode=auto` |
| Import error for `prompts_module` | Custom module path incorrect | Verify the dotted path resolves; module must be on `PYTHONPATH` |
| ffprobe not found | Missing ffmpeg/ffprobe | Install: `apt install ffmpeg` (required for chunk captioning) |
| Step N reads empty input | Previous step produced no output | Check previous step's output JSONL; likely all videos were filtered out or failed |

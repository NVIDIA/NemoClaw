---
name: tao-generate-video-reasoning-annotations
description: >-
  Multi-step video annotation pipeline that turns raw videos into
  Chain-of-Thought training data — multi-level captions, structured
  descriptions, and QA pairs (MCQ, binary, open-ended) with reasoning
  traces, via VLM/LLM distillation. Use when the user wants to "create
  video training data", "generate video QA datasets", "build CoT
  reasoning traces from videos", "auto-label videos", or run the
  video_reasoning_annotation pipeline. Triggers include "video
  annotation", "video CoT", "video QA", "chain-of-thought",
  "video captioning pipeline", "video distillation".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit + at least one VLM endpoint (Gemini API key or OpenAI-compatible).
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash Write
tags:
  - video
  - annotation
  - chain-of-thought
  - captioning
  - qa-generation
  - vlm
  - llm
  - auto-label
---

# Video Reasoning Annotation Pipeline

Generate Chain-of-Thought training datasets from videos by producing multi-level captions, structured descriptions, and QA pairs (MCQ, binary, open-ended) with step-by-step reasoning traces. Domain-agnostic by default — customize prompts for any video domain.

## Purpose

Transform raw videos into CoT Q&A training data for video understanding models. VLMs (e.g., Gemini, Qwen) act as "teacher" annotators: Steps 0–1 require the model to see the video (VLM calls); Steps 2–3 are text-to-text (cheaper LLM calls).

## Pipeline architecture

```
Step 0:  [Optional] Filter & classify videos  → Keep domain-relevant, classify anomaly vs normal
Step 1a: Global + dense captions               → VLM: narrative summary + timestamped events
Step 1b: Chunk captions                         → VLM: fixed-duration segment micro-captions
Step 1c: [Optional, anomaly only] Highlight     → LLM extracts anomaly timestamp, VLM captions clip
Step 2:  Description synthesis                  → LLM: synthesize captions into structured narrative
Step 3:  QA generation                          → LLM: MCQ, binary, open-ended with reasoning
Step 4:  Parse outputs                          → Per-task `tao-vl-reason-v1.0` JSON files
```

Steps are individually selectable via `workflow.steps`. The pipeline has built-in resume — each step skips already-processed videos, so re-running after a prompt tweak is safe.

## Initial consultation

When the user invokes this skill, walk through these questions in order. Don't skip — getting domain and VLM access right up front prevents wasted runs.

### 1. Videos

- Path to the video directory and/or a JSONL with `{"video_path": "..."}` per line.
- Confirm format (`.mp4` preferred; `.avi`, `.mov`, `.mkv` also walked).

### 2. Domain — drives prompt selection

Ask the user: *"What domain are these videos from?"* Choose one of the following branches:

| Domain | What to do |
|---|---|
| **general** | Use the default prompts. Set `prompts_module: ""` (or omit). The built-in `nvidia_tao_ds.auto_label.video_reasoning_annotation.prompts` covers domain-agnostic content. |
| **traffic** (CCTV intersections, highways; dashcam excluded) | Use the reference module. Set `prompts_module: "nvidia_tao_ds.auto_label.video_reasoning_annotation.prompts_traffic"`, **or** copy `references/prompts_traffic.py` into the user's project and tune for their specific camera angles, then point `prompts_module` at the copy. |
| **warehouse** (industrial site CCTV — safety, operations, security) | Same pattern. Set `prompts_module: "nvidia_tao_ds.auto_label.video_reasoning_annotation.prompts_warehouse"`, or copy `references/prompts_warehouse.py` and tune. |
| **custom** (any other domain) | **Run the workshop in [references/domain_adaptation.md](references/domain_adaptation.md)**. It walks through: Phase 1 — question types the user wants the model to answer; Phase 2 — caption-requirements checklist; Phase 3 — fill the `[PLACEHOLDER]` markers in `nvidia_tao_ds.auto_label.video_reasoning_annotation.prompt_template`. The two reference modules above are working examples to model after. Do this **before** any pipeline runs. |

### 3. Anomaly / normal / mixed

- Mixed dataset → `workflow.mode: "auto"` (Step 0 classifies each video).
- Pre-split anomaly only → `workflow.mode: "anomaly"`, drop Step 0.
- Pre-split normal only → `workflow.mode: "normal"`, drop Steps 0 and 1c.

### 4. VLM / LLM endpoint — confirm access **before** running

- **Gemini** (default for both `vlm.backend` and `llm.backend`): user needs `GOOGLE_API_KEY` set, or to put the key in the YAML.
- **OpenAI-compatible** (Qwen via vLLM, NIM endpoint, etc.): user provides `base_url`, `model_name`, and `api_key`.
- Steps 2–3 are text-only — a smaller/cheaper LLM is fine for `llm.backend` even when `vlm.backend` is a frontier video model.

If the user has **no endpoint at all** and wants to self-host, point them at the `skills/applications/tao-run-inference-service` skill — a workflow that stands up a network-specific TAO inference microservice locally and exposes an OpenAI-compatible endpoint. Should support Cosmos, Qwen, and Gemma. Check `skills/applications/tao-run-inference-service/references/service.yaml` for the current `valid_network_arch_config_basenames` list before relying on a specific model.

If the user doesn't have endpoint access ready and isn't ready to set one up, stop here and help them figure it out first.

### 5. Pilot vs full run

- **Recommend a 5–10 video pilot** when domain is `custom`, when any prompt was edited, or when this is the user's first run.
- **Full-run is fine** for `general` / `traffic` / `warehouse` once the user has previously verified output quality on the same data type.
- The pipeline has built-in resume, so a pilot followed by a full run does not re-process the pilot videos.

## Quick start

The pipeline runs inside the TAO Toolkit container via the `auto_label` CLI:

```bash
auto_label generate -e /path/to/spec.yaml \
    results_dir=/results \
    video_reasoning_annotation.data.video_root=/videos \
    video_reasoning_annotation.vlm.gemini.api_key=$GOOGLE_API_KEY \
    video_reasoning_annotation.workflow.mode=auto
```

Generate a default spec to start from:

```bash
auto_label default_specs results_dir=/results module_name=auto_label
# then set:  autolabel_type: "video_reasoning_annotation"
```

All fields support Hydra dot-notation overrides on the command line. For the full YAML reference (every field, model/endpoint setup, error patterns), see [references/configuration.md](references/configuration.md).

## Pilot workflow

Use this when running a 5–10 video pilot:

1. Run the pipeline on the pilot subset with the chosen `prompts_module` and `workflow.mode`.
2. Inspect `results_dir/step_1a_caption/captions.jsonl` — captions accurate, capturing the right level of detail?
3. Inspect `results_dir/step_3_qa/qa_output.jsonl` — questions meaningful, answers correct, reasoning logical?
4. If quality is insufficient: adjust the prompts (in `prompts_module` if domain-customized, or fall back to `general` if a domain module is over-tuned), and re-run. The pipeline auto-skips already-processed videos.
5. Once satisfied, scale to the full dataset by pointing `data.video_root` (or `data.input_jsonl_files`) at the full set and re-running with the same `results_dir` (resume) or a fresh one (full re-run).

Quality compounds downstream — bad captions produce bad descriptions which produce bad QA. Focus iteration on Step 1a/1b output first; descriptions and QA usually improve once captions are right.

## Configuration summary

Key fields (full reference in [references/configuration.md](references/configuration.md)):

| Field | Default | Description |
|---|---|---|
| `workflow.steps` | `["0","1a","1b","1c","2","3","4"]` | Which pipeline steps to execute |
| `workflow.mode` | `"auto"` | `"auto"`, `"anomaly"`, or `"normal"` |
| `vlm.backend` | `"gemini"` | `"gemini"` or `"openai"` (OpenAI-compatible) |
| `llm.backend` | `"gemini"` | Same options; text-only, cheaper model works |
| `workflow.max_workers` | `4` | Parallel threads per step (watch API rate limits) |
| `license` | `""` | Optional: written to `metadata.license` in step 4 outputs (e.g. `"CC-BY-4.0"`) |
| `description_extra` | `""` | Optional: extra text appended to per-task descriptions in step 4 metadata |
| `prompts_module` | `""` | Dotted import path to custom prompts module |

## Prompts

- **Built-in (general)**: `nvidia_tao_ds.auto_label.video_reasoning_annotation.prompts` — domain-agnostic, used by default.
- **Template**: `nvidia_tao_ds.auto_label.video_reasoning_annotation.prompt_template` — same 26 keys with `[PLACEHOLDER]` markers for domain customization.
- **Reference modules** (working examples for the consultation's `traffic` / `warehouse` branches): [references/prompts_traffic.py](references/prompts_traffic.py), [references/prompts_warehouse.py](references/prompts_warehouse.py).
- **Custom domains**: see [references/domain_adaptation.md](references/domain_adaptation.md) for the full workshop and placeholder reference.

## Inputs

- **`video_root`**: Directory of videos (walked recursively for `.mp4`, `.avi`, `.mov`, `.mkv`).
- **`input_jsonl_files`**: List of JSONL files with `{"video_path": "..."}` per line. The `video` key is also accepted; extra fields are allowed.
- **`filter_field`**: Optional boolean field to filter JSONL entries.

Provide `video_root`, `input_jsonl_files`, or both (lists merge).

## Outputs

All outputs go to `results_dir/` with per-step subdirectories (`step_0_filter/`, `step_1a_caption/`, …, `step_4_output/`):

- **Steps 0–3**: JSONL — one JSON object per video per line.
- **Step 4**: One `<task>.json` per non-empty task type, in the **`tao-vl-reason-v1.0`** envelope. Up to 10 files: `mcq.json`, `mcq_openended.json`, `bcq.json`, `bcq_openended.json`, `open_qa.json`, `causal_linkage.json`, `temporal_localization.json`, `temporal_description.json`, `scene_description.json`, `video_summarization.json`.

Each step 4 file looks like:

```json
{
  "format": "tao-vl-reason-v1.0",
  "metadata": {"type": "annotation", "task": "<task>", "date": "YYYY-MM-DD",
               "description": "<per-task + description_extra>", "license": "<from config>"},
  "media_root": "<data.video_root>" | null,
  "items": [{"video_id": "...", "question": "...", "answer": "...", "reasoning": "..."}, ...]
}
```

`media_root` mirrors `data.video_root` (or `null` when unset); each item's `video_id` is the entry's video path with the `video_root` prefix stripped. Set `license` and `description_extra` in the spec to populate the metadata.

## Prerequisites

- **Container**: `tao_toolkit.pyt` (resolves to `nvcr.io/nvidia/tao/tao-toolkit:6.26.3-pyt` via `versions.yaml`).
- **ffmpeg / ffprobe**: required for chunk captioning (Step 1b) and highlight extraction (Step 1c).
- **VLM endpoint**: at least one — Gemini API key or OpenAI-compatible endpoint.

---
name: tao-analyze-gaps-vlm-bcq
description: Extract false-positive and false-negative gaps from VLM binary-classification-question (BCQ, yes/no) predictions.
  Use after running VLM evaluation when you have a predictions JSON and need to identify failure cases for DEFT root cause
  analysis on a binary-classification VLM workflow.
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash
tags:
- gap-analysis
- rcca
- vlm
- evaluation
- false-positive
- false-negative
---

# VLM Binary Classification Gap Analysis

Reads a VLM predictions JSON, compares each model response against ground truth, and writes FP/FN failure cases to a JSONL file with a summary report.

## Purpose

After running a VLM on a binary yes/no evaluation task, the predictions need to be compared against ground truth to identify failure cases. This skill produces a structured list of FP (false positive) and FN (false negative) samples that downstream RCCA stages (e.g., cosmos generation, root cause analysis) consume to drive a DEFT iteration.

## Usage

Invoke the `vlm_bcq` action inside the TAO Toolkit data services container with Hydra-style key=value overrides:

```bash
gap_analysis vlm_bcq \
  predictions_json=/path/to/results.json \
  results_dir=/path/to/output/gaps
```

Include `videos_dir` when `video_id` values in the predictions are relative paths:

```bash
gap_analysis vlm_bcq \
  predictions_json=/path/to/results.json \
  results_dir=/path/to/output/gaps \
  videos_dir=/path/to/videos/root
```

After the run, surface the FP/FN counts from `kpi_gaps_report.txt` and point downstream stages at `kpi_gaps.jsonl`.

## Inputs

- **predictions_json**: Path to predictions JSON file. Must be a JSON array where each item has `video_id`, `response`, and `gt` fields. `response` and `gt` are parsed with word-boundary matching — `'yes'` or `'no'` anywhere in the string is recognized. Samples where both or neither are present are skipped with a warning.
- **videos_dir** (optional): Base directory for resolving relative `video_id` paths. If omitted, `video_id` values are used as absolute paths.

**Predictions JSON format:**
```json
[
  {
    "video_id": "/path/to/video.mp4",
    "response": "Yes, there is a collision.",
    "gt": "B. No",
    "question": "Is there a collision?"
  }
]
```

## Outputs

- **kpi_gaps.jsonl**: One JSON object per line for each FP/FN case. Fields: `video_id` (absolute path), `error_type` (`FP` or `FN`), `question`, `ground_truth`, `response`.
- **kpi_gaps_report.txt**: Human-readable table with total FP/FN counts.

If no gaps are found, no files are written and a message is logged.

## Key Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| predictions_json | Yes | Path to predictions JSON file |
| results_dir | Yes | Output directory; created if it does not exist |
| videos_dir | No | Base directory for resolving relative `video_id` paths |

## Error Patterns

| Error | Cause | Fix |
|-------|-------|-----|
| `FileNotFoundError` | `predictions_json` does not exist | Check the path |
| `ValueError: must be a JSON array` | Predictions file is not a list | Wrap predictions in `[...]` |
| `ValueError: missing 'gt'/'response'/'video_id'` | A prediction item is missing a required field | Inspect and fix the predictions JSON |
| Samples silently skipped | `response` or `gt` contains both or neither 'yes'/'no' | Check logs for warnings; inspect those samples |

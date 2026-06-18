<!--
Copyright (c) 2026, NVIDIA CORPORATION.  All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# PROGRESS.md Tracking Reference

The skill maintains `PROGRESS.md` in `output_dir/` throughout the run. It is the living journal
of what was done, what was attempted, and what broke — visible to the user in real time.

**Why:** if the pipeline halts (OOM, network, container crash), the user can read PROGRESS.md
and understand exactly where we stopped and what to fix. No more "it silently failed three hours
ago."

---

## When to update PROGRESS.md

- **At Phase 0**: initialize the file
- **At the start of each phase**: append a header with phase name and timestamp
- **After each step**: append a one-line entry with status (`✅ done` / `⚠️ warning` / `❌ failed`)
- **When a bug is hit and fixed**: log the symptom, root cause, and fix — future readers of
  PROGRESS.md should see the thinking, not just the outcome
- **When a test fails**: log which test, the failure mode, and the fix
- **At Phase 10**: append a summary line

Think of it as a commit-log for the pipeline run.

---

## PROGRESS.md Template

The skill writes this at the start of Phase 0:

```markdown
# Generation & Validation Progress

**Project:** hft-{{SHORT_NAME}}
**Model:** {{MODEL_ID}}
**Dataset:** {{DATASET}}
**Started:** {{TIMESTAMP}}

| Milestone | Wall time | Notes |
|-----------|-----------|-------|
| Pipeline start | 0:00 | |
| Stage 1 complete (Discover) | — | |
| Stage 2 complete (Data) | — | |
| Stage 3 complete (Script) | — | |
| Stage 4 complete (Train) | — | training only |
| Stage 5 complete (Deliver) | — | |
| **Total** | **—** | generation + training |

This file is the running log of the tao-finetune-huggingface-model skill's work on this project.
Every phase appends a section. Bugs hit during generation are logged here — future readers
will see the debugging trail, not just the final scripts.

---

## Phase 0 — Model Discovery & Validation

- {{TIMESTAMP}} ✅ Inspected {{MODEL_ID}} — `model_type=vit`, task=`image-classification`
- {{TIMESTAMP}} ✅ AutoModel class = `AutoModelForImageClassification`
- {{TIMESTAMP}} ✅ `transformers_version = 4.13.0.dev0`, in CONFIG_MAPPING
- {{TIMESTAMP}} ✅ Wrote `meta/phase0_model_info.yaml`

## Phase 1 — Hardware & Prerequisites Audit

- {{TIMESTAMP}} ✅ Docker daemon running (v28.0.4)
- {{TIMESTAMP}} ✅ NVIDIA Container Toolkit verified
- {{TIMESTAMP}} ✅ 635 GB disk free (≥ 40 GB required)
- {{TIMESTAMP}} ✅ HF_TOKEN valid for {{MODEL_ID}}
- {{TIMESTAMP}} ✅ GPU: A100-SXM4-80GB, driver 560.35.05, 1 GPU, 80 GB VRAM
- {{TIMESTAMP}} ✅ NGC image selected: `nvcr.io/nvidia/pytorch:24.09-py3` (CUDA 12.6, PyTorch 2.5.0)
- {{TIMESTAMP}} ✅ Wrote `meta/phase1_hardware.yaml`

## Phase 2 — Container Setup

- {{TIMESTAMP}} ✅ Pulled NGC image (21 GB)
- {{TIMESTAMP}} ✅ CUDA available inside container, 1 GPU detected

## Phase 3 — Dataset Preparation

- {{TIMESTAMP}} ✅ Source detected: `hf` (dataset_id = `AI-Lab-Makerere/beans`)
- {{TIMESTAMP}} ✅ HF_TOKEN verified for dataset access
- {{TIMESTAMP}} ✅ Schema check: columns = `[image, labels]`
- {{TIMESTAMP}} ✅ Downloaded 1000 train + 133 eval samples → Arrow cache

## Phase 4 — Project Scaffold & Script Generation

- {{TIMESTAMP}} ✅ Generated: train.py, model.py, dataset.py, run_eval.py, inference.py,
                              prepare_data.py, report.py
- {{TIMESTAMP}} ✅ Generated: Dockerfile, setup.py, requirements.txt
- {{TIMESTAMP}} ✅ Generated: README.md, scripts/run.sh, .env.example, .gitignore
- {{TIMESTAMP}} ✅ Syntax check passed — all modules import cleanly
- {{TIMESTAMP}} ✅ Moved phase YAMLs into meta/

## Phase 4.5 — Unit Tests (with fake data)

- {{TIMESTAMP}} ✅ Generated tests/conftest.py, test_dataset.py, test_collator.py, test_model.py, test_smoke.py
- {{TIMESTAMP}} ✅ `pytest tests/` — 12 passed, 0 failed
- {{TIMESTAMP}} ✅ Smoke training (1 step, 2 fake samples) completed without error

## Phase 5 — Wheel Packaging

- {{TIMESTAMP}} ✅ Built wheel: `dist/hft-vit-base-beans-0.1.0-py3-none-any.whl` (10 KB)
- {{TIMESTAMP}} ✅ `hft-train --help` works after install

## Phase 6 — Training

- {{TIMESTAMP}} ✅ Zero-shot baseline: accuracy = 0.000 (expected — ImageNet vs beans labels)
- {{TIMESTAMP}} ✅ Training started (3 epochs, 96 steps)
- {{TIMESTAMP}} ⚠️ HF Hub Xet download hung — fixed by setting `HF_HUB_DISABLE_XET=1`
- {{TIMESTAMP}} ✅ Training completed in 11.5s
- {{TIMESTAMP}} ✅ Final loss: 1.013, eval accuracy: 0.571

## Phase 8 — Evaluation

- {{TIMESTAMP}} ✅ Post-training eval: accuracy = 0.564, top-5 = 1.000

## Phase 9 — Inference Test

- {{TIMESTAMP}} ✅ 5 samples processed; predictions visually reasonable

## Phase 10 — Report Generation

- {{TIMESTAMP}} ✅ Generated: report.pdf, report.html, 6 charts
- {{TIMESTAMP}} ✅ Updated README.md "Results" section

---

## Summary

- **Status:** ✅ complete
- **Generation time:** {{GENERATION_DURATION}} (Phases 0–5: model check → script → smoke test)
- **Training time:** {{TRAINING_DURATION}} (Phase 6 container runtime)
- **Total wall time:** {{TOTAL_DURATION}}
- **Zero-shot baseline → fine-tuned:** 0.000 → 0.564 (+56.4%)
- **Assets delivered:** wheel, Dockerfile, checkpoints/final, reports/report.pdf, inference samples
```

---

## Entry format conventions

**Single-line entries** (90% of cases):
```
- 2026-04-17 14:32:01 ✅ <what happened>
- 2026-04-17 14:32:18 ⚠️ <warning — training continued>
- 2026-04-17 14:32:59 ❌ <failure — stopped>
```

**Bug entries** (when something broke and you fixed it): use a sub-block:
```
- 2026-04-17 14:35:12 ❌ VLM training crashed at step 4
  - Symptom: `AttributeError: 'list' object has no attribute 'shape'` in Idefics3.get_image_features
  - Root cause: `collate_vlm` falls back to a Python list for `pixel_values` when `torch.stack` fails
                 because Idefics3 produces variable `num_images` per sample for high-res images
  - Fix: rewrote collator to use `processor(text=list, images=list, padding=True)` at batch time,
         letting the processor handle image padding via `pixel_attention_mask`
  - Test added: `tests/test_collator.py::test_variable_num_images` — catches this regression
- 2026-04-17 14:37:30 ✅ VLM training resumed, reached step 4 without error
```

The bug sub-block documents the detective work so a reader (you in a week, the user, a different
agent) understands *why* the fix is what it is.

---

## Minimal helper for updating PROGRESS.md

Add this tiny helper so the skill can append entries without boilerplate:

```python
from datetime import datetime
from pathlib import Path
import time

_PIPELINE_START = time.monotonic()

def log_progress(msg: str, status: str = "✅", project_root: str = "."):
    """Append a dated line with elapsed wall time to PROGRESS.md."""
    elapsed = time.monotonic() - _PIPELINE_START
    h, m, s = int(elapsed // 3600), int((elapsed % 3600) // 60), int(elapsed % 60)
    wall = f"{h}:{m:02d}:{s:02d}"
    line = f"- {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} [{wall}] {status} {msg}\n"
    Path(project_root, "PROGRESS.md").open("a").write(line)

def log_milestone(name: str, project_root: str = "."):
    """Update the timing table for a named milestone."""
    elapsed = time.monotonic() - _PIPELINE_START
    h, m, s = int(elapsed // 3600), int((elapsed % 3600) // 60), int(elapsed % 60)
    wall = f"{h}:{m:02d}:{s:02d}"
    p = Path(project_root, "PROGRESS.md")
    text = p.read_text()
    text = text.replace(f"| {name} | — |", f"| {name} | {wall} |", 1)
    p.write_text(text)

# Usage:
log_progress("Training started — 3 epochs, 96 steps")          # → [0:02:14] ✅ Training started...
log_progress("HF Hub Xet hang — set HF_HUB_DISABLE_XET=1", status="⚠️")
log_milestone("Stage 4 complete (Train)")                       # fills timing table
```

The skill itself (not the generated scripts) is responsible for writing PROGRESS.md during
generation. Generated scripts can optionally append runtime events (training started, checkpoint
saved, etc.) so the log stays continuous across skill → wheel → training → report.

---

## Minimum content per phase

| Phase | Required entries |
|-------|------------------|
| 0 | model detected, task type, auto_model class |
| 1 | Docker, nvidia-container, disk, HF token, GPU, NGC image |
| 2 | container pulled, CUDA verified |
| 3 | dataset source, schema check, final count |
| 4 | scripts generated, syntax check, README written |
| 4.5 | tests generated, test results (all pass required) |
| 5 | wheel built, `hft-train --help` works |
| 6 | baseline eval (if not skipped), training complete, final loss |
| 7 | LoRA merge (VLM), or "skipped (CV)" |
| 8 | eval metrics |
| 9 | inference samples |
| 10 | report generated, summary line |

Missing entries mean "phase didn't happen" — useful as a read-only audit trail.

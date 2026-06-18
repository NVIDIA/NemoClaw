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

# Reference Index — fallback safety net

References are consulted **only** when live research is silent, ambiguous, or
unavailable. Live docs always win for the specific model and current API.

---

## Always-on (consulted in the workflow)

| File | Step | Role |
|---|---|---|
| `core-rules.md` | all | Non-negotiable agent behaviours — full enumeration of the rules summarised in SKILL.md, plus the order-of-authority + conflict-resolution rules |
| `execution-platform.md` | all | Default-platform routing, alternate backends, GPU/credentials preflight, `docker run` conventions |
| `error-playbook.md` | 4, 5 | Runtime-error symptom → minimal-fix table (consulted on every failure) |
| `compat-workarounds.md` | 1 | Known-issue registry; auto-applied via `detect` rules |
| `step1-probes.md` | 1 | Containerized model/dataset probe scripts + Docker prereq + accept/reject + compat walk + config skeleton + cleanup |
| `model-discovery.md` | 1 | `model_type` → AutoModel/processor mapping (when card silent) |
| `dataset-recommendations.md` | 1 | Vetted datasets for `source = recommend` |
| `dataset-sources.md` | 1 | Local format detectors + COCO/VOC/imagefolder/jsonl loaders |
| `dataset-patterns.md` | 4 | Universal `prepare_data.py` skeleton |
| `hardware-audit-ngc.md` | 2 | Step 2a audit script + live NGC image-selection rules + compat re-eval + model-fit |
| `hardware-container.md` | 2 | NGC selection (offline fallback), GPU/disk audit, multi-GPU |
| `project-scaffold.md` | 4 | Generated file table + Python copyright header + Dockerfile template + preflight format |
| `research-priorities.md` | 3 | 6-priority live-fetch ladder + extract/record + conflict rules |
| `cv-scripts.md` | 4 | CV scaffold (file names, CLI, config schema). **Don't copy `[FETCH LIVE]` blocks** |
| `vlm-scripts.md` | 4 | VLM/LLM scaffold (TRL/PEFT). **Don't copy `[FETCH LIVE]` blocks** |
| `docker-runs.md` | 4, 5 | Canonical `docker run` invocations for every command |
| `hub-push.md` | 6 | HF Hub push Python block + model card template |
| `pipeline-skill-template.md` | 6 | `run-<short>/SKILL.md` rerun template |
| `deliverables.md` | 4, 6 | Final directory layout + README results section |

---

## Opt-in (only when their flag is set)

| File | Flag | Adds |
|---|---|---|
| `progress-tracking.md` | `emit_progress_log: true` | PROGRESS.md template |
| `testing.md` | `emit_unit_tests: true` | Fake-data heterogeneous-batch tests |
| `reporting.md` | `emit_report: true` | `report.py` (PDF + HTML, reads `trainer_state.json`) |

---

**Rule:** before falling back to a reference, log the live source you tried and
why it was insufficient (in `config.yaml` `notes:`, and PROGRESS.md if enabled).
`[FETCH LIVE]` markers in `cv-scripts.md` / `vlm-scripts.md` are a research
checklist, not code to inline — if a block has no Step 3 finding, refetch the
listed URL.

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

# Project Scaffold (Step 4a)

The file set written into `output_dir/`, the required Python copyright
header, the Dockerfile template, and the preflight summary format.

---

## Generated project files

| File | From | Notes |
|---|---|---|
| `config.yaml` | Steps 1-3 + user input | already started |
| `Dockerfile` | template below + compat injections | layer order: deps → compat → code |
| `requirements.txt` | task baseline + compat pins | don't pin without cause |
| `prepare_data.py` | scaffold + Step 3 | save Arrow to `data/{train,eval}` |
| `train.py` | scaffold + Step 3 recipe | reads `config.yaml`, supports `--smoke --max_steps N` |
| `run_eval.py` | scaffold + Step 3 | **MUST** be `run_eval.py` (collides with HF `evaluate` lib if named `evaluate.py`) |
| `infer.py` | scaffold + Step 3 | writes `reports/inference_samples/<i>_input.jpg`, `_pred.jpg`, `_meta.json` |
| `merge_lora.py` | scaffold | only for VLM with LoRA |
| `.gitignore` | `data/`, `checkpoints/`, `logs/`, `wandb/`, `reports/inference_samples/`, `.env`, `__pycache__/`, `*.pyc`, `.cache/`, `.probe/` | |

Authority order while writing: live research from Step 3 → scaffold reference
(`cv-scripts.md` / `vlm-scripts.md`) for **structure only**, never their
`[FETCH LIVE]` blocks. Apply each `applicable_workarounds` entry: Dockerfile
blocks, requirements pins, config overrides, runtime env vars.

If `emit_unit_tests: true`, also generate `tests/` per `testing.md`.

---

## Required Python copyright header

Every generated `.py` file (`prepare_data.py`, `train.py`, `run_eval.py`,
`infer.py`, `merge_lora.py`, and any `tests/*.py`) must start with the NVIDIA
Apache-2.0 copyright header as a `#`-prefixed comment block — same text as the
HTML copyright comment used in the rerun skill, just commented for Python:

```python
# Copyright (c) 2026, NVIDIA CORPORATION.  All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
```

If you generate an emitter script, make it fail unless every emitted `.py`
begins with that header.

---

## Dockerfile template

```dockerfile
ARG NGC_IMAGE=nvcr.io/nvidia/pytorch:24.09-py3
FROM ${NGC_IMAGE}

ENTRYPOINT ["/bin/bash", "-c"]
WORKDIR /workspace

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# {{COMPAT_DOCKERFILE_BLOCKS}}     ← injected from applicable_workarounds
# {{COMPAT_ENV_VARS}}                ← injected from applicable_workarounds

COPY *.py ./
COPY config.yaml ./
```

---

## Preflight summary format (Step 4c)

Print and verify every field is filled before launching full training:

```
─ PREFLIGHT ────────────────────────────────────────
reference implementation:  <URL from Step 3>
dataset columns verified:  <col1, col2, …>
push_to_hub:               <repo_id>
monitoring:                wandb <project>/<run_name>
ngc_image:                 <image tag>
hardware:                  <gpu_count>× <gpu_name>
smoke test:                PASSED (loss=X.XX, grad_norm=Y.YY)
────────────────────────────────────────────────────
```

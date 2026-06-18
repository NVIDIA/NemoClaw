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

# Execution Platform Details

This skill orchestrates *what* to run; the platform skills own *how* to run it
on a GPU host. Read those skills first and do not redraft their conventions
here.

| Concern | Authoritative skill |
|---|---|
| GPU host runtime — NVIDIA driver 580, CUDA Toolkit 13.0, NVIDIA Container Toolkit 1.19.0 | [`tao-skill-bank:tao-setup-nvidia-gpu-host`](../../../platform/tao-setup-nvidia-gpu-host/SKILL.md) |
| `docker run` flags, NGC auth, `--gpus`, mounts, env passthrough, `--ipc=host`/`--shm-size`, common error modes | [`tao-skill-bank:tao-run-on-docker`](../../../platform/tao-run-on-docker/SKILL.md) |
| Local Docker job preflight (daemon reachable, GPU smoke) | [`tao-skill-bank:tao-run-on-local-docker`](../../../platform/tao-run-on-local-docker/SKILL.md) |

---

## Default platform

`local-docker` — build a one-off image (`run-<short>:latest`) and run it on the
local Docker daemon (see `skills/platform/tao-run-on-local-docker/SKILL.md`).
Ask the user only when they explicitly need a different backend (Brev for a
remote GPU instance, Lepton/SLURM/Kubernetes for managed scheduling); in that
case run the chosen platform's Preflight section first, generate the choices
via `${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/list_tao_platforms.py
--format text`, then route the Steps 4–5 `docker run` commands through that
platform's execution pattern.

---

## GPU runtime preflight

Step 2a runs `tao-setup-nvidia-gpu-host` `--check-only`; do not duplicate the
NCT / driver / `--gpus all` smoke logic here — if it needs to change, change it
in `tao-setup-nvidia-gpu-host`.

---

## Credentials preflight

The SessionStart hook (`hooks/session_start.sh`) loads `~/.config/tao/.env`
into the session env and lists the variable names (never values) in the session
banner. Step 2a confirms only the credentials the current run actually needs —
`HF_TOKEN` for gated downloads or `push_to_hub`, `WANDB_API_KEY`/`WANDB_PROJECT`
if WandB is enabled — instead of hard-requiring them up front.

---

## Docker run conventions

Every `docker run` invocation in `docker-runs.md` follows the canonical flag
set from `tao-run-on-docker` (`--gpus all`, `--ipc=host` or `--shm-size=…`,
`-e VAR` passthrough, bind mounts, `--rm` for one-shots). Treat that skill as
the spec; this one only adds workflow-specific flags (`--entrypoint /bin/bash
-lc`, `PYTORCH_CUDA_ALLOC_CONF`, `--name hft_train`).

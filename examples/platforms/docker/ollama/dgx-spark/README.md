<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Ollama on DGX Spark

These configurations create a Docker gateway, a managed Ollama service, and one agent sandbox on a Linux ARM64 DGX Spark with NVIDIA GPU access.

| Configuration | Agent and model | Settings |
|---|---|---|
| [managed-hermes.yaml](managed-hermes.yaml) | Hermes with Nemotron Nano 4B | 65,536-token context and a 16 GiB GPU budget |
| [managed-ollama.yaml](managed-ollama.yaml) | OpenClaw with Qwen3-0.6B | 32,768-token context and a 16 GiB GPU budget |
| [managed-ollama-gpu.yaml](managed-ollama-gpu.yaml) | OpenClaw with Qwen3-0.6B | The same hardware target, with explicit serving and output limits |

All three require a GPU. The filenames are retained; `managed-ollama.yaml` is not a CPU-only alternative to `managed-ollama-gpu.yaml`.

Follow the [build prerequisites](../../../../../docs/build-deploy/build.md) and [managed-model requirements](../../../../../docs/agents-inference/models.md).
Build the Ollama runtime and the selected harness image for Linux ARM64, replace the image digests and deployment UID in a private copy, and retain the pinned model digest.
Use the [shared run procedure](../../../../README.md#prepare-and-run-a-yaml-example), including an explicit agent request and retained teardown.
Run one example at a time unless the host can accommodate their combined memory budgets and distinct ports.
These files receive configuration checks; no new live qualification is claimed by their relocation.

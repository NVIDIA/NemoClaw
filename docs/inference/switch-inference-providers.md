---
title:
  page: "Switch NemoClaw Inference Providers at Runtime"
  nav: "Switch Inference Providers"
description: "Change the active inference provider without restarting the sandbox."
keywords: ["switch nemoclaw inference provider", "change inference runtime"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "inference_routing", "nim", "vllm"]
content:
  type: how_to
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Switch Inference Providers at Runtime

Change the active inference provider while the sandbox is running.
No restart is required.

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.

## Switch to NVIDIA Cloud

Set the provider to `nvidia-nim` and specify a model from [build.nvidia.com](https://build.nvidia.com):

```console
$ openshell inference set --provider nvidia-nim --model nvidia/nemotron-3-super-120b-a12b
```

This profile requires the `NVIDIA_API_KEY` environment variable.
The `nemoclaw onboard` flow stores this key in `~/.nemoclaw/credentials.json` on first run.

## Switch to Local vLLM

Set the provider to `vllm-local` and specify a model served by vLLM on the host:

```console
$ openshell inference set --provider vllm-local --model nvidia/nemotron-3-nano-30b-a3b
```

The vLLM server must be running before you switch.
Bind the server to `0.0.0.0` and make sure the host firewall allows the bridge subnet to reach port `8000`.
Refer to [Set Up Local vLLM](set-up-local-vllm.md) for setup instructions.

## Switch to Local NIM

Set the provider to `nim-local` and specify a model served by a NIM container on your network:

```console
$ openshell inference set --provider nim-local --model nvidia/nemotron-3-super-120b-a12b
```

This profile requires the `NIM_API_KEY` environment variable.
Refer to [Set Up a Local NIM Service](set-up-local-nim.md) for setup instructions.

## Verify the Active Provider

Run the status command to confirm the change:

```console
$ openclaw nemoclaw status
```

Add the `--json` flag for machine-readable output:

```console
$ openclaw nemoclaw status --json
```

The output includes the active provider, model, and endpoint.

## Available Models

The following table lists the models registered with the `nvidia-nim` provider.
You can switch to any of these models at runtime.

| Model ID | Label | Context Window | Max Output |
|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` | Nemotron 3 Super 120B | 131,072 | 8,192 |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1` | Nemotron Ultra 253B | 131,072 | 4,096 |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | Nemotron Super 49B v1.5 | 131,072 | 4,096 |
| `nvidia/nemotron-3-nano-30b-a3b` | Nemotron 3 Nano 30B | 131,072 | 4,096 |

## Related Topics

- [Inference Profiles](../reference/inference-profiles.md) for full profile configuration details.
- [Set Up Local vLLM](set-up-local-vllm.md) for offline development with vLLM.
- [Set Up a Local NIM Service](set-up-local-nim.md) for on-premises NIM deployment.

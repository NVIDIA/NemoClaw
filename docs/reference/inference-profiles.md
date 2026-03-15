<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Inference Profiles

NemoClaw ships with three inference profiles defined in `blueprint.yaml`.
Each profile configures an OpenShell inference provider and model route.
The agent inside the sandbox uses whichever profile is active.
Inference requests are routed transparently through the OpenShell gateway.

## Profile Summary

| Profile | Provider | Model | Endpoint | Use Case |
|---|---|---|---|---|
| `default` | NVIDIA cloud | `nvidia/nemotron-3-super-120b-a12b` | `integrate.api.nvidia.com` | Production. Requires an NVIDIA API key. |
| `nim-local` | Local NIM service | `nvidia/nemotron-3-super-120b-a12b` | `nim-service.local:8000` | On-premises. NIM deployed as a local pod. |
| `vllm` | vLLM | `nvidia/nemotron-3-nano-30b-a3b` | `localhost:8000` | Local development. vLLM on the host. |

## Available Models

The `nvidia-nim` provider registers the following models from [build.nvidia.com](https://build.nvidia.com):

| Model ID | Label | Context Window | Max Output |
|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` | Nemotron 3 Super 120B | 131,072 | 8,192 |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1` | Nemotron Ultra 253B | 131,072 | 4,096 |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | Nemotron Super 49B v1.5 | 131,072 | 4,096 |
| `nvidia/nemotron-3-nano-30b-a3b` | Nemotron 3 Nano 30B | 131,072 | 4,096 |

The `default` and `nim-local` profiles use Nemotron 3 Super 120B.
The `vllm` profile uses Nemotron 3 Nano 30B.
You can switch to any model in the catalog at runtime.

## `default` -- NVIDIA Cloud

The default profile routes inference to NVIDIA's hosted API through [build.nvidia.com](https://build.nvidia.com).

- **Provider type:** `nvidia`
- **Endpoint:** `https://integrate.api.nvidia.com/v1`
- **Model:** `nvidia/nemotron-3-super-120b-a12b`
- **Credential:** `NVIDIA_API_KEY` environment variable

Get an API key from [build.nvidia.com](https://build.nvidia.com).
The `nemoclaw setup` command prompts for this key and stores it in `~/.nemoclaw/credentials.json`.

```console
$ openshell inference set --provider nvidia-nim --model nvidia/nemotron-3-super-120b-a12b
```

## `nim-local` -- Local NIM Service

Routes inference to a NIM container running on the local network.

- **Provider type:** `openai`, which uses the OpenAI-compatible API
- **Endpoint:** `http://nim-service.local:8000/v1`
- **Model:** `nvidia/nemotron-3-super-120b-a12b`
- **Credential:** `NIM_API_KEY` environment variable

The sandbox network policy includes a `nim_service` entry that allows traffic to `nim-service.local:8000`.

```console
$ openshell inference set --provider nim-local --model nvidia/nemotron-3-super-120b-a12b
```

## `vllm` -- Local vLLM

Routes inference to a vLLM server running on `localhost:8000`.

- **Provider type:** `openai`, which uses the OpenAI-compatible API
- **Endpoint:** `http://localhost:8000/v1`
- **Model:** `nvidia/nemotron-3-nano-30b-a3b`
- **Credential:** `OPENAI_API_KEY` environment variable. Defaults to `dummy` for local use.

```console
$ openshell inference set --provider vllm-local --model nvidia/nemotron-3-nano-30b-a3b
```

## Selecting a Profile at Launch

Pass `--profile` when launching or migrating to select a profile:

```console
$ openclaw nemoclaw launch --profile vllm
$ openclaw nemoclaw migrate --profile nim-local
```

## Switching Profiles at Runtime

After the sandbox is running, switch inference providers with the OpenShell CLI:

```console
$ openshell inference set --provider <provider-name> --model <model-name>
```

The change takes effect immediately.
No sandbox restart is needed.

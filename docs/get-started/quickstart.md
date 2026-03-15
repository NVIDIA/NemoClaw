<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Quickstart

This guide walks you through installing NemoClaw, creating a sandboxed OpenClaw instance, and running your first agent prompt.

## Prerequisites

- Node.js 20+
- Docker or [Colima](https://github.com/abiosoft/colima) on macOS
- [OpenShell CLI](https://github.com/NVIDIA/OpenShell/releases) installed and on your `PATH`
- NVIDIA API Key from [build.nvidia.com](https://build.nvidia.com) for cloud inference

## Install NemoClaw

```console
$ npm install -g nemoclaw
```

Or install from source:

```console
$ git clone https://github.com/NVIDIA/openshell-openclaw-plugin.git
$ cd openshell-openclaw-plugin
$ sudo npm install -g .
```

## Run Setup

```console
$ nemoclaw setup
```

The first run prompts for your NVIDIA API Key and saves it to `~/.nemoclaw/credentials.json`.
Setup creates an OpenShell gateway, registers inference providers, and launches the sandbox.

## Connect to the Sandbox

```console
$ nemoclaw connect
```

This opens an interactive shell inside the sandboxed OpenClaw environment.

## Run an Agent

Inside the sandbox, start an OpenClaw agent session:

```console
$ openclaw agent --agent main --local -m "your prompt" --session-id s1
```

## Switch Inference Providers

NemoClaw supports three inference profiles.
Switch between them with the OpenShell CLI:

::::{tab-set}

:::{tab-item} NVIDIA Cloud

```console
$ openshell inference set --provider nvidia-nim --model nvidia/nemotron-3-super-120b-a12b
```

:::

:::{tab-item} Local vLLM

```console
$ openshell inference set --provider vllm-local --model nvidia/nemotron-3-nano-30b-a3b
```

:::

:::{tab-item} Local NIM

```console
$ openshell inference set --provider nim-local --model nvidia/nemotron-3-super-120b-a12b
```

:::

::::

Refer to [Inference Profiles](../reference/inference-profiles.md) for full details on each provider.

## Monitor the Sandbox

Open the OpenShell TUI to monitor sandbox activity and approve network egress requests:

```console
$ openshell term
```

When the agent tries to access an endpoint not in the baseline policy, the TUI prompts you to approve or deny the request in real time.

## Deploy to a Cloud VM

To run on a remote GPU instance through [Brev](https://brev.nvidia.com):

```console
$ nemoclaw deploy my-gpu-box
```

Then connect remotely:

```console
$ nemoclaw connect my-gpu-box
```

## Next Steps

- Read about the [Architecture](../about/architecture.md) to understand the plugin and blueprint system.
- Refer to the [Commands](../reference/commands.md) reference for all available CLI options.
- Review [Network Policies](../reference/network-policies.md) to understand the sandbox security model.

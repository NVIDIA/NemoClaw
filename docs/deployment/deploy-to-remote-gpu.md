---
title:
  page: "Deploy NemoClaw to a Remote GPU Instance with Brev"
  nav: "Deploy to Remote GPU"
description: "Provision a remote GPU VM with NemoClaw using Brev deployment."
keywords: ["deploy nemoclaw remote gpu", "nemoclaw brev cloud deployment"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "deployment", "gpu", "nemoclaw"]
content:
  type: how_to
  difficulty: intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Deploy NemoClaw to a Remote GPU Instance

Run NemoClaw on a remote GPU instance through [Brev](https://brev.nvidia.com).
The deploy command provisions the VM, installs dependencies, and connects you to a running sandbox.

## Prerequisites

- The [Brev CLI](https://brev.nvidia.com) installed and authenticated.
- An NVIDIA API key from [build.nvidia.com](https://build.nvidia.com).
- NemoClaw installed locally. Follow the [Quickstart](../get-started/quickstart.md) install steps.

## Deploy the Instance

:::{warning}
The `nemoclaw deploy` command is experimental and may not work as expected.
:::

Create a Brev instance and run the NemoClaw setup:

```console
$ nemoclaw deploy <instance-name>
```

Replace `<instance-name>` with a name for your remote instance, for example `my-gpu-box`.

The deploy script performs the following steps on the VM:

1. Installs Docker and the NVIDIA Container Toolkit if a GPU is present.
2. Installs the OpenShell CLI.
3. Runs the nemoclaw setup to create the gateway, register providers, and launch the sandbox.
4. Starts auxiliary services, such as the Telegram bridge and cloudflared tunnel.

## Connect to the Remote Sandbox

After deployment finishes, the deploy command opens an interactive shell inside the remote sandbox.
To reconnect after closing the session, run the deploy command again:

```console
$ nemoclaw deploy <instance-name>
```

## Monitor the Remote Sandbox

SSH to the instance and run the OpenShell TUI to monitor activity and approve network requests:

```console
$ ssh <instance-name> 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && openshell term'
```

## Verify Inference

Run a test agent prompt inside the remote sandbox:

```console
$ openclaw agent --agent main --local -m "Hello from the remote sandbox" --session-id test
```

## GPU Configuration

The deploy script uses the `NEMOCLAW_GPU` environment variable to select the GPU type.
The default value is `a2-highgpu-1g:nvidia-tesla-a100:1`.
Set this variable before running `nemoclaw deploy` to use a different GPU configuration:

```console
$ export NEMOCLAW_GPU="a2-highgpu-1g:nvidia-tesla-a100:2"
$ nemoclaw deploy <instance-name>
```

### Choosing a cost-effective instance for experimentation

The default A100 instance (`a2-highgpu-1g:nvidia-tesla-a100:1`) costs approximately $4.41/hr on GCP.
Since the default inference path routes through the NVIDIA cloud API (not a local model), the GPU on the VM is mostly idle.
For experimentation and testing with cloud inference, a smaller, cheaper instance is sufficient:

```console
$ export NEMOCLAW_GPU="hyperstack_A4000"
$ nemoclaw deploy <instance-name>
```

Use `brev search --sort price` to list available instance types and pricing.

| Instance | GPU | VRAM | Approx. $/hr | Notes |
|---|---|---|---|---|
| `hyperstack_A4000` | A4000 | 16 GB | $0.18 | Cheapest option, sufficient for cloud inference |
| `g4dn.xlarge` | T4 | 16 GB | $0.63 | AWS, stoppable and rebootable |
| `a2-highgpu-1g:nvidia-tesla-a100:1` | A100 | 40 GB | $4.41 | Default, needed only for local NIM inference |

:::{note}
A GPU is only required on the VM if you plan to run local inference via NIM or vLLM.
When using NVIDIA cloud inference (the default), the GPU is not used for model serving.
:::

Remember to delete the instance when you are finished to avoid ongoing charges:

```console
$ brev delete <instance-name>
```

## Related Topics

- [Set Up the Telegram Bridge](set-up-telegram-bridge.md) to interact with the remote agent through Telegram.
- [Monitor Sandbox Activity](../monitoring/monitor-sandbox-activity.md) for sandbox monitoring tools.
- [Commands](../reference/commands.md) for the full `deploy` command reference.

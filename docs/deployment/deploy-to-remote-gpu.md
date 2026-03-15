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
- NemoClaw installed locally. Install with `npm install -g nemoclaw`.

## Deploy the Instance

Create a Brev instance and run the NemoClaw setup:

```console
$ nemoclaw deploy <instance-name>
```

Replace `<instance-name>` with a name for your remote instance, for example `my-gpu-box`.

The deploy script performs the following steps on the VM:

1. Installs Docker and the NVIDIA Container Toolkit if a GPU is present.
2. Installs the OpenShell CLI.
3. Runs `nemoclaw setup` to create the gateway, register providers, and launch the sandbox.
4. Starts auxiliary services, such as the Telegram bridge and cloudflared tunnel.

## Connect to the Remote Sandbox

After deployment finishes, connect to the sandbox on the remote instance:

```console
$ nemoclaw connect <instance-name>
```

This opens an interactive shell inside the remote sandbox.

## Monitor the Remote Sandbox

Open the OpenShell TUI on the remote instance to monitor activity and approve network requests:

```console
$ nemoclaw term <instance-name>
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

## Related Topics

- [Set Up the Telegram Bridge](set-up-telegram-bridge.md) to interact with the remote agent through Telegram.
- [Monitor Sandbox Activity](../monitoring/monitor-sandbox-activity.md) for sandbox monitoring tools.
- [Commands](../reference/commands.md) for the full `deploy` command reference.

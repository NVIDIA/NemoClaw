---
title:
  page: "Set Up NemoClaw on DGX Spark"
  nav: "DGX Spark"
description: "Install and configure NemoClaw on DGX Spark, including cgroup v2 and Docker fixes."
keywords: ["nemoclaw dgx spark", "dgx spark setup", "nemoclaw cgroup v2"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "dgx spark", "nemoclaw"]
content:
  type: get_started
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Set Up NemoClaw on DGX Spark

DGX Spark ships Ubuntu 24.04 with Docker 28.x but no Kubernetes.
OpenShell embeds k3s inside a Docker container, which requires two configuration changes on Spark before NemoClaw can run.
This page covers the Spark-specific Docker fixes and two install paths: the automated `setup-spark` command and the manual approach.

The following structure shows how the components stack on DGX Spark.

```
DGX Spark (Ubuntu 24.04, cgroup v2)
  └── Docker (28.x, cgroupns=host)
       ├── Ollama (optional, host-side local inference)
       └── OpenShell gateway container
            └── k3s (embedded)
                 └── NemoClaw sandbox pod
                      └── OpenClaw agent
```

## Prerequisites

DGX Spark comes with Docker pre-installed.
Verify that the following additional dependencies are available.

| Dependency | Version | Notes |
|---|---|---|
| Docker | 28.x (pre-installed) | Must be running. |
| Node.js | 22 or later | See install instructions below if not present. |
| [OpenShell CLI](https://github.com/NVIDIA/OpenShell) | Latest release | Architecture is `aarch64` on Spark. |
| NVIDIA API key | — | Get one from [build.nvidia.com](https://build.nvidia.com). |

If Node.js is not installed, run:

```console
$ curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
$ sudo apt-get install -y nodejs
```

To install the OpenShell CLI:

```console
$ ARCH=$(uname -m)
$ sudo curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/latest/download/openshell-linux-${ARCH}" -o /usr/local/bin/openshell
$ sudo chmod +x /usr/local/bin/openshell
```

## Install

You can install NemoClaw on Spark in two ways: using `setup-spark` to apply Docker fixes automatically, or applying the fixes manually and running the curl installer.

::::{tab-set}

:::{tab-item} Clone and Run `setup-spark`

Clone the repository, install the CLI, then run the Spark setup command.

```console
$ git clone https://github.com/NVIDIA/NemoClaw.git
$ cd NemoClaw
$ sudo npm install -g .
$ sudo nemoclaw setup-spark
$ nemoclaw onboard
```

The `setup-spark` command applies the following Spark-specific Docker fixes and prompts you to run `nemoclaw onboard` to continue with gateway, inference, and sandbox setup.

- Docker group membership.
  Adds your user to the `docker` group so OpenShell commands do not require `sudo`.
  You may need to log out and back in, or run `newgrp docker`, for the group change to take effect.

- Cgroup v2 namespace mode.
  Spark runs cgroup v2 (the Ubuntu 24.04 default), but the gateway's embedded k3s expects cgroup v1-style paths.
  Without the fix, the kubelet fails with:

  ```
  openat2 /sys/fs/cgroup/kubepods/pids.max: no
  Failed to start ContainerManager: failed to initialize top level QOS containers
  ```

  The script sets `"default-cgroupns-mode": "host"` in `/etc/docker/daemon.json` and restarts Docker.
  This makes all containers use the host cgroup namespace, which k3s requires.

:::

:::{tab-item} Fix Manually and Run the Curl Installer

If `setup-spark` does not work in your environment, apply the fixes manually before running the installer.

1. Check whether your system uses cgroup v2:

   ```console
   $ stat -fc %T /sys/fs/cgroup/
   ```

   If the output is `cgroup2fs`, add the `cgroupns=host` setting to the Docker daemon configuration and restart Docker:

   ```console
   $ sudo python3 -c "
   import json, os
   path = '/etc/docker/daemon.json'
   d = json.load(open(path)) if os.path.exists(path) else {}
   d['default-cgroupns-mode'] = 'host'
   json.dump(d, open(path, 'w'), indent=2)
   "
   $ sudo systemctl restart docker
   ```

2. Add your user to the `docker` group so that Docker commands do not require `sudo`:

   ```console
   $ sudo usermod -aG docker $USER
   $ newgrp docker
   ```

3. Run the standard installer:

   ```console
   $ curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
   ```

   The installer handles Node.js, OpenShell, and the onboard wizard automatically.

:::

::::

## Chat with the Agent

After onboarding completes, verify that the sandbox is running and the agent responds.

1. List OpenShell sandboxes and check that yours is in the `Ready` state:

   ```console
   $ openshell sandbox list
   ```

2. Connect to the sandbox:

   ```console
   $ nemoclaw my-assistant connect
   ```

3. Inside the sandbox shell, open the TUI and send a test message:

   ```console
   $ openclaw tui
   ```

   Verify you receive a response.

   :::{tip}
   To see the full text of long responses, use the CLI instead of the TUI:

   ```console
   $ openclaw agent --agent main --local -m "hello" --session-id test
   ```
   :::

## Inference on Spark

DGX Spark uses the NVIDIA GB10 Superchip with 128 GB of unified memory shared between the Grace CPU and the GPU.
During onboarding, the wizard prompts you to choose between NVIDIA cloud inference and local Ollama inference.

| Provider | Model | Notes |
|---|---|---|
| NVIDIA cloud | `nvidia/nemotron-3-super-120b-a12b` | Requires an NVIDIA API key from [build.nvidia.com](https://build.nvidia.com). |
| Ollama (local) | Selected during onboard | Runs on the Spark GPU. No API key required. |

:::{note}
The sandbox does not receive direct GPU access.
Inference runs through a host-side provider (cloud API or Ollama), and the OpenShell gateway routes requests from the sandbox to that provider.
:::

## Known Issues

| Issue | Status | Details |
|---|---|---|
| Cgroup v2 prevents k3s from starting | Fixed by `setup-spark` | [Troubleshooting: Cgroup v2 errors](../reference/troubleshooting.md#cgroup-v2-errors-during-onboard) |
| Docker permission denied | Fixed by `setup-spark` | [Troubleshooting: Docker permission denied](../reference/troubleshooting.md#docker-permission-denied-on-dgx-spark) |
| CoreDNS CrashLoop after setup | Fixed in `fix-coredns.sh` | [Troubleshooting: CoreDNS CrashLoop](../reference/troubleshooting.md#coredns-crashloop-after-setup-on-dgx-spark) |
| Image pull failure after gateway restart | OpenShell bug | [Troubleshooting: Image pull failure](../reference/troubleshooting.md#image-pull-failure-after-gateway-restart) |
| GPU passthrough | Not yet tested on Spark | Requires NVIDIA Container Toolkit. Use the `--gpu` flag if the toolkit is configured. |

## Next Steps

- [Switch Inference Providers](../inference/switch-inference-providers.md) to use a different model or endpoint.
- [Approve or Deny Network Requests](../network-policy/approve-network-requests.md) to manage egress approvals.
- [Monitor Sandbox Activity](../monitoring/monitor-sandbox-activity.md) through the OpenShell TUI.
- [Troubleshooting](../reference/troubleshooting.md) for common errors and resolution steps.

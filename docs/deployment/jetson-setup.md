---
title:
  page: "Set Up NemoClaw on Jetson"
  nav: "Jetson Setup"
description: "Run NemoClaw on NVIDIA Jetson devices (Orin Nano, Orin NX, AGX Orin)."
keywords: ["nemoclaw jetson", "orin nano", "orin nx", "agx orin", "l4t"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "jetson", "l4t", "edge"]
content:
  type: how_to
  difficulty: technical_intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Set Up NemoClaw on Jetson

NemoClaw runs on NVIDIA Jetson devices (Orin Nano, Orin NX, AGX Orin) with
L4T (Linux for Tegra). A dedicated setup script handles L4T kernel
incompatibilities and configures the OpenShell gateway for Jetson's
iptables backend.

## Prerequisites

- Jetson device running L4T (JetPack 6.x / R36)
- Docker installed and running
- [OpenShell CLI](https://github.com/NVIDIA/OpenShell/releases) installed
- NVIDIA API key from [build.nvidia.com](https://build.nvidia.com)
- Your user in the `docker` group (`sudo usermod -aG docker $USER`, then re-login)

## Install

```console
$ git clone https://github.com/NVIDIA/NemoClaw.git
$ cd NemoClaw
$ cd nemoclaw && npm install && npm run build && cd ..
```

## Run the Setup

The script runs as your **normal user** (not sudo). It uses sudo internally
only for kernel module loading and Docker daemon configuration.

```console
$ export NVIDIA_API_KEY=nvapi-...
$ bash scripts/setup-jetson.sh
```

The script:

1. Detects the Jetson platform (via `/etc/nv_tegra_release` or kernel string)
2. Loads kernel modules required by k3s (`br_netfilter`, `xt_conntrack`, etc.)
3. Configures Docker for `cgroupns=host` on cgroup v2
4. Starts the OpenShell gateway and patches the image to use `iptables-legacy`
5. Disables kube-router's network policy controller (L4T lacks required ipset types)
6. Sets up the NVIDIA inference provider
7. Creates the sandbox with a network policy for egress control
8. Patches CoreDNS for Docker DNS forwarding
9. Installs Ollama for optional local inference

## Activate the Network Policy

After the setup completes, you must activate the network policy once:

1. Open the OpenShell TUI:

   ```console
   $ openshell term
   ```

2. Approve the pending network policy rules in the TUI.

3. Once approved, the sandbox can reach all pre-configured endpoints
   (Telegram, NVIDIA API, GitHub, npm) without further interaction.

This is a **one-time step** per gateway session. The policy remains active
until the gateway is destroyed.

## Connect and Test

```console
$ openshell sandbox connect nemoclaw
```

Inside the sandbox, test inference:

```console
$ openclaw agent --agent main --local -m 'hello' --session-id test1
```

## Local Inference with Ollama

By default, inference routes through NVIDIA cloud. To use local inference
on the Jetson GPU:

```console
$ ollama pull nemotron-3-nano:4b
$ openshell inference set --provider ollama-local --model nemotron-3-nano:4b
```

## What's Different on Jetson

### iptables-legacy

L4T's kernel uses the `iptables-legacy` backend. The OpenShell gateway image
defaults to `iptables-nft`, which panics on L4T because the nf_tables
compatibility layer is incomplete. The setup script patches the gateway image
to use `iptables-legacy`.

### Disabled kube-router Network Policy

L4T's kernel only ships the `ip_set_hash_net` ipset module. kube-router
requires additional types (`hash:ip`, `hash:ipport`, etc.) that are not
compiled into the Tegra kernel. The setup script disables kube-router's
network policy controller to avoid ipset panics.

**What remains active:** OpenShell's application-level egress proxy provides:

- Deny-by-default outbound access with an explicit host allowlist
- HTTP method and path filtering
- Operator approval workflow for unlisted hosts via `openshell term`
- Filesystem and process isolation

**What is missing:** the Kubernetes NetworkPolicy layer that catches traffic
bypassing the HTTP proxy (e.g., raw sockets). This gap could be closed by
rebuilding the L4T kernel with full ipset support.

### CoreDNS Fix

Docker's internal DNS (`127.0.0.11`) is unreachable from k3s pods. The
setup script patches CoreDNS to forward to the gateway container's DNS
proxy, the same fix applied for Colima environments.

## Tested Devices

| Device | JetPack | L4T Kernel | Status |
|--------|---------|------------|--------|
| Orin Nano | 6.x | 5.15.185-tegra | Tested |
| Orin NX | 6.x | 5.15.x-tegra | Expected to work |
| AGX Orin | 6.x | 5.15.x-tegra | Expected to work |

## Troubleshooting

**Gateway fails with iptables errors:**
The setup script automatically patches the gateway image. If you see
`nf_tables` errors, the patch may not have applied. Run the setup again —
it will detect and re-patch.

**Sandbox shows `Pending` phase:**
Wait a minute for the image to be pushed into the gateway. If it stays
pending, check `openshell sandbox get nemoclaw` for details.

**Network requests return 403:**
Open `openshell term` and approve the pending network policy rules.
This is required once after each gateway restart.

**`openshell term` shows nothing:**
Make sure you ran `setup-jetson.sh` as your normal user (not sudo).
The gateway metadata must be in your user's config directory.

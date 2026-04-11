---
title: Brev Deployment
category: concept
created: 2026-04-11
updated: 2026-04-11
sources: [docs-deployment]
tags: [deployment, cloud, gpu, brev]
---

# Brev Deployment

Deploy NemoClaw to a remote GPU VM using Brev provisioning. Experimental.

## Prerequisites

- Brev CLI installed and authenticated
- NVIDIA API key from <https://build.nvidia.com>
- NemoClaw installed locally

## Deploy

```bash
nemoclaw deploy <instance-name>
```

## What `deploy` Does

1. Provisions VM via Brev
2. Installs Docker + NVIDIA Container Toolkit
3. Installs [OpenShell](../entities/openshell.md) CLI
4. Runs `nemoclaw onboard` on the VM
5. Starts auxiliary services ([Telegram](../entities/telegram-bridge.md),
   [Discord](../entities/discord-bridge.md), cloudflared)
6. Opens interactive session inside sandbox

## GPU Selection

```bash
export NEMOCLAW_GPU="a2-highgpu-1g:nvidia-tesla-a100:2"
nemoclaw deploy <instance-name>
```

## Post-Deployment Monitoring

```bash
ssh <instance-name> 'cd /home/ubuntu/nemoclaw && . .env && openshell term'
```

## See Also

- [Installation](installation.md) — Local install guide
- [CLI Commands](cli-commands.md) — `deploy` command
- [Discord Bridge](../entities/discord-bridge.md) — Started by deploy
- [Telegram Bridge](../entities/telegram-bridge.md) — Started by deploy

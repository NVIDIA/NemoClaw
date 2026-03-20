---
title:
  page: "Run NemoClaw with Docker Compose"
  nav: "Run with Docker Compose"
description: "Run the NemoClaw sandbox standalone using Docker Compose without OpenShell orchestration."
keywords: ["nemoclaw docker compose", "nemoclaw standalone docker", "nemoclaw local docker"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "docker", "deployment", "nemoclaw"]
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

# Run NemoClaw with Docker Compose

This page explains how to run the NemoClaw sandbox using Docker Compose without the full OpenShell orchestration layer.
Use this approach for local development and testing when you want a single-command startup.

:::{note}
This setup is intended for local development.
For production use, follow the [standard installation](../get-started/quickstart.md) which includes the full OpenShell security layer.
:::

## Prerequisites

- Docker installed and running.
- An NVIDIA API key from [build.nvidia.com](https://build.nvidia.com).
- [OpenShell](https://github.com/NVIDIA/OpenShell) installed and running on the host (required for inference routing through `inference.local`).

## Configure Environment Variables

Copy the example environment file and fill in your API key.

```console
$ cp .env.example .env
```

Open `.env` and set `NVIDIA_API_KEY`:

```
NVIDIA_API_KEY=nvapi-xxxxxxxxxxxxxxxxxxxx
```

The available variables are:

| Variable | Required | Default | Description |
|---|---|---|---|
| `NVIDIA_API_KEY` | Yes | — | NVIDIA inference API key. |
| `NEMOCLAW_MODEL` | No | `nvidia/nemotron-3-super-120b-a12b` | Override the default model. |
| `CHAT_UI_URL` | No | `http://127.0.0.1:18789` | Browser origin for the Control UI. Change this when accessing from a non-localhost origin. |
| `PUBLIC_PORT` | No | `18789` | Host port to expose the gateway on. |

## Start the Container

```console
$ docker compose up -d
```

The container is ready when its status shows `healthy`.
Check with:

```console
$ docker compose ps
```

## Open the Control UI

Open your browser and navigate to `http://127.0.0.1:18789`.

## View Gateway Logs

```console
$ docker compose logs -f
```

## Stop the Container

```console
$ docker compose down
```

Agent state persists in named volumes (`openclaw-state` and `nemoclaw-state`) and is available when you start the container again.
To remove state along with the container, run:

```console
$ docker compose down -v
```

## Inference Routing

The sandbox routes inference through `inference.local`, which is the OpenShell gateway proxy.
Docker Compose maps `inference.local` to `host-gateway` so the container can reach OpenShell running on the host.
If OpenShell is not running, the Control UI starts but model calls fail.

## Next Steps

- [Set Up the Telegram Bridge](set-up-telegram-bridge.md) to interact with your agent through Telegram.
- [Deploy to a Remote GPU](deploy-to-remote-gpu.md) for GPU-accelerated inference on a remote instance.

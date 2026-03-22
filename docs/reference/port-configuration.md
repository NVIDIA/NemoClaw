---
title:
  page: "NemoClaw Port Configuration"
  nav: "Port Configuration"
description: "Configure NemoClaw network ports using environment variables or a .env file."
keywords: ["nemoclaw ports", "nemoclaw port configuration", "nemoclaw port conflict"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "configuration", "nemoclaw"]
content:
  type: reference
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Port Configuration

NemoClaw uses four network ports.
All ports are configurable through environment variables or a `.env` file at the project root.

## Default Ports

| Port | Default | Environment variable | Purpose |
|------|---------|----------------------|---------|
| Dashboard | 18789 | `NEMOCLAW_DASHBOARD_PORT` | OpenClaw web UI, forwarded from sandbox to host |
| Gateway | 8080 | `NEMOCLAW_GATEWAY_PORT` | OpenShell gateway API |
| vLLM/NIM | 8000 | `NEMOCLAW_VLLM_PORT` | Local vLLM or NIM inference server |
| Ollama | 11434 | `NEMOCLAW_OLLAMA_PORT` | Local Ollama inference server |

## Configure Ports with a .env File

Copy the example file and edit it to set your preferred ports.

```console
$ cp .env.example .env
```

The `.env.example` file contains all four port variables with their defaults:

```bash
NEMOCLAW_DASHBOARD_PORT=18789
NEMOCLAW_GATEWAY_PORT=8080
NEMOCLAW_VLLM_PORT=8000
NEMOCLAW_OLLAMA_PORT=11434
```

Edit `.env` to change any port.
Ports must be integers in the range 1024 to 65535.
The `.env` file is gitignored and not committed to the repository.

## Configure Ports with Environment Variables

Export the variables directly in your shell instead of using a `.env` file.

```console
$ export NEMOCLAW_DASHBOARD_PORT=28789
$ export NEMOCLAW_VLLM_PORT=9000
$ nemoclaw onboard
```

Shell exports take precedence over `.env` file values.

## Dashboard Port Fallback Chain

The dashboard port checks multiple variables for backward compatibility.
The first defined value wins:

1. `NEMOCLAW_DASHBOARD_PORT`
2. `DASHBOARD_PORT`
3. `PUBLIC_PORT`
4. `18789` (default)

## Check for Port Conflicts

Run the port checker script before onboarding to detect conflicts.

```console
$ scripts/check-ports.sh
```

The script reads your `.env` and `.env.local` files (if present) to resolve the configured ports, then checks each one.
If a port is in use, the output shows the process name and PID holding it.

```text
Checking NemoClaw ports...

  ok        18789 (dashboard)
  CONFLICT  8080 (gateway) — in use by nginx (PID 1234)
  ok        8000 (vllm/nim)
  ok        11434 (ollama)

1 port conflict(s) found.
Set NEMOCLAW_*_PORT env vars or edit .env to use different ports.
```

You can also pass custom ports as arguments to check additional ports.

```console
$ scripts/check-ports.sh 9000 9080
```

The onboarding preflight also checks for port conflicts automatically.

:::{note}
Ports 8080 and 8000 are common conflict sources.
Port 8080 is used by many web servers and proxies.
Port 8000 is used by development servers and other inference tools.
:::

## Next Steps

- [Troubleshooting](troubleshooting.md) for resolving port and onboarding issues.
- [CLI Commands](commands.md) for the full command reference.

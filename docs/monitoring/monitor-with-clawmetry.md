---
title:
  page: "Monitor NemoClaw Sandboxes with ClawMetry"
  nav: "Monitor with ClawMetry"
description: "Use ClawMetry to get structured, persistent observability for your NemoClaw sandboxes from any browser."
keywords: ["monitor nemoclaw", "clawmetry nemoclaw", "nemoclaw observability", "nemoclaw dashboard", "nemoclaw fleet monitoring"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "monitoring", "clawmetry", "nemoclaw", "observability"]
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

# Monitor NemoClaw Sandboxes with ClawMetry

[ClawMetry](https://clawmetry.com/nemoclaw) is an open source observability dashboard for OpenClaw agents. It adds structured, persistent monitoring to NemoClaw sandboxes: every tool call, token cost, memory file change, and cron job — synced to the cloud and accessible from any browser.

NemoClaw's built-in TUI shows live terminal output. ClawMetry complements this with persistent logs, cost tracking, and fleet-level visibility across all your sandboxes.

## Prerequisites

- A running NemoClaw sandbox.
- Python 3.8+ available on the host.
- A ClawMetry account at [app.clawmetry.com](https://app.clawmetry.com) (free to create).

## Install ClawMetry on the Host

Run the ClawMetry installer on the host machine running NemoClaw. It installs ClawMetry, applies the ClawMetry network policy preset to all sandboxes, and connects to ClawMetry Cloud.

```console
$ curl -fsSL https://clawmetry.com/install.sh | bash
```

The installer detects NemoClaw automatically and applies the `clawmetry` preset to each sandbox. This preset allows outbound HTTPS from sandbox processes to `clawmetry.com` for telemetry sync.

To apply the preset manually after installation:

```console
$ bash ~/.local/lib/python*/site-packages/clawmetry/resources/add-nemoclaw-clawmetry-preset.sh
```

## Connect to ClawMetry Cloud

After installation, connect your node to ClawMetry Cloud:

```console
$ clawmetry connect
```

Follow the email OTP prompts to authenticate. ClawMetry generates an encryption key on your machine. Only the encrypted telemetry stream leaves the host. Your prompts, responses, and API keys stay local.

## Open the Dashboard

Open [app.clawmetry.com](https://app.clawmetry.com) in any browser. Your NemoClaw node appears in the fleet view.

The dashboard shows the following for each sandbox:

- Live agent session activity (tool calls, file reads, web fetches)
- Token cost per session, per model, and daily totals
- Memory file diffs (changes to `SOUL.md`, `MEMORY.md`, and other workspace files)
- Cron job status (last run, next run, failures)
- Active OpenShell policy summary

## Apply the ClawMetry Preset Per Sandbox

If you manage sandboxes individually, apply the preset to a specific sandbox:

```console
$ nemoclaw <name> policy-add clawmetry
```

This allows ClawMetry's sync process inside the sandbox to reach `clawmetry.com` for telemetry upload.

## Run ClawMetry Inside a Sandbox

To run a local ClawMetry dashboard from within a sandbox:

```console
$ nemoclaw <name> connect
$ python3 -m venv .venv
$ .venv/bin/pip install clawmetry
$ .venv/bin/clawmetry onboard
$ .venv/bin/clawmetry --host 0.0.0.0 --port 8900 &
```

Access the local dashboard at `http://localhost:8900` via the forwarded port.

## Related Topics

- [Monitor Sandbox Activity](monitor-sandbox-activity.md) for built-in NemoClaw monitoring tools.
- [Network Policies](../network-policy/approve-network-requests.md) for managing egress from sandboxes.
- [ClawMetry for NemoClaw](https://clawmetry.com/nemoclaw) for full documentation.
- [ClawMetry GitHub](https://github.com/vivekchand/clawmetry) for the open source project.

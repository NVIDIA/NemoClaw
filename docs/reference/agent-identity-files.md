---
title:
  page: "NemoClaw Agent Identity Files — SOUL.md, USER.md, and IDENTITY.md"
  nav: "Agent Identity Files"
description: "Understand the agent identity files that OpenClaw creates inside the sandbox, where they are stored, and how to back them up and restore them."
keywords: ["nemoclaw agent identity", "soul.md openclaw", "backup sandbox openclaw", "openclaw workspace files"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "nemoclaw", "agent-identity"]
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

# NemoClaw Agent Identity Files — SOUL.md, USER.md, and IDENTITY.md

OpenClaw creates three Markdown files inside the sandbox that define how the agent behaves, remembers the user, and presents itself.
These files persist across sandbox restarts, but the gateway destroys them when it is torn down.
This page describes the files, where they are stored, and how to back them up.

## The Identity Files

Each file controls a distinct aspect of the agent's behavior and memory.

| File | Purpose |
|---|---|
| `SOUL.md` | The agent's core personality, tone, and behavioral rules. |
| `USER.md` | Preferences, context, and facts the agent learns about you over time. |
| `IDENTITY.md` | The agent's name, role description, and self-presentation. |

OpenClaw reads these files at startup and uses them to shape every response in the session.
You can edit them directly to adjust how the agent behaves.

## File Location

All three files live inside the sandbox at:

```text
/sandbox/.openclaw/workspace/
```

The full paths are:

```text
/sandbox/.openclaw/workspace/SOUL.md
/sandbox/.openclaw/workspace/USER.md
/sandbox/.openclaw/workspace/IDENTITY.md
```

:::{note}
The workspace directory is hidden (`.openclaw`).
The files are not at `/sandbox/SOUL.md` — you must include the full path when downloading or uploading them.
:::

## Persistence Behavior

The table below shows which events preserve the identity files and which destroy them.

| Event | Identity files |
|---|---|
| Sandbox restart | Preserved — the sandbox PVC retains its data. |
| `nemoclaw` CLI restart | Preserved. |
| Gateway destroy (`openshell gateway destroy`) | **Lost** — the PVC is deleted with the gateway. |

Back up the identity files before destroying a gateway if you want to reuse your agent's personality and memory in a future session.

## Back Up the Identity Files

Download the identity files from the sandbox to your local machine:

```console
$ openshell sandbox download <sandbox-name> /sandbox/.openclaw/workspace/SOUL.md ./SOUL.md
$ openshell sandbox download <sandbox-name> /sandbox/.openclaw/workspace/USER.md ./USER.md
$ openshell sandbox download <sandbox-name> /sandbox/.openclaw/workspace/IDENTITY.md ./IDENTITY.md
```

Replace `<sandbox-name>` with the name of your sandbox (the default is `nemoclaw`).

To download all three files in one step, download the entire workspace directory:

```console
$ openshell sandbox download <sandbox-name> /sandbox/.openclaw/workspace/ ./openclaw-workspace-backup/
```

## Restore the Identity Files

Upload previously backed-up identity files into a new or existing sandbox:

```console
$ openshell sandbox upload <sandbox-name> ./SOUL.md /sandbox/.openclaw/workspace/SOUL.md
$ openshell sandbox upload <sandbox-name> ./USER.md /sandbox/.openclaw/workspace/USER.md
$ openshell sandbox upload <sandbox-name> ./IDENTITY.md /sandbox/.openclaw/workspace/IDENTITY.md
```

Restart the agent after uploading so it reads the restored files:

```console
$ nemoclaw <sandbox-name> connect
```

## Edit the Identity Files

You can customize the identity files directly.
Connect to the sandbox and open the file with any text editor available inside the sandbox:

```console
$ nemoclaw <sandbox-name> connect
$ nano /sandbox/.openclaw/workspace/SOUL.md
```

Changes take effect the next time the agent starts a new session.

:::{tip}
Keep a local copy of your edited identity files under version control.
This gives you a history of changes and makes it easy to restore a known-good configuration after a gateway rebuild.
:::

## Next Steps

- [Monitor Sandbox Activity](../monitoring/monitor-sandbox-activity.md) to inspect agent behavior and sandbox health.
- [Customize the Network Policy](../network-policy/customize-network-policy.md) to control which external hosts the agent can reach.
- [Deploy to a Remote GPU Instance](../deployment/deploy-to-remote-gpu.md) for always-on operation with a persistent sandbox.

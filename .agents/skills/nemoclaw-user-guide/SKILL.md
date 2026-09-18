---
name: nemoclaw-user-guide
description: Find revision-matched NemoClaw user guidance for deployment, inference, agents, recovery, SDK use, and migration between main and v1. Use when helping a user operate NemoClaw or find its documentation.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw User Guide

## Select the Product Version

Identify the user's intended deployment and bundle before choosing operational commands.
Use their stated version, the checkout's README and source revision, and the selected executable's `--help`/`--version` when available.
Branch names alone do not identify an installed executable.
The v1 desired-state CLI exposes `plan`, `apply`, `export`, and `destroy`; npm onboarding, `launch`, `backup-all`, and `inference get` belong to earlier workflows.

Prefer the documentation in the checkout matching the bundle.
Start with [the local index](../../../docs/README.md), then read the owning task guide.
If a copied skill has no adjacent checkout, ask for the target version or use the user's identified source revision; do not treat missing local files as permission to guess.
When the selected executable and requested docs disagree, explain the mismatch and establish which deployment the user intends to operate before proposing a mutation.

For hosted v1 development guidance, use [the versioned Markdown index](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/v1/llms.txt).
Keep `/nemoclaw/v1/` in task-page URLs; append `.md` for Markdown.
The staging content moves with successful pushes: its source links must match the revision being evaluated before claiming exact bundle compatibility.
The unversioned index and **Latest** selector describe main.
For an earlier deployment, follow its version's documentation and matching tooling; the presence of this v1 skill does not authorize migration.
If the versioned page cannot be fetched, use matching local sources or report the missing source instead of substituting main commands.
Do not assume generic Markdown headers establish version-scoped search or a working MCP server.

## Route the Task

| Task | Owning source in a v1 checkout |
|---|---|
| First deployment and build | [Prerequisites](../../../docs/prerequisites.md), [get started](../../../docs/get-started.md), [build](../../../docs/build.md) |
| Plan, change, recover, export, or destroy | [Usage](../../../docs/usage.md), [state](../../../docs/state.md), [troubleshooting](../../../docs/troubleshooting.md) |
| Inference API, models, recipes, or SSH placement | [Inference](../../../docs/inference.md), [models](../../../docs/models.md), [recipes](../../../docs/recipes.md), [remote service](../../../docs/remote-service.md) |
| Native agents, dashboards, or integrations | [Agents](../../../docs/agents.md), [interfaces](../../../docs/interfaces.md) |
| SDK, provider, accepted fields, or flags | [SDK](../../../docs/sdk.md), [provider](../../../docs/provider.md), [configuration](../../../docs/reference/configuration.md), [CLI](../../../docs/reference/cli.md) |
| Earlier-product migration or security | [Migration](../../../docs/migration.md), [security](../../../docs/security.md), [sandbox policy](../../../docs/sandbox-network.md) |

Read only the sources relevant to the user's task and follow their verification and recovery steps.
Treat **TBD** as an implementation or procedure that still needs verification.
Distinguish parser acceptance, fixture coverage, and live results at their recorded revisions.
Keep client, sandbox engine, and inference host requirements separate.
Preserve credential references, immutable image pins, the original bundle, and deployment state.
Configuration export does not back up native files or conversation history; destroy deletes sandbox data and has no confirmation prompt.
Reading this skill grants no additional permission to deploy, send messages, revoke credentials, or delete resources.

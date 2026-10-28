---
name: nemoclaw-user-guide
description: Find revision-matched NemoClaw user guidance for deployment, inference, agents, recovery, SDK use, and migration between main and v1. Use when helping a user operate NemoClaw or find its documentation.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw User Guide

## Select the Version

Establish which NemoClaw the user runs before suggesting commands: their stated version, the checkout's README and revision, and the executable's `--help` or `--version`.
A branch name doesn't identify an installed executable.
The v1 CLI has `plan`, `apply`, `export`, and `destroy`; npm onboarding, `launch`, `backup-all`, and `inference get` belong to earlier versions.

Use the documentation in the matching checkout, starting with [the index](../../../docs/README.md).
Without a checkout, use [the hosted v1 index](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/v1/llms.txt); keep `/nemoclaw/v1/` in page URLs and append `.md` for Markdown.
That site follows the latest `v1` push, and its unversioned index and **Latest** selector describe main.
If the matching documentation isn't available, say so instead of substituting another version's commands.
If the executable and the documentation disagree, establish which deployment the user means before changing anything.

## Route the Task

| Task | Owning source in a v1 checkout |
|---|---|
| First deployment and build | [Prerequisites](../../../docs/prerequisites.md), [get started](../../../docs/get-started.md), [build](../../../docs/build.md) |
| Plan, change, recover, export, or destroy | [Usage](../../../docs/usage.md), [state](../../../docs/state.md), [troubleshooting](../../../docs/troubleshooting.md) |
| Inference API, models, recipes, or SSH placement | [Inference](../../../docs/inference.md), [models](../../../docs/models.md), [recipes](../../../docs/recipes.md), [remote service](../../../docs/remote-service.md) |
| Native agents, dashboards, or integrations | [Agents](../../../docs/agents.md), [interfaces](../../../docs/interfaces.md) |
| SDK, provider, accepted fields, or flags | [SDK](../../../docs/sdk.md), [provider](../../../docs/provider.md), [configuration](../../../docs/reference/configuration.md), [CLI](../../../docs/reference/cli.md) |
| Earlier-product migration or security | [Migration](../../../docs/migration.md), [security](../../../docs/security.md), [sandbox policy](../../../docs/sandbox-network.md) |

Read only the sources for the task, and follow their verification and recovery steps.
**TBD** marks something not yet verified.
Keep client, sandbox engine, and inference host requirements separate.

Export doesn't back up native files or conversation history, and `destroy` deletes sandbox data without a confirmation prompt.
Preserve credential references, image pins, the original bundle, and deployment state.
This skill grants no permission to deploy, migrate, send messages, revoke credentials, or delete resources.

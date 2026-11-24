---
name: nemoclaw-user-guide
description: Find revision-matched NemoClaw guidance for deployment, inference, agents, recovery, and SDK use. Use this skill to find operational documentation or evaluate NemoClaw Agent Configs in a separate deployment alongside NemoClaw v0.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw User Guide

## Select the Version

Establish which NemoClaw the user runs before suggesting commands: their stated version, the checkout's README and revision, and the executable's `--help` or `--version`.
A branch name doesn't identify an installed executable.
The NemoClaw Agent Configs CLI has `onboard`, `plan`, `apply`, `export`, and `destroy`. The `onboard` command writes deployment YAML without applying it. npm onboarding, `launch`, `backup-all`, and `inference get` belong to NemoClaw v0.

Use the documentation in the matching checkout, starting with [the index](../../../docs/README.md).
Without a checkout, use the [NemoClaw Agent Configs Markdown index](https://docs.nvidia.com/nemoclaw/v1/llms.txt) for NemoClaw Agent Configs tasks or the [parent NemoClaw Markdown index](https://docs.nvidia.com/nemoclaw/llms.txt) for NemoClaw v0 tasks.
Use the page URLs listed in the index. Confirm that the guide matches the installed version and source revision before suggesting commands.
The local preview shows the Agent Configs guide as **Latest (v1)**.
If the matching documentation isn't available, say so instead of substituting another version's commands.
If the executable and the documentation disagree, establish which deployment the user means before changing anything.

## Route the Task

| Task | Source in a NemoClaw Agent Configs checkout |
|---|---|
| Install and verify a first reply | [Install](../../../docs/get-started/install.md), [prerequisites](../../../docs/get-started/prerequisites.md), [first deployment](../../../docs/get-started/first-deployment.md) |
| Author a new deployment document | [Onboarding](../../../docs/get-started/onboard.md) |
| Build a custom revision | [Build from source](../../../docs/build-deploy/build.md) |
| Plan, change, recover, export, or destroy | [Usage](../../../docs/build-deploy/usage.md), [state](../../../docs/build-deploy/state.md), [troubleshooting](../../../docs/observability/troubleshooting.md) |
| Inference API, models, recipes, or SSH placement | [Inference](../../../docs/agents-inference/inference.md), [models](../../../docs/agents-inference/models.md), [recipes](../../../docs/agents-inference/recipes.md), [remote service](../../../docs/agents-inference/remote-service.md) |
| Native agents, dashboards, or integrations | [Agents](../../../docs/agents-inference/agents.md), [interfaces](../../../docs/agents-inference/interfaces.md) |
| SDK, provider, accepted fields, or flags | [SDK](../../../docs/references/sdk.md), [provider](../../../docs/references/provider.md), [configuration](../../../docs/reference/configuration.md), [CLI](../../../docs/references/cli.md) |
| Evaluate Agent Configs alongside NemoClaw v0 | [Separate deployment guide](../../../docs/get-started/migration.md), [Prepare a separate deployment from a NemoClaw v0 export](../nemoclaw-v0-migration/SKILL.md) |
| Security or network policy | [Security](../../../docs/security/security.md), [sandbox policy](../../../docs/security/sandbox-network.md) |

Read only the sources for the task, and follow their verification and recovery steps.
**TBD** marks something not yet verified.
Keep client, sandbox engine, and inference host requirements separate.

Export doesn't back up native files or conversation history, and `destroy` deletes sandbox data without a confirmation prompt.
Preserve credential references, image pins, the original bundle, and deployment state.
This skill grants no permission to deploy, migrate, send messages, revoke credentials, or delete resources.

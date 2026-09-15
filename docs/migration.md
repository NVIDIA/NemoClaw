<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Assess Migration from an Earlier Version

The desired-state SDK, schema, and state format do not promise compatibility with the earlier product.
The current CLI has no general state adoption or migration command.
Keep the earlier deployment's tooling, configuration, and state while evaluating a separate v1 deployment.

A rehearsed end-to-end upgrade, native-data transfer, and rollback procedure: **TBD**.
Do not treat this scaffold as an in-place upgrade procedure.

## Map the User Task

| Earlier task | Current destination |
|---|---|
| Interactive onboarding and agent-specific aliases | One `nemoclaw` CLI operating on YAML; [get started](get-started.md) |
| Imperative inference or sandbox changes | [Desired-state lifecycle](usage.md), with explicit update/replacement limits |
| Export configuration | `nemoclaw export`; see [CLI reference](reference/cli.md) and [state](state.md) |
| Configure agents, dashboards, tools, or heartbeats | [Agent runtimes](agents.md) and [interfaces](interfaces.md) |
| Integrate a lifecycle library | [Rust SDK](sdk.md); TypeScript API compatibility is **TBD** |
| Snapshot, restore, upload/download, or transfer history | **TBD** — see [native-data preservation](state.md#configuration-export-and-native-data) |
| Manage messaging, MCP servers, or arbitrary plugins | **TBD** — see [additional agent integrations](agents.md#additional-agent-integrations) |
| Provision a model router, managed NIM/llama.cpp, or distributed inference | **TBD** — see [additional inference workflows](inference.md#additional-inference-workflows) |
| Install a telemetry collector or reuse Deep Agents trace-export setup | **TBD** — current [OpenClaw tracing](agents.md#openclaw-tracing) selects an existing collector |

## Keep Deployment Identities Separate

Use a fresh deployment UUID, separate state directory, and resource names/endpoints that do not collide with the earlier deployment.
Copying YAML does not migrate native settings or conversations, and reusing names does not transfer ownership.
Use the [current schema](reference/configuration.md) and images built for the selected features.

The [validator](../crates/nemoclaw-sdk/src/config/validation.rs) rejects unsupported combinations, and [state validation](../crates/nemoclaw-sdk/src/state/mod.rs) rejects incompatible retained intent.
These checks are not a conversion mechanism.

## Preserve Data before Retirement

Export is a configuration operation; it does not back up agent files or history.
**Destroy deletes sandbox files and conversation history.**
Read [state and retention](state.md) before retiring either deployment.

Verified backup/restore procedures, compatibility of native agent data across pinned versions, and a rollback rehearsal: **TBD**.
Retain the earlier deployment until the required continuity has been verified.

## Find Earlier Documentation

Versioned previous-release documentation URLs and old-route redirects: **TBD**.
The [documentation migration plan](design/documentation-migration.md) records the source revisions and publication work; it does not establish runtime migration support.

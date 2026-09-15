<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Assess Migration from an Earlier Version

The desired-state SDK, schema, and state format do not promise compatibility with the earlier product.
The current CLI has no general state adoption or migration command.
Keep the earlier deployment's tooling, configuration, and state while evaluating a separate v1 deployment.

A rehearsed end-to-end upgrade, native-data transfer, and rollback procedure: **TBD**.
The evaluation steps below create a separate deployment; they do not provide an in-place upgrade or data conversion.

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

## Evaluate v1 Beside the Existing Deployment

1. Record the earlier deployment's version, tooling, configuration, state, endpoints, and native data you need to retain.
   Use that version's documentation and tools to inspect it.
2. Check the task mapping above for workflows you rely on.
   If a required integration or continuity procedure is **TBD**, keep the earlier deployment available rather than assuming feature parity.
3. Build a separate matched v1 bundle and images, then prepare a fresh UUID and dedicated state directory using [the first-deployment guide](get-started.md).
   Check names, exposed ports, model capacity, and credentials so the evaluation does not overwrite or exhaust the original deployment's resources.
4. Plan and apply only the new v1 configuration/state.
   Verify the native interface and an actual agent reply, then check configuration export and [unchanged reapply](usage.md#verify-an-unchanged-reapply).
5. Validate each required task in the new deployment before switching use to it.
   An agent reply alone does not validate tools, channels, history continuity, or workload quality.
6. If evaluation fails, continue using the retained earlier deployment and diagnose v1 with its own bundle and state.
   Preview any v1 teardown separately and retain data needed for investigation before destroying its sandbox.

Continuing to use an untouched earlier deployment is not a rollback of data written in v1.
Transfer of those changes back to the earlier runtime remains **TBD**.
Do not retire the old deployment when the required native-data backup, transfer, or return path is unverified.

## Preserve Data before Retirement

Export is a configuration operation; it does not back up agent files or history.
**Destroy deletes sandbox files and conversation history.**
Read [state and retention](state.md) before retiring either deployment.

Verified backup/restore procedures, compatibility of native agent data across pinned versions, and a rollback rehearsal: **TBD**.
Retain the earlier deployment until the required continuity has been verified.

## Find Earlier Documentation

The [combined staging site](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/v1/overview) has a version selector:

- **v1 (Development)** describes the desired-state product.
- **Latest (main)** preserves the imported main guides and their release history; start at its [OpenClaw home](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/user-guide/openclaw/home).

The main snapshot is pinned by the [documentation build](AUTOMATION.md#sources-and-outputs); its label does not qualify those procedures for v1.
Use the earlier deployment's actual version when selecting commands or assessing historical qualification.
Public combined-site cutover and a complete hosted legacy-route/redirect sweep remain **TBD**.
The [documentation migration plan](design/documentation-migration.md) records the source revisions and publication work; it does not establish runtime migration support.

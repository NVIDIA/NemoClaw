<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Assess Migration from an Earlier Version

The desired-state SDK, schema, and state format do not promise compatibility with the earlier product.
The current CLI has no general state adoption or migration command.
Keep the earlier deployment's tooling, configuration, and state while evaluating a separate v1 deployment.

NemoClaw has no upgrade, native-data transfer or rollback procedure: native data belongs to the harness, and moving its storage belongs to the platform.
The evaluation steps below create a separate deployment; they do not provide an in-place upgrade or data conversion.

## Map the User Task

Choose the current owner of the task rather than translating earlier CLI commands literally.

| Earlier task | Current destination |
|---|---|
| Install with npm | Build the native bundle from source; releases are tracked in [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) |
| Interactive onboarding and agent-specific aliases | `nemoclaw onboard` writes deployment YAML for the one `nemoclaw` CLI; see [get started](first-deployment.md) |
| `launch`, `status`, `doctor`, `backup-all`, or `rebuild` | No equivalent commands; the [CLI reference](../references/cli.md) lists the current ones |
| Imperative inference or sandbox changes | [Desired-state lifecycle](../build-deploy/usage.md), with explicit update/replacement limits |
| Export configuration (`config export`) | `nemoclaw export`; see [CLI reference](../references/cli.md) and [state](../build-deploy/state.md) |
| Configure agents, dashboards, tools, or heartbeats | [Agent runtimes](../agents-inference/agents.md) and [interfaces](../agents-inference/interfaces.md) |
| Integrate the TypeScript lifecycle package | [Rust SDK](../references/sdk.md); no compatible TypeScript package is provided |
| Install policy presets, approve network requests interactively, or explain policy to an agent | Declare the [isolated preset or an explicit policy](../security/sandbox-network.md#choose-a-policy); managed approval and explanation: [#12651](https://github.com/NVIDIA/NemoClaw/issues/12651) |
| Use Okta/Entra runtime identity and OAuth refresh | [Register an OpenShell OAuth-refresh provider](../agents-inference/oauth-refresh.md); its manual attachments and refresh material are outside exported deployment YAML |
| Snapshot, restore, upload/download, or transfer history | The platform owns backup and transfer of [mounted agent-data volumes](../build-deploy/state.md#keep-agent-files-on-mounted-volumes); native conversation continuity has harness-specific limits |
| Manage messaging, MCP servers, or arbitrary plugins | Messaging: [#12037](https://github.com/NVIDIA/NemoClaw/issues/12037); MCP servers: [#12137](https://github.com/NVIDIA/NemoClaw/issues/12137); see [additional agent integrations](../agents-inference/agents.md#additional-agent-integrations) |
| Provision a model router, managed NIM/llama.cpp, or distributed inference | Model Router and llama.cpp: [#12035](https://github.com/NVIDIA/NemoClaw/issues/12035); distributed inference: [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641); managed NIM: [#12649](https://github.com/NVIDIA/NemoClaw/issues/12649) |
| Install a telemetry collector or reuse Deep Agents trace-export setup | [#12144](https://github.com/NVIDIA/NemoClaw/issues/12144); [Hermes Relay tracing](../agents-inference/agents.md#hermes-relay-tracing) writes trace artifacts in the sandbox |

## Keep Deployment Identities Separate

Use a fresh deployment UUID, separate state directory, and resource names/endpoints that do not collide with the earlier deployment.
Copying YAML does not migrate native settings or conversations, and reusing names does not transfer ownership.
Use the [field reference for the pinned v1 revision](../references/v1-configuration.md) with its matching schema and images built for the selected features.

The [validator](../../crates/nemoclaw-sdk/src/config/validation.rs) rejects unsupported combinations, and [state validation](../../crates/nemoclaw-sdk/src/state/mod.rs) rejects incompatible retained intent.
These checks are not a conversion mechanism.

## Evaluate v1 Beside the Existing Deployment

Use a separate identity and state directory so the comparison does not mutate an earlier deployment.

1. Record the earlier deployment's version, tooling, configuration, state, endpoints, and native data you need to retain.
   Use that version's documentation and tools to inspect it.
2. Check the task mapping above for workflows you rely on.
   If a workflow you need is in [current limits](../resources/limits.md), keep the earlier deployment available rather than assuming feature parity.
3. Build a separate matched v1 bundle and images, then prepare a fresh UUID and dedicated state directory using [the first-deployment guide](first-deployment.md).
   Check names, exposed ports, model capacity, and credentials so the evaluation does not overwrite or exhaust the original deployment's resources.
4. Plan and apply only the new v1 configuration/state.
   Verify the native interface and an actual agent reply, then check configuration export and [unchanged reapply](../build-deploy/usage.md#verify-an-unchanged-reapply).
5. Validate each required task in the new deployment before switching use to it.
   An agent reply alone does not validate tools, channels, history continuity, or workload quality.
6. If evaluation fails, continue using the retained earlier deployment and diagnose v1 with its own bundle and state.
   Preview any v1 teardown separately and retain data needed for investigation before destroying its sandbox.

Continuing to use an untouched earlier deployment is not a rollback of data written in v1.
NemoClaw has no procedure to transfer those changes back to the earlier runtime.
Do not retire the old deployment when the required native-data backup, transfer, or return path is unverified.

## Preserve Data before Retirement

Export is a configuration operation; it does not back up agent files or history.
**Destroy deletes sandbox writable layers and in-memory conversations.**
Caller-supplied mounted volumes remain under platform control; file retention does not establish native conversation continuity.
Read [state and retention](../build-deploy/state.md) before retiring either deployment.

The platform owns backup, restore and transfer of mounted native data; see the [per-harness retention limits](../build-deploy/state.md#choose-what-to-retain-for-each-harness).
Retain the earlier deployment until the required continuity has been verified.

## Find Earlier Documentation

The [combined staging site](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/v1/overview) has a version selector:

- **v1 (Development)** describes the desired-state product.
- **Latest (main)** preserves the imported main guides and their release history; start at its [OpenClaw home](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/user-guide/openclaw/home).

The main snapshot is pinned by the [documentation build](../../internal-docs/contributing/documentation-build.md#sources-and-outputs); its label does not qualify those procedures for v1.
Use the earlier deployment's actual version when selecting commands or assessing historical qualification.
Publishing the combined site and checking its legacy routes are tracked in [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644).

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Evaluating NemoClaw Agent Configs Alongside NemoClaw v0

Choose how to prepare YAML for a separate deployment. Leave your NemoClaw v0 tools, configuration, and state untouched.

- [Author fresh YAML](onboard.md) if you want to start from CLI suggestions or do not have the report-capable v0 exporter.
- [Start from a configuration export](#starting-from-the-earlier-export) if your v0 CLI supports the report-capable exporter and you want to compare settings.

Neither path adopts the earlier deployment, upgrades it in place, or transfers native data.
The harness owns its data format, and the platform owns its storage. NemoClaw provides no data rollback between the two deployments.

This guide and [current limits](../resources/limits.md) describe current support.
The [roadmap milestones](https://github.com/NVIDIA/NemoClaw/milestones) track planned work, including [planned NemoClaw v0 features for Agent Configs](https://github.com/NVIDIA/NemoClaw/milestone/14).
Milestone placement alone does not promise a delivery date.

## Mapping the User Task

Choose the current owner of the task rather than translating earlier CLI commands literally.

| Earlier task | Current destination |
|---|---|
| Install with npm | [Install the v0.1.0 native bundle](install.md) |
| Interactive onboarding and agent-specific aliases | `nemoclaw onboard` writes deployment YAML for the one `nemoclaw` CLI; see the [onboarding guide](onboard.md) |
| `launch`, `status`, `doctor`, `backup-all`, or `rebuild` | No equivalent commands; the [CLI reference](../references/cli.md) lists the current ones |
| Imperative inference or sandbox changes | [Desired-state lifecycle](../build-deploy/usage.md), with explicit update/replacement limits |
| Export configuration (`config export`) | `nemoclaw export`; see [CLI reference](../references/cli.md) and [state](../build-deploy/state.md) |
| Configure agents, dashboards, tools, or heartbeats | [Agent runtimes](../agents-inference/agents.md) and [interfaces](../agents-inference/interfaces.md) |
| Run custom tools and applications used by the agent inside its sandbox | Package tools and dependencies in a [derived agent image](../build-deploy/derived-images.md); use [mounted volumes](../build-deploy/state.md#keeping-agent-files-on-mounted-volumes) for scripts and persistent data. Configure and verify background-service startup and restart separately. |
| Integrate the TypeScript lifecycle package | [Rust SDK](../references/sdk.md); no compatible TypeScript package is provided |
| Install policy presets, approve network requests interactively, or explain policy to an agent | Declare the [isolated preset or an explicit policy](../security/sandbox-network.md#choosing-a-policy); managed approval and explanation aren't planned ([#12651](https://github.com/NVIDIA/NemoClaw/issues/12651)); OpenShell's policy advisor owns both |
| Use Okta/Entra runtime identity and OAuth refresh | [Register an OpenShell OAuth-refresh provider](../agents-inference/oauth-refresh.md); its manual attachments and refresh material are outside exported deployment YAML |
| Snapshot, restore, upload/download, or transfer history | The platform owns backup and transfer of [mounted agent-data volumes](../build-deploy/state.md#keeping-agent-files-on-mounted-volumes); native conversation continuity has harness-specific limits |
| Manage messaging, MCP servers, or arbitrary plugins | Messaging: [#12037](https://github.com/NVIDIA/NemoClaw/issues/12037); NemoClaw doesn't manage MCP servers; see [additional agent integrations](../agents-inference/agents.md#additional-agent-integrations) |
| Provision a model router, managed NIM/llama.cpp, or distributed inference | Managed [llama.cpp](../agents-inference/models.md#serving-a-pinned-gguf-with-llamacpp) and [native NIM candidate with qualification limits](../agents-inference/models.md#native-nim-candidate): [#14556](https://github.com/NVIDIA/NemoClaw/issues/14556); distributed inference: [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641); the Model Router was retired ([#14066](https://github.com/NVIDIA/NemoClaw/issues/14066)), so configure Switchyard routing through [Hermes Relay](../agents-inference/agents.md#hermes-relay-tracing) |
| Trust private endpoint hosts with `NEMOCLAW_TRUSTED_PRIVATE_HOSTS` | No equivalent: OpenShell's network policy decides which private destinations a sandbox can reach; see [preparing an external endpoint](../agents-inference/inference.md#preparing-an-external-endpoint) |
| Install a telemetry collector or reuse Deep Agents trace-export setup | NemoClaw doesn't provision collectors or export Deep Agents traces; [Hermes Relay tracing](../agents-inference/agents.md#hermes-relay-tracing) writes trace artifacts in the sandbox |

## Keeping Deployment Identities Separate

Use a fresh deployment UUID, separate state directory, and resource names/endpoints that don't collide with the earlier deployment.
Copying YAML doesn't migrate native settings or conversations, and reusing names doesn't transfer ownership.
Use the [field reference](../reference/configuration.md) from the bundle's source revision with its matching schema and images built for the selected features.

The [validator](../../crates/nemoclaw-sdk/src/config/validation.rs) rejects unsupported combinations, and [state validation](../../crates/nemoclaw-sdk/src/state/mod.rs) rejects incompatible retained intent.
These checks aren't a conversion mechanism.

## Starting From the Earlier Export

NemoClaw v0's `nemoclaw config export` writes NemoClaw Agent Configs YAML for one sandbox.
The report-capable exporter assigns a new UUID but keeps the earlier gateway port and writes an image placeholder.
If your version of NemoClaw v0 does not include the report-capable exporter, skip export and [author separate deployment YAML](onboard.md) using the settings you can carry over.
Work from a copy of the export, not the running deployment's files.
The [detailed field mappings](../../.agents/skills/nemoclaw-v0-migration/SKILL.md#5-handle-each-report-entry) cover settings that need harness-specific decisions.

1. On the NemoClaw v0 host, export the sandbox using a CLI that includes the [report-capable exporter](https://github.com/NVIDIA/NemoClaw/pull/14602) from revision `7892283831683e8b8b7a167b5cf1006d7bc262a5`:

   ```sh
   nemoclaw config export SANDBOX --output v0-export.yaml
   ```

   File output requires Linux; on other hosts use `--output -` and redirect it.
   A refused export writes no YAML and prints one `<field> (<category>): <reason>` line per capability it cannot carry, such as messaging or host mounts.
   If export refuses, use the [task map](#mapping-the-user-task) to decide whether a fresh configuration meets your needs.
2. Check the first line for `# nemoclaw-export-report: 1`. If the marker is absent, stop and [author fresh YAML](onboard.md) instead.
3. Copy the export to a new `deployment.yaml`. Edit only this copy.
4. Set `metadata.uid` to a fresh UUID from `uuidgen`.
5. Choose a state directory for the new deployment only.
6. Set a free gateway port in the gateway's compute target. The export keeps the earlier gateway's port.
7. Check the gateway subnet for overlap. If it overlaps, set an unused `networkCIDR` in the target. Any managed service names and published ports also need to avoid collisions.
8. Replace the sandbox's `image.ref` placeholder with a digest from the matching release or [build the image](../build-deploy/build.md#building-agent-images) from the bundle's revision.
9. Match `harness.kind` to the selected image's exact adapter ID. For example, use `nvidia.fabric.openclaw` for the release OpenClaw image.
10. Adapt any explicit policy to the selected image. Use its runtime settings for `filesystem_policy`, `process`, and `landlock`. Keep intended egress rules only where the paths and endpoints still match the new image and deployment. Refer to [image-specific policy checks](../../.agents/skills/nemoclaw-v0-migration/SKILL.md#6-check-the-rest-of-the-document).
11. Review each report entry. Use the [field mappings](../../.agents/skills/nemoclaw-v0-migration/SKILL.md#5-handle-each-report-entry) and the selected image's adapter descriptor to identify settings you can carry over. For example, do not copy v0 sandbox proxy settings or OpenClaw reasoning overrides into Agent Configs. Export does not carry native data or manually attached OAuth refresh material.
12. Record the settings you cannot carry over. If you need any of those settings, keep the earlier deployment available.
13. [Evaluate the new deployment](#evaluating-v1-beside-the-existing-deployment) with its own YAML and state directory.

The skill lists the harnesses and revisions it has been run with.
Deep Agents exports and exports with managed inference services are untested.

<a name="evaluating-v1-beside-the-existing-deployment"></a>

## Evaluating NemoClaw Agent Configs Beside the Existing Deployment

Use a separate identity and state directory so the comparison doesn't mutate an earlier deployment.

1. Record the earlier deployment's version, tooling, configuration, state, endpoints, and native data you need to retain.
   Use that version's documentation and tools to inspect it.
2. Check the task mapping above for workflows you rely on.
   If a workflow you need is in [current limits](../resources/limits.md) or [Out of Scope](../resources/out-of-scope.md), keep the earlier deployment available rather than assuming feature parity.
3. [Install the v0.1.0 bundle](install.md).
4. Confirm that the new deployment has a fresh UUID and dedicated state directory.
5. Check resource names, exposed ports, model capacity, and credential scope for conflicts with the original deployment.
6. [Preview changes](../build-deploy/usage.md#planning-and-applying) using only the new YAML and state directory.
7. Review the changes, deferred checks, and unverified advisories. Resolve unexpected changes or missing prerequisites before apply.
8. Apply the reviewed configuration to the new deployment.
9. [Verify an agent reply](../agents-inference/agents.md#running-one-agent-request).
10. Check [configuration export](../build-deploy/state.md).
11. Check [unchanged reapply](../build-deploy/usage.md#verifying-an-unchanged-reapply).
12. Validate each required task before switching to Agent Configs.
    An agent reply alone doesn't validate tools, channels, history continuity, or workload quality.

If evaluation fails, the earlier deployment remains available. Diagnose Agent Configs with its own bundle and state.

1. Preserve data needed for investigation before removing the evaluation deployment.
2. Follow the [teardown procedure](../build-deploy/usage.md#destroying) for the evaluation deployment only.

Continuing to use an untouched earlier deployment isn't a rollback of data written in NemoClaw Agent Configs.
NemoClaw has no procedure to transfer those changes back to the earlier runtime.
Don't retire the old deployment when the required native-data backup, transfer, or return path is unverified.

## Preserving Data Before Retirement

Export is a configuration operation.
It doesn't back up agent files or history.
**Destroy deletes sandbox writable layers and in-memory conversations.**
Caller-supplied mounted volumes remain under platform control.
File retention doesn't establish native conversation continuity.
Read [state and retention](../build-deploy/state.md) before retiring either deployment.

The platform owns backup, restore, and transfer of mounted native data.
See the [per-harness retention limits](../build-deploy/state.md#choosing-what-to-retain-for-each-harness).
Retain the earlier deployment until the required continuity has been verified.

## Finding Earlier Documentation

The staging site has separate guides for the two products:

- [NemoClaw Agent Configs](https://nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw/v1/overview) covers the desired-state architecture and workflows.
- [NemoClaw v0](https://nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw/v0/user-guide/openclaw/home) covers the previous version and its release history.

Use the earlier deployment's actual version when selecting commands or assessing historical qualification.

If you ran llama.cpp with NemoClaw v0, [the managed GGUF contract](../agents-inference/models.md#serving-a-pinned-gguf-with-llamacpp) uses the repository, revision, file, and SHA-256 to identify the model in NemoClaw Agent Configs.
Revalidate each model, host, and required agent task against the [qualified configuration and its limits](../agents-inference/models.md#serving-a-pinned-gguf-with-llamacpp).

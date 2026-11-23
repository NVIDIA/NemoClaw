<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Assessing Migration From an Earlier Version

The desired-state SDK, schema, and state format do not promise compatibility with the earlier product.
The current CLI has no state adoption or migration command.
To start a v1 deployment from an earlier deployment's settings, [convert its configuration export](#starting-from-the-earlier-export).
Keep the earlier deployment's tooling, configuration, and state while evaluating a separate NemoClaw Agent Configs deployment.

NemoClaw has no upgrade, native-data transfer or rollback procedure: native data belongs to the harness, and moving its storage belongs to the platform.
The evaluation steps below create a separate deployment.
They don't provide an in-place upgrade or data conversion.

## Mapping the User Task

Choose the current owner of the task rather than translating earlier CLI commands literally.

| Earlier task | Current destination |
|---|---|
| Install with npm | Build the native bundle from source; releases are tracked in [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) |
| Interactive onboarding and agent-specific aliases | `nemoclaw onboard` writes deployment YAML for the one `nemoclaw` CLI; see the [onboarding guide](../../crates/nemoclaw-onboarding/README.md) |
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

The earlier product's `nemoclaw config export` writes v1 YAML for one sandbox.
That YAML can't be planned as written: its image is a placeholder, and it reuses the earlier deployment's identity and gateway port.
The [V0 migration skill](../../.agents/skills/nemoclaw-v0-migration/SKILL.md) completes it; an assistant with this checkout can follow it, or you can follow its steps yourself.
It leaves the earlier deployment untouched and moves no native data.

1. On the earlier deployment's host, export the sandbox with the CLI of a V0 release with the export report:

   ```sh
   nemoclaw config export SANDBOX --output v0-export.yaml
   ```

   File output requires Linux; on other hosts use `--output -` and redirect it.
   A refused export writes no YAML and prints one `<field> (<category>): <reason>` line per capability it cannot carry, such as messaging or host mounts.
   Check those capabilities in the task map above before continuing without them.
2. Read the comment block at the top of the export.
   Each line names a setting the export left out, replaced with a placeholder, or rewrote.
   An export without the first line `# nemoclaw-export-report: 1` comes from a release without the report; export again with a release that writes it.
3. Ask the assistant to read `.agents/skills/nemoclaw-v0-migration/SKILL.md` and complete the export.
   It assigns a fresh UUID, state directory, and free gateway port, selects an agent image, replaces the parts of the policy that describe the earlier image, writes the settings v1 can hold, and lists the ones it can't.
4. Review the completed YAML and the list of lost settings, then plan it as step 4 below describes.

The skill lists the harnesses and revisions it has been run with.
Deep Agents exports and exports with managed inference services are untested.

## Evaluating v1 Beside the Existing Deployment

Use a separate identity and state directory so the comparison doesn't mutate an earlier deployment.

1. Record the earlier deployment's version, tooling, configuration, state, endpoints, and native data you need to retain.
   Use that version's documentation and tools to inspect it.
2. Check the task mapping above for workflows you rely on.
   If a workflow you need is in [current limits](../resources/limits.md) or [Out of Scope](../resources/out-of-scope.md), keep the earlier deployment available rather than assuming feature parity.
3. Build a separate matched v1 bundle and images, then prepare a fresh UUID and dedicated state directory using [the first-deployment guide](first-deployment.md).
   Check names, exposed ports, model capacity, and credentials so the evaluation doesn't overwrite or exhaust the original deployment's resources.
4. Plan and apply only the new v1 configuration/state.
   Verify the native interface and an actual agent reply, then check configuration export and [unchanged reapply](../build-deploy/usage.md#verifying-an-unchanged-reapply).
5. Validate each required task in the new deployment before switching use to it.
   An agent reply alone doesn't validate tools, channels, history continuity, or workload quality.
6. If evaluation fails, continue using the retained earlier deployment and diagnose v1 with its own bundle and state.
   Preview any v1 teardown separately and retain data needed for investigation before destroying its sandbox.

Continuing to use an untouched earlier deployment isn't a rollback of data written in v1.
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

The [combined staging site](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/v1/overview) has a version selector:

- **v1 (Development)** describes the desired-state product.
- **Latest (main)** preserves the imported main guides and their release history.
  Start at its [OpenClaw home](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/user-guide/openclaw/home).

The main snapshot is pinned by the [documentation build](../../internal-docs/contributing/documentation-build.md#sources-and-outputs).
Its label doesn't qualify those procedures for v1.
Use the earlier deployment's actual version when selecting commands or assessing historical qualification.
Publishing the combined site and checking its legacy routes are tracked in [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644).

For Classic llama.cpp users, [the managed GGUF contract](../agents-inference/models.md#serving-a-pinned-gguf-with-llamacpp) carries repository/revision/file/SHA-256 identity into v1.
Revalidate each model, host, and required agent task against the [qualified configuration and its limits](../agents-inference/models.md#serving-a-pinned-gguf-with-llamacpp).

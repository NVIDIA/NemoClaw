<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Assess Migration from an Earlier Version

The desired-state SDK, schema, and state format do not promise compatibility with the earlier product.
The current CLI has no general state adoption or migration command.
Keep the earlier deployment's tooling, configuration, and state while evaluating a separate v1 deployment.

There is no rehearsed upgrade, native-data transfer or rollback procedure yet ([#12639](https://github.com/NVIDIA/NemoClaw/issues/12639)).
The evaluation steps below create a separate deployment; they do not provide an in-place upgrade or data conversion.

## Move from the Combined Kubernetes Gateway Resource

This policy applies to managed Kubernetes and OpenShift deployments created before the native Helm provider graph.
Their `nemoclaw_kubernetes_gateway.runtime` resource owned both chart installation and gateway observation.
The new graph requires separate authentication and `helm_release.gateway` bindings, so an existing combined gateway binding cannot establish ownership in the new graph.
The [scope decision](design/scope.md#responsibilities) permits rejecting incompatible state; it does not authorize adopting its resources.

There is no in-place state conversion or retained-storage adoption procedure for this transition.
Keep the original bundle, YAML, entire state directory including `runtime/`, and agent data needed by the earlier deployment.
Its original bundle still requires the Helm CLI and the same referenced kubeconfig, context, and credentials for recovery or teardown.
Use the replacement bundle only with a separate deployment.

From the directory containing the original deployment YAML, set the paths to the two verified bundles:

```sh
original_bundle=/absolute/path/to/original-bundle
replacement_bundle=/absolute/path/to/replacement-bundle
```

In these examples, the existing files are `original-kubernetes.yaml` and `.local/original-kubernetes`; substitute the actual original paths.
If an original apply was interrupted, correct its cause and follow [operation recovery](usage.md#recover-an-interrupted-operation) with the original bundle and state:

```sh
"$original_bundle/bin/nemoclaw" --bundle "$original_bundle" \
  apply --state-dir .local/original-kubernetes original-kubernetes.yaml
```

If destroy already began, resume the original bundle's `destroy` command instead of applying.
If ownership or recovery checks fail, retain the original state and resolve the error before proceeding with that deployment.
Do not import, remove, or rewrite OpenTofu bindings to bypass the transition boundary.

Prepare `provider-kubernetes.yaml` using the replacement bundle's schema and image metadata, with a fresh `metadata.uid`, an unused Kubernetes namespace, and a new state directory `.local/provider-kubernetes`.
If both deployments remain available, choose a different gateway loopback port.
Keep the authored kubeconfig and context explicit; the platform prerequisites remain operator-owned.
These choices create new resources and do not transfer data or ownership from the earlier deployment.

Preview the separate deployment with the replacement bundle:

```sh
"$replacement_bundle/bin/nemoclaw" --bundle "$replacement_bundle" \
  plan --verbose --state-dir .local/provider-kubernetes provider-kubernetes.yaml
```

The runtime plan should create separate storage, authentication, Helm release, and gateway-observation resources in the new namespace.
The OpenShell stage may remain deferred until its gateway is available.
After reviewing that plan, apply the same configuration and state:

```sh
"$replacement_bundle/bin/nemoclaw" --bundle "$replacement_bundle" \
  apply --state-dir .local/provider-kubernetes provider-kubernetes.yaml
```

On failure, keep the replacement bundle, YAML, and state together and use that deployment's [recovery procedure](usage.md#recover-an-interrupted-operation).
The current Fabric health limitation still applies; this transition does not establish working inference or transfer native agent data.

Retire the original deployment only after preserving needed native data and validating the replacement for its intended use.
**Destroy deletes the original sandbox's files and conversation history.**
Preview its removal with the original bundle:

```sh
"$original_bundle/bin/nemoclaw" --bundle "$original_bundle" \
  plan --destroy --state-dir .local/original-kubernetes
```

After reviewing the removal and retention effects, run:

```sh
"$original_bundle/bin/nemoclaw" --bundle "$original_bundle" \
  destroy --state-dir .local/original-kubernetes
```

The original namespace, encryption key, persistent volumes, and local state remain retained; successful destroy does not make them available for adoption by the replacement deployment.
Keep the original state and bundle to account for them.
Agent-data transfer and complete retained-resource cleanup remain outside this procedure; see [data preservation](state.md#configuration-export-and-agent-data) and [retention](state.md#deletion-and-retention).

## Map the User Task

| Earlier task | Current destination |
|---|---|
| Install with npm | Build the native bundle from source; releases are tracked in [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) |
| Interactive onboarding and agent-specific aliases | `nemoclaw onboard` writes deployment YAML for the one `nemoclaw` CLI; see [get started](get-started.md) |
| `launch`, `status`, `doctor`, `backup-all`, or `rebuild` | No equivalent commands; the [CLI reference](reference/cli.md) lists the current ones |
| Imperative inference or sandbox changes | [Desired-state lifecycle](usage.md), with explicit update/replacement limits |
| Export configuration (`config export`) | `nemoclaw export`; see [CLI reference](reference/cli.md) and [state](state.md) |
| Configure agents, dashboards, tools, or heartbeats | [Agent runtimes](agents.md) and [interfaces](interfaces.md) |
| Integrate the TypeScript lifecycle package | [Rust SDK](sdk.md); no compatible TypeScript package is provided |
| Install policy presets, approve network requests interactively, or explain policy to an agent | Declare the [isolated preset or an explicit policy](sandbox-network.md#choose-a-policy); managed approval and explanation: [#12651](https://github.com/NVIDIA/NemoClaw/issues/12651) |
| Use Okta/Entra runtime identity and OAuth refresh | [#12652](https://github.com/NVIDIA/NemoClaw/issues/12652); provider authentication references do not replace it |
| Snapshot, restore, upload/download, or transfer history | No v1 equivalent yet ([#12639](https://github.com/NVIDIA/NemoClaw/issues/12639)); see [agent-data preservation](state.md#configuration-export-and-agent-data) |
| Manage messaging, MCP servers, or arbitrary plugins | Messaging: [#12037](https://github.com/NVIDIA/NemoClaw/issues/12037); MCP servers: [#12137](https://github.com/NVIDIA/NemoClaw/issues/12137); see [additional agent integrations](agents.md#additional-agent-integrations) |
| Provision a model router, managed NIM/llama.cpp, or distributed inference | Model Router and llama.cpp: [#12035](https://github.com/NVIDIA/NemoClaw/issues/12035); distributed inference: [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641); managed NIM: [#12649](https://github.com/NVIDIA/NemoClaw/issues/12649) |
| Install a telemetry collector or reuse Deep Agents trace-export setup | [#12144](https://github.com/NVIDIA/NemoClaw/issues/12144); [OpenClaw tracing](agents.md#openclaw-tracing) selects an existing collector |

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
   If a workflow you need is in [current limits](limits.md), keep the earlier deployment available rather than assuming feature parity.
3. Build a separate matched v1 bundle and images, then prepare a fresh UUID and dedicated state directory using [the first-deployment guide](get-started.md).
   Check names, exposed ports, model capacity, and credentials so the evaluation does not overwrite or exhaust the original deployment's resources.
4. Plan and apply only the new v1 configuration/state.
   Verify the native interface and an actual agent reply, then check configuration export and [unchanged reapply](usage.md#verify-an-unchanged-reapply).
5. Validate each required task in the new deployment before switching use to it.
   An agent reply alone does not validate tools, channels, history continuity, or workload quality.
6. If evaluation fails, continue using the retained earlier deployment and diagnose v1 with its own bundle and state.
   Preview any v1 teardown separately and retain data needed for investigation before destroying its sandbox.

Continuing to use an untouched earlier deployment is not a rollback of data written in v1.
Transferring those changes back to the earlier runtime is tracked in [#12639](https://github.com/NVIDIA/NemoClaw/issues/12639).
Do not retire the old deployment when the required native-data backup, transfer, or return path is unverified.

## Preserve Data before Retirement

Export is a configuration operation; it does not back up agent files or history.
**Destroy deletes sandbox files and conversation history.**
Read [state and retention](state.md) before retiring either deployment.

Backup and restore of native agent data are tracked in [#12639](https://github.com/NVIDIA/NemoClaw/issues/12639).
Retain the earlier deployment until the required continuity has been verified.

## Find Earlier Documentation

The [combined staging site](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/v1/overview) has a version selector:

- **v1 (Development)** describes the desired-state product.
- **Latest (main)** preserves the imported main guides and their release history; start at its [OpenClaw home](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/user-guide/openclaw/home).

The main snapshot is pinned by the [documentation build](contributing/documentation-build.md#sources-and-outputs); its label does not qualify those procedures for v1.
Use the earlier deployment's actual version when selecting commands or assessing historical qualification.
Publishing the combined site and checking its legacy routes are tracked in [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644).

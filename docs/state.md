<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Locate and Preserve Deployment State

Keep the desired-state YAML, its matching bundle, and the entire deployment state directory for recovery.
The CLI defaults to `.nemoclaw` in the working directory; use `--state-dir` to select another directory.
Separate deployments need separate state directories and deployment UUIDs.

## Named Sandbox Resources

Intent version 3 identifies sandboxes and providers by name rather than their position in the document.
Reordering sandboxes, agents, providers, or model choices does not change their resource addresses or the intent digest.
Sandbox-local providers receive identities derived from their sandbox and provider names; moving a definition between scopes can change its identity.
Intent versions 1 and 2 are rejected without rewriting state.
Keep the original bundle for recovery or teardown, then use a fresh UUID and state directory with the new bundle.
Do not edit the intent version to bypass this check.
Existing agent files and conversations are not migrated.

## Native Inference Migration

The earlier intent version 2 introduced native provider endpoints and sandbox provider attachments.
Intent version 1 is rejected before reconciliation; its files are retained unchanged.
Keep the previous bundle and OpenShell gateway available for export, recovery, or teardown of the old deployment.
Do not edit the intent version or remove route entries from OpenTofu state manually.
Create the replacement against a separate gateway running the new pinned revision, with a fresh deployment UUID and state directory.
Preserve the old gateway endpoint and state until the replacement is verified, then retire the original through its original bundle.
Upgrading the old gateway first removes the upstream managed-route API and prevents that recovery path.
Native agent data is not migrated by this procedure.

## Local Deployment Files

These files are managed by the SDK and OpenTofu.
They are implementation details for identifying retained state, not a manual editing interface.

| Location under the state directory | Purpose |
|---|---|
| `intent.json` | Desired document, ownership generations, digest, and operation progress |
| `deployment.lock` | Excludes concurrent NemoClaw operations on this state directory |
| `terraform.tfstate` | OpenTofu resource state and durable bindings |
| `main.tf.json`, `providers.tfrc` | SDK-generated graph and provider configuration |
| `runtime/` | Separate managed-runtime stage and its retained state, when applicable |

The [state store](../crates/nemoclaw-sdk/src/state/mod.rs) and [deployment lifecycle](../crates/nemoclaw-sdk/src/deployment/mod.rs) define these files.
Keep the whole directory after failure; deleting state does not establish that its runtime resources are absent.
The local lock does not exclude other clients of the same gateway.

## Native Agent Files

These paths are inside the sandbox, not the client's deployment state directory.
Use authenticated [native access](interfaces.md) for the selected deployment.

| Native data | Location and lifetime |
|---|---|
| OpenClaw configuration and native state | `/sandbox/.openclaw`; includes `openclaw.json` and, when a dashboard is declared, `interface-token` |
| Declared OpenClaw agents' working files | `/sandbox/workspaces/<agent-name>` |
| Default local Hermes API/native state | `/sandbox/.hermes`; includes the API `interface-token` |
| Default local Hermes dashboard and browser-chat state | `/sandbox/.hermes/profiles/dashboard-home`; separate from the API conversation |
| Experimental Hermes Relay traces | `/sandbox/artifacts/relay`; per-session event/trajectory files; deleted with the sandbox |
| Experimental Hermes Relay native home | `.fabric/hermes/runtimes/<runtime-id>` under the configured Fabric artifact root; distinct from the local Hermes API/dashboard homes |
| Pi conversation | Held in the running Pi process; changing its model or restarting the runtime loses the in-memory conversation |

The [OpenClaw adapter](../image/fabric/openclaw_adapter.py) and [interface guide](interfaces.md) define these locations.
Native state can survive a process restart while its files remain; deleting the sandbox deletes its files.
Separate agent workspaces within one sandbox are not separate security boundaries.
File/history locations and restoration procedures for the other harnesses: **TBD**.

## Configuration Export and Native Data

Export produces checked desired-state YAML with credential references.
It does not copy agent files, histories, native settings, or model weights.
Use [the export workflow](usage.md) for configuration and [native agent access](agents.md) to identify agent-owned state.

Native-data backup and restore procedures for each harness: **TBD**.
Portable snapshots and restore into another deployment: **TBD**.
The current CLI has no snapshot or lost-state adoption command.

## Deletion and Retention

**Destroy deletes sandbox files and conversation history.**
The [destroy guide](usage.md#destroy) owns the workload removal, retained-storage, and recovery procedure.
The retained OpenShell workspace resource does not imply that sandbox files survive.

Credentials can also remain in retained runtime storage.
See [managed vLLM authentication](inference.md#authenticate-a-managed-vllm-service), [Ollama proxy credentials](inference.md#use-external-ollama-through-a-managed-proxy), and [security](security.md) before retiring storage.

A complete inventory and verified manual removal procedure for retained resources: **TBD**.
There is no current purge command.

### Understand the Retained Resources

| Resource or data | Result of a completed destroy |
|---|---|
| Sandbox and its native files, settings, tokens, and conversations | Deleted |
| Deployment provider profiles and registrations, including declared Brave integration resources | Removed; upstream keys are not revoked |
| External gateway, inference service, external Ollama daemon/model, and externally owned engine/network | Remain under their operators' control |
| OpenShell workspace | Retained and tracked; does not preserve the deleted sandbox's files |
| Managed vLLM/Ollama process containers | Removed; model storage remains tracked |
| Managed model downloads and prepared data | Retained; authenticated vLLM storage can also contain its generated key |
| Managed Ollama proxy | Container removed; tracked credential volume retained |
| Managed gateway | Process removed; database, signing/encryption keys, bridge, and stopped initializer retained |
| Local deployment state, bundle, and container images | Remain; removing the CLI bundle is separate from destroying its deployment |

The [teardown implementation](../crates/nemoclaw-sdk/src/deployment/runtime/teardown.rs) selects retained bindings.
Destroy's JSON `retained` list identifies tracked resource addresses; it is not an inventory of every host file or externally owned resource.
Record those addresses and keep the state directory if you need to account for retained storage later.

## Recovery and Transfer

Use [operation recovery](usage.md#updates-and-recovery) with the original configuration and retained state.
For a move from an earlier product version, use [migration](migration.md).
Cross-host state transfer and a verified old-to-new native-data migration procedure: **TBD**.

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Locate and Preserve Deployment State

Keep the desired-state YAML, its matching bundle, and the entire deployment state directory for recovery.
The CLI defaults to `.nemoclaw` in the working directory; use `--state-dir` to select another directory.
Separate deployments need separate state directories and deployment UUIDs.

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

## Recovery and Transfer

Use [operation recovery](usage.md#updates-and-recovery) with the original configuration and retained state.
For a move from an earlier product version, use [migration](migration.md).
Cross-host state transfer and a verified old-to-new native-data migration procedure: **TBD**.

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Architecture Overview

NemoClaw translates a desired-state document into resources for one or more agent sandboxes. Its CLI and Rust SDK coordinate a deployment; OpenTofu orders resource changes and records resource state. OpenShell supplies the gateway, sandbox isolation, provider registration, and inference routing. Fabric configures and runs the agent harness inside each sandbox. The model endpoint may be externally operated or a service that NemoClaw manages on a supported Docker engine. See [the ecosystem](ecosystem.md) for the boundary with each upstream component.

## Follow a Deployment

A deployment separates resource reconciliation from agent invocation. Follow these stages to identify which check establishes which result.

1. You write a YAML document that declares a gateway, inference connections, named sandboxes, and one Fabric agent for each sandbox. Select a bundle and image from the same source revision; see [the first deployment](../get-started/first-deployment.md).
2. The SDK validates the document, checks saved deployment state and resource identities, and compiles an OpenTofu graph. `plan` previews changes without mutating runtime resources. `apply` checks its own plan before reconciling resources through the bundled providers. Keep the state and bundle for [recovery](../build-deploy/usage.md#recover-an-interrupted-operation).
3. The OpenShell gateway runs each sandbox, with Fabric and the selected agent harness in its image. OpenShell routes requests from a sandbox to its attached inference provider. Fabric's adapter owns native input, output, tools, and process behavior. NemoClaw's CLI does not send an agent prompt; use a [native invocation](../agents-inference/agents.md#choose-native-access).
4. Apply checks configuration and resource readiness. Only a subsequent agent invocation can verify that a particular agent and model reply. For available evidence and its limits, see [diagnosis](../observability/troubleshooting.md#inference-and-agent-readiness).

## Understand Ownership and Data Lifetime

OpenTofu and the NemoClaw providers reconcile owned resources. Operators retain control of external gateways and endpoints. Deployment state binds resources to a UID and preserves recovery information; export preserves configuration, not native agent data. Sandbox replacement or destroy can delete writable files and conversation history. Mounted volumes and other retained resources need separate [retention and cleanup](../build-deploy/state.md#deletion-and-retention). An incomplete observation or ownership mismatch is not evidence that a resource is absent.

This overview describes the implementation inspected at `origin/v1` revision `86b8d94273a76a696e06b300dc29f7035b163667`: `crates/nemoclaw-sdk/src/deployment/mod.rs`, `crates/nemoclaw-sdk/src/compile.rs`, and `crates/nemoclaw-sdk/src/config/types.rs`. The [internal architecture](../../internal-docs/design/architecture.md) records detailed design rationale. Source inspection does not establish a live deployment or agent response.

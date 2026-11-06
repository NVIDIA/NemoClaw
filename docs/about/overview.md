<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Overview

NemoClaw manages agent deployments from desired-state YAML. You can preview and reconcile a deployment with its CLI, or integrate the same operations into a Rust application. It combines OpenShell sandbox isolation and inference routing with Fabric-managed agent runtimes. Keeping deployment state lets you check changes and recover interrupted operations; it does not back up agent files or conversations.

## What You Can Do

The inspected v1 implementation supports these workflows; use a bundle and agent image built from the same source revision as your configuration.

- [Deploy an OpenClaw agent](../get-started/first-deployment.md) with an existing gateway and model endpoint, then send a native request to verify the reply.
- [Manage multiple sandboxes](../build-deploy/usage.md#configure-sandboxes-and-inference), each with one agent, and connect them to hosted or managed inference providers.
- [Plan, apply, export, and destroy](../build-deploy/usage.md) resources, with retained state for recovery and separate cleanup for persistent data.
- [Use the Rust SDK](../references/sdk.md) to integrate deployment operations, or [deploy to Kubernetes or OpenShift](../build-deploy/kubernetes.md) when the cluster prerequisites are available.

The CLI does not invoke agents, manage channels, or take snapshots. An apply checks configuration and runtime readiness, not a model response. Refer to [native agent access](../agents-inference/agents.md#choose-native-access) and [current limits](../resources/limits.md) before choosing a workflow. v1 has no published release or support policy established by these sources; refer to [Release Notes](release-notes.md).

## Where to Start

For a first deployment, [check prerequisites](../get-started/prerequisites.md) and follow the [guided OpenClaw deployment](../get-started/first-deployment.md). For a different environment, [Architecture Overview](architecture-overview.md) explains the deployment flow and ownership, and [Ecosystem](ecosystem.md) distinguishes the adjacent products. Before changing an existing deployment, [review data retention](../build-deploy/state.md#deletion-and-retention) and [recovery](../build-deploy/usage.md#updates-and-recovery).

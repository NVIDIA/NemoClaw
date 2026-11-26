<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Overview

NemoClaw Agent Configs uses a desired-state model to deploy sandboxed agents.
In YAML, you declare the agents, sandboxes, and inference connections you want so you can review changes before applying them.
Use the CLI to preview and apply the changes, or integrate the same operations into a Rust application.
It combines NVIDIA OpenShell sandbox isolation and inference routing with agent runtimes managed by NVIDIA NeMo Fabric.
Deployment state lets you check changes and recover interrupted operations, but it does not back up agent files or conversations.

## What You Can Do

Use the v0.1.0 bundle, configuration schema, and agent image together. The following workflows cover first deployment and ongoing operations:

- [Deploy an OpenClaw agent](../get-started/first-deployment.md) with local Docker and NVIDIA Endpoints, then send a native request to verify the reply.
- [Manage multiple sandboxes](../build-deploy/usage.md#configuring-sandboxes-and-inference), each with one agent, and connect them to hosted or managed inference providers.
- [Plan, apply, export, and destroy](../build-deploy/usage.md) resources, with retained state for recovery and separate cleanup for persistent data.
- [Using the Rust SDK](../references/sdk.md) to integrate deployment operations, or deploy to [Kubernetes](../build-deploy/kubernetes.md) or [OpenShift](../build-deploy/openshift.md) when the cluster prerequisites are available.
- [Use the providers from your own OpenTofu project](../build-deploy/opentofu-project.md), with your own pipelines and state backend, instead of the CLI or SDK.

The CLI doesn't invoke agents, manage channels, or take snapshots. An apply checks configuration and runtime readiness, not a model response. Refer to [native agent access](../agents-inference/agents.md#choosing-native-access) and [current limits](../resources/limits.md) before choosing a workflow.
Refer to [Release Notes](../changelog/overview.md).

## Where to Start

If you use NemoClaw v0, start with [Evaluating NemoClaw Agent Configs Alongside NemoClaw v0](../get-started/migration.md).

The [guided OpenClaw deployment](../get-started/first-deployment.md) leads from CLI installation to a verified reply. For a separate deployment of your own, use [interactive YAML authoring](../get-started/onboard.md). For a different environment, [Architecture Overview](architecture-overview.md) explains the deployment flow and ownership, and [Ecosystem](ecosystem.md) distinguishes the adjacent products. Before changing an existing deployment, [review data retention](../build-deploy/state.md#deletion-and-retention) and [recovery](../build-deploy/usage.md#updates-and-recovery).

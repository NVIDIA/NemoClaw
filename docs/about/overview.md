<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Overview

NVIDIA NemoClaw is an open source reference stack for running supported AI agents in NVIDIA OpenShell sandboxes.
NemoClaw Agent Configs (v1) lets you capture the gateway, model connections, sandbox policies, and agent settings in reusable YAML.
Start from a reference configuration, adapt it to your task, and share the file so another developer can reproduce the setup.
Use the CLI or Rust SDK to preview resource changes before applying them.

## What You Can Do

- **Run a sandboxed assistant.** [Deploy OpenClaw](../get-started/first-deployment.md) with local Docker and NVIDIA Endpoints, then send a request and check the reply.
- **Repeat or compare an evaluation.** Adapt a [reference configuration](../../examples/README.md) by changing the instructions, tools, model connection, or access policy for a representative task. Share the YAML so another developer can run that setup, or run the same task with another supported model or harness and compare the results. Check [current limits](../resources/limits.md) for your image, adapter, model, and platform.
- [**Run independent agents side by side.**](../agents-inference/agents.md#deploying-several-agents) Define one agent per sandbox with its own settings and access policy. Reuse an inference provider definition where the agents need the same endpoint.
- **Review changes before deployment.** [Plan, apply, export, and destroy](../build-deploy/usage.md) through the same workflow. Review the plan for replacements and retain deployment state for recovery. Export preserves deployment configuration. Use [mounted storage and backups](../build-deploy/state.md#keeping-agent-files-on-mounted-volumes) for agent files that must survive sandbox replacement.

For a supported Hermes setup, [configure NeMo Relay tracing and Switchyard routing](../agents-inference/agents.md#hermes-relay-tracing) using the harness settings.
For automation, use the [Rust SDK](../references/sdk.md) or [OpenTofu providers](../build-deploy/opentofu-project.md).
For cluster deployments, check the [Kubernetes](../build-deploy/kubernetes.md) or [OpenShift](../build-deploy/openshift.md) prerequisites.

## Where to Start

For a new deployment, use the [v0.1.0 CLI bundle](../get-started/install.md), configuration schema, and agent image together.
Start with the [OpenClaw tutorial](../get-started/first-deployment.md) or use [interactive YAML authoring](../get-started/onboard.md) to create a configuration for your setup.
Refer to the [release notes](../changelog/overview.md) for release-specific changes.

If you already use NemoClaw v0, [evaluate Agent Configs in a separate deployment](../get-started/migration.md).
Check that it supports the capabilities your workflow needs and verify an agent response before switching.
For component roles, refer to [Ecosystem](ecosystem.md#understanding-each-component).
For deployment flow, refer to [Architecture Overview](architecture-overview.md).

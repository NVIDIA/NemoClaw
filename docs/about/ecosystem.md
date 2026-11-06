<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Ecosystem

NemoClaw combines deployment management, OpenShell sandbox controls, and NeMo Fabric agent execution.
You use NemoClaw to configure and operate the deployment, then send requests to the running agent through Fabric.

## Understand Each Component

Choose the component responsible for the action you need rather than assuming NemoClaw owns every runtime operation.

| Component | Responsibility |
|---|---|
| NemoClaw | Turn desired-state YAML into deployment resources, connect inference, and retain deployment state for recovery. |
| [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) | Manage sandboxes, enforce filesystem, process, and network policy, and deliver provider credentials at authorized destinations. |
| [NVIDIA NeMo Fabric](https://docs.nvidia.com/nemo/fabric/) | Discover agent adapters, validate and map their native configuration, and start, invoke, and stop agent runtimes. |
| Agent harness, such as OpenClaw, Hermes, or Pi | Handle user requests, call models and tools, and manage its native sessions and behavior. |
| Inference service | Serve model requests through a hosted endpoint or a managed service such as Ollama or vLLM. |

NemoClaw's CLI and Rust SDK use [OpenTofu](../references/provider.md) to order resource operations and record resource state.
OpenShell enforces the sandbox's access controls while Fabric runs the selected harness inside it.
The [accepted scope](../../internal-docs/design/scope.md#upstream-boundaries) defines these ownership boundaries.

For the configuration-to-request flow, refer to [Architecture Overview](architecture-overview.md). Use [desired-state operations](../build-deploy/usage.md) to change deployment resources and [native agent access](../agents-inference/agents.md#choose-native-access) to send requests.

## Choose Where to Start

Start with the guide for the component that owns your task.

| Your task | Starting point |
|---|---|
| Deploy and manage agents with gateway, inference, policy, and state in one configuration | NemoClaw's [prerequisites](../get-started/prerequisites.md) and [first deployment](../get-started/first-deployment.md). |
| Build an application or evaluation that invokes different harnesses through a common API | [Fabric documentation](https://docs.nvidia.com/nemo/fabric/); your application owns its deployment workflow. |
| Run a workload in a sandbox and configure its image, policy, and agent integration yourself | [OpenShell documentation](https://docs.nvidia.com/openshell/). |

Fabric can be used independently of NemoClaw, and OpenShell can sandbox workloads that do not use Fabric.
In NemoClaw, the agent images include Fabric and the selected harness; follow [the image build guide](../build-deploy/build.md#build-agent-images) for this deployment path.

## Match the Components to Your Deployment

Use the bundle, image, schema, and documentation from the same NemoClaw revision.
An adapter available in Fabric does not establish compatibility with your NemoClaw image, model, or platform.
Check [Fabric harnesses](../references/fabric-harnesses.md), [compatibility across releases](../references/compatibility.md), and [current limits](../resources/limits.md) before choosing a configuration.

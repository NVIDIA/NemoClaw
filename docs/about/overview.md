---
title:
  page: "NemoClaw Overview: What It Is"
  nav: "Overview"
description:
  main: "NemoClaw is an open-source reference stack that simplifies running OpenClaw always-on assistants more safely."
  agent: "Explains what NemoClaw covers: onboarding, lifecycle management, and OpenClaw operations within OpenShell containers, plus capabilities and why it exists. Use when users ask what NemoClaw is or what the project provides. For ecosystem placement or OpenShell-only paths, use the Ecosystem page; for internal mechanics, use How It Works."
keywords: ["nemoclaw overview", "openclaw always-on assistants", "nvidia openshell", "nvidia nemotron"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "inference_routing", "blueprints"]
content:
  type: concept
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Overview

NVIDIA NemoClaw is an open-source reference stack that simplifies running [OpenClaw](https://openclaw.ai) always-on assistants.
NemoClaw provides onboarding, lifecycle management, and OpenClaw operations within OpenShell containers.
It incorporates policy-based privacy and security guardrails, giving you control over your agents’ behavior and data handling.
This enables self-evolving claws to run more safely in clouds, on prem, RTX PCs and DGX Spark.

NemoClaw pairs open-source and hosted models (for example [NVIDIA Nemotron](https://build.nvidia.com)) with a hardened sandbox, routed inference, and declarative egress policy so deployment stays safer and more repeatable.
The sandbox runtime comes from [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell); NemoClaw adds the blueprint, `nemoclaw` CLI, onboarding, and related tooling as the reference way to run OpenClaw there.

| Capability              | Description                                                                                                                                          |
|-------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| Sandbox OpenClaw        | Creates an OpenShell sandbox pre-configured for OpenClaw, with filesystem and network policies applied from the first boot.                   |
| Route inference         | Configures OpenShell inference routing so agent traffic goes to the provider and model you chose during onboarding (NVIDIA Endpoints, OpenAI, Anthropic, Gemini, compatible endpoints, local Ollama, and others). The agent uses `inference.local` inside the sandbox; credentials stay on the host. |
| Manage the lifecycle    | Handles blueprint versioning, digest verification, and sandbox setup.                                                                                |

## Key Features

NemoClaw provides the following product capabilities.

| Feature | Description |
|---------|-------------|
| Guided onboarding | Validates credentials, selects providers, and creates a working sandbox in one command. |
| Hardened blueprint | A security-first Dockerfile with capability drops, least-privilege network rules, and declarative policy. |
| State management | Safe migration of agent state across machines with credential stripping and integrity verification. |
| Channel messaging | OpenShell-managed processes connect Telegram, Discord, Slack, and similar platforms to the sandboxed agent. NemoClaw configures channels during onboarding; OpenShell supplies the native constructs, credential flow, and runtime supervision. |
| Routed inference | Provider-routed model calls through the OpenShell gateway, transparent to the agent. Supports NVIDIA Endpoints, OpenAI, Anthropic, Google Gemini, and local Ollama. |
| Layered protection | Network, filesystem, process, and inference controls that can be hot-reloaded or locked at creation. |

## Challenge

Autonomous AI agents like OpenClaw can make arbitrary network requests, access the host filesystem, and call any inference endpoint. Without guardrails, this creates security, cost, and compliance risks that grow as agents run unattended.

## Benefits

NemoClaw provides the following benefits.

| Benefit                    | Description                                                                                                            |
|----------------------------|------------------------------------------------------------------------------------------------------------------------|
| Sandboxed execution        | Every agent runs inside an OpenShell sandbox with Landlock, seccomp, and network namespace isolation. No access is granted by default. |
| Routed inference           | Model traffic is routed through the OpenShell gateway to your selected provider, transparent to the agent. You can switch providers or models. Refer to [Inference Options](../inference/inference-options.md).          |
| Declarative network policy | Egress rules are defined in YAML. Unknown hosts are blocked and surfaced to the operator for approval.                 |
| Single CLI                 | The `nemoclaw` command orchestrates the full stack: gateway, sandbox, inference provider, and network policy.           |
| Blueprint lifecycle        | Versioned blueprints handle sandbox creation, digest verification, and reproducible setup.                             |

## Use Cases

You can use NemoClaw for various use cases including the following.

| Use Case                  | Description                                                                                  |
|---------------------------|----------------------------------------------------------------------------------------------|
| Always-on assistant       | Run an OpenClaw assistant with controlled network access and operator-approved egress.        |
| Sandboxed testing         | Test agent behavior in a locked-down environment before granting broader permissions.         |
| Remote GPU deployment     | Deploy a sandboxed agent to a remote GPU instance for persistent operation.                   |

## Next Steps

- [Ecosystem](ecosystem.md) to understand how OpenClaw, OpenShell, and NemoClaw relate in the wider stack, and when to use NemoClaw versus OpenShell.
- [How It Works](how-it-works.md) to understand how NemoClaw works internally: plugin, blueprint, sandbox lifecycle.
- [Quickstart](../get-started/quickstart.md) to install NemoClaw and run your first agent.
- [Switch Inference Providers](../inference/switch-inference-providers.md) to configure the inference provider.
- [Approve or Deny Network Requests](../network-policy/approve-network-requests.md) to manage egress approvals.
- [Deploy to a Remote GPU Instance](../deployment/deploy-to-remote-gpu.md) for persistent operation.
- [Monitor Sandbox Activity](../monitoring/monitor-sandbox-activity.md) to observe agent behavior.

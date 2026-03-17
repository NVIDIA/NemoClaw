---
title:
  page: "How NemoClaw Works — Plugin, Blueprint, and Sandbox Lifecycle"
  nav: "How It Works"
description: "Plugin, blueprint, sandbox creation, and inference routing concepts."
keywords: ["how nemoclaw works", "nemoclaw sandbox lifecycle blueprint"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "inference_routing", "blueprints", "network_policy"]
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

# How NemoClaw Works

NemoClaw combines a lightweight CLI plugin with a versioned blueprint to move OpenClaw into a controlled sandbox.
This page explains the key concepts at a high level.

## Plugin and Blueprint

NemoClaw is split into two parts:

- The *plugin* is a TypeScript package that adds commands to the OpenClaw CLI under the `openclaw nemoclaw` namespace.
  It handles user interaction and delegates orchestration work to the blueprint.
- The *blueprint* is a versioned Python artifact that contains all the logic for creating sandboxes, applying policies, and configuring inference.
  The plugin resolves, verifies, and executes the blueprint as a subprocess.

This separation keeps the plugin small and stable while allowing the blueprint to evolve on its own release cadence.

## Sandbox Creation

When you run `openclaw nemoclaw launch`, NemoClaw creates an OpenShell sandbox that runs OpenClaw in an isolated container.
The blueprint orchestrates this process through the OpenShell CLI:

1. The plugin downloads the blueprint artifact, checks version compatibility, and verifies the digest.
2. The blueprint determines which OpenShell resources to create or update, such as the gateway, inference providers, sandbox, and network policy.
3. The blueprint calls OpenShell CLI commands to create the sandbox and configure each resource.

After the sandbox starts, the agent runs inside it with all network, filesystem, and inference controls in place.

## Inference Routing

Inference requests from the agent never leave the sandbox directly.
OpenShell intercepts every inference call and routes it to the configured provider.
NemoClaw routes inference to NVIDIA cloud, specifically Nemotron 3 Super 120B through [build.nvidia.com](https://build.nvidia.com). You can switch models at runtime without restarting the sandbox.

## Network and Filesystem Policy

The sandbox starts with a strict baseline policy defined in `openclaw-sandbox.yaml`.
This policy controls which network endpoints the agent can reach and which filesystem paths it can access.

- For network, only endpoints listed in the policy are allowed.
  When the agent tries to reach an unlisted host, OpenShell blocks the request and surfaces it in the TUI for operator approval.
- For filesystem, the agent can write to `/sandbox` and `/tmp`.
  All other system paths are read-only.

Approved endpoints persist for the current session but are not saved to the baseline policy file.

## Next Steps

- Follow the [Quickstart](../get-started/quickstart.md) to launch your first sandbox.
- Refer to the [Architecture](../reference/architecture.md) for the full technical structure, including file layouts and the blueprint lifecycle.
- Refer to [Inference Profiles](../reference/inference-profiles.md) for detailed provider configuration.

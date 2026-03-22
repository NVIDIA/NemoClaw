---
title:
  page: "NemoClaw Architecture — Plugin, Blueprint, and Sandbox Structure"
  nav: "Architecture"
description: "Plugin structure, blueprint lifecycle, sandbox environment, and inference routing."
keywords: ["nemoclaw architecture", "nemoclaw plugin blueprint structure"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "blueprints", "inference_routing"]
content:
  type: reference
  difficulty: intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Architecture

NemoClaw has three layers: a host CLI for sandbox lifecycle management, a TypeScript plugin that runs inside the sandbox, and a Python blueprint that orchestrates OpenShell resources.

## Host CLI

The `nemoclaw` binary runs on the host machine and manages the full sandbox lifecycle.
It is installed via `npm install -g nemoclaw`.

```text
bin/
├── nemoclaw.js                     CLI entry point — command dispatch
└── lib/
    ├── runner.js                   Shell execution (shellQuote, validateName)
    ├── onboard.js                  Interactive setup wizard
    ├── credentials.js              Credential storage and retrieval
    ├── registry.js                 Sandbox registry (~/.nemoclaw/sandboxes.json)
    ├── policies.js                 Network policy preset loading and merging
    ├── nim.js                      NIM container lifecycle
    ├── inference-config.js         Inference provider selection
    ├── local-inference.js          Local inference health checks
    ├── platform.js                 OS and container runtime detection
    ├── preflight.js                Pre-flight validation checks
    └── resolve-openshell.js        OpenShell binary resolution
```

## Sandbox Plugin

The plugin is a thin TypeScript package that registers an inference provider and the `/nemoclaw` slash command.
It runs in-process with the OpenClaw gateway inside the sandbox.

```text
nemoclaw/
├── src/
│   ├── index.ts                    Plugin entry — registers provider and slash command
│   ├── commands/
│   │   ├── slash.ts                /nemoclaw chat command handler
│   │   └── migration-state.ts      Snapshot creation and restoration
│   ├── blueprint/
│   │   └── state.ts                Persistent state (run IDs)
│   └── onboard/
│       └── config.ts               Onboarding configuration
├── openclaw.plugin.json            Plugin manifest
└── package.json                    Commands declared under openclaw.extensions
```

## NemoClaw Blueprint

The blueprint is a versioned Python artifact with its own release stream.
The host CLI invokes the blueprint runner as a subprocess during onboarding.
The blueprint drives all interactions with the OpenShell CLI.

```text
nemoclaw-blueprint/
├── blueprint.yaml                  Manifest — version, profiles, compatibility
├── orchestrator/
│   └── runner.py                   CLI runner — plan / apply / status
├── policies/
│   └── openclaw-sandbox.yaml       Default network + filesystem policy
```

### Blueprint Lifecycle

```{mermaid}
flowchart LR
    A[resolve] --> B[plan]
    B --> C[apply]
    C --> D[status]
```

1. Resolve. The host CLI locates the blueprint artifact and checks the version against `min_openshell_version` and `min_openclaw_version` constraints in `blueprint.yaml`.
2. Plan. The runner determines what OpenShell resources to create or update, such as the gateway, providers, sandbox, inference route, and policy.
3. Apply. The runner executes the plan by calling `openshell` CLI commands.
4. Status. The runner reports current state.

## Sandbox Environment

The sandbox runs the
[`ghcr.io/nvidia/openshell-community/sandboxes/openclaw`](https://github.com/NVIDIA/OpenShell-Community)
container image. Inside the sandbox:

- OpenClaw runs with the NemoClaw plugin pre-installed.
- Inference calls are routed through OpenShell to the configured provider.
- Network egress is restricted by the baseline policy in `openclaw-sandbox.yaml`.
- Filesystem access is confined to `/sandbox` and `/tmp` for read-write access, with system paths read-only.

## Inference Routing

Inference requests from the agent never leave the sandbox directly.
OpenShell intercepts them and routes to the configured provider:

```text
Agent (sandbox)  ──▶  OpenShell gateway  ──▶  NVIDIA Endpoint (build.nvidia.com)
```

Refer to [Inference Profiles](../reference/inference-profiles.md) for provider configuration details.

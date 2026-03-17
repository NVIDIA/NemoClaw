---
title:
  page: "NemoClaw Overview — What It Does and How It Fits Together"
  nav: "Overview"
description: "NemoClaw sandboxes OpenClaw with NVIDIA inference and declarative policy."
keywords: ["nemoclaw overview", "openclaw openshell sandbox plugin"]
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

NemoClaw is the [OpenClaw](https://openclaw.ai) plugin for [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell).
It moves OpenClaw into a sandboxed environment where every network request, file access, and inference call is governed by declarative policy.

## What NemoClaw Does

- Sandboxes OpenClaw. Creates an OpenShell sandbox pre-configured for OpenClaw, with strict filesystem and network policies applied from the first boot.
- Routes inference through NVIDIA cloud. Configures OpenShell inference routing so agent traffic flows through cloud-hosted Nemotron 3 Super 120B via [build.nvidia.com](https://build.nvidia.com).
- Manages the lifecycle. Handles blueprint versioning, digest verification, and sandbox setup.

## How It Fits Together

NemoClaw is a thin TypeScript plugin that registers commands under the `openclaw nemoclaw` namespace.
It delegates heavy lifting to a versioned blueprint, a Python artifact that orchestrates sandbox creation, policy application, and inference provider setup through the OpenShell CLI.

```{mermaid}
flowchart TB
    subgraph Host
        CMD["openclaw nemoclaw launch"]
        PLUGIN[nemoclaw plugin]
        BLUEPRINT[blueprint runner]
        CLI["openshell CLI\nsandbox · gateway · inference · policy"]

        CMD --> PLUGIN
        PLUGIN --> BLUEPRINT
        BLUEPRINT --> CLI
    end

    subgraph Sandbox["OpenShell Sandbox"]
        AGENT[OpenClaw agent]
        INF[NVIDIA inference, routed]
        NET[strict network policy]
        FS[filesystem isolation]

        AGENT --- INF
        AGENT --- NET
        AGENT --- FS
    end

    PLUGIN --> AGENT

    classDef nv fill:#76b900,stroke:#333,color:#fff
    classDef nvLight fill:#e6f2cc,stroke:#76b900,color:#1a1a1a
    classDef nvDark fill:#333,stroke:#76b900,color:#fff

    class CMD,PLUGIN,BLUEPRINT nvDark
    class CLI nv
    class AGENT nv
    class INF,NET,FS nvLight

    style Host fill:none,stroke:#76b900,stroke-width:2px,color:#1a1a1a
    style Sandbox fill:#f5faed,stroke:#76b900,stroke-width:2px,color:#1a1a1a
```

## Design Principles

Thin plugin, versioned blueprint
: The plugin stays small and stable. Orchestration logic lives in the blueprint and evolves on its own release cadence.

Respect CLI boundaries
: Plugin commands live under the `nemoclaw` namespace and never override built-in OpenClaw commands.

Supply chain safety
: Blueprint artifacts are immutable, versioned, and digest-verified before execution.

OpenShell-native for new installs
: For users without an existing OpenClaw installation, NemoClaw recommends `openshell sandbox create` directly
  rather than forcing a plugin-driven bootstrap.

Reproducible setup
: Running setup again recreates the sandbox from the same blueprint and policy definitions.

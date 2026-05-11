---
title:
  page: "NemoClaw Architecture Overview: Plugin, Blueprint, and Sandbox Lifecycle"
  nav: "How It Works"
description:
  main: "Learn how NemoClaw combines a host CLI, sandbox plugin, and versioned blueprint to move OpenClaw into a controlled sandbox."
  agent: "Describes how NemoClaw works internally: CLI, plugin, blueprint runner, OpenShell orchestration, inference routing, and protection layers. Use for sandbox lifecycle and architecture mechanics; not for product definition (Overview) or multi-project placement (Ecosystem)."
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

# NemoClaw Architecture Overview

This page explains how NemoClaw operates in the supported OpenClaw-on-OpenShell path: which parts run on the host, which parts run in the sandbox, and how onboarding connects the blueprint, inference routing, policy, and agent runtime.

NemoClaw is a reference stack; it does not replace OpenClaw or OpenShell.
It packages opinionated integration around them: a host-side CLI workflow, a versioned YAML blueprint and runner, default policies, inference provider setup, OpenClaw plugin configuration, and state helpers that work together as a repeatable baseline.
You can use the stack as-is for the supported OpenClaw sandbox path, or treat it as an implementation example when building your own OpenShell integration.

The `nemoclaw onboard` command is the primary entrypoint for setting up and managing sandboxed OpenClaw agents.
It collects configuration, validates credentials, passes sandbox settings through the blueprint runner, and also calls the OpenShell CLI directly for host-side setup such as gateway and provider operations.

```{mermaid}
flowchart TB
    USER(["User"])
    SETUP["NemoClaw setup<br/>CLI + blueprint"]
    INTERFACE["User interface<br/>UI, TUI, messaging channels"]

    subgraph Sandbox["OpenShell Sandbox"]
        AGENT[OpenClaw agent]
        PLUGIN["NemoClaw plugin"]
        INF["inference.local<br/>routed by OpenShell"]
        CONTROLS["Sandbox controls<br/>network + filesystem policy"]

        AGENT --- PLUGIN
        AGENT --- INF
        AGENT --- CONTROLS
    end

    ENDPOINT["Inference endpoint"]

    USER --> SETUP
    USER --> INTERFACE
    SETUP -->|"creates and configures"| AGENT
    INTERFACE --> AGENT
    INF --> ENDPOINT

    classDef nv fill:#76b900,stroke:#333,color:#fff
    classDef nvLight fill:#e6f2cc,stroke:#76b900,color:#1a1a1a
    classDef nvDark fill:#333,stroke:#76b900,color:#fff

    class USER,SETUP nv
    class AGENT nv
    class PLUGIN,INF,CONTROLS,INTERFACE,ENDPOINT nvLight

    style Sandbox fill:#f5faed,stroke:#76b900,stroke-width:2px,color:#1a1a1a
```

Between your shell and the running sandbox, NemoClaw contributes these integration layers:

| Layer | Role in the flow |
|-------|------------------|
| Onboarding | `nemoclaw onboard` validates credentials, selects providers, resolves sandbox settings, and drives setup until the sandbox is ready. |
| Blueprint | Supplies the sandbox image definition, default policies, inference profiles, and policy additions that the runner applies through OpenShell. |
| OpenShell orchestration | NemoClaw calls the OpenShell CLI to create or update the gateway, providers, sandbox, inference route, and policy. |
| OpenClaw plugin | The plugin runs with OpenClaw in the sandbox. It registers the `/nemoclaw` command, managed provider metadata, and runtime context about the sandbox and policy. |
| State management | Migrates agent state across machines with credential stripping and integrity checks. |
| Messaging setup | NemoClaw configures channel credentials during onboarding. OpenClaw handles channel delivery inside the sandbox through OpenShell's provider, placeholder, and L7 proxy pipeline, with no separate NemoClaw host daemon. |

For repository layout, file paths, and deeper diagrams, see [Architecture](../reference/architecture.md).

## Design Principles

NemoClaw architecture follows the following principles.

Thin plugin, versioned blueprint
: The sandbox plugin stays small and stable. Host-side orchestration uses a versioned blueprint and runner that can evolve on its own release cadence.

Respect CLI boundaries
: The `nemoclaw` CLI is the primary interface for sandbox management.

Supply chain safety
: Blueprint artifacts are immutable, versioned, and digest-verified before execution.

OpenShell-backed lifecycle
: NemoClaw orchestrates OpenShell resources under the hood, but `nemoclaw onboard`
  is the supported operator entry point for creating or recreating NemoClaw-managed sandboxes.

Reproducible setup
: Running setup again recreates the sandbox from the same blueprint and policy definitions.

## CLI, Plugin, and Blueprint

NemoClaw is split into three integration pieces:

- The *host CLI* runs onboarding, validates provider choices, stores configuration, and calls OpenShell commands for gateway, provider, sandbox, and policy operations.
- The *plugin* is a TypeScript package that runs with OpenClaw inside the sandbox.
  It registers the managed inference provider metadata, the `/nemoclaw` slash command, and runtime context hooks.
- The *blueprint* is a versioned YAML package with the sandbox image, policy, inference profile, and supporting assets.
  The runner resolves and verifies the blueprint before applying it through OpenShell.

This separation keeps the sandbox plugin small while allowing host orchestration and blueprint contents to evolve on their own release cadence.

## Sandbox Creation

When you run `nemoclaw onboard`, NemoClaw creates an OpenShell sandbox that runs OpenClaw in an isolated container.
The host CLI and blueprint runner orchestrate this process through the OpenShell CLI:

1. NemoClaw resolves the blueprint, checks version compatibility, and verifies the digest.
2. The onboarding flow determines which OpenShell resources to create or update, such as the gateway, inference providers, sandbox, and network policy.
3. The runner calls OpenShell CLI commands to create the sandbox and configure each resource.

After the sandbox starts, the agent runs inside it with all network, filesystem, and inference controls in place.

## Inference Routing

Inference requests from the agent never leave the sandbox directly.
OpenShell intercepts every inference call and routes it to the configured provider.
During onboarding, NemoClaw validates the selected provider and model, configures the OpenShell route, and bakes the matching model reference into the sandbox image.
The sandbox then talks to `inference.local`, while the host owns the actual provider credential and upstream endpoint.
If you select the Model Router provider, `inference.local` routes to a host-side router that chooses from the configured NVIDIA model pool for each request.

## Protection Layers

The sandbox starts with a default policy that controls network egress, filesystem access, process privileges, and inference routing.

| Layer | What it protects | When it applies |
|---|---|---|
| Network | Blocks unauthorized outbound connections. | Hot-reloadable at runtime. |
| Filesystem | Restricts system paths to read-only; `/sandbox` and `/tmp` are writable. | Locked at sandbox creation. |
| Process | Blocks privilege escalation and dangerous syscalls. | Locked at sandbox creation. |
| Inference | Reroutes model API calls to controlled backends. | Hot-reloadable at runtime. |

When the agent tries to reach an unlisted host, OpenShell blocks the request and surfaces it in the TUI for operator approval. Approved endpoints persist for the current session but are not saved to the baseline policy file.

For details on the baseline rules, refer to [Network Policies](../reference/network-policies.md). For container-level hardening, refer to [Sandbox Hardening](../deployment/sandbox-hardening.md).

## Next Steps

- Read [Ecosystem](ecosystem.md) for stack-level relationships and NemoClaw versus OpenShell-only paths.
- Follow the [Quickstart](../get-started/quickstart.md) to launch your first sandbox.
- Refer to the [Architecture](../reference/architecture.md) for the full technical structure, including file layouts and the blueprint lifecycle.
- Refer to [Inference Options](../inference/inference-options.md) for detailed provider configuration.

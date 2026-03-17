---
title:
  page: "NVIDIA NemoClaw Developer Guide"
  nav: "NemoClaw"
description: "Sandbox OpenClaw with NVIDIA inference routing and strict network policies."
keywords: ["nemoclaw sandboxed ai agent", "openclaw openshell plugin"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "inference_routing", "nemoclaw"]
content:
  type: get_started
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NVIDIA NemoClaw

```{include} ../README.md
:start-after: <!-- start-badges -->
:end-before: <!-- end-badges -->
```

NemoClaw is the OpenClaw plugin for [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell).
It runs OpenClaw inside a sandboxed environment with NVIDIA cloud inference, such as Nemotron 3 Super 120B through [build.nvidia.com](https://build.nvidia.com).
The sandbox enforces strict network policies and operator-controlled egress approval.

## Get Started

Install the CLI and launch a sandboxed OpenClaw instance in a few commands.

```{raw} html
<style>
.nc-term {
  background: #1a1a2e;
  border-radius: 8px;
  overflow: hidden;
  margin: 1.5em 0;
  box-shadow: 0 4px 16px rgba(0,0,0,0.25);
  font-family: 'SFMono-Regular', Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  font-size: 0.875em;
  line-height: 1.8;
}
.nc-term-bar {
  background: #252545;
  padding: 10px 14px;
  display: flex;
  gap: 7px;
  align-items: center;
}
.nc-term-dot { width: 12px; height: 12px; border-radius: 50%; }
.nc-term-dot-r { background: #ff5f56; }
.nc-term-dot-y { background: #ffbd2e; }
.nc-term-dot-g { background: #27c93f; }
.nc-term-body { padding: 16px 20px; color: #d4d4d8; }
.nc-term-body .nc-ps { color: #76b900; user-select: none; }
.nc-hl { color: #76b900; font-weight: 600; }
.nc-cursor {
  display: inline-block;
  width: 2px;
  height: 1.1em;
  background: #d4d4d8;
  vertical-align: text-bottom;
  margin-left: 1px;
  animation: nc-blink 1s step-end infinite;
}
@keyframes nc-blink { 50% { opacity: 0; } }
</style>
<div class="nc-term">
  <div class="nc-term-bar">
    <span class="nc-term-dot nc-term-dot-r"></span>
    <span class="nc-term-dot nc-term-dot-y"></span>
    <span class="nc-term-dot nc-term-dot-g"></span>
  </div>
  <div class="nc-term-body">
    <div><span class="nc-ps">$ </span>curl -fsSL https://nvidia.com/nemoclaw.sh | bash</div>
  </div>
</div>
```

Run `nemoclaw --help` in your terminal to view the full CLI reference.
You can also clone the [NemoClaw repository](https://github.com/NVIDIA/NemoClaw) to explore the plugin source and blueprint.

Proceed to the [Quickstart](get-started/quickstart.md) for step-by-step instructions.

---

## Explore

::::{grid} 2 2 3 3
:gutter: 3

:::{grid-item-card} About NemoClaw
:link: about/overview
:link-type: doc

Learn what NemoClaw does and how it integrates OpenClaw with OpenShell.

+++
{bdg-secondary}`Concept`
:::

:::{grid-item-card} Quickstart
:link: get-started/quickstart
:link-type: doc

Install the CLI, configure inference, and launch your first sandboxed agent.

+++
{bdg-secondary}`Tutorial`
:::

:::{grid-item-card} Commands
:link: reference/commands
:link-type: doc

CLI commands for launching, connecting, monitoring, and managing sandboxes.

+++
{bdg-secondary}`Reference`
:::

:::{grid-item-card} Inference Profiles
:link: reference/inference-profiles
:link-type: doc

NVIDIA cloud inference configuration and available models.

+++
{bdg-secondary}`Reference`
:::

:::{grid-item-card} How It Works
:link: about/how-it-works
:link-type: doc

High-level overview of the plugin, blueprint, sandbox, and inference routing.

+++
{bdg-secondary}`Concept`
:::

:::{grid-item-card} Architecture
:link: reference/architecture
:link-type: doc

Plugin structure, blueprint system, and sandbox lifecycle.

+++
{bdg-secondary}`Reference`
:::

:::{grid-item-card} Network Policies
:link: reference/network-policies
:link-type: doc

Egress control, operator approval flow, and policy configuration.

+++
{bdg-secondary}`Reference`
:::

:::{grid-item-card} How-To Guides
:link: inference/switch-inference-providers
:link-type: doc

Task-oriented guides for inference, deployment, and policy management.

+++
{bdg-secondary}`How-To`
:::

::::

```{toctree}
:hidden:

Home <self>
```

```{toctree}
:caption: About NemoClaw
:hidden:

Overview <about/overview>
How It Works <about/how-it-works>
Release Notes <about/release-notes>
```

```{toctree}
:caption: Get Started
:hidden:

Quickstart <get-started/quickstart>
```

```{toctree}
:caption: Inference
:hidden:

Switch Inference Providers <inference/switch-inference-providers>
```

```{toctree}
:caption: Network Policy
:hidden:

Approve or Deny Network Requests <network-policy/approve-network-requests>
Customize the Network Policy <network-policy/customize-network-policy>
```

```{toctree}
:caption: Deployment
:hidden:

Deploy to a Remote GPU Instance <deployment/deploy-to-remote-gpu>
Set Up the Telegram Bridge <deployment/set-up-telegram-bridge>
```

```{toctree}
:caption: Monitoring
:hidden:

Monitor Sandbox Activity <monitoring/monitor-sandbox-activity>
```

```{toctree}
:caption: Reference
:hidden:

Architecture <reference/architecture>
Commands <reference/commands>
Inference Profiles <reference/inference-profiles>
Network Policies <reference/network-policies>
```

```{toctree}
:caption: Resources
:hidden:

resources/license
```

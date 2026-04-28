---
title:
  page: "NVIDIA NemoClaw Developer Guide"
  nav: "NemoClaw"
description:
  main: "NemoClaw is an open-source reference stack that simplifies running OpenClaw always-on assistants more safely, with a single command."
  agent: "Provides an open-source reference stack that simplifies running OpenClaw always-on assistants more safely. Use when setting up NemoClaw, exploring the project, or looking for the landing page."
keywords: ["nemoclaw open source reference stack", "openclaw always-on assistants", "nvidia openshell", "nvidia nemotron"]
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

NVIDIA NemoClaw is an open-source reference stack that simplifies running [OpenClaw](https://openclaw.ai) always-on assistants more safely.
NemoClaw provides onboarding, lifecycle management, and OpenClaw operations within OpenShell containers.
It installs the [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) runtime, part of NVIDIA Agent Toolkit, an environment designed for executing claws with additional security, and open-source models like [NVIDIA Nemotron](https://build.nvidia.com).

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
.nc-copy-btn {
  margin-left: auto;
  position: relative;
  background: none;
  border: 0;
  color: #8a8aa3;
  cursor: pointer;
  padding: 4px;
  line-height: 0;
}
.nc-copy-btn:hover, .nc-copy-btn.copied { color: #76b900; }
.nc-copy-btn svg { width: 16px; height: 16px; fill: currentColor; }
.nc-copy-btn.copied::after {
  content: 'Copied';
  position: absolute;
  right: 100%;
  top: 50%;
  transform: translate(-8px, -50%);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
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
    <button
      class="nc-copy-btn"
      type="button"
      aria-label="Copy install command"
      title="Copy"
      onclick="
        const button = this;
        const text = button.closest('.nc-term').querySelector('.nc-cmd').textContent;
        const show = (label, copied = false) => {
          button.classList.toggle('copied', copied);
          button.setAttribute('aria-label', label);
          button.title = label;
          clearTimeout(button._copyResetTimer);
          button._copyResetTimer = setTimeout(() => {
            button.classList.remove('copied');
            button.setAttribute('aria-label', 'Copy install command');
            button.title = 'Copy';
            button._copyResetTimer = null;
          }, 1200);
        };
        if (!navigator.clipboard) {
          show('Copy failed');
          return;
        }
        navigator.clipboard.writeText(text).then(() => show('Copied', true)).catch((err) => {
          console.error('Failed to copy install command:', err);
          show('Copy failed');
        });
      "
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path fill-rule="evenodd" d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1z"/>
      </svg>
    </button>
  </div>
  <div class="nc-term-body">
    <div><span class="nc-ps">$ </span><span class="nc-cmd">curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash</span></div>
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

What NemoClaw is: capabilities, benefits, and typical uses.

+++
{bdg-secondary}`Concept`
:::

:::{grid-item-card} Ecosystem
:link: about/ecosystem
:link-type: doc

How OpenClaw, OpenShell, and NemoClaw form a stack and when to use NemoClaw versus OpenShell alone.

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

:::{grid-item-card} Inference Options
:link: inference/inference-options
:link-type: doc

Providers available during onboarding and how inference routing works.

+++
{bdg-secondary}`Concept`
:::

:::{grid-item-card} How It Works
:link: about/how-it-works
:link-type: doc

How NemoClaw runs: plugin, blueprint, OpenShell orchestration, routing, and policy layers.

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

:::{grid-item-card} Workspace Files
:link: workspace/workspace-files
:link-type: doc

Understand `SOUL.md`, `USER.md`, and other workspace files, plus backup and restore.

+++
{bdg-secondary}`Concept`
:::

:::{grid-item-card} Security Best Practices
:link: security/best-practices
:link-type: doc

Controls reference, risk framework, and posture profiles for sandbox security.

+++
{bdg-secondary}`Concept`
:::

:::{grid-item-card} How-To Guides
:link: inference/switch-inference-providers
:link-type: doc

Task-oriented guides for inference, deployment, and policy management.

+++
{bdg-secondary}`How-To`
:::

:::{grid-item-card} Agent Skills
:link: resources/agent-skills
:link-type: doc

Use AI coding assistants with NemoClaw's built-in agent skills for guided setup and operation.

+++
{bdg-secondary}`Resource`
:::

::::

---

```{admonition} Notice and Disclaimer
:class: warning

This software automatically retrieves, accesses or interacts with external materials. Those retrieved materials are not distributed with this software and are governed solely by separate terms, conditions and licenses. You are solely responsible for finding, reviewing and complying with all applicable terms, conditions, and licenses, and for verifying the security, integrity and suitability of any retrieved materials for your specific use case. This software is provided "AS IS", without warranty of any kind. The author makes no representations or warranties regarding any retrieved materials, and assumes no liability for any losses, damages, liabilities or legal consequences from your use or inability to use this software or any retrieved materials. Use this software and the retrieved materials at your own risk.
```

```{toctree}
:caption: About NemoClaw
:hidden:

Overview <about/overview>
How It Works <about/how-it-works>
Ecosystem <about/ecosystem>
Release Notes <about/release-notes>
```

```{toctree}
:caption: Get Started
:hidden:

Prerequisites <get-started/prerequisites>
Quickstart <get-started/quickstart>
```

```{toctree}
:caption: Inference
:hidden:

Inference Options <inference/inference-options>
Use Local Inference <inference/use-local-inference>
Switch Inference Providers <inference/switch-inference-providers>
```

```{toctree}
:caption: Network Policy
:hidden:

Approve or Deny Network Requests <network-policy/approve-network-requests>
Customize the Network Policy <network-policy/customize-network-policy>
```

```{toctree}
:caption: Security
:hidden:

Security Best Practices <security/best-practices>
Credential Storage <security/credential-storage>
OpenClaw Controls <security/openclaw-controls>
```

```{toctree}
:caption: Deployment
:hidden:

Deploy to a Remote GPU Instance <deployment/deploy-to-remote-gpu>
Set Up Telegram <deployment/set-up-telegram-bridge>
Install OpenClaw Plugins <deployment/install-openclaw-plugins>
Sandbox Hardening <deployment/sandbox-hardening>
```

```{toctree}
:caption: Workspace
:hidden:

Workspace Files <workspace/workspace-files>
Backup & Restore <workspace/backup-restore>
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
Network Policies <reference/network-policies>
Troubleshooting <reference/troubleshooting>
```

```{toctree}
:caption: Resources
:hidden:

Agent Skills <resources/agent-skills>
Report Vulnerabilities <https://github.com/NVIDIA/NemoClaw/blob/main/SECURITY.md>
resources/license
Discord <https://discord.gg/XFpfPv9Uvx>
```

---
title: Overview
category: overview
created: 2026-04-11
updated: 2026-04-11
---

# NemoClaw — Project Overview

NVIDIA NemoClaw is an open-source reference stack that simplifies running
[OpenClaw](entities/openclaw.md) always-on assistants safely. It installs the
[NVIDIA OpenShell](entities/openshell.md) runtime (part of NVIDIA Agent Toolkit),
which provides sandboxed execution for autonomous agents, and includes open-source
models such as [NVIDIA Nemotron](entities/nvidia-nemotron.md).

## Status

Alpha — early preview since March 16, 2026. Not production-ready. Interfaces,
APIs, and behaviour may change without notice.

## Architecture at a Glance

NemoClaw follows a [two-part architecture](concepts/two-part-architecture.md):

1. **Plugin** (TypeScript) — thin CLI that registers with OpenClaw, provides
   `nemoclaw` host commands, and orchestrates the blueprint.
2. **Blueprint** (Python) — versioned artifact that handles sandbox creation,
   [policy](concepts/network-policy.md) application, and
   [inference routing](concepts/inference-routing.md).

The [sandbox](entities/sandbox.md) is an isolated OpenShell container running
OpenClaw with policy-enforced egress and filesystem restrictions.

## Protection Model

Four layers of [sandbox hardening](concepts/sandbox-hardening.md):

| Layer | Scope |
|---|---|
| [Network policy](concepts/network-policy.md) | Blocks unauthorized outbound connections |
| Filesystem | Prevents access outside `/sandbox` and `/tmp` |
| Process | Blocks privilege escalation and dangerous syscalls |
| [Inference routing](concepts/inference-routing.md) | Reroutes model calls to controlled backends |

## Key Workflows

- **Install & onboard** — single `curl | bash` command runs the installer and
  guided wizard. See [installation](concepts/installation.md).
- **Connect & chat** — `nemoclaw <name> connect` then `openclaw tui` or CLI.
- **Inference** — transparent provider routing through `inference.local`.
  Supports [NVIDIA cloud, OpenAI, Anthropic, Gemini, Ollama, NIM, vLLM](concepts/inference-routing.md).
- **Policy customization** — static YAML edits or dynamic runtime changes
  via [presets](concepts/policy-presets.md).
- **Backup & restore** — built-in commands preserve
  [workspace files](concepts/workspace-files.md) and wiki state.
- **Multi-agent** — [sub-agents](concepts/sub-agents.md) with separate
  workspaces, models, and optional wiki memory.
- **Remote deployment** — [Brev cloud deploy](concepts/brev-deployment.md) for
  GPU VMs.
- **Bridges** — [Discord](entities/discord-bridge.md) and
  [Telegram](entities/telegram-bridge.md) forwarding.

## Relationships

| Project | Role |
|---|---|
| [OpenClaw](entities/openclaw.md) | Always-on agent framework that NemoClaw wraps |
| [OpenShell](entities/openshell.md) | Container runtime providing sandbox isolation |
| [NVIDIA Nemotron](entities/nvidia-nemotron.md) | Default cloud inference model |
| [NVIDIA Agent Toolkit](entities/nvidia-agent-toolkit.md) | Broader toolkit family |

## See Also

- [index.md](index.md) — Full content catalog
- [log.md](log.md) — Activity history

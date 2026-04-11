---
title: OpenClaw
category: entity
created: 2026-04-11
updated: 2026-04-11
sources: [readme, docs-about-overview]
tags: [agent-framework, openclaw, core]
---

# OpenClaw

Always-on agent framework developed by the OpenClaw community. OpenClaw provides
the agent runtime, TUI, CLI, and plugin system that NemoClaw wraps inside a
sandboxed environment.

## Role in NemoClaw

NemoClaw creates a fresh OpenClaw instance inside the [sandbox](sandbox.md) during
onboarding. The agent runs within OpenShell's isolation layer while NemoClaw
manages inference routing, network policy, and lifecycle.

## Key Commands (Inside Sandbox)

| Command | Purpose |
|---|---|
| `openclaw tui` | Interactive chat TUI |
| `openclaw agent --agent main --local -m "<msg>"` | Send single message via CLI |
| `openclaw agents add <id>` | Create a [sub-agent](../concepts/sub-agents.md) |

## Plugin System

OpenClaw supports plugins via `openclaw.plugin.json` manifest files. The
[NemoClaw plugin](nemoclaw-plugin.md) registers:

- Inference provider configuration
- `/nemoclaw` slash command for in-chat status
- Sandbox-specific CLI extensions

## Workspace Files

OpenClaw reads [workspace files](../concepts/workspace-files.md) at session start:
`SOUL.md`, `USER.md`, `IDENTITY.md`, `AGENTS.md`, `MEMORY.md`, and daily notes
under `memory/`.

## Links

- Website: <https://openclaw.ai>
- Documentation: <https://docs.openclaw.ai>

## See Also

- [NemoClaw Plugin](nemoclaw-plugin.md) — TypeScript plugin that extends OpenClaw
- [Sandbox](sandbox.md) — Isolated container running OpenClaw
- [Workspace Files](../concepts/workspace-files.md) — Agent personality and memory

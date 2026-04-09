---
name: "nemoclaw-user-skills-coding"
description: "Describes the agent skills shipped with NemoClaw and how to access them by cloning the repository. Use when users ask about AI agent support, coding assistant integration, or the .agents/skills/ directory."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw User Skills Coding

Describes the agent skills shipped with NemoClaw and how to access them by cloning the repository. Use when users ask about AI agent support, coding assistant integration, or the .agents/skills/ directory.

## Context

NemoClaw ships agent skills that are generated directly from this documentation.
Each skill is a converted version of one or more doc pages, structured so AI coding assistants can consume it as context.
This means you can interact with the full NemoClaw documentation as skills inside your agent chat session, instead of reading the docs separately.

Ask your assistant a question about NemoClaw and it responds with the same guidance found in these docs, adapted to your current situation.
Skills cover installation, inference configuration, network policy management, monitoring, deployment, security, workspace management, and the CLI reference.

> **Note:** If you are a contributor and have cloned the full NemoClaw repository, the full set of skills including contributor and maintainer skills are already available at the project root.
> Open the `NemoClaw` directory in your coding assistant and the skills load automatically.
> This page is for users who installed NemoClaw with the installer and do not have a local clone.

## Get the Skills

Fetch only the skills from the NemoClaw repository without downloading the full source tree.

```console
$ git clone --filter=blob:none --no-checkout https://github.com/NVIDIA/NemoClaw.git
$ cd NemoClaw
$ git sparse-checkout set --no-cone '/.agents/skills/nemoclaw-user-*/**' '/.agents/skills/nemoclaw-skills-guide/**' '/.claude/**' '/AGENTS.md' '/CLAUDE.md'
$ git checkout
```

Open the `NemoClaw` directory in your AI coding assistant.
The assistant discovers the skills in `.agents/skills/` and uses them to answer NemoClaw questions with project-specific guidance.

You can keep the skills inside the cloned directory or copy `.agents/skills/` to a global location (such as `~/.cursor/skills/` or `~/.claude/skills/`) so they are available across all your projects.
The choice depends on whether you want NemoClaw skills scoped to one workspace or accessible everywhere.

## Update the Skills

The sparse checkout filter is saved, so `git pull` fetches only updated skills without downloading the full source tree.
Run `git pull` after each NemoClaw release to pick up new and updated skills.

## Available Skills

The following user skills ship with NemoClaw.

| Skill | Summary |
|-------|---------|
| `nemoclaw-user-overview` | What NemoClaw is, ecosystem placement (OpenClaw + OpenShell + NemoClaw), how it works internally, and release notes. |
| `nemoclaw-user-get-started` | Install NemoClaw, launch a sandbox, and run the first agent prompt. |
| `nemoclaw-user-configure-inference` | Choose inference providers during onboarding, switch models without restarting, and set up local inference servers (Ollama, vLLM, TensorRT-LLM, NIM). |
| `nemoclaw-user-manage-policy` | Approve or deny blocked egress requests in the TUI and customize the sandbox network policy (add, remove, or modify allowed endpoints). |
| `nemoclaw-user-monitor-sandbox` | Check sandbox health, read logs, and trace agent behavior to diagnose problems. |
| `nemoclaw-user-deploy-remote` | Deploy NemoClaw to a remote GPU instance, set up the Telegram bridge, and review sandbox container hardening. |
| `nemoclaw-user-configure-security` | Review the risk framework for every configurable security control, understand credential storage, and assess posture trade-offs. |
| `nemoclaw-user-workspace` | Back up and restore OpenClaw workspace files (soul.md, identity.md, memory.md, agents.md) and understand file persistence across sandbox restarts. |
| `nemoclaw-user-reference` | CLI command reference, plugin and blueprint architecture, baseline network policies, and troubleshooting guide. |

## Example Questions and Triggered Skills

After opening the cloned repository in your coding assistant, ask a NemoClaw question in natural language.
The assistant matches your question to the relevant skill and follows the guidance it contains.

Examples of questions your assistant can answer with these skills:

| Question | Skill triggered |
|----------|-----------------|
| "How do I install NemoClaw?" | `nemoclaw-user-get-started` |
| "Switch my inference provider to Ollama." | `nemoclaw-user-configure-inference` |

*Full details in `references/agent-skills.md`.*

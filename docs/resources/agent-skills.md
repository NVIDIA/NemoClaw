---
title:
  page: "NemoClaw Agent Skills for Your AI Coding Assistant"
  nav: "Agent Skills"
description:
  main: "NemoClaw ships agent skills that let AI coding assistants guide you through installation, configuration, and operation."
  agent: "Describes the agent skills shipped with NemoClaw and how to access them by cloning the repository. Use when users ask about AI agent support, coding assistant integration, or the .agents/skills/ directory."
keywords: ["nemoclaw agent skills", "ai coding assistant", "cursor", "claude code", "copilot"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "agent_skills", "nemoclaw"]
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

# NemoClaw Agent Skills for Your AI Coding Assistant

NemoClaw ships agent skills that are generated directly from this documentation.
Each skill is a converted version of one or more doc pages, structured so AI coding assistants can consume it as context.
This means you can interact with the full NemoClaw documentation as skills inside your agent chat session, instead of reading the docs separately.

Ask your assistant a question about NemoClaw and it responds with the same guidance found in these docs, adapted to your current situation.
Skills cover installation, inference configuration, network policy management, monitoring, deployment, security, workspace management, and the CLI reference.

:::{note}
If you are a contributor and have cloned the full NemoClaw repository, the full set of skills including contributor and maintainer skills are already available at the project root.
Open the `NemoClaw` directory in your coding assistant and the skills load automatically.
This page is for users who installed NemoClaw with the installer and do not have a local clone.
:::

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

```{include} ../../.agents/skills/nemoclaw-skills-guide/SKILL.md
:start-after: <!-- user-skills-table:begin -->
:end-before: <!-- user-skills-table:end -->
```

## Example Questions and Triggered Skills

After opening the cloned repository in your coding assistant, ask a NemoClaw question in natural language.
The assistant matches your question to the relevant skill and follows the guidance it contains.

Examples of questions your assistant can answer with these skills:

| Question | Skill triggered |
|----------|-----------------|
| "How do I install NemoClaw?" | `nemoclaw-user-get-started` |
| "Switch my inference provider to Ollama." | `nemoclaw-user-configure-inference` |
| "A network request was blocked. How do I approve it?" | `nemoclaw-user-manage-policy` |
| "Show me the sandbox logs." | `nemoclaw-user-monitor-sandbox` |
| "How do I deploy NemoClaw to a remote GPU?" | `nemoclaw-user-deploy-remote` |
| "What security controls can I configure?" | `nemoclaw-user-configure-security` |
| "Back up my agent workspace files." | `nemoclaw-user-manage-sandboxes` |
| "What CLI commands are available?" | `nemoclaw-user-reference` |

You can also reference a skill directly by name if you know which one you need.

## AI Coding Assistants that You Can Use with NemoClaw Skills

The NemoClaw agent skills follow the [Agent Skills best practices](https://agentskills.io/skill-creation/best-practices) and the [Claude Skills best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).
The following table shows how each AI coding assistant can use the NemoClaw skills.

| Assistant | Skill discovery |
|-----------|----------------|
| Cursor | Reads `AGENTS.md` at the project root, which references `.agents/skills/`. |
| Claude Code | Follows the `.claude/skills/` symlink, which points to `.agents/skills/`. |
| Other assistants | Point the assistant to `.agents/skills/` if it supports project-level skill loading. |

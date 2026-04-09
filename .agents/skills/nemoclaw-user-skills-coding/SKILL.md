---
name: "nemoclaw-user-skills-coding"
description: "Describes the agent skills shipped with NemoClaw and how to access them by cloning the repository. Use when users ask about AI agent support, coding assistant integration, or the .agents/skills/ directory."
---

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

---
name: "nemoclaw-skills-guide"
description: "Start here. Introduces what NemoClaw is, what agent skills are available, and which skill to use for a given task. Use when discovering NemoClaw capabilities, choosing the right skill, or orienting in the project. Trigger keywords - skills, capabilities, what can I do, help, guide, index, overview, start here."
---

# NemoClaw Skills Guide

NVIDIA NemoClaw runs OpenClaw always-on assistants inside hardened OpenShell sandboxes with NVIDIA inference (Nemotron).
It provides CLI tooling, guided onboarding, a security blueprint, routed inference, and workspace management.

This guide lists every agent skill shipped with NemoClaw, organized by audience.
Load the specific skill you need after identifying it here.

## Skill Buckets

Skills are grouped into three buckets by audience.
The prefix in each skill name indicates who it is for.

### `nemoclaw-user-*` (9 skills)

For end users operating a NemoClaw sandbox.
Covers installation, inference configuration, network policy management, monitoring, remote deployment, security configuration, workspace management, and reference material.

*Full details in `references/agent-skills.md`.*

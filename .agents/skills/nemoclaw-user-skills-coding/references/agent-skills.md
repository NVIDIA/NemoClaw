# NemoClaw Agent Skills for AI Coding Assistants

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

### `nemoclaw-maintainer-*` (6 skills)

For project maintainers.
Covers the daily maintainer cadence (morning standup, daytime loop, evening handoff), cutting releases, finding PRs to review, and performing security code reviews.

### `nemoclaw-contributor-*` (1 skill)

For contributors to the NemoClaw codebase.
Covers drafting documentation updates from recent commits.

## Skill Catalog

### User Skills

<!-- user-skills-table:begin -->
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
<!-- user-skills-table:end -->

### Maintainer Skills

| Skill | Summary |
|-------|---------|
| `nemoclaw-maintainer-morning` | Morning standup: triage the backlog, determine the day's target version, label selected items, surface stragglers, and output the daily plan. |
| `nemoclaw-maintainer-day` | Daytime loop: pick the highest-value version-targeted item and execute the right workflow (merge gate, salvage, security sweep, test gaps, hotspot cooling, or sequencing). Designed for `/loop`. |
| `nemoclaw-maintainer-evening` | End-of-day handoff: check version progress, bump stragglers to the next patch, generate a QA handoff summary, and cut the release tag. |
| `nemoclaw-maintainer-cut-release-tag` | Cut an annotated semver tag on main, move the `latest` floating tag, and push both to origin. |
| `nemoclaw-maintainer-find-review-pr` | Find open PRs labeled security + priority-high, link each to its issue, detect duplicates, and present a review summary. |
| `nemoclaw-maintainer-security-code-review` | Perform a 9-category security review of a PR or issue, producing per-category PASS/WARNING/FAIL verdicts. |

### Contributor Skills

| Skill | Summary |
|-------|---------|
| `nemoclaw-contributor-update-docs` | Scan recent git commits for user-facing changes and draft or update the corresponding documentation pages. |

## Getting Started

Ask the user which role best describes them:

- **User** — operating a NemoClaw sandbox (running, configuring, monitoring).
- **Contributor** — contributing code or docs to the NemoClaw project.
- **Maintainer** — triaging, reviewing, releasing, and managing the project day-to-day.

Skills are cumulative. Each role includes the skills from the roles above it:

| Role | Skills included | Count | Start with |
|------|----------------|-------|------------|
| User | `nemoclaw-user-*` | 9 | `nemoclaw-user-get-started` |
| Contributor | `nemoclaw-user-*` + `nemoclaw-contributor-*` | 10 | `nemoclaw-user-overview` |
| Maintainer | All skills | 16 | `nemoclaw-maintainer-morning` |

After identifying the role, present the applicable skills from the Skill Catalog above and recommend the starting skill.

## Use a Skill

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
| "Back up my agent workspace files." | `nemoclaw-user-workspace` |
| "What CLI commands are available?" | `nemoclaw-user-reference` |

You can also reference a skill directly by name if you know which one you need.

## Use the Skills with AI Coding Assistants

Agent skills follow the [Agent Skills standard](https://agentskills.io/skill-creation/best-practices) and [Claude Skills best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).
They are compatible with the following AI coding assistants.

| Assistant | Skill discovery |
|-----------|----------------|
| Cursor | Reads `AGENTS.md` at the project root, which references `.agents/skills/`. |
| Claude Code | Follows the `.claude/skills/` symlink, which points to `.agents/skills/`. |
| Other assistants | Point the assistant to `.agents/skills/` if it supports project-level skill loading. |

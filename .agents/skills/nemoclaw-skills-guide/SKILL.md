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

### `nemoclaw-maintainer-*` (3 skills)

For project maintainers.
Covers cutting releases, finding PRs to review, and performing security code reviews.

### `nemoclaw-contributor-*` (1 skill)

For contributors to the NemoClaw codebase.
Covers drafting documentation updates from recent commits.

## Skill Catalog

### User Skills

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

### Maintainer Skills

| Skill | Summary |
|-------|---------|
| `nemoclaw-maintainer-cut-release-tag` | Cut an annotated semver tag on main, move the `latest` floating tag, and push both to origin. |
| `nemoclaw-maintainer-find-review-pr` | Find open PRs labeled security + priority-high, link each to its issue, detect duplicates, and present a review summary. |
| `nemoclaw-maintainer-security-code-review` | Perform a 9-category security review of a PR or issue, producing per-category PASS/WARNING/FAIL verdicts. |

### Contributor Skills

| Skill | Summary |
|-------|---------|
| `nemoclaw-contributor-update-docs` | Scan recent git commits for user-facing changes and draft or update the corresponding documentation pages. |

## Quick Decision Guide

Use this table to jump directly to the right skill.

| I want to... | Load this skill |
|---------------|-----------------|
| Install NemoClaw or onboard for the first time | `nemoclaw-user-get-started` |
| Understand what NemoClaw is or how it fits together | `nemoclaw-user-overview` |
| Switch my inference provider or model | `nemoclaw-user-configure-inference` |
| Set up a local model server (Ollama, vLLM, NIM) | `nemoclaw-user-configure-inference` |
| Approve or deny a blocked network request | `nemoclaw-user-manage-policy` |
| Add or remove endpoints from the network policy | `nemoclaw-user-manage-policy` |
| Check sandbox logs, status, or health | `nemoclaw-user-monitor-sandbox` |
| Deploy to a remote GPU or cloud instance | `nemoclaw-user-deploy-remote` |
| Set up Telegram or a chat bridge | `nemoclaw-user-deploy-remote` |
| Review security controls or credential storage | `nemoclaw-user-configure-security` |
| Back up or restore workspace files | `nemoclaw-user-workspace` |
| Look up a CLI command or troubleshoot an error | `nemoclaw-user-reference` |
| Cut a new release tag | `nemoclaw-maintainer-cut-release-tag` |
| Find the next PR to review | `nemoclaw-maintainer-find-review-pr` |
| Security review a pull request | `nemoclaw-maintainer-security-code-review` |
| Update docs after landing code changes | `nemoclaw-contributor-update-docs` |

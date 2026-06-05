---
name: "nemoclaw-skills-guide"
description: "Start here. Introduces what NemoClaw is, what agent skills are available, and which skill to use for a given task. Use when discovering NemoClaw capabilities, choosing the right skill, or orienting in the project. Trigger keywords - skills, capabilities, what can I do, help, guide, index, overview, start here."
license: "Apache-2.0"
---

# NemoClaw Skills Guide

NVIDIA NemoClaw runs OpenClaw always-on assistants inside hardened OpenShell sandboxes with NVIDIA inference (Nemotron).
It provides CLI tooling, guided onboarding, a security blueprint, routed inference, and workspace management.

This guide lists every agent skill shipped with NemoClaw, organized by audience.
Load the specific skill you need after identifying it here.

## Skill Buckets

Skills are grouped into three buckets by audience.
The prefix in each skill name indicates who it is for.

### `nemoclaw-user-*` (10 skills)

For end users operating a NemoClaw sandbox.
Covers installation, inference configuration, network policy management, monitoring, remote deployment, security configuration, workspace management, and reference material.

### `nemoclaw-maintainer-*` (13 skills)

For project maintainers.
Covers the daily maintainer cadence (morning standup, daytime loop, evening handoff), workflow policy reference, cutting releases, drafting release notes, finding PRs to review, comparing PRs, cross-issue sweeps, triage, normalizing issue and PR title tags, performing security code reviews, and verifying whether stale bug reports still reproduce on the latest release.

### `nemoclaw-contributor-*` (2 skills)

For contributors to the NemoClaw codebase.
Covers creating pull requests that follow the project template and drafting documentation updates from recent commits.

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
| `nemoclaw-user-manage-sandboxes` | Manage day-two sandbox operations, including status, logs, diagnostics, rebuilds, upgrades, messaging channels, workspace files, backup, and restore. |
| `nemoclaw-user-reference` | CLI command reference, plugin and blueprint architecture, baseline network policies, and troubleshooting guide. |
| `nemoclaw-user-agent-skills` | Describes the agent skills shipped with NemoClaw and how to access them by cloning the repository. |
<!-- user-skills-table:end -->

### Maintainer Skills

| Skill | Summary |
|-------|---------|
| `nemoclaw-maintainer-morning` | Morning standup: triage the backlog, determine the day's target version, label selected items, surface stragglers, and output the daily plan. |
| `nemoclaw-maintainer-triage` | Suggest and optionally apply labels for issues and PRs using the live NemoClaw triage instructions. |
| `nemoclaw-maintainer-policies` | Read-only maintainer workflow policy reference for Issue Type, labels, Project fields, daily release labels, triage, duplicates, blocked items, and workflow decisions. |
| `nemoclaw-maintainer-cross-issue-sweep` | Scan open issues for adjacent fixes or contradiction risks when reviewing a PR. |
| `nemoclaw-maintainer-day` | Daytime loop: pick the highest-value version-targeted item and execute the right workflow (merge gate, salvage, security sweep, test gaps, hotspot cooling, or sequencing). Designed for `/loop`. |
| `nemoclaw-maintainer-evening` | End-of-day handoff: check version progress, bump stragglers to the next patch, generate a QA handoff summary, and cut the release tag. |
| `nemoclaw-maintainer-cut-release-tag` | Cut an annotated semver tag on a maintainer-confirmed `origin/main` commit; the GitHub workflow moves `latest`, and `lkg` stays manual. |
| `nemoclaw-maintainer-release-notes` | Draft release notes from live tag/compare data, with the three-paragraph narrative, categorized change list, and external-only contributor thanks. |
| `nemoclaw-maintainer-find-review-pr` | Find open PRs labeled security + priority-high, link each to its issue, detect duplicates, and present a review summary. |
| `nemoclaw-maintainer-pr-comparator` | Compare competing PRs for the same issue and recommend which one to merge. |
| `nemoclaw-maintainer-normalize-title-tags` | Preview and remove bracketed `NemoClaw` title tags from issues and PRs case-insensitively, even when the tag appears later in the title. |
| `nemoclaw-maintainer-security-code-review` | Perform a 9-category security review of a PR or issue, producing per-category PASS/WARNING/FAIL verdicts. |
| `nemoclaw-maintainer-verify-stale` | Verify whether old bug reports still reproduce on latest. Reuses or provisions a Brev box (CPU or GPU), runs the extracted reproducer, scores confidence, and posts an evidence-backed comment with `fixed-on-latest` or `verify-inconclusive`. Tag-only — never auto-closes. |

### Contributor Skills

| Skill | Summary |
|-------|---------|
| `nemoclaw-contributor-create-pr` | Create GitHub pull requests that follow the NemoClaw PR template, including pre-PR checks, conventional commit titles, and DCO sign-off. |
| `nemoclaw-contributor-update-docs` | Scan recent git commits for user-facing changes, draft or update documentation pages, and refresh generated user skills during release prep. |

## Getting Started

Ask the user which role best describes them:

- **User** — operating a NemoClaw sandbox (running, configuring, monitoring).
- **Contributor** — contributing code or docs to the NemoClaw project.
- **Maintainer** — triaging, reviewing, releasing, and managing the project day-to-day.

Skills are cumulative. Each role includes the skills from the roles above it:

| Role | Skills included | Count | Start with |
|------|----------------|-------|------------|
| User | `nemoclaw-user-*` | 10 | `nemoclaw-user-get-started` |
| Contributor | `nemoclaw-user-*` + `nemoclaw-contributor-*` | 12 | `nemoclaw-user-overview` |
| Maintainer | All skills | 25 | `nemoclaw-maintainer-morning` |

After identifying the role, present the applicable skills from the Skill Catalog above and recommend the starting skill.

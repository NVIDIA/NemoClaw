---
name: "nemoclaw-skills-guide"
description: "Start here. Introduces what NemoClaw is, what agent skills are available, and which skill to use for a given task. Use when discovering NemoClaw capabilities, choosing the right skill, or orienting in the project. Trigger keywords - skills, capabilities, what can I do, help, guide, index, overview, start here."
license: "Apache-2.0"
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Skills Guide

NVIDIA NemoClaw runs OpenClaw always-on assistants inside hardened OpenShell sandboxes with NVIDIA inference (Nemotron).
It provides CLI tooling, guided onboarding, a security blueprint, routed inference, and workspace management.

This guide lists every agent skill shipped with NemoClaw, organized by audience.
Load the specific skill you need after identifying it here.

## Skill Buckets

Skills are grouped into three buckets by audience.
The prefix in each skill name indicates who it is for.

### `nemoclaw-user-*` (1 skill)

For end users operating a NemoClaw sandbox.
Covers routing human users' AI agents to the canonical NemoClaw Markdown documentation.

### `nemoclaw-maintainer-*` (15 skills)

For project maintainers.
Covers the daily maintainer cadence, trusted E2E dispatch, workflow policy, documentation refactors, releases, review selection, comparison, triage, security review, and stale bug verification.

### `nemoclaw-contributor-*` (7 skills)

For contributors to the NemoClaw codebase.
Covers trusted checkout setup and readiness checks, issue planning and capability slicing, issue implementation, dependency
migration audits, creating pull requests that follow the project template, monitoring CI and
automated review feedback, drafting documentation updates, and onboarding new messaging channels.

## Skill Catalog

### User Skills

<!-- user-skills-table:begin -->
| Skill | Summary |
|-------|---------|
| `nemoclaw-user-guide` | Route human users' AI agents to `llms.txt` and the relevant NemoClaw Markdown docs for installation, configuration, operation, security, and troubleshooting. |
<!-- user-skills-table:end -->

### Maintainer Skills

| Skill | Summary |
|-------|---------|
| `nemoclaw-maintainer-morning` | Morning standup: triage the backlog, determine the day's target version, label selected items, surface stragglers, and output the daily plan. |
| `nemoclaw-maintainer-triage` | Propose Issue Type, Project fields, and approved labels for issues and PRs. Apply only changes that the maintainer accepts. |
| `nemoclaw-maintainer-policies` | Answer maintainer workflow questions from the read-only policy references. |
| `nemoclaw-maintainer-cross-issue-sweep` | Find open issues that a PR can also fix or conflict with. Report file and line evidence. |
| `nemoclaw-maintainer-day` | Run one daytime maintainer pass for the release version. Select a merge, salvage, security, test, conflict, or sequencing workflow. Designed for `/loop`. |
| `nemoclaw-maintainer-evening` | End-of-day handoff: require the pre-tag dated changelog PR, check version progress, identify stragglers, generate a QA handoff summary, cut the release tag, carry stragglers forward, retire the released label, and hand off the Announcement. |
| `nemoclaw-maintainer-cut-release-tag` | Verify the dated changelog entry, cut an annotated semver tag on a maintainer-confirmed `origin/main` commit, wait for workflow-managed `latest`, carry remaining open items forward, and delete the released label; `lkg` stays manual. |
| `nemoclaw-maintainer-e2e` | Describe default E2E triggered by pushes to `main`, dispatch exact-revision manual PR E2E, and verify applicable workflow evidence. |
| `nemoclaw-maintainer-release-notes` | Draft the post-tag Announcement from live tag/compare data, with the three-paragraph narrative, categorized change list, and external-only contributor thanks. |
| `nemoclaw-maintainer-find-review-pr` | Find open security PRs with Urgent or High Project Priority. Link each PR to its issue and identify competing PRs. |
| `nemoclaw-maintainer-pr-comparator` | Compare open PRs for the same issue. Apply gates and score the eligible PRs before you recommend one to merge. |
| `nemoclaw-maintainer-normalize-title-tags` | Preview and remove bracketed `NemoClaw` title tags from issues and PRs case-insensitively, even when the tag appears later in the title. |
| `nemoclaw-maintainer-refactor-docs` | Split oversized Fern docs into focused topics with journey-based navigation, canonical ownership, route-safe redirects, variant checks, and deduplication. |
| `nemoclaw-maintainer-security-code-review` | Review PR or issue changes in nine security categories. Report PASS, WARNING, or FAIL for each category. |
| `nemoclaw-maintainer-verify-stale` | Verify whether old issues with native Issue Type `Bug` still reproduce on latest. Reuses or provisions a Brev box, scores confidence, and proposes evidence-backed Project/comment writes for approval; never auto-closes. |

### Contributor Skills

| Skill | Summary |
|-------|---------|
| `nemoclaw-contributor-onboard` | Set up, repair, or verify a trusted source checkout, with explicit opt-ins for host-visible CLI exposure, the pinned agent, and runtime onboarding. |
| `nemoclaw-contributor-plan-issue` | Research, refine, and divide a named issue into independently valuable capability slices without implementing or publishing them. |
| `nemoclaw-contributor-implement-issue` | Implement the smallest accepted issue capability slice with focused validation and no pull request publication. |
| `nemoclaw-contributor-create-pr` | Create a PR with the NemoClaw template, required checks, DCO declaration, and verified commits. Then, monitor CI and automated reviews. |
| `nemoclaw-contributor-update-dependencies` | Audit and implement a dependency upgrade from current upstream and downstream contracts, including Hermes CalVer and base-image upgrades. |
| `nemoclaw-contributor-onboard-messaging-channel` | Add or review a messaging channel through the current messaging architecture and accepted product scope. |
| `nemoclaw-contributor-update-docs` | Find user-visible changes and update their owning documentation under current repository policy. |

## Getting Started

Ask the user which role best describes them:

- **User** — operating a NemoClaw sandbox (running, configuring, monitoring).
- **Contributor** — contributing code or docs to the NemoClaw project.
- **Maintainer** — triaging, reviewing, releasing, and managing the project day-to-day.

Skills are cumulative. Each role includes the skills from the roles above it:

| Role | Skills included | Count | Start with |
|------|----------------|-------|------------|
| User | `nemoclaw-user-*` | 1 | `nemoclaw-user-guide` |
| Contributor | `nemoclaw-user-*` + `nemoclaw-contributor-*` | 8 | `nemoclaw-contributor-onboard` |
| Maintainer | All skills | 23 | `nemoclaw-maintainer-morning` |

After identifying the role, present the applicable skills from the Skill Catalog above and recommend the starting skill.

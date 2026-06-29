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

### `nemoclaw-user-*` (1 skill)

For end users operating a NemoClaw sandbox.
Covers routing human users' AI agents to the canonical NemoClaw Markdown documentation.

### `nemoclaw-maintainer-*` (13 skills)

For project maintainers.
Covers the daily maintainer cadence (morning standup, daytime loop, evening handoff), workflow policy reference, cutting releases, drafting release notes, finding PRs to review, comparing PRs, cross-issue sweeps, triage, normalizing issue and PR title tags, performing security code reviews, and verifying whether stale bug reports still reproduce on the latest release.

### `nemoclaw-contributor-*` (3 skills)

For contributors to the NemoClaw codebase.
Covers creating pull requests that follow the project template, monitoring CI and automated review feedback after pushing, drafting documentation updates from recent commits, and onboarding new messaging channels.

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
| `nemoclaw-maintainer-triage` | Suggest and optionally apply labels for issues and PRs using the live NemoClaw triage instructions. |
| `nemoclaw-maintainer-policies` | Read-only maintainer workflow policy reference for Issue Type, labels, Project fields, daily release labels, triage, duplicates, blocked items, and workflow decisions. |
| `nemoclaw-maintainer-cross-issue-sweep` | Scan open issues for adjacent fixes or contradiction risks when reviewing a PR. |
| `nemoclaw-maintainer-day` | Daytime loop: pick the highest-value version-targeted item and execute the right workflow (merge gate, salvage, security sweep, test gaps, hotspot cooling, or sequencing). Designed for `/loop`. |
| `nemoclaw-maintainer-evening` | End-of-day handoff: check version progress, identify stragglers, generate a QA handoff summary, cut the release tag, bump stragglers to the next patch, and hand off release notes. |
| `nemoclaw-maintainer-cut-release-tag` | Cut an annotated semver tag on a maintainer-confirmed `origin/main` commit, wait for workflow-managed `latest`, and bump remaining open items to the next patch; `lkg` stays manual. |
| `nemoclaw-maintainer-release-notes` | Draft release notes from live tag/compare data, with the three-paragraph narrative, categorized change list, and external-only contributor thanks. |
| `nemoclaw-maintainer-find-review-pr` | Find open security PRs with Urgent or High Project Priority, link each to its issue, detect duplicates, and present a review summary. |
| `nemoclaw-maintainer-pr-comparator` | Compare competing PRs for the same issue and recommend which one to merge. |
| `nemoclaw-maintainer-normalize-title-tags` | Preview and remove bracketed `NemoClaw` title tags from issues and PRs case-insensitively, even when the tag appears later in the title. |
| `nemoclaw-maintainer-security-code-review` | Perform a 9-category security review of a PR or issue, producing per-category PASS/WARNING/FAIL verdicts. |
| `nemoclaw-maintainer-verify-stale` | Verify whether old issues with native Issue Type `Bug` still reproduce on latest. Reuses or provisions a Brev box, scores confidence, and proposes evidence-backed Project/comment writes for approval; never auto-closes. |

### Contributor Skills

| Skill | Summary |
|-------|---------|
| `nemoclaw-contributor-create-pr` | Create GitHub pull requests that follow the NemoClaw PR template, including pre-PR checks, conventional commit titles, DCO sign-off, post-push CI monitoring, and CodeRabbit/PR Review Advisor follow-up. |
| `nemoclaw-contributor-onboard-messaging-channel` | Add or review a new messaging channel with manifest-first implementation, upstream source analysis, plugin install confirmation, reachability checks, policies, docs, and tests. |
| `nemoclaw-contributor-update-docs` | Scan recent git commits for user-facing changes and draft or update documentation pages during release prep. |

## Getting Started

Ask the user which role best describes them:

- **User** — operating a NemoClaw sandbox (running, configuring, monitoring).
- **Contributor** — contributing code or docs to the NemoClaw project.
- **Maintainer** — triaging, reviewing, releasing, and managing the project day-to-day.

Skills are cumulative. Each role includes the skills from the roles above it:

| Role | Skills included | Count | Start with |
|------|----------------|-------|------------|
| User | `nemoclaw-user-*` | 1 | `nemoclaw-user-guide` |
| Contributor | `nemoclaw-user-*` + `nemoclaw-contributor-*` | 4 | `nemoclaw-user-guide` |
| Maintainer | All skills | 17 | `nemoclaw-maintainer-morning` |

After identifying the role, present the applicable skills from the Skill Catalog above and recommend the starting skill.

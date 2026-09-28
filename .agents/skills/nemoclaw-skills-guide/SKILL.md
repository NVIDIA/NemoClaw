---
name: "nemoclaw-skills-guide"
description: "Find the repository skill for a NemoClaw task or browse the skill catalog. Use when skill selection needs help."
license: "Apache-2.0"
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Skills Guide

Choose the skill whose capability matches the task. Use the catalog when selection is unclear;
go directly to a known skill otherwise. Infer the audience from the request and repository context.

Contributor stages compose within one task: setup when needed, planning when requested,
implementation for code and tests, and publication when the user requests a PR. A stage boundary
does not require renewed authorization for work the user already requested.

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
| `nemoclaw-maintainer-evening` | Complete the cumulative documentation PR and release entry, show release context, and optionally start tag cutting. |
| `nemoclaw-maintainer-cut-release-tag` | Verify candidate evidence, record the maintainer's E2E decision, and cut one signed semver tag. |
| [`nemoclaw-maintainer-e2e`](../nemoclaw-maintainer-e2e/SKILL.md) | Route requested local E2E, trusted GitHub dispatch, or read-only release evidence. |
| `nemoclaw-maintainer-classify-ci-failure` | Classify one failed GitHub Actions job from bounded, redacted logs and an optional validated artifact. |
| `nemoclaw-maintainer-analyze-ci-performance` | Analyze retained CLI test timings and base-image publication latency with bounded, read-only GitHub evidence. |
| `nemoclaw-maintainer-analyze-pr-value-stream` | Measure one PR from its earliest observable branch push through merge, separate approval delay from automation time, and compare the latest revision with a target. |
| `nemoclaw-maintainer-runtime-provider` | Implement or review one managed runtime provider through the bundle API, qualification-backed activation, provider-neutral orchestration, and exact-commit E2E qualification. |
| `nemoclaw-maintainer-fix-e2e-failures` | Continuously fix automatic `main` E2E failures by root cause, coordinate peer approvals, merge eligible PRs, and monitor new results. |
| `nemoclaw-maintainer-validate-launchable` | Run advisory validation of the staging Brev Launchable deployment, image and runtime identity, preinstalled user journey, inference, and cleanup. |
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
| `nemoclaw-contributor-implement-issue` | Implement the smallest accepted issue capability slice with focused validation, then continue to publication when requested. |
| `nemoclaw-contributor-create-pr` | Create a PR with the NemoClaw template, required checks, DCO declaration, and verified commits. Then, monitor CI and automated reviews. |
| `nemoclaw-contributor-update-dependencies` | Audit and implement a dependency upgrade from current upstream and downstream contracts, including Hermes CalVer and base-image upgrades. |
| `nemoclaw-contributor-update-docs` | Find user-visible changes merged to `main` and update their owning documentation under current repository policy. |

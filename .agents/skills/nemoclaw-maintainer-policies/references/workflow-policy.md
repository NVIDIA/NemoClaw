<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer Workflow Policy

This package is the canonical maintainer-policy source for NemoClaw agent workflows.

## Source Of Truth Hierarchy

1. Native GitHub Issue Type classifies issues as `Bug`, `Enhancement`, `Task`, `Documentation`, `Epic`, or `Initiative`.
2. `triage-instructions.md` defines how agents evaluate issues and PRs, including confidence, minimal-labeling rules, and when to ask for more information.
3. `label-taxonomy.md` and `label-taxonomy.json` define the approved label taxonomy and machine-readable validation rules.
4. GitHub Project fields own lifecycle, priority, effort, dates, and release/project status. Project Status values include `Needs Review`.
5. Labels own routing, reproduction surfaces, immediate action queues, community contribution signals, PR release activation, and issue release tracking.

## Policy Boundaries

- Do not duplicate policy in individual maintainer or contributor skills. Those skills should point here and keep only workflow-specific mechanics.
- Do not use labels as a second source of truth for issue type, priority, effort, lifecycle status, sprint, or resolution.
- Default mode is recommendation-only. Agents may write only inside an explicit authorization context.
- `human_review_required` means the proposed write is outside the current authorization context, has elevated risk, or needs maintainer judgment before execution.

An authorization context can be:

- A maintainer request that asks an agent to perform a specific class of writes.
- A repo automation configured to apply a known class of writes.
- A triage UI user accepting a suggested write set.
- A release workflow running under a named release automation.
- An authorized agent-owned workflow operating only in the `agt: *` label namespace.

Each write requires authorization for that operation.
This includes labels, Issue Type, Project fields, comments, release labels, closes, merges, and label deletion.
Security, destructive, release, merge, and comment writes require stricter authorization than triage labels.

## Contributor PR Eligibility

Contributor-owned PRs must pass DCO and commit-verification checks before review.
The contributor must correct a failure.

- The PR description must include the contributor's `Signed-off-by:` declaration.
- Every commit must appear as `Verified` in GitHub.
- Contributor agents must check both requirements before running `gh pr create`.
- If either check fails, the agent must stop and tell the contributor how to correct it.
- If force-push is not allowed, the contributor must create a branch and PR with verified commits.

Maintainers must reject a PR with an unverified commit or no DCO declaration.
Do not merge, approve, or repair it for the contributor.

## Issue Classification

Native GitHub Issue Type is the canonical issue-kind field:

| Issue Type | Use For |
|---|---|
| `Bug` | Confirmed or suspected broken behavior, regression, crash, incorrect result, or security-sensitive malfunction. |
| `Enhancement` | User-visible improvement or new capability that is not a regression. |
| `Task` | Maintainer work, cleanup, infrastructure, testing, policy, or internal follow-up. |
| `Documentation` | Missing, incorrect, unclear, or broken documentation. |
| `Epic` | Multi-issue delivery group. |
| `Initiative` | Larger product or program objective spanning epics or projects. |

Labels must not replace native Issue Type.

## Agent-Owned Labels

`agt: *` is an agent-owned namespace.

- Agents may create, apply, remove, and delete `agt: *` labels inside an authorized agent-owned workflow.
- `agt: *` labels are agent automation and coordination signals.
- `agt: *` labels must not encode product type, priority, project status, sprint, release version, or issue classification.
- Human-maintained taxonomy files should not depend on an `agt: *` label being durable.

Consumers must use this package for canonical write policy.

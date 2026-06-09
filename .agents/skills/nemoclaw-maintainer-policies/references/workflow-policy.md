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

Canonical labels, Issue Type, Project fields, public comments, release labels, closes, merges, and non-agent label deletion require an authorization context that explicitly allows that operation. Security-sensitive, destructive, release, merge, and public-comment writes require stricter authorization than ordinary triage labels.

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

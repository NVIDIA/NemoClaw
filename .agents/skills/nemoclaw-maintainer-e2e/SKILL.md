---
name: nemoclaw-maintainer-e2e
description: "Run or inspect NemoClaw live E2E evidence. Routes requested local execution, trusted GitHub dispatch, and release-evidence inspection."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Maintainer E2E

## Route the Request

| Request | Procedure |
| --- | --- |
| Run working-tree source or a selected local commit | [Local Runs](references/local-runs.md) |
| Run the latest PR commit on GitHub, including failure-triggered comparison with its exact base | [Manual PR Runs](references/manual-pr.md) |
| Run the current `main` commit on GitHub | [Main Runs](references/main-runs.md) and the Launchable boundary below |
| Inspect existing evidence for a release decision | [Report the Release Context](#report-the-release-context) |
| Triage, diagnose, debug, or repair an E2E failure | Load [Audit E2E Assertions](../nemoclaw-maintainer-audit-e2e-assertions/SKILL.md); this skill still owns dispatch and run-level reporting. |
| Classify one failed GitHub Actions job | For E2E failures, use the assertion-audit route above. For other jobs, load `nemoclaw-maintainer-classify-ci-failure`. |

A new GitHub candidate run tests the latest PR commit or the current `main` commit.
Manual PR runs may replay the PR base after a candidate failure, as described in their procedure.
Report arbitrary historical candidate selection as unsupported. Preserve the workflow's identity and trust checks.

Push runs select change-relevant E2E and publish `Relevant E2E`; they do not always run the full
suite. Only a full manual run publishes `Release qualification`. That aggregate reports the full
suite; it does not decide whether a tag can proceed. A generic E2E request does not authorize
`Exact staging Brev Launchable`.

Use `.github/workflows/e2e.yaml` from trusted `main` for GitHub runs. Do not substitute local live
E2E unless the maintainer explicitly requests local execution. Do not load a dispatch reference for
a release inspection unless the maintainer requests a new run.

## Carry execution authorization through the task

When the accepted upgrade or repair task includes live E2E, carry that authorization through
in-scope repairs and qualification of subsequent candidate commits. A completed, failed, or
cancelled run, a new candidate SHA, compaction, or a skill handoff does not expire it.
Do not ask for dispatch approval again solely because one of those events occurred.
Record the authorized PR, selectors, targets, credential scope, cost bounds, cleanup obligations,
and any explicit expiry or run limit in the shared task record. Do not invent a one-run limit.

Before each dispatch, recheck candidate identity, execution prerequisites, remaining budgets,
and active runs. Reuse a matching run; preserve spent retries. Apply the shared bounded retry
policy to unchanged inputs. Qualification after an in-scope repair evaluates changed inputs;
it is not permission for repeated unchanged runs or for exceeding a task-wide limit.
Ask only for a missing initial execution decision or a material expansion of the recorded scope,
cost, credentials, or resource ownership. A generic PR request alone does not authorize every live target.

Distinguish task authorization from GitHub environment protection, repository access, and trusted
controller admission. Existing task authorization does not bypass those controls. If one blocks
execution, name the exact gate, run URL, responsible approver, and required action when known;
do not replace it with a generic request to approve E2E again. Continue independent authorized work.

## Staging Brev Launchable Boundary

Read [Staging Launchable](references/staging-launchable.md) before a dispatch that includes
`Exact staging Brev Launchable`. It owns the credential, deployment, cleanup, artifact, and queue
boundaries. A generic E2E request does not authorize that job.

## Report the Release Context

Read [Release Context](references/release-context.md) to inspect the newest identifiable full
manual `main` run and report its commit, times, attempt, aggregate, and non-successful jobs.
This is read-only. The caller owns the release decision.

## Handoff

Return:

- the mode and selectors;
- the tested commit;
- the result;
- the workflow URL; and
- relevant job URLs.

A focused run supplements the reported full-run status; it does not become a full run.

Report selected, skipped, failed, and unreached scenarios separately, with the selection or prerequisite reason for each relevant gap.
Use the trusted planner's result and retained receipts; empty selectors do not select every opt-in job.
For timeouts, report the terminating deadline, last completed phase, first unreached check, and available timing evidence.
Distinguish the observed failure mechanism from a demonstrated cause of increased runtime.
Keep run identities, active comparisons, and trial counts in the [task record](../_shared/task-continuation.md).

Do not ask for release confirmation or decide whether a release can proceed. The release-tag skill
owns the general E2E decision and records any reason for proceeding with an exceptional general E2E
status.

## Access Failures

Follow the shared [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md).

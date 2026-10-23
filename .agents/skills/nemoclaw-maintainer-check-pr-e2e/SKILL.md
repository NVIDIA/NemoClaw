---
name: nemoclaw-maintainer-check-pr-e2e
description: "Verify passing E2E evidence before approving a NemoClaw PR targeting main. PRs targeting v1 are excluded."
license: "Apache-2.0"
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Check PR E2E Evidence Before Approval

Every PR targeting `main` must have passing E2E evidence before approval, including documentation,
dependency, and bot PRs. Determine applicability from the PR's target branch, not its source branch
or version label. PRs targeting `v1` are excluded. Report other target branches as not applicable.

This skill inspects evidence. It does not dispatch tests, approve workflows, publish reviews, or merge PRs.
This is an agent approval requirement; the manual workflow remains an advisory GitHub check.
Follow [Documentation Writing and Review](../_shared/documentation-writing-review.md) for the review result.

## Record the PR Identity

Read the target branch first. For `v1` or another branch outside `main`, return `NOT APPLICABLE` without requiring E2E evidence.
For `main`, read fresh GitHub metadata for the repository, PR number, state, source repository,
source owner, latest PR commit SHA, and base SHA. Preserve those values throughout the check.
Missing or ambiguous identity blocks approval.

Read the candidate's verified review-queue context through
[Discovery and identity](../../../tools/pr-review-advisor/REVIEW-QUEUE.md#discovery-and-identity).
Preserve its complete `deterministic.requiredJobs` and `deterministic.requiredTargets` as the required coverage floor.
Include any additional coverage explicitly required by the accepted scope.
The trusted [workflow planner](../../../tools/e2e/workflow-plan.mts) owns selector expansion and runtime coverage.
Verify its result against that floor; do not derive a separate coverage list from the diff.

When both required arrays are empty, require the existing credential-free `vllm-docker-storage` E2E in the `shared-e2e` job.
Use explicit `targets=vllm-docker-storage`, empty `jobs`, and `gateway_runtimes=docker` inputs.
Require its live Docker execution to pass, alongside every other selected execution.
Do not substitute the credential-bearing default suite for this fallback.
An empty selection or a run containing only planning or support tests cannot satisfy this gate.

## Verify the Evidence

Read the [Results contract](../../../tools/pr-review-advisor/REVIEW-QUEUE.md#results) before accepting artifacts.
Use GitHub run, job, and artifact metadata to verify the evidence; a PR comment or green badge is insufficient.

Require all of these conditions:

- The run uses `.github/workflows/e2e.yaml` from trusted `NVIDIA/NemoClaw` `main` with event `workflow_dispatch`.
- The dispatch receipt matches this PR, source repository and owner, latest PR commit, base SHA, and executing workflow SHA.
- The dispatch and result artifact envelopes identify the same run and attempt, with supported payload versions.
- The selected coverage is nonempty and covers the required plan. Record the selectors and any separately authorized opt-ins.
- The workflow completed with conclusion `success`, and `Relevant E2E` succeeded.
- The result receipt reports `pass`. Every selected E2E job and matrix execution succeeded.
  Apply only the Results contract's planner-authorized exception for skipped `base-image-publication`.

For a manual PR run, Actions `head_sha` identifies the executing workflow commit.
Use the verified dispatch receipt to identify the tested candidate commit.
Inspect the latest attempt of each relied-on run. An earlier successful attempt cannot replace a failed or incomplete rerun.
Keep each dispatch/result artifact pair within one run and attempt.

Unit tests, `e2e-support`, local claims, base replays, and post-merge `main` runs cannot replace passing candidate evidence.
Full-main `Release qualification` does not qualify a different PR commit.
Infrastructure failures and failures inherited from the base do not satisfy this gate.
Missing, expired, stale, pending, failed, cancelled, or skipped selected E2E evidence blocks approval.

## Handle Missing or Failing Evidence

Continue the complete review and report the E2E blocker with the other findings.
When a maintainer authorizes a run, use [Run Maintainer E2E](../nemoclaw-maintainer-e2e/SKILL.md).
This requirement does not authorize credential use, hardware, staging Launchable execution, or fork adoption.
The manual PR workflow rejects fork sources. Keep the original fork PR blocked by this gate.
Authorized adoption requires a replacement PR with a source branch in `NVIDIA/NemoClaw`.
Evaluate the replacement PR's own identity and E2E evidence; its results do not qualify the original PR.
Follow [source-repository eligibility](../nemoclaw-contributor-create-pr/references/publication.md#select-the-source-repository)
before publishing a replacement or closing the original. Do not create an exemption or bypass the workflow's trust checks.
Before diagnosing or repairing failed E2E, use [Audit E2E Assertions](../nemoclaw-maintainer-audit-e2e-assertions/SKILL.md).
Preserve the shared [bounded retry policy](../_shared/pr-follow-up.md#bounded-retry-policy).

## Complete the Check

Re-read the PR identity and relied-on run attempts immediately before approval.
A changed target, source identity, latest PR commit, base SHA, or run attempt requires a fresh evaluation.

Return `PASS`, `BLOCKED`, or `NOT APPLICABLE`, with the target branch and reason.
For `main`, include the candidate and base SHAs, coverage, workflow SHA, run attempts, artifact identities,
and workflow and relevant job URLs. Name any missing evidence.
Only `PASS` satisfies this E2E requirement for `main`; the other approval gates must still pass.
Exclusion from this gate does not waive any existing requirement for `v1` or another target branch.

For access failures, follow [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md).

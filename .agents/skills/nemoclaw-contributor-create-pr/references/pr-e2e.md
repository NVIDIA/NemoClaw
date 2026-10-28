<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run E2E for a Published PR

The PR creator owns obtaining passing candidate evidence. The existing E2E skill owns execution;
the evidence-check skill owns qualification. Use this procedure after publication and feedback collection.
Do not create another dispatcher or substitute local execution for the trusted GitHub runner.

## Prepare the candidate and coverage

Read the PR target branch first. The automatic stage applies to `main`; `v1` is excluded.
For another target, preserve separately requested tests without inventing a requirement from this policy.

Complete [PR follow-up](../../_shared/pr-follow-up.md) for one unchanged latest PR commit.
Record the PR number, source repository and owner, candidate SHA, base SHA, and trusted workflow revision.
Require the source repository to be `NVIDIA/NemoClaw`; follow publication's source-eligibility procedure for an incompatible source.

Use [Record the PR Identity](../../nemoclaw-maintainer-check-pr-e2e/SKILL.md#record-the-pr-identity)
to obtain the complete verified coverage plan, including its empty-plan fallback.
That owner defines selector selection. Do not compute a separate list or discard unresolved coverage.
Record selectors, gateway runtimes, credential boundaries, resource ownership, and execution opt-ins before dispatch.
Never replace a focused plan with empty job and target inputs; those inputs select the default suite.

## Reuse or run the candidate

Inspect existing evidence through [Check PR E2E Evidence](../../nemoclaw-maintainer-check-pr-e2e/SKILL.md).
If it returns `PASS` for the recorded identity and full plan, reuse that evidence.
If a matching run is queued or running, monitor it instead of dispatching a duplicate.
Preserve its correlation ID and attempt. An ambiguous dispatch requires reconciliation through the runner's procedure.

For missing evidence, carry forward existing authorization for the selected execution.
The E2E requirement alone does not authorize credentials, hardware, staging deployments, or a different resource owner.
If authorization is missing, prepare the concrete plan and request only that missing decision.
Keep the draft and report the uncompleted E2E stage; do not describe the full lifecycle as complete.
Do not ask again when the existing authorization still covers the same target, cost, credentials, and cleanup.

When authorized, invoke [Run Maintainer E2E](../../nemoclaw-maintainer-e2e/SKILL.md) in
[Manual PR Runs](../../nemoclaw-maintainer-e2e/references/manual-pr.md) mode.
Use the trusted `main` workflow and its recorded candidate, base, selectors, and gateway runtimes.
Preserve its trust checks, credential restrictions, correlation, bounded polling, artifact handling, and cleanup.
Hardware and `Exact staging Brev Launchable` retain their separate opt-ins.

After the runner returns, invoke the evidence-check skill and require `PASS`.
A successful dispatch or a green workflow badge alone does not complete verification.
Record the verified selectors, runtime coverage, candidate and base SHAs, workflow SHA, run and attempt,
dispatch and result artifact identities, and workflow and relevant job URLs in the PR evidence.

## Repair and continue

Before diagnosing or repairing failed E2E, use
[Audit E2E Assertions](../../nemoclaw-maintainer-audit-e2e-assertions/SKILL.md).
Return classified in-scope code repairs to `nemoclaw-contributor-implement-issue`.
Then use the publication workflow for validation and a guarded update.
Collect CI and reviews for the new candidate before returning to this E2E stage.

Follow the shared [bounded retry policy](../../_shared/pr-follow-up.md#bounded-retry-policy).
Do not blindly retry, replay the base, or duplicate an active run.
An infrastructure failure or a passing base replay does not qualify the candidate.

Re-read the PR identity and run attempt before reporting readiness.
A candidate update invalidates affected evidence and requires qualification of the new commit.
It does not revoke execution authorization that still covers the same boundaries.
If the base, source identity, or plan changes, recompute qualification and check the authorization boundaries again.

Return to the PR creator with `PASS`, `BLOCKED`, or `NOT APPLICABLE`, supporting evidence, and remaining decisions.
Only `PASS` completes this stage for `main`. The other review and approval requirements still apply.

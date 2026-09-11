<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Review queue evidence

Issue #11489 owns this read-only consumer contract. These artifacts are advisory evidence, not merge authorization.
The consumer must verify GitHub provenance before parsing their contents. New artifacts appear only after this producer reaches trusted `main`.
Older runs remain unknown. The blocker ledger is a separate dependency proposed by PR #11047; this change does not publish blocker counts.

## Advisor recommendations

Each successful specialist writes `pr-review-<interest>-e2e.json` inside `pr-review-specialist-<interest>-<attempt>`.
`e2e-receipt.mts` records and validates complete specialist evidence. It reuses the recommendation types, selector checks, and deduplication in `tools/advisors/e2e-recommendations.mts`.
The payload has these fields:

| Field | Meaning |
| --- | --- |
| `kind` | `nemoclaw-advisor-e2e-v1` |
| `headSha`, `baseSha` | Full candidate and comparison commit SHAs |
| `interest`, `expectedSpecialists` | Specialist owner and complete trusted specialist inventory |
| `deterministic.version`, `deterministic.planHash` | Reference to the existing risk plan, not a second copy of its recommendations |
| `advisor.recommendations` | Every additional specialist recommendation, including optional coverage |
| `advisor.noAdditionalE2eReason` | Required nonempty reason when the specialist adds no selectors; otherwise `null` |
| `advisor.unresolvedRecommendations` | Needed coverage without a supported selector; prevents a complete passing decision |

A recommendation is `{selectorType, id, required, reason}`. `selectorType` is `job`, `target`, or `all`.
`all` uses ID `e2e-all`. Preserve `required:false`: the review queue requires optional recommendations to pass too.
Deduplicate by selector type and ID. A required occurrence takes precedence over an optional occurrence.
Collection adds every job and typed target from the context's trusted risk plan. Specialist output cannot remove that floor.

The recording tool validates IDs against the trusted inventory. An invalid or duplicate selection is rejected without recording a result.
The specialist can correct rejected input. Missing successful recording fails the specialist run.
Never discard invalid records and then treat the remaining empty list as success.

Only a complete set can return `no-tests-needed`: every specialist has an explicit empty reason, both selection lists are empty, and no unresolved coverage remains.
An empty deterministic plan alone is insufficient. Free-form Markdown is not a count or selector source.
Tests in `test/automation/pull-requests/pr-review-advisor-e2e-receipt.test.ts` provide selected, optional, full-suite, empty, unresolved, and invalid examples.
`test/fixtures/review-queue-e2e-optional.json` is a tested payload fixture with a synthetic single-specialist inventory.

## Discovery and identity

Each specialist artifact also contains `review-queue-context.json`, with kind `nemoclaw-review-queue-context-v1`.
The trusted runner writes it before model execution from the same deterministic context used by that specialist.
It contains no GitHub discussion context or session internals. No repository code execution is required to read it.

| Field | Meaning |
| --- | --- |
| `headSha`, `baseSha` | Full candidate and comparison commits |
| `expectedSpecialists` | Complete sorted trusted specialist inventory |
| `deterministic` | Complete existing risk plan: `version`, `planHash`, `headSha`, `changedFiles`, `tier`, `families`, `requiredJobs`, `requiredTargets` |
| `selectorInventory` | Existing trusted selector inventory: `workflow`, `fanoutId`, `selectorTypes`, `allowedJobIds`, `manualOnlyJobIds`, `liveSupportedTargetIds` |
| `provenance` | Hosted identity described below; `null` for local runs |

Hosted provenance contains `repository`, `prNumber`, `workflowRepository`, `workflowSha`, `workflowPath`, `eventName`, `runId`, and `runAttempt`.
Run IDs and attempts are positive decimal strings. The PR number is a positive integer, or `null` for non-PR runs.
The workflow repository is `NVIDIA/NemoClaw`; the path is `.github/workflows/pr-review-advisor.yaml`.
Events are `workflow_run` or `workflow_dispatch`. Local or non-PR provenance cannot establish queue readiness.
Every provenance value must match independently verified GitHub evidence. Payload identity does not authenticate an artifact.

Preserve every `deterministic.requiredJobs` and `deterministic.requiredTargets` entry as required coverage, using its `id` and `reasons`.
Both arrays contain `{id, tier, families, reasons, matchedFiles}` entries. Empty arrays explicitly represent an empty deterministic floor.
Do not derive selectors from family descriptions or recompute a partial plan from changed files.
The existing plan hash identifies the complete plan, including workflow-derived focused coverage; it is not an artifact signature.
The producer copies that plan without truncation. Reject incomplete data rather than dropping unrecognized selections.
`test/fixtures/review-queue-context.json` is a tested synthetic payload for passive consumers.

1. Read the current PR candidate SHA, base SHA, and source repository from GitHub.
2. Find the trusted `pr-review-advisor.yaml` run that reviewed that candidate. Validate the workflow path, repository, event, and trusted workflow revision.
3. Read regular Markdown prompt filenames under `tools/pr-review-advisor/specialists` at the trusted workflow revision. Never let a payload shorten that inventory.
4. List all artifacts for the run. Select one nonexpired artifact per expected specialist, with the current attempt suffix.
5. Verify each immutable artifact ID belongs to that run and verify its download digest. Extract only bounded regular files without links or traversal.
6. Require identical contexts across all specialists, matching trusted identities and inventories. Match receipt candidate/base, specialist, and plan identities to that context.
7. Recheck the PR identity and run attempt after collection. Discard the result if either changed.

Run and attempt identity come from the GitHub artifact envelope. Payloads cannot establish their own provenance.
Do not combine artifacts from different runs or attempts. Incomplete rerun artifacts remain unknown even if an earlier attempt passed.
Runs without the context sidecar remain unknown. Do not scrape Pi session chunks to supply missing evidence.

The proposed #11047 finding ledger is separate. All validated P0/P1 findings count as blockers, including findings excluded from automated repair.
Require every expected specialist ledger before reporting zero. A completion comment alone cannot establish zero blockers.

## Dispatch

Dispatch `e2e.yaml` with `ref:main` through the existing authenticated GitHub workflow interface.
Bind `pr_number`, `checkout_repository:NVIDIA/NemoClaw`, `checkout_sha`, `base_sha`, and `workflow_sha` to fresh GitHub evidence.
`checkout_sha` must be the latest PR commit for review-queue evidence. A base replay cannot satisfy it.
Fork PRs require the existing maintainer adoption workflow; this contract does not authorize adoption.

Send job IDs in comma-separated `jobs`, and typed target IDs in comma-separated `targets`.
For `e2e-all`, empty both selectors to request the default suite. Empty selectors never mean no tests.
An explicit full-suite selection does not erase separately recommended hardware or other explicit-only selectors; dispatch those separately with their required authority.
Use `inference_mode:mock` unless the requested coverage requires another supported mode.
Preserve `gateway_runtime` or `gateway_runtimes` when coverage requires a specific runtime.

Keep `allow_jetson_dispatch` and `include_staging_brev_launchable` false unless separately authorized.
Recommendations do not grant hardware opt-in. Protected environments and other workflow checks still apply.
See the owning `test/e2e/README.md` for credential custody and hardware requirements.

Generate a UUIDv4 `correlation_id` once for the logical dispatch. Persist the candidate, base, workflow SHA, selectors, opt-ins, correlation, and send time before sending.
An accepted response is not passing E2E evidence. Reconcile a returned run ID against GitHub workflow identity and the dispatch receipt.
For an ambiguous response, read the workflow inventory and match the correlation in `E2E PR #<number> (<uuid>)` plus repository, workflow path, event, and workflow SHA.
Require one matching run. Zero, multiple, inconsistent, or incomplete results remain unresolved; do not dispatch again automatically.
`pr-e2e-dispatch-reconciliation.mts` documents the existing bounded bot-controller reconciliation implementation. Its bot actor checks are not suitable for a human dispatcher unchanged.

## Results

The existing `e2e-dispatch-<run-id>-<attempt>/dispatch.json` (`nemoclaw-e2e-dispatch-v2`) binds selectors, opt-ins, candidate, base, workflow, actor, run, and attempt.
Require it to match the recorded request and current PR before accepting results.

The existing `Relevant E2E` job uploads `review-queue-e2e-result-<run-id>-<attempt>/review-queue-e2e-result.json` for PR runs.
Its kind is `nemoclaw-review-queue-e2e-result-v1`. `dispatchArtifact` references the existing dispatch artifact from the same run and attempt.
Verify both artifact envelopes and the dispatch identity before accepting results. A payload reference alone proves no identity.
`release-qualification.mts` records selected workflow jobs and their GitHub `needs` results before enforcing its existing success check.
PR evidence requires a nonempty selection. Every selected job, `base-image-publication`, and `generate-matrix` must succeed.
Each matrix group includes its fan-out executions. A pass requires every selected group to succeed.
Missing, skipped, or cancelled groups are unknown. A failed selected group or controller produces `fail`.
This aggregate proves the whole dispatched set; it does not attribute a group failure to an individual selector within that group.
For per-selector failure detail, retain the GitHub job links and report the aggregate limitation.

Require workflow completion with conclusion `success` and receipt status `pass` before accepting the dispatched set as passing.
A queued or running matching run is pending. A complete search with no matching dispatch is not-run.
Missing artifacts, skipped jobs, cancellations, expired retention, stale identities, unsupported versions, and ambiguous searches remain unknown.
All recommendation selectors must be covered by passing matching dispatches before the consumer reports green.
Tests in `test/e2e/support/release-qualification.test.ts` cover pass, fail, incomplete, skipped, cancelled, and invalid dispatch references.
`test/fixtures/review-queue-e2e-pass.json` is the tested passing payload fixture. Its dispatch reference is synthetic.

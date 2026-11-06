<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Qualify merge outcome reporting

## Accepted scope

Decision: Accept for #14163. Accountable maintainer: @deepujain.
The approval covers the reporting workflow and standalone helper in #14253.

Reason: maintainers need outcomes beside the opening session report to evaluate
workflow changes. Reports use GitHub metadata and label revision counts as
observed because complete push history is unavailable.

Placement: `.github/workflows/pr-merge-report.yml` and the standalone helper
under `tools/ci/`. Repository automation maintainers own failures and recovery;
the accountable maintainer owns changes to this scope.

Lifecycle: reporting starts with the next merge after installation. Each merged
PR into `main` or `v1` receives one collapsed bot report. Runs are serialized per
PR and bounded to 20 minutes; artifacts expire after 90 days. Existing comments
remain intact, and retries must avoid duplicate reports.

Compatibility and security: preserve the opening report and support fork PRs
without reading session records or executing PR code. Compile only the verified
squash-parent reporter and disable persisted checkout credentials. Expose the
short-lived workflow token only to the API steps that need it, with the
permissions declared by the job.

Validation plan: run the reporter and workflow-adapter tests below, including
API refusal, trusted-checkout rejection, publication readback, failure retention,
and duplicate avoidance. Complete hosted acceptance after installation; local
fixtures do not establish GitHub event delivery or effective token permissions.

## Local evidence

The report workflow has two evidence owners. The standalone Rust tests cover
metadata selection, rendering and publication recovery. The workflow adapter
test executes the checked-in YAML with controlled API, compiler and checkout
boundaries. Its publication-recovery scenario compiles and executes the real
reporter. It uses Ruby's standard YAML parser and `jq`.

Run the local checks from the repository root:

```sh
rustfmt --edition 2024 --check tools/ci/pr-merge-report*.rs
rustc --edition=2024 -D warnings --test tools/ci/pr-merge-report.rs -o /tmp/report-tests
/tmp/report-tests
rustc --edition=2024 -D warnings --test tools/ci/pr-merge-report-workflow.rs -o /tmp/adapter-tests
/tmp/adapter-tests
```

After the commit endpoint confirms a missing historical revision, the report
lists the history gap and retains available revisions. Reviews without commit
attribution remain in the report without commit lookups or attributed follow-ups.
Repair and review-follow-up counts require a forward step in the retained PR
commit order. A retry on an older SHA does not increase either count. Access
failures, other API failures and missing merged PR revisions stop reporting.

These tests cannot prove GitHub event selection, effective token permissions or
the real checkout action. The `report` job owns that live boundary. It runs on
a merged `pull_request_target` closed event, verifies the trusted checkout,
posts with the workflow token, compares the opening report before and after,
and invokes the reporter again to check duplicate avoidance. A posting failure
remains a job failure while summary and artifact retention still run.

## Hosted acceptance

After installation, the covering scenario is an approved contribution from a
fork that changes `tools/ci/pr-merge-report.rs` and merges through normal review.
This document does not authorize creating or merging a qualification PR.
The installation merge itself skips reporting when its parent lacks the helper.

For the covering scenario, inspect the real workflow run and its artifact.
The name is `merge-outcomes-` followed by the run attempt, such as
`merge-outcomes-1`. Require all of the following before recording acceptance:

- The run uses the installed workflow revision and the merged fork PR's closed
  event. The job's token-permission log shows read access to contents, actions
  and checks, and write access to pull requests.
- `Record publication inputs` verifies the checkout against the squash parent
  and rejects changed reporter source before compilation. The receipt identifies
  that parent as `reporter_revision` and records its `reporter_blob`.
- The intended PR has one collapsed bot report with its merged head SHA. The
  reporter's successful publication step includes an identical API readback.
- `Verify hosted publication` passes its opening-report comparison and its
  second-invocation comparison. The opening report stays intact and no second
  merge report appears. The receipt's `opening_report_count` is at least one.
- Summary retention and artifact upload succeed. The artifact contains the full
  report and `merge-outcomes-receipt.json` from that run attempt. The artifact
  name and receipt's `run_attempt` match the selected attempt.
- The receipt has `fork_modified_reporter: true`. An ordinary same-repository
  run or a fork PR without a reporter change supplies smoke evidence only.

Record the workflow run URL, attempt, installed `workflow_revision`,
`reporter_revision`, `reporter_blob`, PR head SHA, comment URL and artifact URL.
These fields bind the evidence to the installed implementation. Keep a failed
or missing observation pending; a checked-in scenario or fixture pass is not a
hosted acceptance receipt. A changed workflow or reporter needs fresh evidence.

Keep readback API failure injection in fixtures. For a live failure, retain the
run and report, then inspect the bot comment. If readback content differs from
the posted report, stop and investigate. Do not retry integrity failures or
access denials. Retry transient API failures only under the repository's
[bounded retry policy](../../.agents/skills/_shared/pr-follow-up.md#bounded-retry-policy).
An allowed retry regenerates the report; an existing bot report prevents another
POST. If the failed attempt retained an artifact, verify it is unchanged after
a permitted rerun. Verify that the recovered attempt's artifact contains its
report and receipt.

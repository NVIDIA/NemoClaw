<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Qualify merge outcome reporting

## Scope and ownership

[Issue #14163](https://github.com/NVIDIA/NemoClaw/issues/14163) defines merge-outcome
reporting under the maintainer-owned [session-report epic #14160](https://github.com/NVIDIA/NemoClaw/issues/14160).
@deepujain owns this workflow's scope; repository automation maintainers own
failures and recovery.

Maintainers need GitHub-derived outcomes beside the opening session report.
Revision counts are observed because complete push history is unavailable.
The default-branch workflow and helper under `tools/ci/` serve merged PRs into
`main` and `v1`, including forks, without session access or PR-code execution.

Install the workflow on the default branch and the reporter on each target
branch (`main` and `v1`). A merge whose parent lacks the reporter is skipped, so
reporting starts with the next eligible merge into that branch. Each eligible PR
gets one collapsed bot report. Runs serialize per PR and stop after 20 minutes.
The workflow attempts to retain generated reports for 90 days. Failures before
report generation have no report artifact. Existing comments stay intact;
retries avoid duplicates. A separate job with `contents: write` and no checkout
confirms that only squash merging is enabled; GitHub withholds those settings
from a read-only token. Compile only the verified squash-parent reporter,
disable persisted checkout credentials, and expose the short-lived token only
to API steps with the declared job permissions.

Validation covers metadata, rejected parents and events, API refusal,
publication readback, failure retention, and recovery. Hosted acceptance follows
installation; fixtures cannot establish GitHub event delivery, effective token
permissions, or the real checkout action.

## Local evidence

The report workflow has two evidence owners. The standalone Rust tests cover
metadata selection, rendering and publication recovery. The workflow adapter
test executes the checked-in YAML with controlled API, compiler and checkout
boundaries. Its publication-recovery scenario compiles and executes the real
reporter. It uses Bash from `PATH`, Ruby's standard YAML parser and `jq`.
Use Bash 5 or later to match the workflow runner.

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
and verifies one bot report for the merged head. Each attempt invokes the
reporter once. A posting failure remains a job failure while summary and
artifact retention still run.

## Hosted acceptance

After installation, the covering scenario is an approved contribution from a
fork that changes `tools/ci/pr-merge-report.rs` and merges through normal review.
This document does not authorize creating or merging a qualification PR.
The installation merge itself skips reporting when its parent lacks the helper.

For the covering scenario, inspect the real workflow run and its artifact.
The name is `merge-outcomes-` followed by the run attempt, such as
`merge-outcomes-1`. Require all of the following and the permitted-rerun
recovery observation below before recording acceptance:

- The run uses the installed workflow revision and the merged fork PR's closed
  event. The `merge-settings` job's token-permission log shows write access to
  contents only, and it passes. The `report` job's log shows read access to
  contents, actions and checks, and write access to pull requests.
- `Record publication inputs` verifies the checkout against the squash parent
  and rejects changed reporter source before compilation. The receipt identifies
  that parent as `reporter_revision` and records its `reporter_blob`.
- The intended PR has one collapsed bot report with its merged head SHA. The
  reporter's successful publication step includes an identical API readback.
- `Verify hosted publication` passes its opening-report comparison and one-report
  check. The receipt has `report_unique: true` and `opening_report_count` of at
  least one. The opening report stays intact.
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

Keep readback API failure injection in fixtures. For a live publication failure,
retain the run and any generated report. Then inspect the bot comment. If
readback content differs from the posted report, stop and investigate. Do not
retry integrity failures or access denials. Retry transient API failures only
under the repository's
[bounded retry policy](../../.agents/skills/_shared/pr-follow-up.md#bounded-retry-policy).
An allowed retry regenerates the report. For an existing bot report, recovery
requires exactly one copy matching the intended published body, including
truncation. A mismatch or duplicate stops recovery without posting or editing.

Verify hosted duplicate recovery through one separately authorized report-job
rerun. Record the bot report's ID and body, the opening comments, and the prior
artifact before the rerun. Require unchanged comments afterward, one merge
report, and an unchanged prior artifact. The rerun's artifact must contain its
report and revision-bound receipt. If no rerun is permitted or observed, keep
this recovery observation pending. The ordinary report job does not invoke the
reporter a second time to produce this evidence.

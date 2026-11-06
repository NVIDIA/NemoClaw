<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Qualify merge outcome reporting

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

For the covering scenario, inspect the real workflow run and its `merge-outcomes`
artifact. Require all of the following before recording acceptance:

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
  report and `merge-outcomes-receipt.json` from that run attempt.
- The receipt has `fork_modified_reporter: true`. An ordinary same-repository
  run or a fork PR without a reporter change supplies smoke evidence only.

Record the workflow run URL, attempt, installed `workflow_revision`,
`reporter_revision`, `reporter_blob`, PR head SHA, comment URL and artifact URL.
These fields bind the evidence to the installed implementation. Keep a failed
or missing observation pending; a checked-in scenario or fixture pass is not a
hosted acceptance receipt. A changed workflow or reporter needs fresh evidence.

The API-failure fixtures cover successful POST followed by failed readback.
Do not inject that failure into the live repository. If it occurs naturally,
retain the failed run and its full report, inspect the existing bot comment,
and apply the repository's bounded retry policy before retrying publication.
A retry regenerates the full report even when the bot comment already exists.
The publication guard prevents another POST, and successful verification retains
the recovered attempt's report and receipt.

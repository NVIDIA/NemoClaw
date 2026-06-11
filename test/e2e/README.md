<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E CI

## Nightly Onboard Trace Timing

The GitHub Actions workflow `.github/workflows/nightly-e2e.yaml` enables NemoClaw tracing for the `cloud-onboard-e2e` lane.
That job sets:

```bash
NEMOCLAW_TRACE_DIR=/tmp/nemoclaw-traces
```

The reusable E2E runner uploads `/tmp/nemoclaw-traces/` after every run as the `cloud-onboard-traces` artifact.
Failure-only logs continue to use each job's normal `artifact_name` and `artifact_path`.
NemoClaw sanitizes trace artifacts as they are written: sensitive-looking keys and common token value formats are redacted while trace span names, durations, statuses, and summary timing fields are preserved.

The nightly `scorecard` job reads the `cloud-onboard-traces` artifact, selects the trace JSON that contains the root `nemoclaw.onboard` span, and reports:

- total onboard trace duration from `summary.total_duration_ms`
- top matching `nemoclaw.onboard.phase.*` duration changes in Slack
- a full phase timing table in the GitHub job summary
- deltas against the latest completed `nightly-e2e` run for the prior semver release tag's commit

Phase deltas and the full summary table are reported only when the same trace span names exist in both runs.
If phase names change between runs, the scorecard reports only the total onboard duration change.
If the artifact, prior release tag, prior run, or matching trace data is unavailable, the scorecard keeps the nightly result best-effort and reports the missing comparison in the Slack summary instead of failing CI.

## Slack Scorecard Configuration

`nightly-e2e.yaml` posts the scorecard through repository Actions secrets:

- `SLACK_WEBHOOK_URL_DAILY` for scheduled full nightly runs
- `SLACK_WEBHOOK_URL_FULLRUN` for manual full runs
- `SLACK_WEBHOOK_URL_PREVIEW` for selective dispatches when `post_to_slack=true`

The trace timing section is part of the same Slack scorecard message, but it stays compact: total duration, the three largest matching phase changes, and a pointer to the GitHub run summary for the full table.
It does not post raw trace JSON, prompts, credentials, or environment values.
The uploaded trace artifact is already sanitized by NemoClaw before upload.

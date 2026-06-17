<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E CI

## Nightly Onboard Trace Timing

The GitHub Actions workflow `.github/workflows/nightly-e2e.yaml` enables NemoClaw tracing for the `cloud-onboard-e2e` lane.
That lane is the current GitHub E2E trace-timing scope; other E2E lanes keep their existing failure-log artifacts until they opt into a trusted timing-summary artifact.
That job sets:

```bash
NEMOCLAW_TRACE_DIR=/tmp/nemoclaw-traces
```

The reusable E2E runner does not upload `/tmp/nemoclaw-traces/` directly.
After the target-ref script finishes, trusted workflow code reads candidate trace JSON files from that target-controlled directory and writes a timing-only summary under `/tmp/nemoclaw-trace-summary/`.
Only that summary directory is uploaded after every run as the `cloud-onboard-traces` artifact.
Failure-only logs continue to use each job's normal `artifact_name` and `artifact_path`.
The uploaded timing summary keeps only the trace schema version, trace id, total duration, known `nemoclaw.onboard.phase.*` durations, and a bounded slowest-span timing list.
It omits raw attributes, events, prompts, environment values, file names, arbitrary files, and unrecognized trace fields.
NemoClaw also sanitizes trace files as they are written, but that in-process redaction is defense in depth rather than the artifact upload trust boundary.

The nightly `scorecard` job reads the `cloud-onboard-traces` artifact, selects the trusted `nemoclaw.trace_timing.v1` summary JSON, and reports:

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

Scheduled nightly runs and manual full runs post the scorecard automatically.
Selective dispatches are silent by default and post only when `post_to_slack=true`, so developers can run targeted checks without notifying Slack.
The trace timing section is part of the same Slack scorecard message, but it stays compact: total duration, the three largest matching phase changes, and a pointer to the GitHub run summary for the full table.
The scorecard counts passed, failed, cancelled, and skipped jobs separately.
Runs with cancellations but no failures stay in the warning state instead of being reported as all passed, including mixed pass and cancelled selective dispatches.
Slack no longer includes the legacy `Trend` context; trace timing is the only duration comparison in the scorecard.
Slack does not post raw trace JSON, prompts, credentials, or environment values.
The uploaded artifact is the trusted timing-only summary, not the raw target-ref trace directory.

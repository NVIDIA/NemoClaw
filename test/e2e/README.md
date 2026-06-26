<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E CI

## Hermetic Compatible Inference for Direct Bash Jobs

Direct bash E2E jobs that need onboarding inference, but do not need the live NVIDIA hosted service, should use `test/e2e/lib/hermetic-compatible-inference.sh` instead of `test/e2e/lib/ci-compatible-inference.sh` or workflow-injected hosted inference secrets.

This pattern supports issue #5747 conversions:

1. Source `lib/hermetic-compatible-inference.sh` from the test script.
2. Call `nemoclaw_e2e_start_hermetic_compatible_inference` during prerequisites.
3. Run the onboarding behavior under test normally; the helper exports a fake `custom` OpenAI-compatible endpoint and fake `COMPATIBLE_API_KEY`.
4. Assert the endpoint was actually used with `nemoclaw_e2e_assert_hermetic_compatible_inference_used`.
5. Stop it from the test cleanup trap with `nemoclaw_e2e_stop_hermetic_compatible_inference`.
6. In `.github/workflows/nightly-e2e.yaml`, install/build only the CLI and OpenShell needed by the script; do not inject `NVIDIA_INFERENCE_API_KEY`, `COMPATIBLE_API_KEY`, `NEMOCLAW_E2E_USE_HOSTED_INFERENCE`, or hosted model/env knobs into the converted job.
7. Add/update workflow contract coverage in `test/e2e-script-workflow.test.ts` so the job cannot regress back to hosted inference secrets.

Use the lower-level `openai-compatible-api-proof.sh` directly only when a test needs raw fake-server lifecycle control without NemoClaw onboarding environment exports.

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

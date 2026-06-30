<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E CI

Direct E2E coverage runs through Vitest.

Interactive TUI targets require `expect`. The unified workflow installs it
before those targets run; local runners must provide it themselves.

- `.github/workflows/e2e.yaml` is the scheduled and manually
  dispatchable live target workflow.
- `.github/workflows/e2e-branch-validation.yaml` provisions Brev instances and
  runs focused E2E targets from source on a clean machine.
- Platform workflows such as macOS, WSL, Ollama proxy, sandbox image, and
  regression E2E call their target E2E tests directly.

The former top-level `test/e2e/test-*.sh` suite has been removed. Keep real
shell, installer, process, Docker, OpenShell, `/proc`, and sandbox boundaries in
E2E tests when those boundaries are the behavior under test.

## Scheduled operations

The consolidated workflow keeps its operational reporting in the same job
graph as the live targets:

- `notify-on-failure` creates or updates the open `CI/CD` failure issue only
  when a scheduled run fails or is cancelled.
- `scorecard` writes the scheduled/manual result summary, compares the trusted
  cloud-onboard timing summary with the latest prior-release `e2e.yaml` run,
  and posts to the daily or full-run Slack route.
- Selective dispatches remain silent unless they run on `main` with
  `post_to_slack=true`, which uses the preview Slack route. Branch-dispatched
  runs never receive Slack webhook secrets.

Raw cloud-onboard traces stay under the runner temporary directory. Before
artifact upload, `scripts/e2e/sanitize-trace-timing.py` reduces them to the
allowlisted `cloud-onboard-trace-timing-summary.json` timing schema and deletes
the raw directory. Aggregation ratchets require `notify-on-failure`,
`report-to-pr`, and `scorecard` to wait for the same execution-job set.

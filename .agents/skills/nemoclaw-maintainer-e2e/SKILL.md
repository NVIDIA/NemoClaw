---
name: nemoclaw-maintainer-e2e
description: "Run or inspect NemoClaw live E2E evidence. Routes requested local execution, trusted GitHub dispatch, and release-evidence inspection."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Maintainer E2E

## Route the Request

| Request | Procedure |
| --- | --- |
| Run working-tree source or a selected local commit | [Local Runs](references/local-runs.md) |
| Run the latest PR commit on GitHub, including failure-triggered comparison with its exact base | [Manual PR Runs](references/manual-pr.md) |
| Run the current `main` commit on GitHub | [Main Runs](references/main-runs.md) and the Launchable boundary below |
| Inspect existing evidence for a release decision | [Report the Release Context](#report-the-release-context) |
| Classify one failed GitHub Actions job | Load `nemoclaw-maintainer-classify-ci-failure`; this skill still owns dispatch and run-level reporting. |

A new GitHub candidate run tests the latest PR commit or the current `main` commit.
Manual PR runs may replay the PR base after a candidate failure, as described in their procedure.
Report arbitrary historical candidate selection as unsupported. Preserve the workflow's identity and trust checks.

Push runs select change-relevant E2E and publish `Relevant E2E`; they do not always run the full
suite. Only a full manual run publishes `Release qualification`. That aggregate reports the full
suite; it does not decide whether a tag can proceed. A generic E2E request does not authorize
`Exact staging Brev Launchable`.

Use `.github/workflows/e2e.yaml` from trusted `main` for GitHub runs. Do not substitute local live
E2E unless the maintainer explicitly requests local execution. Do not load a dispatch reference for
a release inspection unless the maintainer requests a new run.

## Staging Brev Launchable Boundary

Read [Staging Launchable](references/staging-launchable.md) before a dispatch that includes
`Exact staging Brev Launchable`. It owns the credential, deployment, cleanup, artifact, and queue
boundaries. A generic E2E request does not authorize that job.

## Report the Release Context

Read [Release Context](references/release-context.md) to inspect the newest identifiable full
manual `main` run and report its commit, times, attempt, aggregate, and non-successful jobs.
This is read-only. The caller owns the release decision.

## Handoff

Return:

- the mode and selectors;
- the tested commit;
- the result;
- the workflow URL; and
- relevant job URLs.

A focused run supplements the reported full-run status; it does not become a full run.

Do not ask for release confirmation or decide whether a release can proceed. The release-tag skill
owns the general E2E decision and records any reason for proceeding with an exceptional general E2E
status.

## Access Failures

Follow the shared [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md).

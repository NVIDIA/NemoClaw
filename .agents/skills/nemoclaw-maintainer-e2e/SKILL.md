---
name: nemoclaw-maintainer-e2e
description: Dispatches and reports trusted GitHub Actions E2E runs. Use for focused, full, staging Launchable, manual PR, and release-decision requests.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Maintainer E2E

Use `.github/workflows/e2e.yaml` from trusted `main`. Do not substitute local live E2E unless the maintainer explicitly requests local execution.

Push runs publish `Relevant E2E`. Only a full manual run publishes `Release qualification`. That
aggregate reports the full suite; it does not decide whether a tag can proceed. A generic E2E
request does not authorize `Staging Brev Launchable`.

## Route the Request

- For E2E against a pull request revision, read and follow [Manual PR Runs](references/manual-pr.md).
- To dispatch ordinary, focused, staging Launchable, or full E2E on `main`, read and follow
  [Main Runs](references/main-runs.md) and the Launchable boundary below.
- For a release decision inspection, use the section below. Do not load a dispatch reference unless the maintainer requests a new run.
- For one failed job, load `nemoclaw-maintainer-classify-ci-failure` for bounded, redacted log and optional artifact evidence. This skill still owns dispatch and run-level reporting.

## Staging Brev Launchable Boundary

`Staging Brev Launchable` runs only for a trusted manual dispatch against `main`. Launchable
mode selects only that job. Full mode adds it to the default E2E selection. The trusted workflow
requires repository `maintain` or `admin` permission before the job's source checkout.

The job builds the candidate image, deploys the standing Launchable, and verifies all of these
results before it succeeds:

- environment access and the booted image;
- the candidate SHA, image-repository SHA, baked checkout with no uncommitted changes, and absence of runtime overrides;
- hosted and sandbox inference through the preinstalled full E2E suite; and
- Brev workspace deletion and confirmed absence.

`Staging Brev Launchable` reads these credentials from repository Actions secrets:

- `BREV_API_KEY` authenticates the trusted host-side Brev CLI for workspace operations in the
  organization identified by `BREV_ORG_ID`. Candidate code does not receive this API key.
- `NEMOCLAW_IMAGE_DISPATCH_TOKEN` is exposed as `GH_TOKEN` only to the trusted host script. It
  grants Actions read/write access to `brevdev/nemoclaw-image` for workflow dispatch, run inspection,
  and artifact download.
- `NVIDIA_INFERENCE_API_KEY` is exported into the Brev guest for the full E2E process. Code in the
  baked candidate checkout can read and use it.

`brev login` writes `BREV_API_KEY` and `BREV_ORG_ID` to `$HOME/.brev/credentials.json` on the
GitHub-hosted runner. Later trusted steps and processes in that job can read the file. The workflow
does not delete it explicitly. Runner teardown discards the ephemeral filesystem.

The credentials remain valid until they expire or an administrator revokes them in their issuing
services. If cleanup fails, remove the recorded Brev workspace. Rotate or revoke each credential to
remove later access.

The `NEMOCLAW_STAGING_LAUNCHABLE_ID` repository Actions variable selects the standing Launchable.
Keep it equal to the Launchable ID in the default URL owned by
[`nemoclaw-maintainer-validate-launchable`](../nemoclaw-maintainer-validate-launchable/SKILL.md).

A successful job retains `launchable-e2e.json`, `full-e2e.log`, and `cleanup.json`. The cleanup
record exists only after the job confirms workspace absence. A preparation failure can produce no
artifact. A later failure can retain only `lane.log` and the phase artifacts created before exit.

The job uses the `staging-brev-launchable-cpu` concurrency group without cancelling a running job.
GitHub keeps at most one pending job in that group, so a newer job can replace an older pending job.
A queued, waiting, or accepted dispatch is not a successful result.

## Inspect the Newest Full Main Run

This mode is read-only. It does not dispatch a run.

List the newest identifiable full manual `main` run:

```bash
gh run list --repo NVIDIA/NemoClaw --workflow e2e.yaml \
  --event workflow_dispatch --branch main --limit 100 \
  --json databaseId,displayTitle,attempt,createdAt,startedAt,updatedAt,headSha,status,conclusion,url \
  --jq 'map(select(.displayTitle | startswith("E2E full main"))) | first'
```

Inspect `Release qualification`, `Staging Brev Launchable`, and every other job that is not
successful:

```bash
gh run view <run-id> --attempt <attempt> --repo NVIDIA/NemoClaw \
  --json jobs --jq '[.jobs[] |
    select(.name == "Release qualification" or .name == "Staging Brev Launchable" or
      .status != "completed" or
      (.conclusion != null and .conclusion != "success")) |
    {name,status,conclusion,startedAt,completedAt,url}]'
```

If no named full run appears in the 100-run window, report that no recent identifiable full run was
found. Runs created before this naming contract cannot be distinguished without scanning each run's
jobs. Do not perform that legacy scan.

Dispatch and verify new PR and `main` runs only through the selected reference above. Those references
own permission checks, selector validation, candidate resolution, correlation IDs, bounded run lookup,
SHA binding, result verification, credential boundaries, and resource cleanup. Do not
reconstruct those commands here.

The PR reference also owns the native-runtime producer's first-attempt, ephemeral-runner, unprivileged
account, Docker isolation, evidence, and cleanup requirements.

## Report the Release Context

Return:

- Exact `createdAt`, `startedAt`, and `updatedAt` values, labeling `updatedAt` as last updated;
- workflow attempt;
- age at inspection time calculated from `createdAt`;
- tested commit SHA;
- workflow status, conclusion, and URL;
- `Release qualification` status, conclusion, start, completion, and URL; and
- failed, cancelled, skipped, or still-running jobs and their URLs.

When the caller provides a release candidate, state whether the tested commit matches it. Do not
reject a different commit, impose a staleness threshold, or decide whether tagging can proceed.

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

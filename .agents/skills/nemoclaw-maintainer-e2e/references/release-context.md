<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Inspect the Newest Full Main Run

This mode is read-only. It does not dispatch a run.

List the newest identifiable full manual `main` run:

```bash
gh run list --repo NVIDIA/NemoClaw --workflow e2e.yaml \
  --event workflow_dispatch --branch main --limit 100 \
  --json databaseId,displayTitle,attempt,createdAt,startedAt,updatedAt,headSha,status,conclusion,url \
  --jq 'map(select(.displayTitle | startswith("E2E full main"))) | first'
```

Inspect `Release qualification`, `Exact staging Brev Launchable`, and every other job that is not
successful:

```bash
gh run view <run-id> --attempt <attempt> --repo NVIDIA/NemoClaw \
  --json jobs --jq '[.jobs[] |
    select(.name == "Release qualification" or .name == "Exact staging Brev Launchable" or
      .status != "completed" or
      (.conclusion != null and .conclusion != "success")) |
    {name,status,conclusion,startedAt,completedAt,url}]'
```

If no named full run appears in the 100-run window, report that no recent identifiable full run was
found. Runs created before this naming contract cannot be distinguished without scanning each run's
jobs. Do not perform that legacy scan.

For a requested new run, select the dispatch reference in [Run Maintainer E2E](../SKILL.md#route-the-request). Those references
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

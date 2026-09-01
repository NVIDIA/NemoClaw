<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validate Existing Launchable Evidence

Use this read-only procedure when another workflow needs to consume an existing
`Staging Brev Launchable` result. Do not use it to dispatch a run.

## Inspect the Result

Run the read-only inspector with the expected lowercase 40-character candidate SHA:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-e2e/scripts/inspect-launchable-evidence.ts \
  --candidate <candidate-sha>
```

Use `--repo OWNER/REPO` only when inspecting another repository. The script selects
the newest eligible job, downloads the exact artifact, validates every binding and
cleanup receipt, and emits the bounded versioned handoff JSON. A nonzero exit means
the evidence is not acceptable. Do not reconstruct these checks manually.

The inspector selects the newest successful `Staging Brev Launchable` job whose
workflow run has all of these properties:

- `head_sha` equals the candidate SHA;
- `path` is `.github/workflows/e2e.yaml`;
- `head_branch` is `main`;
- `event` is `workflow_dispatch`; and
- the job is completed successfully.

Record the workflow run ID, attempt, URL, job ID, and job URL. Stop when the run,
job, or candidate binding is missing or contradictory.

## Validate the Private Artifact

Download this exact artifact from the selected run and attempt:

```text
staging-brev-launchable-<candidate-sha>-<run-id>-<attempt>
```

Require `launchable-e2e.json`, a nonempty `full-e2e.log`, and `cleanup.json`.
Require `full-e2e.log` to contain the exact success sentinel
`NEMOCLAW_FULL_E2E_PASSED`.

Require `launchable-e2e.json` to establish:

- `candidateSha` equals the candidate SHA;
- `producer.runId` is numeric and `producer.status` is `success`;
- `boot.bootImage` is a nonempty concrete image URI;
- `boot.schemaVersion` is `1`;
- `boot.sourceRepository` is `NVIDIA/NemoClaw` and `boot.sourcePath` is
  `/opt/nemoclaw-image/NemoClaw`;
- `boot.repoSha` and `boot.provisionSha` equal the candidate SHA;
- `boot.imageRepositorySha` is a lowercase 40-character SHA;
- `boot.repoClean` is `true` and `boot.runtimeOverrides` is `false`;
- the workspace name and ID are nonempty; and
- `fullE2e` is `passed`.

Require `cleanup.json` to name the same workspace, report `ABSENT`, and contain
an ISO 8601 UTC `verifiedAt` value. Stop when an artifact is absent, malformed,
or bound to another candidate, run, attempt, or workspace.

## Handoff

Return:

- candidate SHA;
- workflow run ID, attempt, and URL;
- job ID and URL;
- artifact name;
- producer run ID and URL;
- concrete boot image and image-repository SHA;
- workspace name and ID;
- full E2E result; and
- verified cleanup time.

If cleanup is not confirmed, report the workspace. Remove it through the trusted
Brev boundary, then rotate or revoke every credential exposed to that workspace.
Do not report successful Launchable evidence until absence is confirmed.

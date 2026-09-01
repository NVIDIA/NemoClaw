<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validate Existing Launchable Evidence

Use this read-only procedure when another workflow needs to consume an existing
`Exact staging Brev Launchable` result.

## Inspect the Result

Run the inspector with a lowercase 40-character candidate SHA:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-e2e/scripts/inspect-launchable-evidence.ts \
  --candidate <candidate-sha>
```

The inspector reads only `NVIDIA/NemoClaw`; other repositories and forks are not supported.
Run it once. It selects the newest eligible job, downloads its artifact, validates all
bindings and cleanup evidence, and emits bounded handoff JSON.

Accept the evidence only when the command exits zero. Use its JSON as the handoff.
Do not reconstruct the checks manually.

## What the Inspector Validates

The inspector selects the newest successful `Exact staging Brev Launchable` job whose
workflow run meets these conditions:

- `head_sha` equals the candidate SHA;
- `path` is `.github/workflows/e2e.yaml`;
- `head_branch` is `main`;
- `event` is `workflow_dispatch`; and
- the job completed successfully.

The artifact name binds the candidate, run, and attempt:

```text
staging-brev-launchable-<candidate-sha>-<run-id>-<attempt>
```

The inspector requires `launchable-e2e.json`, a nonempty `full-e2e.log`, and
`cleanup.json`. The log must contain the exact `NEMOCLAW_FULL_E2E_PASSED`
sentinel.

The inspector verifies these values in `launchable-e2e.json`:

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

The inspector requires `cleanup.json` to name the same workspace, report
`ABSENT`, and include a UTC `verifiedAt` value. It rejects missing or malformed
artifacts and mismatched bindings.

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

If cleanup is not confirmed, the error reports the workspace name, ID, status, and check time.
Use that recovery handoff to remove the workspace through the trusted Brev boundary. Then rotate or
revoke every credential exposed to that workspace.
Do not report successful Launchable evidence until absence is confirmed.

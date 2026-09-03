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

The inspector selects the newest completed `Exact staging Brev Launchable` job whose
workflow run meets these conditions. It accepts evidence only when that job succeeded:

- `path` is `.github/workflows/e2e.yaml`;
- `head_branch` is `main`;
- `event` is `workflow_dispatch`; and
- the job is completed.

A historical candidate may be tested by a later trusted `main` dispatch, so the workflow run SHA need
not equal the candidate. The artifact name and its contents bind the candidate, run, and attempt:

```text
staging-brev-launchable-<candidate-sha>-<run-id>-<attempt>
```

The inspector requires `launchable-e2e.json`, a nonempty `full-e2e.log`, and
`cleanup.json` for successful evidence. Before workspace creation, the lane writes
`workspace-recovery.json` with the candidate, run, attempt, deterministic name, and an empty ID; it
updates the receipt after inventory returns the workspace ID. When full evidence is absent, the
inspector uses that recovery receipt only to report recovery identity;
it never accepts it as release evidence. The log must contain the exact `NEMOCLAW_FULL_E2E_PASSED`
sentinel.

The inspector verifies these values in `launchable-e2e.json`:

- `candidateSha` equals the candidate SHA;
- `producer.runId` is a positive decimal string and `producer.status` is `success`;
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

If cleanup is not confirmed, the error reports the run, attempt, job, artifact, workspace name and ID,
status, and check time. Follow the recovery procedure below. Do not report successful Launchable
evidence until absence is confirmed.

## Recover Incomplete Cleanup

Only a maintainer with access to the repository's Brev organization may perform this procedure.

1. Open the reported run in `NVIDIA/NemoClaw`. Confirm that its workflow is
   `E2E / Main and Manual Suite` (`.github/workflows/e2e.yaml`), its event is
   `workflow_dispatch`, its branch is `main`, and the reported attempt contains job
   `Exact staging Brev Launchable`.
2. Download the reported artifact from that run attempt. Its name must be
   `staging-brev-launchable-<candidate>-<run-id>-<attempt>`. In `launchable-e2e.json`, require
   `candidateSha` to equal the candidate and require `workspace.name` and `workspace.id` to equal
   the reported values. If full evidence is absent, require `workspace-recovery.json` instead; its
   candidate, run, attempt, and workspace name must equal the reported values. The workspace name
   must also equal `nclaw-e2e-<run-id>-<attempt>`. When the receipt contains an ID, require it to equal
   the reported ID. A pending-create receipt may have an empty ID.
3. Authenticate the Brev CLI to the repository's Brev organization through the maintainer-approved
   credential path. For a pending-create receipt, reconcile `brev ls --json` every 15 seconds for the
   same bounded 120-second create deadline used by the lane. Obtain the ID only when exactly one row
   has the deterministic reported name. Do not treat one absent inventory as resolved: if no unique row
   appears by the deadline and no terminal create result proves absence, keep recovery unresolved and
   escalate the handoff to the Brev organization owner. For a receipt with an ID, permit deletion only
   when exactly one row has both the reported name and ID. If that row is absent, skip deletion. If the
   inventory is unavailable, ambiguous, or differs by name or ID, prohibit deletion and escalate.
4. Run `brev delete <workspace-id>` once, using the validated ID rather than the workspace name.
   Brev CLI version 0.6.334 accepts a workspace name or ID and resolves the ID immediately before its
   delete request. If deletion fails, record cleanup as unresolved and use a private route from
   [SECURITY.md](../../../../SECURITY.md), such as GitHub private vulnerability reporting or encrypted
   email to NVIDIA PSIRT, to transfer cleanup to the Brev organization owner. Include only the minimum
   non-secret recovery identity: run and job URLs, artifact name, candidate SHA, workspace name and ID,
   last inventory result, credential-removal actions, and a sanitized error summary. Keep credentials
   and raw error output out of public issues, pull requests, and handoffs. The Brev organization owner
   must acknowledge cleanup ownership and set a deletion or investigation deadline.
5. After an ID-bound deletion, read `brev ls --json` every 15 seconds for at most 10 minutes. Stop
   after two consecutive successful inventories contain no row with either the reported name or ID.
   If the deadline expires, keep cleanup unresolved and record the last inventory result.
6. Record the run URL, attempt, job URL, artifact name, candidate SHA, workspace name and ID, deletion
   decision, both final inventory check times, and final state in the release or incident handoff.
7. Rotate or revoke `NVIDIA_INFERENCE_API_KEY`, which candidate code in the guest could read. Rotate
   or revoke the host-side `BREV_API_KEY` and `NEMOCLAW_IMAGE_DISPATCH_TOKEN` only if the trusted
   host boundary was compromised.

A missing or malformed artifact never authorizes deletion.

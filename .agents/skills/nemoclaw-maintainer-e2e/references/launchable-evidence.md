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

- `head_sha` equals the candidate SHA;
- `path` is `.github/workflows/e2e.yaml`;
- `head_branch` is `main`;
- `event` is `workflow_dispatch`; and
- the job is completed.

The artifact name binds the candidate, run, and attempt:

```text
staging-brev-launchable-<candidate-sha>-<run-id>-<attempt>
```

The inspector requires `launchable-e2e.json`, a nonempty `full-e2e.log`, and
`cleanup.json` for successful evidence. The lane writes `workspace-recovery.json` immediately
after it obtains the workspace ID. When full evidence is absent, the inspector uses that
candidate-, run-, attempt-, name-, and ID-bound receipt only to report recovery identity;
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
   candidate, run, attempt, workspace name, and workspace ID must equal the reported values. The workspace name must also equal `nclaw-e2e-<run-id>-<attempt>`.
3. Authenticate the Brev CLI to the repository's Brev organization through the maintainer-approved
   credential path. Run `brev ls --json`. Permit deletion only when exactly one row has both the
   reported name and ID. If the row is absent, skip deletion. If the inventory is unavailable,
   ambiguous, or differs by name or ID, prohibit deletion and escalate the handoff to the Brev
   organization owner.
4. The Brev CLI supports only name-bound deletion. Do not issue `brev delete` during manual recovery,
   because a different workspace could reuse the validated name before deletion. Record cleanup as
   unresolved and open a repository security escalation for the Brev organization owner. Include the
   run and job URLs, artifact name, candidate SHA, workspace name and ID, last inventory result, and
   credential-removal actions. The owner must acknowledge cleanup ownership and set a deletion or
   investigation deadline. Close the escalation only after two consecutive inventories confirm that
   both the reported name and ID are absent, or after the owner records why the workspace must remain.
   The owner may use an approved ID-bound conditional deletion mechanism when available.
5. After an ID-bound deletion, read `brev ls --json` every 15 seconds for at most 10 minutes. Stop
   after two consecutive successful inventories contain no row with either the reported name or ID.
   If the deadline expires, keep cleanup unresolved and record the last inventory result.
6. Record the run URL, attempt, job URL, artifact name, candidate SHA, workspace name and ID, deletion
   decision, both final inventory check times, and final state in the release or incident handoff.
7. Rotate or revoke `NVIDIA_INFERENCE_API_KEY`, which candidate code in the guest could read. Rotate
   or revoke the host-side `BREV_API_KEY` and `NEMOCLAW_IMAGE_DISPATCH_TOKEN` only if the trusted
   host boundary was compromised.

A missing or malformed artifact never authorizes deletion.

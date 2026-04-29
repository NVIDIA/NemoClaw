<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# PR 2699 / OpenShell Mount Dependency Handoff

Date: 2026-04-29

## Current State

- NemoClaw PR: <https://github.com/NVIDIA/NemoClaw/pull/2699>
  - Status: open draft.
  - Current implementation: `nemoclaw onboard --share` uses `openshell sandbox create --upload`.
  - Important limitation: this is creation-time file seeding, not a live host-mounted directory.
- OpenShell PR: <https://github.com/NVIDIA/OpenShell/pull/1067>
  - Status: closed by the first-time contributor vouch gate.
  - Branch: `ChunkyMonkey11:codex/host-directory-mounts`.
  - Commit: `651b849 feat(sandbox): add host directory mounts`.
  - Adds `openshell sandbox create --mount <host-dir>:<sandbox-path>`.
- OpenShell vouch discussion: <https://github.com/NVIDIA/OpenShell/discussions/1068>
  - Wait for a maintainer to comment `/vouch`.

## What Is Blocked

The NemoClaw PR should not be treated as a full fix for issue #2631 until OpenShell has a real mount option available. The OpenShell PR is the upstream capability needed to replace the current `--upload` stopgap.

Current blocker:

- A maintainer must vouch `ChunkyMonkey11` in OpenShell discussion #1068.

Expected secondary blocker after reopening:

- A repo maintainer/admin must approve GitHub Actions workflows for the fork PR before CI runs.

## Reopen Sequence

After the OpenShell vouch is approved:

1. Wait a few minutes for the vouch state to propagate.
2. Reopen <https://github.com/NVIDIA/OpenShell/pull/1067>.
3. Comment on OpenShell PR #1067:

   ```text
   I have read the DCO document and I hereby sign the DCO.
   ```

4. Comment on OpenShell PR #1067:

   ```text
   recheck
   ```

5. Wait for a maintainer/admin to approve the fork workflows if GitHub Actions remains in `action_required`.
6. Once OpenShell #1067 is accepted or close to accepted, update NemoClaw PR #2699 to use:

   ```shell
   openshell sandbox create --mount <host-dir>:<sandbox-path>
   ```

   instead of:

   ```shell
   openshell sandbox create --upload <host-dir>:<sandbox-path>
   ```

7. Update the NemoClaw PR body/comments to say it depends on OpenShell mount support.
8. Mark the NemoClaw PR ready for review only after it uses `--mount` or after maintainers explicitly accept the upload-only stopgap.

## Validation Already Run

NemoClaw PR #2699 local validation:

```shell
npm run build:cli
npm run typecheck:cli
npx vitest run src/lib/onboard-command.test.ts test/onboard.test.ts
```

OpenShell PR #1067 focused validation:

```shell
Z3_SYS_Z3_HEADER=/opt/homebrew/opt/z3/include/z3.h \
Z3_LIBRARY_PATH_OVERRIDE=/opt/homebrew/opt/z3/lib \
mise exec -- cargo test -p openshell-cli -p openshell-driver-docker -p openshell-driver-podman -p openshell-driver-kubernetes -p openshell-driver-vm -p openshell-server host_mount --lib --tests
```

## Related Comments

- NemoClaw coordination comment: <https://github.com/NVIDIA/NemoClaw/pull/2699#issuecomment-4347311501>
- OpenShell coordination comment: <https://github.com/NVIDIA/OpenShell/pull/1067#issuecomment-4347311507>

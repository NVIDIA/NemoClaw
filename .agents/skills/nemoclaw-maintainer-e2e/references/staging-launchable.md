<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Staging Brev Launchable Boundary

`Exact staging Brev Launchable` runs only for a trusted manual dispatch against `main`. Launchable
mode selects only that job. Full mode adds it to the default E2E selection. The trusted workflow
requires repository `maintain` or `admin` permission before the job's source checkout.

The job builds the candidate image, deploys the standing Launchable, and verifies all of these
results before it succeeds:

- environment access and the booted image;
- the candidate SHA, image-repository SHA, baked checkout with no uncommitted changes, and absence of runtime overrides;
- hosted and sandbox inference through the preinstalled full E2E suite; and
- Brev workspace deletion and confirmed absence.

`Exact staging Brev Launchable` reads these credentials from repository Actions secrets:

- `BREV_API_KEY` authenticates the trusted host-side Brev CLI for workspace operations in the
  organization identified by `BREV_ORG_ID`. Candidate code does not receive this API key.
- `NEMOCLAW_IMAGE_DISPATCH_TOKEN` is exposed as `GH_TOKEN` only to the trusted host script. It
  grants Actions read/write access to `brevdev/nemoclaw-image` for workflow dispatch, run inspection,
  and artifact download.
- `NVIDIA_API_KEY` supplies the public NVIDIA endpoint credential. The workflow exports it as
  `NVIDIA_INFERENCE_API_KEY` into the Brev guest for full E2E. Code in the baked candidate checkout
  can read and use it.

`brev login` writes `BREV_API_KEY` and `BREV_ORG_ID` to `$HOME/.brev/credentials.json` on the
GitHub-hosted runner. Later trusted steps and processes in that job can read the file. The workflow
does not delete it explicitly. Runner teardown discards the ephemeral filesystem.

The credentials remain valid until they expire or an administrator revokes them in their issuing
services. If cleanup fails, remove the recorded Brev workspace. Rotate or revoke each credential to
remove later access.

The `NEMOCLAW_STAGING_LAUNCHABLE_ID` repository Actions variable selects the standing Launchable.
Keep it equal to the Launchable ID in the default URL owned by
[`nemoclaw-maintainer-validate-launchable`](../../nemoclaw-maintainer-validate-launchable/SKILL.md).

A successful job retains `launchable-e2e.json`, `full-e2e.log`, and `cleanup.json`. The cleanup
record exists only after the job confirms workspace absence. A preparation failure can produce no
artifact. A later failure can retain only `lane.log` and the phase artifacts created before exit.

The job uses the `staging-brev-launchable-cpu` concurrency group without cancelling a running job.
All Launchable consumers use `queue: max`, which preserves up to 100 pending entries.
GitHub cancels new entries when the queue is full.
A queued, waiting, or accepted dispatch is not a successful result.

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DGX Station v1 Smoke

`station.yml` builds a candidate on a dedicated self-hosted ARM64 DGX Station, applies
`examples/gtc-dc/hermes-dgx-station.yaml`, checks its four Docker containers, and destroys
the workloads. It checks running state and Docker health when present; it requests no inference.

## Runner Requirements

Register the runner with the repository that will run the workflow and the labels
`self-hosted`, `Linux`, `ARM64`, and `dgx-station`. A runner registered to a fork cannot
receive upstream repository jobs. Colorunner may manage the lease and runner registration;
no Cologit dispatcher or Cloudflare tunnel participates in this workflow.

The operator must provide:

- A dedicated GB300 Station with sufficient lease time for a first download and build.
- Docker with Buildx, the containerd image store, and NVIDIA CDI devices including
  `nvidia.com/gpu=all`. The runner service account must have Docker access.
- The [native build prerequisites](../../docs/build.md), including a C compiler and
  OpenSSL development headers. The workflow does not run APT or reboot the host.
- Rustup at `~/.local/share/nemoclaw-ci/bin/rustup`. Rust toolchains and Cargo downloads
  live under `~/.cache/nemoclaw-ci/{rustup,cargo}`. The candidate selects its pinned
  Rust toolchain; the existing setup action installs pinned protoc and nextest.

Docker access permits host-level operations. Run maintainer-selected candidate commits
on this dedicated runner. Do not dispatch pull-request events automatically.

## Execution

Manual dispatch accepts `example_path`; this smoke currently admits only the Hermes
Station example. Until the workflow is present on the default branch, initial qualification
uses the opt-in `run-station-v1-e2e/**` push trigger. For a fork experiment, adapt the
repository/branch guard in a separate test branch; do not change the fork's default branch.

The workflow:

1. Checks the host and builds its bundle and test executables from the checked-out commit.
2. Builds Hermes and vLLM with job-specific local tags and obtains their immutable digests.
3. Prepares an owned example with a generated deployment UID and those image references.
4. Runs `station_example_components_are_running`, which observes gateway, model, sandbox,
   and supervisor containers after SDK apply, then attempts SDK destroy.
5. Runs cleanup even after failure, checks that no owned workload remains, and requires a
   matching passing receipt. A skipped or unselected smoke cannot produce a successful job.

The committed example retains its ports and subnet. Reserve those addresses for the smoke
on the dedicated Station. No image is published. Build cache and downloaded dependencies
remain local; the first run also downloads the model if its deployment storage is empty.

## State, Cache, and Recovery

Private files live under `~/.local/state/nemoclaw-station-e2e`, outside the Actions checkout:

| Path | Purpose |
| --- | --- |
| `deployments/<intent-hash>/` | Deployment UID and SDK state, including retained storage bindings |
| `jobs/<run-id>-<attempt>/bundle/` | Candidate bundle retained for recovery |
| `jobs/<run-id>-<attempt>/station-host` | Matching cleanup executable |
| `jobs/<run-id>-<attempt>/smoke.log` | Private smoke diagnostics |
| `jobs/<run-id>-<attempt>/recovery.json` | Binding between the job, prepared configuration, and deployment |
| `pending.json` | Unfinished job that must be cleaned up before another apply |

Compatible runs reuse their deployment UID and storage. Changing candidate image digests
alone preserves that identity; changing the model, other example intent, or the gateway
pin creates a separate deployment and may require another model download. Existing
retained deployments are preserved.

The smoke requests cancellation after 95 minutes of apply/observation, then attempts teardown.
Cancellation requests cooperative SDK cancellation and teardown. Workflow cleanup retries
using the job's retained bundle. A forced process kill, runner loss, or host failure can
prevent cleanup; `pending.json` then blocks later applies. An operator must recover that
recorded job before another run. Never delete the marker to bypass unresolved resources.

For manual recovery, use the recorded job's bundle and deployment state with the
[documented destroy command](../../docs/usage.md#destroy), then run the retained `jobs/<run-id>-<attempt>/station-host cleanup`
with the original `STATION_ROOT` and `STATION_JOB_DIR`. Keep the job directory and its executable until recovery completes. Cleanup still reports smoke failure if the interrupted
job did not produce a passing receipt.

Only `summary.json` is uploaded. It contains the candidate SHA, test result, cleanup result,
and successful component observations. Configuration, raw logs, credentials, and SDK state
stay on the runner. SDK destroy retains storage and credentials under the product's
[retention rules](../../docs/usage.md#remove-retained-resources). Private job bundles and
build images are also retained; remove owned artifacts only after confirming cleanup and
that they are no longer needed for recovery. The workflow does not release the Colossus lease.

## Validation Scope

The smoke owns SDK-to-Docker component readiness. SDK/provider suites own configuration
and resource lifecycle rules. Focused tests cover prepared identity, retained-state
selection, admission after failed cleanup, and passing-receipt validation. A live first
run and a compatible cached rerun are required to qualify a new runner. Host-loss and
forced-kill recovery require separate evidence; passing unit tests do not qualify them.

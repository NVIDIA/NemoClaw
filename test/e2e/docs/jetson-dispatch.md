<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Jetson Dispatch Controller

NemoClaw owns the trusted GitHub Actions controller for the
`jetson-nvmap-gpu` live E2E target. An operator-owned service runs the target on
a Jetson device. This page defines the versioned HTTP boundary, GitHub
configuration, and evidence that remain in NemoClaw. It does not define how to
deploy or operate the service.

## Owned Surface

NemoClaw owns these files and settings:

- `.github/workflows/e2e.yaml` selects the fixed target from the trusted
  workflow on `main`.
- `tools/e2e/jetson-dispatch-client.mts` obtains a GitHub OpenID Connect (OIDC)
  token, sends the candidate commit, validates responses, and writes
  bounded evidence.
- `tools/e2e/jetson-dispatch-contract.mts` implements HTTP contract versions
  `1.0.0` and `2.0.0`.
- `tools/e2e/contracts/v1/jetson-dispatch.json` and
  `tools/e2e/contracts/v2/jetson-dispatch.json` contain the shared static
  compatibility vectors.
- The repository variable `JETSON_DISPATCH_URL` selects the operator-provided
  service origin.
- `test/e2e/live/jetson-nvmap-gpu.test.ts` defines the live target.

The service implementation and device lifecycle are operator-owned
infrastructure. NemoClaw has no build-time dependency on that implementation.

## HTTP Contract 2.0.0

Contract version `2.0.0` uses JSON with `schemaVersion: 2`. The controller sends
a request body with these exact fields:

```json
{
  "schemaVersion": 2,
  "target": "jetson-nvmap-gpu",
  "candidateSha": "<lowercase-40-character-commit-sha>",
  "managedImageRevision": "<lowercase-40-character-commit-sha>",
  "workflowRunId": "<positive-decimal-integer>",
  "workflowRunAttempt": 1
}
```

`candidateSha` identifies the NemoClaw commit under test.
`managedImageRevision` identifies the applicable successful managed-image
publication selected by the trusted publication gate. The values can differ
when a later main commit does not change a managed-image input.

The request has no command, repository, ref, or free-form target field. The
controller rejects missing and extra fields, any target other than
`jetson-nvmap-gpu`, a noncanonical commit SHA, and invalid workflow-run values.

The controller uses these endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/jobs` | Submit the request and receive its initial status. |
| `GET` | `/v1/jobs/{jobId}` | Poll the queued, running, or completed status. |
| `DELETE` | `/v1/jobs/{jobId}` | Request cancellation after a signal, deadline, or repeated poll failure. |
| `GET` | `/v1/jobs/{jobId}/artifact` | Read the completed status, bounded log, and optional artifact archive. |

Job creation and status responses wrap the status as `{ "job": <status> }`.
The `jobId` is the lowercase SHA-256 digest of the colon-separated request
tuple `schemaVersion`, `target`, `candidateSha`, `managedImageRevision`,
`workflowRunId`, and `workflowRunAttempt`. The controller verifies that
relationship before it accepts a status.

A status advances through `queued`, `running`, and `completed`. Queued and
running jobs have `cleanup: "pending"`. A completed job has one of these
conclusions:

- `success`
- `failure`
- `cancelled`
- `timed-out`
- `cleanup-failed`

A completed job reports cleanup as `succeeded` or `failed`. A failed cleanup
requires `conclusion: "cleanup-failed"`. That conclusion can report cleanup as
`succeeded` when job cleanup finished but a later lifecycle step, such as
device-lock release, failed. A successful result includes the bounded device
identity fields `model`, `jetpackVersion`,
`jetsonLinuxRelease`, and `kernel`.

The artifact response contains the same completed status and a log of at most
4 MiB. It can contain a canonical base64 artifact archive of at most 1 MiB. A
successful result must contain the archive. The client rejects unknown fields,
invalid timestamps, inconsistent states, a mismatched job ID, oversized
content, and a noncanonical archive.

The static vectors are the compatibility boundary shared with the
operator-owned service. Contract 1.0.0 remains immutable at SHA-256
`d50e381860ec131e92f78c25272bfdcbacb790adc9552c3aaf0778427171314c`.
Contract 2.0.0 is immutable at SHA-256
`fbf173a23db958caa74e0b32aaf362c604caf4c86204fc0a4ce7a1865b41eeb9`.
The receiver's CI and deployment gate compare both copies against NemoClaw
`main`. Each vector file includes one request, queued and completed responses,
one artifact, and rejected request examples.

## Trusted GitHub Dispatch

The Jetson job runs automatically for each trusted push to `main` in
`NVIDIA/NemoClaw`. A manual run requires `allow_jetson_dispatch=true` on the
trusted `main` workflow. The manual input defaults to `false`. The workflow
limits a manual candidate checkout to the same repository and sends the `checkout_sha` or current trusted ref commit as `candidateSha`. GitHub queues
later Jetson jobs instead of canceling a running job.

For a trusted main run, the publication gate exports the first-parent commit
whose successful managed-image workflow covers the candidate. The controller
sends that commit as `managedImageRevision`. A manual candidate run preserves
the exact-candidate selection only when it has a qualified `linux/arm64`
managed-image revision. A changed-input PR candidate catalog qualifies
`linux/amd64` only. The trusted publication job reports that limitation, and
the Jetson job does not dispatch.

The job grants only `contents: read` and `id-token: write`. The controller
requests a short-lived GitHub OIDC token with audience
`nemoclaw-jetson-dispatch` and sends it as a bearer token on every service
request. It does not store the token in the uploaded evidence.

Configure `JETSON_DISPATCH_URL` as a GitHub repository variable. The client
requires an HTTPS origin without user information, a path, a query, or a
fragment. Do not put a token or other credential in that variable.

The operator-owned service must remain available and compatible with contract
version `2.0.0` for trusted `main` pushes. Keep the manual flag disabled for
ordinary and full manual `main` runs. Use a separate focused manual run when the
maintainer requests the Jetson target.

## Evidence

The trusted workflow records `dispatch.json` in the
`e2e-dispatch-<run-id>-<attempt>` artifact before candidate execution. That
receipt binds the candidate repository and SHA, base SHA, trusted workflow SHA,
workflow run ID and attempt, selectors, event, and hardware opt-in decisions.

The Jetson controller writes private files under the target artifact directory:

- `jetson-dispatch.json` records the validated request and derived job ID before
  submission begins. It records the cancellation reason and final outcome. If
  cancellation reports that the job is absent after submission may have reached
  the dispatcher, the controller records one follow-up request. A completed
  artifact replaces this recovery state with the validated status and bounded
  log. The file excludes the base64 archive payload.
- `jetson-e2e-artifacts.tar.gz` contains the decoded target evidence when the
  service returns an archive.

The workflow uploads that directory as `e2e-jetson-nvmap-gpu`, including on job
failure. A successful proof requires the candidate request, a conclusion
of `success`, `cleanup: "succeeded"`, a device identity, and the artifact
archive.

If a workflow fails after submission begins, inspect `jetson-dispatch.json`
before another dispatch. Use its job ID to inspect the operator-service job,
even when the receipt has no `cancellation` record. If artifact upload failed
and the file is unavailable, use the job ID from the workflow error or logs.
Cancel the job or confirm completion before another dispatch, regardless of
whether the cancellation outcome is absent, pending, succeeded, or failed.

## Live Target

`test/e2e/live/jetson-nvmap-gpu.test.ts` runs the Jetson hardware target for the
commit under review. Managed-image lookup uses the separately dispatched
publication commit. Candidate identity checks continue to use the commit under
review. The controller contract requires the
`jetson-nvmap-gpu` target ID. For
[PR #8910](https://github.com/NVIDIA/NemoClaw/pull/8910), the target is the
candidate proof for native OpenShell CDI GPU passthrough on AGX Thor and IGX
Orin. It does not establish product support by itself.

The test verifies these requirements:

- The host identifies as AGX Thor or IGX Orin.
- `/dev/nvmap` is a character device on the host.
- Docker discovers an NVIDIA CDI GPU device.
- A readable NVIDIA CDI specification declares `/dev/nvmap` and `libcuda.so`.
- NemoClaw installation completes without prompts.
- The sandbox registry records the immutable published
  `ghcr.io/nvidia/nemoclaw/openclaw-sandbox` digest selected for `linux/arm64`,
  and its source revision matches the separately dispatched publication commit.
- The installed commands resolve inside the Jetson job workspace.

The live test runs `bash install.sh --non-interactive` with
`NEMOCLAW_SANDBOX_GPU=1`. The native route leaves device injection, driver
library mounts, supplemental groups, and CDI-derived policy enrichment under
OpenShell ownership. The test rejects NemoClaw's Docker GPU compatibility
recreation path.

A passing test requires these results:

- Onboarding reports successful `nvidia-smi`, proc-comm, and `cuInit(0)` GPU
  proofs.
- `nemoclaw e2e-jetson-nvmap status` reports `Sandbox GPU: enabled` and
  `CUDA verified`.
- The OpenShell sandbox command runs as a non-root identity, can read `/sys`,
  can access `/dev/nvmap`, and can run `nvidia-smi`.
- Loading `libcuda.so.1` and calling `cuInit(0)` inside that sandbox returns
  zero.

The test writes `phase-2-published-managed-image.json` with the registry
workload receipt, digest-qualified managed-image reference, and inspected image
labels used to prove its agent, contracts, source revision, and platform.

The test result is candidate evidence for the named commit and reported
device. The OpenShell dependency stack must be released, and AGX Thor and IGX
Orin must each produce an independent successful run before #8910 can leave
draft or the integration can be described as supported. The test records phase
evidence through the shared live E2E artifact fixtures.

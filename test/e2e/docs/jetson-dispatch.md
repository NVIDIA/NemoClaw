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
  token, sends the exact candidate commit, validates responses, and writes
  bounded evidence.
- `tools/e2e/jetson-dispatch-contract.mts` implements HTTP contract version
  `1.0.0`.
- `tools/e2e/contracts/v1/jetson-dispatch.json` contains the shared static
  compatibility vectors for contract version `1.0.0`.
- The repository variable `JETSON_DISPATCH_URL` selects the operator-provided
  service origin.
- `test/e2e/live/jetson-nvmap-gpu.test.ts` defines the live target.

The service implementation and device lifecycle are operator-owned
infrastructure. NemoClaw has no build-time dependency on that implementation.

## HTTP Contract 1.0.0

Contract version `1.0.0` uses JSON with `schemaVersion: 1`. The controller sends
a request body with these exact fields:

```json
{
  "schemaVersion": 1,
  "target": "jetson-nvmap-gpu",
  "candidateSha": "<lowercase-40-character-commit-sha>",
  "workflowRunId": "<positive-decimal-integer>",
  "workflowRunAttempt": 1
}
```

The request has no command, repository, ref, or free-form target field. The
controller rejects missing and extra fields, any target other than
`jetson-nvmap-gpu`, a noncanonical commit SHA, and invalid workflow-run values.

The controller uses these endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/jobs` | Submit the exact request and receive its initial status. |
| `GET` | `/v1/jobs/{jobId}` | Poll the queued, running, or completed status. |
| `DELETE` | `/v1/jobs/{jobId}` | Request cancellation after a signal, deadline, or repeated poll failure. |
| `GET` | `/v1/jobs/{jobId}/artifact` | Read the completed status, bounded log, and optional artifact archive. |

Job creation and status responses wrap the status as `{ "job": <status> }`.
The `jobId` is the lowercase SHA-256 digest of the colon-separated request
tuple `schemaVersion`, `target`, `candidateSha`, `workflowRunId`, and
`workflowRunAttempt`. The controller verifies that relationship before it
accepts a status.

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

The static vectors in
`tools/e2e/contracts/v1/jetson-dispatch.json` are the compatibility boundary
shared with the operator-owned service. They include one request, queued and
completed responses, one artifact, and rejected request examples. Change the
contract version, parser tests, client tests, and vectors together when an
incompatible wire change is required.

## Trusted GitHub Dispatch

The Jetson job runs only for an explicit `workflow_dispatch` on the trusted
`main` workflow in `NVIDIA/NemoClaw`. The workflow requires
`allow_jetson_dispatch=true`, limits candidate checkout to the same repository,
and sends the exact `checkout_sha` or current trusted ref commit as
`candidateSha`. GitHub queues later Jetson jobs instead of canceling a running
job.

The job grants only `contents: read` and `id-token: write`. The controller
requests a short-lived GitHub OIDC token with audience
`nemoclaw-jetson-dispatch` and sends it as a bearer token on every service
request. It does not store the token in the uploaded evidence.

Configure `JETSON_DISPATCH_URL` as a GitHub repository variable. The client
requires an HTTPS origin without user information, a path, a query, or a
fragment. Do not put a token or other credential in that variable.

The operator-owned service must already be available and compatible with
contract version `1.0.0` before a maintainer enables the dispatch flag. Keep
the flag disabled for ordinary runs and required pre-tag evidence.

## Evidence

The trusted workflow records `dispatch.json` in the
`e2e-dispatch-<run-id>-<attempt>` artifact before candidate execution. That
receipt binds the candidate repository and SHA, base SHA, trusted workflow SHA,
workflow run ID and attempt, selectors, event, and hardware opt-in decisions.

The Jetson controller writes private files under the target artifact directory:

- `jetson-dispatch.json` contains the validated completed status and bounded
  log. It excludes the base64 archive payload.
- `jetson-e2e-artifacts.tar.gz` contains the decoded target evidence when the
  service returns an archive.

The workflow uploads that directory as `e2e-jetson-nvmap-gpu`, including on job
failure. A successful proof requires the exact candidate request, a conclusion
of `success`, `cleanup: "succeeded"`, a device identity, and the artifact
archive.

## Live Target

`test/e2e/live/jetson-nvmap-gpu.test.ts` runs the supported Jetson hardware
proof against the candidate checkout. It verifies the Jetson hardware gate,
Docker NVIDIA runtime, real noninteractive NemoClaw installation, job-local
installed commands, sandbox access to `/dev/nvmap`, successful CUDA
initialization, and the verified GPU status reported by NemoClaw. The test
records phase evidence through the shared live E2E artifact fixtures.

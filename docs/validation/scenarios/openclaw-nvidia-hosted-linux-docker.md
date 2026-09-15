<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validate a v0 OpenClaw Export with v1

This scenario implements the first checklist item in [NVIDIA/NemoClaw issue #11810](https://github.com/NVIDIA/NemoClaw/issues/11810).
It treats a redacted v0 configuration export as an input artifact and validates a new v1 deployment.
It does not run, patch, or inspect the v0 test harness.

The checked-in synthetic export permits deterministic development before v0 E2E workflows publish reusable exports.
It is modeled from `test/e2e/manifests/openclaw-nvidia.yaml` at NVIDIA/NemoClaw revision `f47724f29838fe08898993fad1c8c6b7fcb3e080`.
Replace it with exact bytes from a qualified v0 export when those artifacts become available.

This scenario creates a new v1 deployment.
It does not adopt a v0 deployment or migrate its workspace, conversations, credentials, or runtime state.

## Artifact and Translation Contract

The caller supplies these v0 artifact properties:

- An absolute path to redacted YAML.
- The SHA-256 of its exact bytes.
- A nonempty source identity, such as a producing scenario and revision or a declared synthetic fixture.

The translator rejects unknown v0 fields instead of silently dropping them.
It carries portable deployment identity, gateway port, inference, agent, and network intent into v1.
The caller separately binds the v1 gateway engine, gateway image, gateway network, and Fabric image because v0 exports do not identify those v1 runtime dependencies.
Imported explicit policy remains literal, including its process user and group.
The selected v1 Fabric image must provide those principals, or a separately reviewed migration contract must define how to translate them.

The checked-in contract lives under `crates/nemoclaw-e2e/fixtures/openclaw-nvidia-hosted/`:

- `v0.yaml` is the unmodified reference manifest with its upstream revision and hash.
- `v0-export.yaml` is the representative redacted export.
- `v1.yaml` is the expected translated v1 desired state.

Run the deterministic checks without Docker or a credential:

```sh
cargo test -p nemoclaw-e2e --test hosted_parity
```

## Live Verification

The live test performs this v1 lifecycle:

1. Verify the artifact hash, source identity, redaction, and strict translation.
2. Plan and apply the translated desired state in an owned state directory.
3. Require a real OpenClaw reply through the NVIDIA hosted endpoint.
4. Require unchanged plan and apply with stable resource identities.
5. Export v1 desired state and compare it with the translated document.
6. Reapply the v1 export without changes.
7. Preview and destroy the owned workloads.
8. Confirm that only the owned workspace and gateway storage remain.

Apply failure retains state and resources for diagnosis.
A feedback-only run may reapply the identical pending intent after a failure.
A Linux qualification candidate must start from fresh state.

The test writes `openclaw-nvidia-hosted-parity.json` and `exported.yaml` under the state directory.
The evidence records the exact artifact hash and source, v1 revision and bundle, redacted input, v1-only bindings, environment, operations, resource identities, agent reply, export comparison, cleanup, and verdict.
Review retained files for credentials before sharing them.

## Prerequisites and Ownership

Use an owned Docker daemon, deployment UID, port, subnet, state directory, and NVIDIA API key.
The key must be available only as `NVIDIA_INFERENCE_API_KEY`; do not place its value in YAML, arguments, state, evidence, or repository files.
The test does not revoke it.

Build a verified bundle and an immutable `nc-prototype-fabric` image for the Docker daemon's architecture.
Use an immutable gateway image.
Create a private state directory with this marker before running:

```json
{
  "scenario": "openclaw-nvidia-hosted-linux-docker",
  "deploymentUid": "the-uid-from-the-v0-export",
  "owned": true
}
```

Set absolute paths and exact identities:

```sh
export NEMOCLAW_LIVE_V1_REVISION="$(git rev-parse HEAD)"
export NEMOCLAW_LIVE_V0_EXPORT=/absolute/private/path/v0-export.yaml
export NEMOCLAW_LIVE_V0_EXPORT_SHA256=sha256-of-exact-export-bytes
export NEMOCLAW_LIVE_V0_SOURCE='producer scenario and exact revision'
export NEMOCLAW_LIVE_HOSTED_STATE=/absolute/path/to/owned-state
export NEMOCLAW_TEST_BUNDLE=/absolute/path/to/verified-bundle
export NEMOCLAW_LIVE_GATEWAY_ENGINE=unix:///var/run/docker.sock
export NEMOCLAW_LIVE_GATEWAY_IMAGE=repository@sha256:reviewed-digest
export NEMOCLAW_LIVE_GATEWAY_NETWORK_CIDR=owned-cidr
export NEMOCLAW_LIVE_FABRIC_IMAGE=nc-prototype-fabric@sha256:local-digest
```

For a Linux qualification candidate, use a clean checkout and the candidate acknowledgement:

```sh
export NEMOCLAW_RUN_LIVE_HOSTED_PARITY=issue-11810
cargo test -p nemoclaw-e2e --test hosted_parity \
  v0_export_artifact_drives_v1_hosted_openclaw_lifecycle \
  -- --ignored --nocapture
```

Do not include this paid, credentialed test in an ignored-test aggregate.
The runner records `qualified: false` in every result.
Assign qualification only after reviewing the artifact provenance and redacted lifecycle evidence.

## Docker Desktop Feedback

Docker Desktop is useful for early feedback but does not qualify the Linux baseline.
Run the Linux ARM64 test and bundle inside an owned Linux controller container with the Docker Desktop socket mounted at `/var/run/docker.sock`.
Use the feedback-only acknowledgement:

```sh
export NEMOCLAW_RUN_LIVE_HOSTED_PARITY=issue-11810-local-feedback
```

Docker Desktop may replace the requested socket source with `/run/host-services/docker.proxy.sock`.
v1 accepts that exact source and target pair only when the selected daemon identifies its operating system as `Docker Desktop` and its name as `docker-desktop`.
Other source changes remain drift.

The managed gateway uses Linux host networking.
Docker Desktop does not reproduce the native Linux gateway and sandbox callback topology from a controller container without an additional operator-owned forwarding layer.
Record any such layer as a feedback-only environment adaptation; do not treat that run as unmodified lifecycle or qualification evidence.

## Linux Baseline

Use a disposable native Linux x86_64 Docker host for qualification when matching Fabric and gateway images are available.
A GPU is not required because inference uses the hosted NVIDIA endpoint.
Record the host release, kernel, architecture, Docker client and server versions, daemon identity, image digests, bundle manifest, v1 revision, artifact identity, and artifact hash.

A Brev CPU VM is suitable for ad hoc qualification.
Review its price before creation, keep credentials out of startup metadata and shell history, retrieve the redacted evidence, and delete the billable VM after owned resources have been handled.

## Recovery and Cleanup

After a failed apply, keep the exact artifact, bindings, bundle, and state directory.
Reapply only the identical desired state while diagnosing a pending intent.
Do not create a second state directory for the same deployment UID.

After observation, preview destroy and destroy only the deployment bound to the owned state.
Confirm that its sandbox and managed gateway container are absent.
The v1 destroy contract retains its workspace and gateway storage identities.
Do not mark issue #11810 complete; this scenario covers only its first configuration.

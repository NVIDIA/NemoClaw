<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validate a v0 OpenClaw Export with v1

This scenario implements the first checklist item in [NVIDIA/NemoClaw issue #11810](https://github.com/NVIDIA/NemoClaw/issues/11810).
It compares a redacted v0 configuration export with separately authored current intent and validates a new v1 deployment.
It does not run, patch, or inspect the v0 test harness.

The checked-in export is raw output from the public v0 `nemoclaw config export` path aligned by [NVIDIA/NemoClaw issue #11977](https://github.com/NVIDIA/NemoClaw/issues/11977) and merged at revision `b6934c6300c4e1e175757e9281ae3a641d9a5b1f`.
The historical checked-in export uses the obsolete `agents` list and is rejected by the current parser.
The separately authored `v1.yaml` fixture preserves its intent using singular `agent`; deterministic checks verify both rejection and retained intent.
Live verification requires both the raw export and a separately authored current configuration; it does not import the historical export directly.
Updating the fixture is a manual review step: run the public command against a representative supported deployment, inspect the output for credential values, copy the redacted bytes into this repository without reshaping them, and update the separately authored current document in the same change.
The v0 E2E export mechanism is a convenient producer of candidate inputs, not a pipeline dependency of the v1 test.
Source scenario, revision, date, or executable identity may be retained with the fixture as useful audit metadata, but the v1 test does not require or resolve an exact v0 version.

This scenario creates a new v1 deployment.
It does not adopt a v0 deployment or migrate its workspace, conversations, credentials, or runtime state.

## Artifact and Parser Contract

The caller supplies absolute paths to the manually curated, redacted raw v0 export and a separately authored current v1 configuration.
The runner computes and records the SHA-256 and redacted bytes of each input.
An optional free-form source note may identify the producing scenario or revision for later audits; it is not an execution or qualification gate.

The runner parses the authored configuration through the ordinary v1 `Document::parse` path.
A test-only comparison replaces the raw export’s single-entry `agents` list with `agent` in memory and checks that its parsed intent equals the authored configuration.
The v1 parser supplies target defaults, including the gateway engine and image, gateway network, and agent image.
Only the separately supplied current document drives deployment; the SDK has no compatibility translator.
This comparison requires one sandbox and one historical agent, and rejects changes to identity, inference, policy, or other portable intent.

The checked-in contract lives under `crates/nemoclaw-e2e/fixtures/openclaw-nvidia-hosted/`:

- `NOTICE.md` records producer revision, refresh date, and artifact handling.
- `v0.yaml` is the unmodified reference manifest with its upstream revision and hash.
- `v0-export.yaml` is the raw representative redacted export from the supported public path.
- `v1.yaml` is the explicitly reauthored current document with the same portable intent.

Run the deterministic checks without Docker or a credential:

```sh
cargo test -p nemoclaw-e2e --test hosted_parity
```

## Live Verification

The live test performs this v1 lifecycle:

1. Verify both inputs are redacted, parse the authored v1 configuration, compare its intent with the test-only projection of the raw export, and record both hashes.
2. Plan and apply the authored desired state in an owned state directory.
3. Require a real OpenClaw reply through the NVIDIA hosted endpoint.
4. Require unchanged plan and apply with stable resource identities.
5. Export v1 desired state and compare it with the authored input.
6. Reapply the v1 export without changes.
7. Preview and destroy the owned workloads.
8. Confirm that only the owned workspace and gateway storage remain.

Apply failure retains state and resources for diagnosis.
A feedback-only run may reapply the identical pending intent after a failure.
A Linux qualification candidate must start from fresh state.

The test writes `openclaw-nvidia-hosted-parity.json` and `exported.yaml` under the state directory.
The evidence records both input hashes and redacted inputs, the raw export’s optional source note, their intent comparison, parsed v1 input, v1 revision and bundle, environment, operations, resource identities, agent reply, export comparison, cleanup, and verdict.
Review retained files for credentials before sharing them.

## Prerequisites and Ownership

Use an owned Docker daemon, deployment UID, port, subnet, state directory, and NVIDIA API key.
The key must be available only as `NVIDIA_INFERENCE_API_KEY`; do not place its value in YAML, arguments, state, evidence, or repository files.
The test does not revoke it.

Preserve the raw export unchanged and author a separate current configuration by replacing its single-entry `agents` list with `agent`.
Both inputs must describe the same owned deployment UID and portable intent; do not repurpose another deployment’s identity.
Build a verified bundle and ensure that the immutable gateway and agent images pinned by the SDK revision exist in the owned Docker daemon.
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
export NEMOCLAW_LIVE_V1_CONFIG=/absolute/private/path/authored-v1.yaml
# Optional audit note; the runner does not resolve or validate this identity.
export NEMOCLAW_LIVE_V0_SOURCE='producer scenario or revision'
export NEMOCLAW_LIVE_HOSTED_STATE=/absolute/path/to/owned-state
export NEMOCLAW_TEST_BUNDLE=/absolute/path/to/verified-bundle
```

For a Linux qualification candidate, use a clean checkout and the candidate acknowledgement:

```sh
export NEMOCLAW_RUN_LIVE_HOSTED_PARITY=issue-11810
cargo test -p nemoclaw-e2e --test hosted_parity \
  authored_v1_intent_preserves_v0_export_through_hosted_openclaw_lifecycle \
  -- --ignored --nocapture
```

Do not include this paid, credentialed test in an ignored-test aggregate.
The runner records `qualified: false` in every result.
Assign qualification only after reviewing the curated input and redacted lifecycle evidence.

## Docker Desktop Feedback

Docker Desktop is useful for early feedback but does not qualify the Linux baseline.
Run the Linux ARM64 test and bundle inside an owned Linux controller container with the Docker Desktop socket mounted at `/var/run/docker.sock`.
Use the feedback-only acknowledgement:

```sh
export NEMOCLAW_RUN_LIVE_HOSTED_PARITY=issue-11810-local-feedback
```

Docker Desktop may replace the requested socket source with `/run/host-services/docker.proxy.sock`.
The managed-runtime observer treats that replacement as binding drift and fails closed.
Supporting the replacement requires a separate product decision and does not belong to this native-Linux scenario.

The managed gateway uses Linux host networking.
Docker Desktop does not reproduce the native Linux gateway and sandbox callback topology from a controller container without an additional operator-owned forwarding layer.
Record any such layer as a feedback-only environment adaptation; do not treat that run as unmodified lifecycle or qualification evidence.

## Linux Baseline

Use a disposable native Linux Docker host with matching Fabric and gateway images.
The current Fabric image build is qualified for native Linux ARM64, so ARM64 is the least-friction environment for this run; architecture remains an observed property rather than a scenario matrix.
A GPU is not required because inference uses the hosted NVIDIA endpoint.
Record the host release, kernel, architecture, Docker client and server versions, daemon identity, image digests, bundle manifest, v1 revision, artifact identity, and artifact hash.

A Brev CPU VM is suitable for ad hoc qualification.
Review its price before creation, keep credentials out of startup metadata and shell history, retrieve the redacted evidence, and delete the billable VM after owned resources have been handled.

## Recovery and Cleanup

After a failed apply, keep both exact input artifacts, the bundle, and the state directory.
Reapply only the identical desired state while diagnosing a pending intent.
Do not create a second state directory for the same deployment UID.

After observation, preview destroy and destroy only the deployment bound to the owned state.
Confirm that its sandbox and managed gateway container are absent.
The v1 destroy contract retains its workspace and gateway storage identities.
Do not mark issue #11810 complete; this scenario covers only its first configuration.

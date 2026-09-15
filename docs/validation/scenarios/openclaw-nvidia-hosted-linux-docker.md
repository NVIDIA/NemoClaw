<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Compare Hosted NVIDIA OpenClaw on Linux and Docker

This scenario implements the first checklist item in [NVIDIA/NemoClaw issue #11810](https://github.com/NVIDIA/NemoClaw/issues/11810).
It does not contain a live result.
Qualification requires a dedicated NVIDIA credential and an owned Linux Docker daemon.

The deterministic contract retains the v0 manifest, a representative v0 export, and the expected translated v1 desired state under `crates/nemoclaw-e2e/fixtures/openclaw-nvidia-hosted/`.
The v0 manifest is copied without modification from `test/e2e/manifests/openclaw-nvidia.yaml` at revision `f47724f29838fe08898993fad1c8c6b7fcb3e080`.
Its SHA-256 is `35c28e708e5a89a77a52fd91cbd587c1c39621014bed096464c36bbc37409b9b`.
That upstream file was last changed at revision `4a179614ac8a07273fce8f1cb679b33c0444f5c4`.

This is a desired-state translation into a new v1 deployment.
It does not adopt the v0 deployment or migrate its workspace, conversations, credentials, or runtime state.
The translator rejects unknown v0 export fields instead of silently dropping them.

## Comparison Boundary

| Property | Pinned v0 | Closest v1 |
|---|---|---|
| Host and target | Ubuntu, local | Linux, local Docker engine |
| Runtime | Running Docker daemon | Managed OpenShell gateway and Fabric/OpenClaw sandbox on Docker |
| Inference | NVIDIA provider through `inference.local` | OpenAI-compatible route to `https://integrate.api.nvidia.com/v1` |
| Model | v0 default `nvidia/nemotron-3-super-120b-a12b` | Explicit same model ID |
| Credential | `NVIDIA_INFERENCE_API_KEY` reference | Same environment reference; no value in YAML, state, export, or evidence |
| Policy | Exported effective explicit policy and proxy | Same explicit policy and proxy |
| Messaging | None | None |
| Storage | v0 workspace lifecycle | v1 workspace and managed gateway storage retained after destroy; sandbox files deleted |

The v0 export supplies portable identity, gateway port, inference, agent, and network intent.
The operator must separately bind the v1 gateway engine, gateway image, gateway network, and Fabric image because the v0 export does not contain equivalent v1 runtime identities.
The final candidate verdict is **Equivalent desired-state intent and agent behavior** only if both live lifecycles pass and the v1 export equals the translated v0 desired state.

## Live Prerequisites and Effects

Run each revision from a clean detached worktree on the same owned Linux host.
Use a dedicated Docker daemon or reserve every selected port, subnet, deployment UID, sandbox name, and state directory for this scenario.
Use a dedicated NVIDIA API key and revoke it through its issuer after the comparison.

The v0 run installs its pinned checkout, creates its target's Docker and OpenShell resources, sends a real hosted inference request, exports the live configuration, and invokes target cleanup.
The v1 run creates a managed gateway and sandbox, installs the credential into the owned provider registration, sends a real agent request, and destroys workloads.
It retains the v1 workspace, gateway storage, bundle, state, and redacted evidence.
Neither runner revokes the upstream API key.

Do not hand-author a live v1 YAML file.
The live gate strictly translates the captured v0 export and rejects unrepresented fields.
Supply the four v1-only runtime bindings through the environment.
The Fabric image must use the owned local `nc-prototype-fabric` repository and an immutable digest present in the selected Docker daemon.
Create a private empty state directory containing `ownership.json` with this shape:

```json
{
  "scenario": "openclaw-nvidia-hosted-linux-docker",
  "deploymentUid": "the-uid-from-the-v0-export",
  "owned": true
}
```

The v1 entrypoint rejects existing OpenTofu state, a dirty checkout, a relative path, a changed scenario field, or a missing ownership marker.
On failure it retains established state and resources for diagnosis instead of destroying through an incomplete observation.

## Qualify the Pinned v0 Deployment

Check out `f47724f29838fe08898993fad1c8c6b7fcb3e080` in the v0 worktree and confirm that it is clean.
Follow that revision's `test/e2e/docs/README.md` safety and setup instructions.
The v0 harness must invoke `nemoclaw config export` after the real-agent probe and before cleanup in the same target lifecycle.
The current pinned canonical target cleans up without publishing that export, so running it unchanged is insufficient for this comparison.
Do not claim a live verdict until a reviewed local harness hook or an upstream target change captures the export at this boundary.

With `NVIDIA_INFERENCE_API_KEY` supplied by the dedicated secret mechanism, the underlying Docker target remains:

```sh
NEMOCLAW_E2E_EXPECTED_SHA=f47724f29838fe08898993fad1c8c6b7fcb3e080 \
NEMOCLAW_GATEWAY_RUNTIME=docker \
NEMOCLAW_RUN_LIVE_E2E=1 \
TARGET_ID=ubuntu-repo-cloud-openclaw \
  npm run test:live-e2e -- \
    test/e2e/live/registry-targets.test.ts \
    -t '^ubuntu-repo-cloud-openclaw:' \
    --silent=false --reporter=default
```

Retain the target's redacted artifacts and their SHA-256 digests.
Retain the secret-free YAML produced before cleanup by this command, where `<sandbox>` is the target-owned sandbox name:

```sh
nemoclaw config export <sandbox> \
  --output /absolute/private/path/v0-export.yaml \
  --force
```

Confirm that the export contains only credential references, then calculate its SHA-256.
Create a redacted JSON proof for the v1 runner.
It must contain no credential value or string beginning with `nvapi-` and must satisfy this shape:

```json
{
  "scenario": "openclaw-nvidia-hosted-linux-docker",
  "revision": "f47724f29838fe08898993fad1c8c6b7fcb3e080",
  "manifestSha256": "35c28e708e5a89a77a52fd91cbd587c1c39621014bed096464c36bbc37409b9b",
  "target": "ubuntu-repo-cloud-openclaw",
  "passed": true,
  "realAgentResponse": true,
  "exported": true,
  "exportSha256": "sha256-of-the-exact-v0-export-bytes",
  "destroyed": true,
  "ownedResourcesOnly": true,
  "redacted": true,
  "input": {"credentialRefs": ["NVIDIA_INFERENCE_API_KEY"]},
  "platform": {
    "os": "linux",
    "architecture": "observed",
    "kernel": "observed uname -sr",
    "linuxRelease": "observed ID:VERSION_ID from /etc/os-release"
  },
  "runtime": {
    "containerEngine": "docker",
    "dockerClientVersion": "observed",
    "dockerServerVersion": "observed",
    "dockerServerOs": "observed",
    "dockerServerArchitecture": "observed",
    "dockerDaemonId": "observed"
  },
  "images": {"recordImmutableIdentities": true},
  "model": {"id": "nvidia/nemotron-3-super-120b-a12b"},
  "commands": ["record the redacted target, agent probe, config export, and cleanup invocations"],
  "artifacts": {"recordPathsAndSha256": true}
}
```

Replace the illustrative values with the observed Ubuntu release, architecture, kernel, Docker client and server versions, Docker daemon identity, immutable image identities, selected model, exact export hash, redacted commands, artifact paths, and hashes.
Do not infer a pass from configuration parsing or process startup.

## Qualify the v1 Desired State

Build and copy an immutable verified Linux bundle from the clean v1 revision under test.
Set the full revision and absolute paths without placing the credential in the command line:

```sh
export NEMOCLAW_RUN_LIVE_HOSTED_PARITY=issue-11810
export NEMOCLAW_LIVE_V1_REVISION="$(git rev-parse HEAD)"
export NEMOCLAW_LIVE_V0_EXPORT=/absolute/private/path/v0-export.yaml
export NEMOCLAW_LIVE_HOSTED_STATE=/absolute/path/to/owned-empty-state
export NEMOCLAW_LIVE_V0_PROOF=/absolute/path/to/redacted-v0-proof.json
export NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable-linux-bundle
export NEMOCLAW_LIVE_GATEWAY_ENGINE=unix:///var/run/docker.sock
export NEMOCLAW_LIVE_GATEWAY_IMAGE=ghcr.io/nvidia/openshell/gateway@sha256:the-reviewed-digest
export NEMOCLAW_LIVE_GATEWAY_NETWORK_CIDR=the-owned-cidr
export NEMOCLAW_LIVE_FABRIC_IMAGE=nc-prototype-fabric@sha256:the-locally-built-digest

cargo test -p nemoclaw-e2e --test hosted_parity \
  pinned_v0_and_v1_hosted_openclaw_lifecycles_produce_a_parity_verdict \
  -- --ignored --nocapture
```

The ignored test verifies that the proof names the exact v0 export hash, that the v0 and v1 runs use the same Linux release, kernel, architecture, and Docker daemon, and that the export translates without loss.
It then checks a read-only fresh plan, SDK apply, a real OpenClaw reply through OpenShell, unchanged plan and apply, CLI export, SDK reapply, stable resource identities, destroy preview, CLI destroy, and retained workspace and gateway-storage identities.
It records the exact revisions, v0 manifest and export hashes, redacted v0 input, explicit v1-only bindings, translated desired state, host and Docker environment, bundle manifest and file hashes, operation results, resource identities, normalized desired-state comparison, lifecycle difference, and verdict in `openclaw-nvidia-hosted-parity.json` under the state directory.

Review the retained JSON for redaction before sharing it.
Hash any separately retained logs and artifacts after redaction.
Do not mark issue #11810 complete; this record covers only its first scenario.

## Recover or Clean Up

If the v1 test fails after apply, keep the exact YAML, bundle, credential reference, and complete state directory.
Inspect the failure and reapply the same desired state before attempting destroy.
After observations are complete, preview and destroy only that owned state as described in the [destroy procedure](../../usage.md#destroy).
Confirm the sandbox and managed gateway container are absent and that only the recorded workspace and gateway-storage bindings remain.

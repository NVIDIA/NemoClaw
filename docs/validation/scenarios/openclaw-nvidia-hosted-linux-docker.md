<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Compare Hosted NVIDIA OpenClaw on Linux and Docker

This scenario implements the first checklist item in [NVIDIA/NemoClaw issue #11810](https://github.com/NVIDIA/NemoClaw/issues/11810).
It does not contain a live result.
Qualification requires a dedicated NVIDIA credential and an owned Linux Docker daemon.

The deterministic contract retains the v0 manifest and its closest v1 desired state under `crates/nemoclaw-e2e/fixtures/openclaw-nvidia-hosted/`.
The v0 manifest is copied without modification from `test/e2e/manifests/openclaw-nvidia.yaml` at revision `f47724f29838fe08898993fad1c8c6b7fcb3e080`.
Its SHA-256 is `35c28e708e5a89a77a52fd91cbd587c1c39621014bed096464c36bbc37409b9b`.
That upstream file was last changed at revision `4a179614ac8a07273fce8f1cb679b33c0444f5c4`.

## Comparison Boundary

| Property | Pinned v0 | Closest v1 |
|---|---|---|
| Host and target | Ubuntu, local | Linux, local Docker engine |
| Runtime | Running Docker daemon | Managed OpenShell gateway and Fabric/OpenClaw sandbox on Docker |
| Inference | NVIDIA provider through `inference.local` | OpenAI-compatible route to `https://integrate.api.nvidia.com/v1` |
| Model | v0 default `nvidia/nemotron-3-super-120b-a12b` | Explicit same model ID |
| Credential | `NVIDIA_INFERENCE_API_KEY` reference | Same environment reference; no value in YAML, state, export, or evidence |
| Policy | `personal`, including reviewed general web access | `isolated`, allowing inference routing without general egress |
| Messaging | None | None |
| Storage | v0 workspace lifecycle | v1 workspace and managed gateway storage retained after destroy; sandbox files deleted |

The policy is an intentional architectural difference.
This scenario tests inference and lifecycle parity, not general web-tool parity.
The final candidate verdict is **Equivalent with an intentional architectural difference** only if both live lifecycles pass.

## Live Prerequisites and Effects

Run each revision from a clean detached worktree on the same owned Linux host.
Use a dedicated Docker daemon or reserve every selected port, subnet, deployment UID, sandbox name, and state directory for this scenario.
Use a dedicated NVIDIA API key and revoke it through its issuer after the comparison.

The v0 run installs its pinned checkout, creates its target's Docker and OpenShell resources, sends a real hosted inference request, and invokes target cleanup.
The v1 run creates a managed gateway and sandbox, installs the credential into the owned provider registration, sends a real agent request, and destroys workloads.
It retains the v1 workspace, gateway storage, bundle, state, and redacted evidence.
Neither runner revokes the upstream API key.

Copy the v1 fixture outside the checkout.
Change `metadata.uid`, the loopback gateway port, and `networkCIDR` to fresh owned values.
If the fixture's Fabric image is not present, build the OpenClaw image from the clean v1 checkout, replace only `spec.sandboxes[0].image.ref` with the printed immutable digest, and set `NEMOCLAW_LIVE_FABRIC_IMAGE` to that exact reference.
The entrypoint rejects a tag, a different local repository, a mismatched acknowledgement, or an image that is absent from the owned Docker daemon.
Create a private empty state directory containing `ownership.json` with this shape:

```json
{
  "scenario": "openclaw-nvidia-hosted-linux-docker",
  "deploymentUid": "the-uid-from-the-live-v1-yaml",
  "owned": true
}
```

The v1 entrypoint rejects existing OpenTofu state, a dirty checkout, a relative path, a changed scenario field, or a missing ownership marker.
On failure it retains established state and resources for diagnosis instead of destroying through an incomplete observation.

## Qualify the Pinned v0 Deployment

Check out `f47724f29838fe08898993fad1c8c6b7fcb3e080` in the v0 worktree and confirm that it is clean.
Follow that revision's `test/e2e/docs/README.md` safety and setup instructions.
With `NVIDIA_INFERENCE_API_KEY` already supplied by the dedicated secret mechanism, run only the Docker form of the canonical target:

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
  "destroyed": true,
  "ownedResourcesOnly": true,
  "redacted": true,
  "input": {"credentialRefs": ["NVIDIA_INFERENCE_API_KEY"]},
  "platform": {"os": "linux", "architecture": "observed", "kernel": "observed"},
  "runtime": {
    "containerEngine": "docker",
    "dockerClientVersion": "observed",
    "dockerServerVersion": "observed",
    "dockerDaemonId": "observed"
  },
  "images": {"recordImmutableIdentities": true},
  "model": {"id": "nvidia/nemotron-3-super-120b-a12b"},
  "commands": ["record the redacted focused invocation"],
  "artifacts": {"recordPathsAndSha256": true}
}
```

Replace the illustrative values with the observed Ubuntu release, architecture, kernel, Docker client and server versions, Docker daemon identity, immutable image identities, selected model, redacted commands, artifact paths, and hashes.
Do not infer a pass from configuration parsing or process startup.

## Qualify the v1 Desired State

Build and copy an immutable verified Linux bundle from the clean v1 revision under test.
Set the full revision and absolute paths without placing the credential in the command line:

```sh
export NEMOCLAW_RUN_LIVE_HOSTED_PARITY=issue-11810
export NEMOCLAW_LIVE_V1_REVISION="$(git rev-parse HEAD)"
export NEMOCLAW_LIVE_HOSTED_CONFIG=/absolute/path/to/live-v1.yaml
export NEMOCLAW_LIVE_HOSTED_STATE=/absolute/path/to/owned-empty-state
export NEMOCLAW_LIVE_V0_PROOF=/absolute/path/to/redacted-v0-proof.json
export NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable-linux-bundle
export NEMOCLAW_LIVE_FABRIC_IMAGE=nc-prototype-fabric@sha256:the-locally-built-digest

cargo test -p nemoclaw-e2e --test hosted_parity \
  pinned_v0_and_v1_hosted_openclaw_lifecycles_produce_a_parity_verdict \
  -- --ignored --nocapture
```

The ignored test checks a read-only fresh plan, SDK apply, a real OpenClaw reply through OpenShell, unchanged plan and apply, CLI export, SDK reapply, stable resource identities, destroy preview, CLI destroy, and retained workspace and gateway-storage identities.
It records the exact revisions, v0 manifest hash, redacted v0 proof, normalized v1 input, host and Docker environment, bundle manifest and file hashes, operation results, resource identities, lifecycle difference, and verdict in `openclaw-nvidia-hosted-parity.json` under the state directory.

Review the retained JSON for redaction before sharing it.
Hash any separately retained logs and artifacts after redaction.
Do not mark issue #11810 complete; this record covers only its first scenario.

## Recover or Clean Up

If the v1 test fails after apply, keep the exact YAML, bundle, credential reference, and complete state directory.
Inspect the failure and reapply the same desired state before attempting destroy.
After observations are complete, preview and destroy only that owned state as described in the [destroy procedure](../../usage.md#destroy).
Confirm the sandbox and managed gateway container are absent and that only the recorded workspace and gateway-storage bindings remain.

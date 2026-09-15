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
| Host and target | Ubuntu, local | Same Linux host and local Docker engine |
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

## Prepare a Disposable Brev Host

The current least-friction path uses one Ubuntu 24.04 ARM64 CPU VM for both revisions so the Linux release, kernel, architecture, and Docker daemon identity match.
A GPU is not required because inference uses the hosted NVIDIA endpoint.
Select an offering with at least 4 vCPUs, 16 GB of memory, and 100 GB of disk.
The current Fabric image builder rejects non-ARM64 hosts, so an x86_64 VM cannot complete this scenario without a separately reviewed amd64 Fabric artifact.
Review the current compute and disk price before creating it, and delete it as soon as the evidence is retrieved.

Query current matching offers and review the selected type's hourly compute and disk prices:

```sh
brev search cpu --arch arm64 --min-vcpu 4 --min-ram 16 \
  --min-disk 100 --sort price
```

After selecting one returned type, create one VM:

```sh
export REVIEWED_TYPE=the-type-returned-by-search
brev create nemoclaw-11810-parity --mode vm --jupyter=false \
  --min-disk 100 --type "$REVIEWED_TYPE"
```

Provision Docker, a native C toolchain, Node 22.19.0 or newer, Rust 1.98.1, and verified protoc 36.1 on the disposable host before cloning either revision.
This repository does not prescribe a host tool-version manager.
Run all scenario commands on the Brev host, not in its workload container, and verify the tools before supplying credentials:

```sh
brev shell nemoclaw-11810-parity --host
uname -sm
. /etc/os-release && printf '%s %s\n' "$ID" "$VERSION_ID"
node --version
npm --version
rustc --version
protoc --version
docker version
```

Confirm that the release command prints `ubuntu 24.04` and that the architecture is `aarch64`.
Do not place the NVIDIA credential in the startup script, Brev metadata, shell history, or repository.
Prepare the v0 and v1 worktrees and all immutable images before exporting the credential into the final interactive shell.
Run v0 setup from the pinned v0 worktree:

```sh
npm run dev:setup
```

Build the v1 Linux ARM64 bundle from the clean v1 worktree:

```sh
PROTOC="$(command -v protoc)" \
  cargo run -p nemoclaw-build -- bundle --platform linux_arm64
```

Either build the Fabric/OpenClaw image on this ARM64 host with the [documented image-store, Python, uv, and Buildx prerequisites](../../inference.md#build-an-image-with-the-configuration-interface), or load a reviewed immutable ARM64 image archive prepared from the same v1 revision.
Before supplying the credential, confirm that `docker image inspect` reports a nonempty repository digest for the exact image on the Brev Docker daemon.
Record the archive hash before transfer when using an archive.

## Qualify the Pinned v0 Deployment

Check out `f47724f29838fe08898993fad1c8c6b7fcb3e080` in the v0 worktree and confirm that it is clean.
Follow that revision's `test/e2e/docs/README.md` safety and setup instructions.
The checked-in validation overlay invokes `nemoclaw config export` after the real-agent probe and before cleanup in the same target lifecycle.
The outer runner verifies the pinned revision, manifest hash, successful target result, and successful cleanup before it writes the final v0 proof.
It removes the overlay from the v0 worktree when the command exits and records the overlay hash in the proof.
The overlay changes only the validation harness; it does not change the pinned product source.

The overlay is derived from `test/e2e/live/registry-targets.test.ts` at the pinned v0 revision.
NemoClaw v1 added the issue-specific capture on 2026-09-15.
Review `tools/validation/openclaw-hosted-v0-capture.patch` before the live run.
Its reviewed SHA-256 is `71d23276a2472d50a8a6304e93d5e0330b1022052c839dfe53a55057089b9110`.

Prepare an existing empty absolute capture directory with mode `700` outside both worktrees:

```sh
install -d -m 700 /absolute/path/to/empty-owned-capture
```

From the v1 worktree, set the two paths and the issue-specific acknowledgement, then run the wrapper:

```sh
export NEMOCLAW_RUN_LIVE_HOSTED_PARITY=issue-11810
export NEMOCLAW_V0_WORKTREE=/absolute/path/to/pinned-v0
export NEMOCLAW_V0_CAPTURE_DIR=/absolute/path/to/empty-owned-capture

tools/validation/openclaw-hosted-v0-capture.sh
```

Supply `NVIDIA_INFERENCE_API_KEY` only in the process environment.
The wrapper produces `v0-export.yaml`, `v0-proof.json`, and redacted v0 artifacts under the capture directory.
If the target or cleanup fails, it leaves diagnostic artifacts but does not write a passing proof.

The wrapper executes this underlying Docker target with `NVIDIA_INFERENCE_API_KEY` supplied by the dedicated secret mechanism:

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

The validation overlay retains the target's redacted artifacts and the secret-free YAML produced before cleanup by this command, where `<sandbox>` is the target-owned sandbox name:

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
  "validationOverlaySha256": "71d23276a2472d50a8a6304e93d5e0330b1022052c839dfe53a55057089b9110",
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

Copy the capture directory and v1 state directory from the Brev host, then inspect the copies for credentials before sharing them:

```sh
brev copy --host nemoclaw-11810-parity:/absolute/path/to/capture ./v0-capture
brev copy --host nemoclaw-11810-parity:/absolute/path/to/v1-state ./v1-state
```

Unset `NVIDIA_INFERENCE_API_KEY` in the remote shell and revoke the dedicated key through its issuer.
If v0 cleanup failed, inspect its `cleanup.json` and remove only the target-owned resources before deleting the VM.
After preserving the required evidence and resolving owned resources, delete the billable VM explicitly:

```sh
brev delete nemoclaw-11810-parity
```

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validate a v0 Hermes Export with v1

This scenario implements [NVIDIA/NemoClaw issue #12019](https://github.com/NVIDIA/NemoClaw/issues/12019) under the v0-to-v1 validation plan in [issue #11810](https://github.com/NVIDIA/NemoClaw/issues/11810).
It takes a manually reviewed, redacted Hermes export from the public v0 `nemoclaw config export` path and sends those bytes directly through v1's ordinary `Document::parse` path.
It does not use a translator, adopt a v0 sandbox, or qualify Relay, Switchyard, messaging, local inference, or custom images.

The fixture under `crates/nemoclaw-e2e/fixtures/hermes-nvidia-hosted/` records:

- the representative supported v0 deployment shape and its exact hash;
- the secret-free `nemoclaw.nvidia.com/v1alpha1` export shape delivered by revision `b6934c6300c4e1e175757e9281ae3a641d9a5b1f` in #11986; and
- the same document after the v1 parser applies its gateway, network, and Hermes-image defaults.

The Hermes default is the offline-verified ARM64 image pinned by `images.hermes` in `versions.json`.
It is separate from the OpenClaw image selected by `images.agent`, so the omitted target-owned image cannot start the wrong harness runtime.

The deterministic test verifies the direct parse and preservation of the Hermes harness, explicit API interface, hosted provider, model route, credential reference, process principal, and required Fabric, NemoClaw, and Hermes filesystem roots:

```sh
cargo test -p nemoclaw-e2e --test hosted_parity
```

## Live Verification

The ignored test applies the parsed document to a fresh owned Linux/Docker deployment, requires a real Hermes reply through NVIDIA hosted inference, verifies an unchanged apply, exports and reapplies the v1 document, destroys the owned workloads, and retains redacted evidence.
Its lifecycle and security rules are the same as the [OpenClaw hosted scenario](openclaw-nvidia-hosted-linux-docker.md): use an immutable verified bundle, an owned state directory, and a dedicated `NVIDIA_INFERENCE_API_KEY`; never put the credential value in YAML, arguments, state, evidence, or repository files.

Create `ownership.json` in the state directory before running:

```json
{
  "scenario": "hermes-nvidia-hosted-linux-docker",
  "deploymentUid": "the-uid-from-the-v0-export",
  "owned": true
}
```

Set the same absolute-path variables described by the OpenClaw scenario, then run a clean native-Linux qualification candidate with the Hermes-specific gate:

```sh
export NEMOCLAW_RUN_LIVE_HOSTED_PARITY=issue-12019
cargo test -p nemoclaw-e2e --test hosted_parity \
  v0_export_artifact_drives_v1_hosted_hermes_lifecycle \
  -- --ignored --nocapture
```

For non-qualifying Docker Desktop feedback, use `issue-12019-local-feedback`.
The test writes `hermes-nvidia-hosted-parity.json` and `exported.yaml` under the owned state directory.
Every result remains `qualified: false` until the curated input and redacted lifecycle evidence are externally reviewed.

After a failure, retain the exact artifact, bundle, and state and reapply only the identical pending intent.
After observation, destroy only the deployment bound to that owned state and confirm its sandbox and managed gateway are absent.

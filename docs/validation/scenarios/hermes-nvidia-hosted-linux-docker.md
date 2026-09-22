<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validate Hermes Intent from v0 to v1

This scenario implements [NVIDIA/NemoClaw issue #12019](https://github.com/NVIDIA/NemoClaw/issues/12019) under the v0-to-v1 validation plan in [issue #11810](https://github.com/NVIDIA/NemoClaw/issues/11810).
It retains a manually reviewed, redacted Hermes export from the public v0 `nemoclaw config export` path and compares its portable intent with a separately authored current v1 document.
Current v1 intentionally accepts one `agent` per sandbox, while the historical export contains an `agents` list, so the raw bytes are evidence rather than deployable v1 input.
The comparison projects that one historical agent only inside the test and requires the projected document to equal the ordinarily parsed v1 document.
It does not add a production translator, adopt a v0 sandbox, or qualify Relay, Switchyard, messaging, local inference, or custom images.

The fixture under `crates/nemoclaw-e2e/fixtures/hermes-nvidia-hosted/` records:

- the representative supported v0 deployment shape and its exact hash;
- the secret-free `nemoclaw.nvidia.com/v1alpha1` export shape delivered by revision `b6934c6300c4e1e175757e9281ae3a641d9a5b1f` in #11986; and
- the separately authored current v1 document after the parser applies its gateway, network, and Hermes-image defaults.

The Hermes default is the offline-verified ARM64 image pinned by `images.hermes` in `versions.json`.
It is separate from the OpenClaw image selected by `images.agent`, so the omitted target-owned image cannot start the wrong harness runtime.

The deterministic test verifies rejection of the historical list shape, equality of its test-only projection with the authored document, and preservation of the Hermes harness, explicit API interface, hosted provider, model route, credential reference, process principal, and required Fabric, NemoClaw, and Hermes filesystem roots:

```sh
cargo test -p nemoclaw-e2e --test hosted_parity
```

## Live Verification

The live test checks the public deployment operations:

1. Parse the authored v1 YAML and compare it with the raw export's portable intent.
2. Apply the owned deployment and require readiness.
3. Request a real Hermes response through NVIDIA hosted inference and require `FOUR`.
4. Require a subsequent plan and apply to report no changes while preserving resource identities.
5. Export the configuration, compare it with the input, reapply it, and require the same identities.
6. Destroy the owned workloads while retaining the workspace and gateway storage.

The test reports assertion failures through Cargo and writes no separate report.

Use an owned native Linux Docker daemon, a fresh deployment UID, available gateway port and subnet, and an unused state-directory path whose parent exists.
Supply the referenced `NVIDIA_INFERENCE_API_KEY` through the process environment; never put its value in YAML, command arguments, state, or repository files.
Use a verified bundle built from the selected revision and make the immutable Hermes image available to the selected Docker daemon.
A GPU is not required because the configuration selects hosted inference.

From the repository root, set absolute paths and run the selected test:

```sh
NEMOCLAW_LIVE_V0_EXPORT=/absolute/private/path/v0-export.yaml \
NEMOCLAW_LIVE_V1_CONFIG=/absolute/private/path/authored-v1.yaml \
NEMOCLAW_LIVE_HOSTED_STATE=/absolute/path/to/new-state \
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/verified-bundle \
  cargo test -p nemoclaw-e2e --test hosted_parity \
  authored_v1_intent_preserves_v0_export_through_hosted_hermes_lifecycle \
  -- --ignored
```

The test creates the state directory and rejects an existing path.
It does not require a Git revision variable, a clean checkout, an issue acknowledgement, or an ownership-marker file.
Do not run live tests as an ignored-test aggregate.

## Recovery and Cleanup

After a failed apply, keep both inputs, the bundle, and the state directory.
Follow [interrupted-operation recovery](../../usage.md#recover-an-interrupted-operation) with the same v1 YAML and state.
Do not create another state directory for the same deployment UID.

Use [destroy](../../usage.md#destroy) to remove a failed test's owned workloads when appropriate.
Successful test completion already destroys those workloads and retains the workspace and gateway storage.
Retire the upstream NVIDIA key separately when it is no longer needed.

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Preserve Intent After Refused Applies on Linux ARM64

The fix for [issue #12462](https://github.com/NVIDIA/NemoClaw/issues/12462) passed an owned managed Docker deployment on Linux ARM64 on 2026-09-29.
The implementation is `1577e413f0`; the final verified bundle is `0.1.0-dev.1b1c55577bc479fb`.
The host used Docker Engine 29.2.1, Rust 1.98.1, OpenTofu 1.12.6, and Docker provider 4.6.0.
Gateway, supervisor, sandbox runtime, and Pi workload used the [gateway migration image pins](managed-docker-openshell-v012-linux-arm64.md#pinned-images).

## Observed Lifecycle

The final-bundle run used a fresh deployment UUID, unused loopback port and private subnet, separate state directory, and two Pi sandboxes named `assistant` and `reviewer`.
Inference selected a reserved example-domain endpoint; no model or agent requests were sent.

| Operation | Result |
|---|---|
| Initial apply and export | Succeeded; apply took 13.08 seconds |
| Plan and apply after removing `reviewer` | Refused before runtime reconciliation, naming the sandbox and reporting no runtime changes |
| Plan and apply after changing `reviewer`'s image or policy | Refused with the same retention guarantees |
| State and export after each refusal | Retained intent and both OpenTofu state files stayed byte-for-byte unchanged; every export matched the initial export |
| Destroy preview after the refusals | Succeeded without changing retained state |
| Destroy without reapplying the original YAML | Succeeded in 5.66 seconds; removed both sandboxes and the managed gateway workload |

All refusals completed in 0.30–0.32 seconds.
Workspace and gateway-storage bindings, initialized data, signing and encryption keys, bridge, stopped initializer, local state, and images were retained.
No owned test workloads remained running, and no packages or images were published.
The successful Pi apply returned `fabric_health_unsupported`; it does not establish positive agent health or working inference.

## Regression Tests

The [managed-service fixture](../../crates/nemoclaw-e2e/tests/remote_service.rs) first failed because refused removal rewrote `intent.json`.
It now checks removal, image and policy changes, a simultaneous managed-runtime image change, unchanged state and exports, and direct destroy.
It also verifies that a root observation failure after an unchanged runtime stage preserves retained intent.
State tests allow model edits, additions and reordering, and changed launch settings after explicit teardown leaves no sandbox binding.
CLI tests verify the named refusal, unchanged-resource report, and separate-deployment guidance in text and JSON.

From the repository root, with a verified bundle, run the focused fixture without live Docker resources:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/verified-bundle \
  cargo test -p nemoclaw-e2e --test remote_service \
  managed_pi_model_lifecycle_preserves_data_without_generation -- --ignored
```

All 27 deployment fixtures and seven managed-service cases passed.
Those runs used development bundle `0.1.0-dev.b2c36b7029f0311b`, whose SDK, CLI, and provider implementation matches the final bundle; only test-fixture corrections followed.
The focused managed-service case also passed against the final bundle in 92.30 seconds.
Workspace checks passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` (920 passed, zero failed, 124 ignored).
Opt-in fixture tests were selected separately; ignored tests are not counted as passes.
Documentation validation passed with zero errors and one Fern warning.

## Boundaries

Follow the [change constraints](../usage.md#choose-the-change-path) for sandbox replacement or removal.
The early check rejects changes against retained sandbox intent; provider refresh and plan still verify live identity and drift before any mutation.
This change prevents refused requests from overwriting intent; it does not repair intent already overwritten by an older bundle.
A runtime stage with actual resource changes still checkpoints recovery state before mutation, so a later failure can leave a partial apply.
The deterministic managed-service fixture does not qualify real managed inference, Podman, or model responses.

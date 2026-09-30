<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Recover Failed First Applies on Linux ARM64

The fix for [issue #12459](https://github.com/NVIDIA/NemoClaw/issues/12459) passed real OpenTofu fixtures and two owned managed Docker deployment scenarios on Linux ARM64 on 2026-09-29.
The tested implementation is `f63741b453`; the bundle is `0.1.0-dev.bd98e523bb244ae2`.
The host used Docker Engine 29.2.1, Rust 1.98.1, OpenTofu 1.12.6, and Docker provider 4.6.0.
The gateway, supervisor, sandbox runtime, and Pi workload used the exact [image pins recorded for the gateway migration](managed-docker-openshell-v012-linux-arm64.md#pinned-images).
No packages or images were published.

## Observed Recovery

Each live scenario used a fresh deployment UUID, unused loopback port and private subnet, and separate state directory.
Both selected an external inference endpoint on a reserved example domain and made no inference or agent requests.

| Failure and operation | Result |
|---|---|
| First apply with `run_as_user: sandbox` on the Pi image, which uses `node` | Failed in 10.38 seconds with `IdentityResolutionFailed`; resource IDs remained in OpenTofu state |
| Destroy preview immediately after that failure | Succeeded without changing retained intent or either OpenTofu state file |
| Destroy without a successful reapply | Succeeded in 5.34 seconds; removed owned workloads and retained workspace and gateway storage |
| Corrected policy with `run_as_user: "1000"`, applied after destroy | Succeeded; export/reapply had no changes; final destroy succeeded |
| First apply with an unknown Pi model | Failed in 12.07 seconds with the existing `observation query failed` diagnostic; sandbox, provider, profile, and workspace IDs remained saved |
| Destroy preview after the model failure | Succeeded without changing retained intent or either OpenTofu state file |
| Corrected model applied to that failed deployment | Succeeded in 7.00 seconds; all previously saved resource IDs stayed unchanged |
| Export/reapply and destroy after model correction | Reapply reported no changes; destroy succeeded and retained only workspace and gateway-storage bindings |

All test workloads were removed; input documents and state were retained with gateway storage, signing and encryption keys, initializers, and bridges.
The successful Pi applies returned `fabric_health_unsupported`; they do not establish positive agent health or working inference.
The generic model-failure diagnostic remains unchanged by this fix.

## Regression Tests

Two new [deployment fixtures](../../crates/nemoclaw-e2e/tests/deployment.rs) reproduced the original refusals before implementation and passed afterward.
They cover teardown from a first-apply sandbox error or agent-configuration failure, and corrected configuration without recreating the sandbox.
Permission errors, foreign owners, and substituted sandbox IDs refuse teardown while preserving intent and resource state.
State tests reject mismatched binding metadata and deposed-only IDs, retain unresolved creations, and check recovery across a saved-record reload.
The existing lost-create-reply test still refuses teardown until the missing identity is recovered with the original resource configuration.

The diagnostic regression first reported `unknown`, then passed with the fixed `IdentityResolutionFailed` and `ControlSupervisorStartFailed` codes.
Unrecognized reason strings and backend messages remain excluded from diagnostics.

From the repository root, with a verified bundle, the two focused fixtures run against isolated local gRPC servers and temporary state without creating Docker resources:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/verified-bundle \
  cargo test -p nemoclaw-e2e --test deployment failed_first_ -- --ignored
```

All 27 deployment fixture tests passed against the rebuilt bundle in 115.22 seconds.
Workspace validation passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` (918 passed, zero failed, 124 ignored).
The deployment fixtures were selected separately; ignored tests are not counted as passes.
Documentation validation passed with zero errors and one Fern warning.

## Recovery Boundaries

Follow the [operation recovery procedure](../usage.md#recover-an-interrupted-operation) with the retained state directory and a compatible bundle.
Saved bindings resolve pending-creation uncertainty only when name, workspace, owner, and generation match; fresh provider observations and checked plans still gate mutations.
Agent configuration is accounted for by its bound parent sandbox.

The fix does not adopt resources with missing saved IDs, relax older records without per-resource evidence, migrate incompatible gateway/profile formats, or authorize automatic sandbox replacement.
A sandbox in `Error` can still block ordinary apply; explicit destroy deletes its files and history before corrected intent can create a new sandbox.
This qualification does not establish Podman recovery, managed inference, or model responses.

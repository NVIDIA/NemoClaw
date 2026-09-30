<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed Docker Gateways with OpenShell v0.1.2

The managed Docker fix for [issue #12456](https://github.com/NVIDIA/NemoClaw/issues/12456) passed real gateway isolation and bundled OpenTofu lifecycle tests on Linux ARM64 on 2026-09-29.
The tested implementation is `d08e165ce7`; the verified candidate bundle is `0.1.0-dev.1c033ca8b073b603`.
The host used Docker Engine 29.2.1, Rust 1.98.1, OpenTofu 1.12.6, and Docker provider 4.6.0.

## Pinned Images

| Component | Immutable image |
|---|---|
| Gateway | `ghcr.io/nvidia/openshell/gateway@sha256:2fe4dad9118e14ab80a8258b545ea6e6cd74c3469e24ad4e6610f964d98913a2` |
| Supervisor | `ghcr.io/nvidia/openshell/supervisor@sha256:d7b5264bb6bc56f4796e6fa3617b8e4a8d785be0b7293542efd8cc250b0fb67a` |
| Sandbox runtime | `ghcr.io/nvidia/openshell/sandbox@sha256:bf4797b6c511f2d8ba02955dbba4bf76c1f0dd6d83531420c5408d5f1fb9d72f` |
| Test workload | `nc-explore@sha256:a44cda3fe7f32409545ec7abe6de94ebb998348cb62b7a694b0af9de50e00f0d` |

The gateway and runtime images match the OpenShell `6648bd0c290efbc41ba131ee9831ee45cd431f94` source pin.
The workload image contains Pi, but the test ran `/bin/sleep`, shell, and file commands rather than its Fabric adapter.

## Observed Results

The [two-gateway isolation test](../testing/live.md#docker-gateway-isolation) passed in 10.39 seconds using fresh deployment identities, ports, and bridge subnets.
It used production configuration rendering and storage initialization, the pinned gateway image, and the pinned Rust SDK.

| Case | Result |
|---|---|
| Two managed gateways start | Both passed gateway health and each sandbox reached Ready |
| Supervisor callback on nondefault ports | Commands executed through both gateways on ports 60375 and 60823 |
| Second gateway starts | First sandbox kept its ID, Ready phase, and test file |
| Second gateway restarts | First sandbox remained Ready and its test file remained readable |
| Owned teardown | Both test sandboxes and gateway processes were removed; gateway storage, initializers, and bridges remained |

The separate [bundled gateway recovery test](../testing/live.md#docker-gateway-recovery) passed in 53.78 seconds through real OpenTofu and the production provider.
It verified read-only planning, provider-owned gateway readiness, unchanged apply with stable bindings, stopped/deleted process recovery, listen-port replacement, retained credential identity, rejection of a substituted encryption key without state changes, and destroy/reapply.
It removed its gateway process and retained its storage and local deployment state.

Deterministic regressions first failed on the obsolete Docker fields and absent namespace, then passed with `sandbox_label` scoped to each gateway.
The storage regression first failed on the ambiguous diagnostic, then distinguished incompatible retained configuration from a missing file while rejecting both without writes.
The retained fixture's earlier Docker TOML is intentionally used for that incompatibility check.

Workspace validation passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` (915 passed, zero failed, 121 ignored).
The two live tests above were selected separately; ignored tests are not counted as passes.
Documentation validation passed with zero errors and one Fern warning.

## Scope and Recovery

The fix removes Docker's obsolete `network_name` and `host_gateway_ip`, retains the driver's runtime-derived loopback callback, and assigns a stable gateway-specific sandbox namespace.
Podman's generated configuration remains unchanged.
Gateway bridge retention still supports gateway placement and local service publication.

Existing storage containing the old Docker configuration is preserved and refused; follow the [fresh-deployment procedure](../state.md#managed-docker-gateway-configuration).
These tests do not establish automatic migration of that storage or repair the general failed-first-apply deadlock in [issue #12459](https://github.com/NVIDIA/NemoClaw/issues/12459).
They do not qualify imported profiles affected by [issue #12458](https://github.com/NVIDIA/NemoClaw/issues/12458), Fabric readiness, agent replies, managed inference, or Podman on this revision.

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Stable Provider Profile Revisions on Linux ARM64

The fix for [issue #12458](https://github.com/NVIDIA/NemoClaw/issues/12458) passed pinned-gateway and bundled deployment checks on Linux ARM64 on 2026-09-29.
The tested implementation is `2d79d421f8`; the rebuilt bundle is `0.1.0-dev.4b407cdc220d8629`.
The host used Docker Engine 29.2.1, Rust 1.98.1, OpenTofu 1.12.6, and Docker provider 4.6.0.
Gateway, supervisor, sandbox runtime, and Pi workload images used the exact [image pins recorded for the gateway migration](managed-docker-openshell-v012-linux-arm64.md#pinned-images).
OpenShell remains pinned to `6648bd0c290efbc41ba131ee9831ee45cd431f94`; no gateway image was rebuilt or published.

## Observed Results

The wire-round-trip regression failed on the earlier Brave profile because an unchanged profile produced different protobuf bytes.
It passed after ownership, generation, and inference fields were encoded in one canonical JSON annotation.
The regression covers Brave, Tavily, and authenticated and unauthenticated OpenAI and Anthropic profiles.
Observation tests also reject missing, malformed, extra, foreign, and legacy metadata while preserving complete profile-definition checks.

The [provider profile live test](../testing/live.md#provider-profile-revisions) passed in 7.98 seconds against the pinned gateway.
It used a fresh owned gateway, workspace, and sandbox, with synthetic provider credentials and no inference or search requests.

| Case | Result |
|---|---|
| Authenticated OpenAI and Anthropic, unauthenticated OpenAI, Brave, and Tavily attached together | Sandbox reached Ready |
| Repeated environment observations | All 64 reads returned the same provider revision |
| Unchanged profile reconciliation | All five profile identities remained unchanged |
| Gateway restart | Sandbox retained its identity and Ready phase; another 64 reads returned the original revision |
| Owned teardown | Sandbox, providers, profiles, and gateway process were removed; workspace and gateway storage remained |

A separate fresh deployment used the rebuilt bundle's CLI and real OpenTofu with the Pi workload image and declared `gpt-4o-mini` model.
Its external inference endpoint was a reserved example domain; the run checked configuration and lifecycle without requesting a model response.

| Bundled operation | Result |
|---|---|
| Plan | Succeeded without changing the container inventory |
| Apply | Succeeded in 13.54 seconds; Pi reported `fabric_health_unsupported` |
| Unchanged apply | Succeeded with no changes and stable resource IDs |
| Export and reapply | Succeeded with no changes and stable resource IDs |
| Destroy | Reported `destroyed`; removed workloads and retained workspace and gateway storage |

Workspace checks passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` (917 passed, zero failed, 122 ignored).
The live profile test was selected separately; ignored tests are not counted as passes.
Documentation validation passed with zero errors and one Fern warning.

## Limits and Recovery

The canonical annotation is a NemoClaw mitigation for the pinned gateway's unordered protobuf map hashing.
Revisit it when the gateway pin provides canonical profile hashing.
Profiles with the earlier separate annotations are refused without rewriting or adoption; follow the [fresh-deployment boundary](../state.md#imported-provider-profiles).

This qualification does not repair failed-first-apply recovery in [issue #12459](https://github.com/NVIDIA/NemoClaw/issues/12459), qualify search integration export, establish inference or agent replies, or qualify managed inference and Podman.
The direct profile test runs `/bin/sleep`; the separate bundled deployment exercises Pi's Fabric configuration but does not establish positive agent health.

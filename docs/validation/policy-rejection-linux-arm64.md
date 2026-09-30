<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Runtime Policy Rejection on Linux ARM64

The [issue #12464](https://github.com/NVIDIA/NemoClaw/issues/12464) rejection regression passed at implementation commit `0a423e35ce15c34ae9d8141f9373482f8a119ac6`, using bundle `0.1.0-dev.954f5b7677b8f680`.
The bundle was built with Rust 1.98.1 and OpenTofu 1.12.6 on Linux ARM64 on 2026-09-29.
The regression tests below use temporary state and local OpenShell protocol fixtures, without live containers or model requests.
A subsequent manual test exercised the same bundle against real Docker and OpenShell; its separate results follow.

## Reproduction and Observed Behavior

The previous bundle, `0.1.0-dev.652ef254724527fe`, ignored an explicit configuration-admission rejection from the fixture gateway.
The bundled regression failed after 123.17 seconds with `observation query failed`, without the sandbox name or repair reason.
The direct startup regression also failed before implementation because the reported rejection did not stop the wait.

Agent configuration and sandbox completion now check the bound sandbox's admission before issuing runtime commands.
An explicit `Rejected` state stops the wait, including while the sandbox is `Starting`.
The provider preserves four fixed diagnostics from the pinned gateway and replaces unknown text with a fixed repair message.
CLI text and JSON failures name the sandbox and preserve created bindings.
The [policy guide](../sandbox-network.md#recover-from-runtime-policy-rejection) describes recovery and policy-replacement constraints.

The [direct OpenShell regression](../../crates/nemoclaw-e2e/tests/openshell.rs) checks rejection in `Starting` and `Ready`, safe diagnostics, no exec or resource mutation, identity substitution, authentication and transport failures, retained refresh, and teardown.
All 12 direct OpenShell tests passed.
The [bundled lifecycle regression](../../crates/nemoclaw-e2e/tests/deployment.rs) starts from the explicit-policy example and requires each rejected CLI apply to finish within 15 seconds.
It verifies immediate destroy after failed first apply and, separately, recovery after simulated gateway acceptance without replacing the sandbox, followed by export, unchanged apply, and destroy.
The complete two-branch test passed in 18.46 seconds.
The [standalone sandbox completion fixture](../../crates/nemoclaw-e2e/tests/sandbox_readiness.rs) verifies prompt rejection after earlier successful configuration, a safe fallback in retained observations, unchanged bindings, and teardown without readiness.
It passed against the same bundled provider.
See [fixture instructions](../testing/fixtures.md#opentofu-and-bundle-lifecycle) for explicit bundle selection.

Workspace checks passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace --no-fail-fast -- --test-threads=4` (933 passed, zero failed, 131 ignored).
Ignored tests require explicit selection and are not counted as workspace passes.
All 46 explicitly selected bundle fixtures passed: 29 deployment, four export-observation, 12 Fabric, and one multiple-provider test.
The standalone sandbox completion test adds one separately selected pass against the same bundled provider.
Independent documentation review and documentation validation passed with zero errors and one existing Fern warning.

## Manual Docker and OpenShell Test

A manual test on 2026-09-29 (America/Vancouver) used the same verified bundle from source revision `30636f9984e320887e679bc46302bc629535d7af`, Docker Engine 29.2.1, and the [pinned gateway, supervisor, and sandbox runtime images](managed-docker-openshell-v012-linux-arm64.md#pinned-images).
The Nooa workload was `nc-explore@sha256:689b0e29623919cfdcb99be6d0a9ee2bec8170ee8ba73fa7d483b528e91fbd1d`, with the `nvidia.nooa.coding-agent` workflow.
The run used a fresh deployment UUID, unused loopback port and subnet, new state directory, and immutable bundle copy whose manifest checksums were verified.
Its external inference endpoint was a reserved example domain; no inference or agent requests were sent.

The rejected policy reproduced the reported REST, MCP, and raw TCP rules, numeric UID/GID 1000, missing curl/psql paths, and Landlock `hard_requirement` on the same Nooa image.
The supervisor reported runtime configuration failure, and the gateway logged repeated failed policy-load reports.
The CLI returned `sandbox/nooa: OpenShell configuration rejected: Effective configuration could not be activated; replace the policy or repair attached providers; resources retained`.

| Operation | Observed result |
|---|---|
| Initial plan | Passed in 2.57 seconds with the managed gateway deferred; container inventory unchanged |
| First apply with rejected policy | Failed in 17.08 seconds including gateway startup; sandbox, provider, profile, workspace, and gateway bindings retained |
| Apply a changed policy before destroy | Refused in 0.32 seconds; intent and both resource state files unchanged |
| Destroy preview after rejection | Passed in 2.32 seconds; intent and both resource state files unchanged |
| Direct destroy after failed first apply | Passed in 4.28 seconds; removed owned sandbox, registrations, and gateway process |
| Recreate with a simpler policy | Passed in 15.15 seconds using retained gateway storage |
| Unchanged apply | Passed in 6.37 seconds with no changes and identical resource IDs |
| Export and reapply | Export passed in 2.47 seconds; reapply passed in 6.53 seconds with no changes and identical resource IDs |
| Final destroy | Passed in 4.26 seconds; retained only workspace and gateway-storage bindings |

The simpler policy removed the three egress rule groups, used Landlock `best_effort`, and added writable `/home/node`.
Those changes were tested together and do not isolate which rule caused the original rejection.
Successful applies reported `fabric_health_unsupported`; they do not establish positive agent health.
After the lifecycle checks, the test's stopped initializer, gateway volume, and bridge were removed following UID-label checks; pre-existing container IDs remained present.
Local input documents, command output, timings, and historical state were retained; that state cannot be reused after storage cleanup.

## Qualification Limits

The fixtures qualify protocol handling, while the manual run qualifies startup rejection, explicit teardown, and recreation on the named Linux ARM64 host and immutable images.
Neither identifies the exact policy rule that caused the original live report or qualifies kernel enforcement, arbitrary image contents, native agent responses, or other platforms.
A pending or absent admission report still follows the ordinary startup wait.
A rejected policy update represented by a previously accepted admission carrying an error is outside this startup-rejection check.
The image catalog records adapter requirements and runtime files, not a complete filesystem or executable inventory; arbitrary executable paths and process identities are not newly validated by this change.
Existing explicit filesystem-grant checks remain in effect.

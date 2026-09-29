<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw Configuration Updates on Linux ARM64

The fix for [issue #12460](https://github.com/NVIDIA/NemoClaw/issues/12460) passed an owned managed Docker lifecycle on Linux ARM64 on 2026-09-29.
The implementation is `832976a936`; the verified bundle is `0.1.0-dev.cca4191d33fb0e85`.
The DGX Spark host used Docker Engine 29.2.1, Rust 1.98.1, OpenTofu 1.12.6, and Docker provider 4.6.0.

## Pinned Image and Scope

The locally built OpenClaw image was `nc-12460-47c4@sha256:ff843ee823e406998d80b072b3d9db7e91be01953891610eecde5335d7a9f313`.
It retains Fabric revision `24f068c895e5cbc30286bc743498be4e5014d658` and the [documented adapter patch](../../image/fabric/OPENCLAW-NOTICE.md).
Gateway, supervisor, and sandbox runtime used the [OpenShell v0.1.2 migration pins](managed-docker-openshell-v012-linux-arm64.md#pinned-images).
The bundle alone cannot update an adapter already installed in a sandbox; follow the [image and update prerequisites](../usage.md#choose-the-change-path).

The final run used a fresh deployment UUID, unused loopback port and private subnet, dedicated state directory, and one OpenClaw sandbox named `assistant`.
Inference selected a reserved example-domain endpoint.
No inference or agent invocation requests were sent.
Native startup used OpenClaw's local health RPC; NemoClaw's Fabric health result remained `fabric_health_unsupported`.

## Observed Lifecycle

| Operation | Result |
|---|---|
| Initial apply | Succeeded in 16.55 seconds with model `stub-a` |
| Model-only plan | Planned one agent-configuration update; the running runtime ID stayed unchanged |
| Model-only apply | Changed native model to `stub-b` in 11.28 seconds and restarted the runtime inside the same sandbox |
| Native model and tool settings | Applied `maxTokens: 2048` and the `read` tool allowlist in 11.36 seconds; native settings matched |
| Export and unchanged reapply | Succeeded; the exported plan had no resource changes and reapply preserved the runtime ID |
| Failed restart | A deliberately missing OpenClaw CLI path failed in 6.10 seconds with `fabric_start_failed` and runtime state `unavailable` |
| Explicit corrected retry | Started the runtime in 9.96 seconds without replacing the sandbox |
| Revert and export | Restored the original model and settings in 11.15 seconds; export succeeded |
| Destroy preview and destroy | Succeeded; destroy removed the sandbox and managed gateway workload in 5.72 seconds |

Workspace and native-directory sentinel files survived model edits, settings changes, failed restart, retry, and revert.
The same sandbox container remained throughout those checks.
The failure diagnostic omitted the native CLI path and exception text.
The unchanged plan still deferred inference catalog verification because the selected endpoint was unreachable; an empty changes list did not mean a complete plan.

Destroy retained the workspace and gateway-storage bindings, initialized data, signing and encryption keys, bridge, stopped initializer, local state, and images.
No owned test workloads remained running.
No packages or images were published, and unrelated workloads were preserved.

## Regression Coverage

The [native regression](../../image/test_openclaw_reconfiguration.py) first reproduced the retained-configuration conflict against the previous OpenClaw image.
A managed test then exposed OpenShell's deliberate rejection of process-group signals; a separate native subprocess regression reproduced that shutdown failure before the signal fallback was implemented.
Both native regressions passed against the final image in 19.91 seconds with networking disabled.
They cover model and settings updates, unchanged runtime identity, failed-start reporting, explicit retry, restart of the Fabric host, retained files, and shutdown when group signals are denied.

The [ownership tests](../../image/fabric/test_openclaw_configuration.py) cover unrelated bookkeeping, obsolete owned sections, conflicting direct edits, unowned-section collisions, malformed ownership records, symlinks, and recovery after an interrupted ownership-record write.
The [bridge tests](../../image/fabric/test_runtime_contract.py) and provider tests verify the bounded failure fields and omission of native exception details.
The bundled failure fixture first reported only `observation query failed`; it now preserves the safe failure code and runtime state through OpenTofu, then recovers without sandbox replacement.

All 39 explicitly selected deployment and [Fabric lifecycle fixtures](../../crates/nemoclaw-e2e/tests/fabric_deployment.rs) passed against the verified bundle, including model edits for all ten harnesses.
Workspace checks passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` (921 passed, zero failed, 125 ignored).
Ignored tests were selected separately and are not counted as workspace passes.
[Image checks](../../.github/workflows/images.yml) passed: Ruff, seven build-selection tests, Dockerfile checks, 23 packaging tests, and six installed-image checks; two checks for other harness images were skipped.
The installed-image checks verified discovery, dependency versions, source hashes, and provenance.
Documentation validation passed with zero errors and one Fern warning.

## Qualification Limits

These results qualify configuration and process lifecycle on the named Linux ARM64 Docker host and image.
They do not establish model responses, conversation continuation, Podman behavior, or AMD64 runtime compatibility.
The other nine harnesses' model-update coverage uses deterministic SDK/provider fixtures, not fresh native deployments.
A native restart failure may leave the runtime unavailable; the fix reports that state and supports explicit retry, without promising rollback to the old process.
Conflicting edits to adapter-owned native sections still require correction before startup.

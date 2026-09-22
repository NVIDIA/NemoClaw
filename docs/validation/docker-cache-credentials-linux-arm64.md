<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Docker Cache and Credential Resource Qualification

On 2026-09-20 UTC, the standalone resource fixture passed on Linux ARM64 with Docker 29.2.1, OpenTofu 1.12.6, and Docker provider 4.6.0.
The source revision was `64de6b1b001d2e5dc5723c432c87cbbcede6dfd0`, with verified bundle `0.1.0-dev.5a1cb2b0baff58c7` and deployment intent version 7.
Use a fresh deployment UID and state directory; older intent is rejected without mutation and requires its original bundle for recovery or teardown.

## Independent Resource Composition

The [hand-written HCL](../../crates/nemoclaw-e2e/tests/fixtures/cache_provider.tf) uses a native Docker local-image lookup, volume and container resources alongside a NemoClaw retained credential-storage resource.
The [runner](../../crates/nemoclaw-e2e/tests/fixtures/cache_provider.py) invokes OpenTofu directly, without SDK compilation, deployment planning, or lifecycle coordination.
A Python process writes simulated model bytes and a generated fixture credential; it performs no inference.

The run passed in 46.34 seconds:

- Create and unchanged plan.
- Container replacement with the same credential.
- Failed container start followed by explicit recovery.
- Teardown through a zero container count, retaining both declared volumes, followed by reapply.
- Deleted cache and container followed by reconstruction with the same credential hash.
- Missing credential volume rejecting apply before compute creation, with unchanged provider state.
- A same-named credential-volume replacement with matching ownership labels also rejecting apply and preserving state.

The fixture image was `nc-fabric@sha256:f3b2b22d01fe9baf7946266f437773bdf1e5871cc8b0b6d17ce60d740882148e`.
Resources used fresh deployment names and were removed only after checking the fixture's owner label.
The image remained available; no package or image was published.

## Responsibility Boundary

Docker owns cache creation, observation, and recovery through its volume resource.
Caches survive SDK destroy by policy; the teardown graph retains their declarations and `prevent_destroy` guards.
The SDK no longer requires immutable cache creation-time or daemon identity, or a durable cache binding before replacing compute.
The NemoClaw credential resource still rejects missing or substituted bound durable storage during provider planning.

The distinction does not eliminate deployment policy: OpenTofu cannot enforce `prevent_destroy` after its resource declaration is removed.
The SDK retains desired intent, state locking, stage coordination, retention decisions, and application-readiness consumption.
The hosted runtime still owns model preparation, hardware checks, memory protection, and application health.

## Other Validation and Limits

The production vLLM and Ollama graphs also passed the real-Docker CPU fixture in 70.74 seconds against the same final bundle.
That fixture keeps installer commands and dependencies while adapting host placement and GPU-sized limits; it checks container replacement, network recovery, and retained model-data sentinels.
Its status-writing images were `nc-provider-runtime-exp-9ad3b2dd651f@sha256:a83e18979448440d337d7849ae2cefa17cb174edd44e05f506d066ec95188392` (Ollama) and `nc-provider-runtime-exp-9ad3b2dd651f@sha256:486b434dd1bf3a7f547b7ad2db7a6e67da158108b66591f7f8fd4ab2ced60768` (vLLM).
Only fixture resources and those temporary image tags were removed afterward.

Workspace tests, formatting, Clippy with warnings denied, and all 47 bundled protocol/lifecycle cases passed locally.
The remote-service simulator additionally checks cache reconstruction with unchanged credentials and missing, foreign, or substituted credential rejection through SDK apply.
Its model status is simulated.

This record does not qualify GPU execution, actual model preparation or inference, cross-host migration, Podman changes, credential-content tampering within an unchanged volume, or a complete standalone OpenShell deployment.
See [fixture instructions](../testing/fixtures.md#standalone-cache-and-credential-resources) and [state transition requirements](../state.md#provider-managed-service-compute).

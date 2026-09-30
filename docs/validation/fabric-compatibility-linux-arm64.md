<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric Compatibility Diagnostics on Linux ARM64

The [issue #12461](https://github.com/NVIDIA/NemoClaw/issues/12461) regression checks that a rejected configuration names its sandbox, adapter, canonical field, and affected model route.
The shared assessment preserves Fabric's typed field path with a fixed explanation, without copying raw schema errors or rejected values.
The [provider reference](../provider.md#engine-and-fabric-discovery) describes the diagnostic contract and limits.

## Regression Results

Before implementation, two [SDK regressions](../../crates/nemoclaw-sdk/tests/fabric_planner.rs) failed because both a rejected Pi token limit and an invalid adapter setting produced only the generic `fabric_plan` reason.
The corrected tests require the specific field, the authored `fast` route, and the `overrides.maxTokens` hint for the token-limit case, and verify that an invalid secret-bearing setting is not echoed.
The existing `fabric_plan` identifier is preserved for report consumers.
The [OpenTofu discovery regression](../../crates/nemoclaw-e2e/tests/discovery.rs) also failed against the previous bundle because its postcondition omitted the sandbox and adapter.

The final bundle is `0.1.0-dev.f1733ba3caf677d1`, built with Rust 1.98.1 and OpenTofu 1.12.6 on 2026-09-29 (America/Vancouver).
All three explicitly selected OpenTofu discovery fixtures passed against that bundle in 1.74 seconds.
The implementation is commit `105c25d8270fd7fc205871322d00a262d0b99385`.
Workspace checks passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace --no-fail-fast -- --test-threads=4` (941 passed, zero failed, 132 ignored).
Ignored tests require explicit selection and are not counted as workspace passes.
Independent documentation review found no consequential issues; documentation validation passed with zero errors and one existing Fern warning.

## Manual Pi Reproduction

The manual test uses a checksum-verified Linux ARM64 bundle, Docker Engine 29.2.1, and the existing Pi image `nc-explore@sha256:a44cda3fe7f32409545ec7abe6de94ebb998348cb62b7a694b0af9de50e00f0d`.
A fresh deployment UUID, unused loopback endpoint, and separate state directories isolate each command.
The `coder` sandbox selects `nvidia.fabric.pi` and a `fast` route with `overrides.maxTokens: 256`.
The external inference endpoint is a reserved example domain; no model requests are sent.

Plan and apply must reject the token limit in both text and JSON output, naming `sandbox/coder`, `nvidia.fabric.pi`, `models.default.max_tokens`, `overrides.maxTokens`, and `fast`.
Fabric's `default` role is the SDK's alias for the selected route; it does not require an authored route called `default`.
Removing the token limit must make planning pass.
The final bundle passed every check below, and container inventory remained unchanged after each command.

| Operation | Observed result |
|---|---|
| Plan, JSON | Rejected in 2.56 seconds with the specific diagnostic |
| Plan, text | Rejected in 2.22 seconds with the same diagnostic |
| Apply, JSON | Rejected during planning in 2.34 seconds |
| Apply, text | Rejected during planning in 2.33 seconds |
| Plan after removing `maxTokens` | Passed in 2.58 seconds |

No containers were created and no inference or agent requests were sent.
Local input documents, command output, timings, and planning state were retained.

## Qualification Limits

This check qualifies rejection diagnostics for observed image metadata and the matching pinned Fabric contract.
It does not start a Pi runtime or establish native model catalog support, inference, agent health, or support on other platforms.
It reports the canonical planner's first rejection; it does not enumerate every invalid field or execute adapters to discover additional runtime constraints.
Unknown error variants retain a generic safe rejection, and unsupported or missing metadata retains the existing supported/unsupported/unknown classification.

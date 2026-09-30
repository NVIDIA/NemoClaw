<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sandbox Startup Diagnostics on Linux ARM64

The [issue #12463](https://github.com/NVIDIA/NemoClaw/issues/12463) qualification covers OpenShell startup reason codes, named sandbox errors, fixed explanations, and teardown after failed first apply.
The implementation is commit `8f7bc12446ed3f8a2242ed4a62d6957c057464a7`, qualified with bundle `0.1.0-dev.662bedd02573bfe1`.
Tests ran on Linux ARM64 on 2026-09-29 (America/Vancouver), with Rust 1.98.1 and OpenTofu 1.12.6.

## Reproduced Failure

At revision `e93f8a5b576631438b936d91261bb6e324df1bf6`, bundle `0.1.0-dev.e9a71dfbc8d62887` already reported `IdentityResolutionFailed` for a policy selecting the nonexistent workload user `sandbox` in the pinned Nooa image.
The live apply failed in 14.12 seconds and retained the deployment resources.
It omitted the sandbox name and an explanation of the reason.
This run did not reproduce the earlier `reason unknown` result; the known reason codes were already preserved by the failed-first-apply recovery work.

A focused provider regression and an explicitly selected bundled CLI regression failed before implementation on the missing sandbox context.
A live retry exposed a second missing-name boundary during resource refresh, which an expanded CLI regression also reproduced.
The fix adds `sandbox/<name>` to startup creation and refresh failures and shares fixed explanations between SDK errors and observations.
It does not expose raw condition messages or broaden the accepted backend reason vocabulary.

## Fixture Results

The [provider tests](../../crates/nemoclaw-provider/src/openshell/probes.rs) cover both `IdentityResolutionFailed` and `ControlSupervisorStartFailed`, shared error formatting, private-message exclusion, unknown conditions, terminal phases, and readiness deadlines.
The [CLI test](../../crates/nemoclaw-e2e/tests/deployment.rs) checks text and JSON failures during creation and subsequent read-only planning, retained state, and direct destroy while the startup failure remains configured.
It passed against the final bundle in 10.22 seconds.
Workspace checks passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace --no-fail-fast -- --test-threads=4` (943 passed, zero failed, 134 ignored).
Ignored tests require explicit selection and are not counted as workspace passes.

## Live Docker and OpenShell Results

The manual run used the [pinned OpenShell v0.1.2 images](managed-docker-openshell-v012-linux-arm64.md#pinned-images) and Nooa image `nc-explore@sha256:689b0e29623919cfdcb99be6d0a9ee2bec8170ee8ba73fa7d483b528e91fbd1d`.
It used a fresh deployment UID, state directory, available loopback port and subnet, and an immutable checksum-verified bundle copy.
The inference endpoint was a reserved example domain; no inference or agent requests were sent.
With the final bundle, a read-only plan against the retained failed deployment reported `sandbox/missing-user`, `IdentityResolutionFailed`, and the user/group policy guidance in 4.38 seconds.
Destroy preview passed in 2.77 seconds, and direct destroy passed in 3.87 seconds without a successful reapply.
The test then removed its stopped initializer, retained gateway volume, and empty bridge after checking their deployment UID labels.
All 111 pre-existing container IDs remained present.
Local documents, outputs, and historical state were retained; that state cannot be reused after storage cleanup.

## Qualification Limits

The live test covers the missing-user failure on this image and Docker host.
Supervisor startup failure is qualified through protocol fixtures; no unstable provider configuration was recreated live.
Unknown reasons and unavailable exit codes remain explicitly unknown, and backend messages stay private.
The fixed explanations identify the relevant checks without asserting the exact underlying gateway error.

Image metadata does not expose a workload user/group inventory, so planning still does not prove that a named user exists in the pinned image.
Changing an existing sandbox's image or policy remains subject to the [replacement constraints](../usage.md#choose-the-change-path).
This run does not qualify Podman, agent replies, or arbitrary startup failures.

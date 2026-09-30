<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric Runtime Failure Diagnostics on Linux ARM64

The [issue #12465](https://github.com/NVIDIA/NemoClaw/issues/12465) regression verifies named sandbox failures and structured Fabric runtime codes through the native binding, Python SDK, deployment bridge, provider, and CLI.
The final provider bundle is `0.1.0-dev.e9a71dfbc8d62887`, built with Rust 1.98.1 and OpenTofu 1.12.6 on 2026-09-29 (America/Vancouver).
Implementation revision: `422f49861bf236010a3c1c9973b4987086cffe01`.
The [source notice](../../image/fabric/FABRIC-ERROR-NOTICE.md) records the exact Fabric revision, modified files, and retained patch.

## Reproduced Failures

Before implementation, the bridge replaced `pi_model_unknown` with `fabric_start_failed`, and the provider replaced it with `fabric_configuration_failed`.
Resource diagnostics also omitted the sandbox name.
Both focused regressions failed before those changes.

Testing the actual call path exposed two earlier losses in the pinned Fabric dependency.
A native Rust regression failed because its Python exception had no `code` attribute, and a public-SDK regression failed because the Python wrapper discarded that attribute.
An actual fixture-adapter process emitting `pi_model_unknown` also reached the bridge only as `fabric_start_failed`.
The packaged patch preserves the typed lifecycle code through both boundaries without parsing exception text.

## Observed Results

The private patched wheel was built from Fabric revision `24f068c895e5cbc30286bc743498be4e5014d658` with the checked-in patch, then installed with the source lockfile's dependencies in an isolated Python 3.11 environment.
Applying the patch with zero fuzz to the original revision reproduced all three tested source files exactly.
Native binding tests passed (two tests), and strict Clippy passed for the modified native crate and its targets.
All 26 image runtime, catalog, wheel-lock, and OpenClaw configuration contracts passed against that wheel.
They include an actual owner-fixture process emitting both a Pi-style typed failure and an ordinary startup exception; each reaches the bridge with its code and without private messages or details.
All seven image build-selection tests passed.

Workspace checks passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace --no-fail-fast -- --test-threads=4` (942 passed, zero failed, 133 ignored).
Ignored tests require explicit selection and are not counted as workspace passes.
All three explicitly selected fixtures passed against the final bundle: Pi startup text/JSON and direct teardown (8.00 seconds), credential redaction and recovery (25.50 seconds), and failed configuration recovery (10.73 seconds).

The [CLI fixtures](../../crates/nemoclaw-e2e/tests/deployment.rs) require `sandbox/coder`, `start`, `pi_model_unknown`, runtime availability, and retained-resource guidance in text and JSON after failed first apply.
They verify direct destroy while the failure remains configured, named reapply errors, and credential redaction for both short and diagnostic-colliding values.
The [Fabric lifecycle fixture](../../crates/nemoclaw-e2e/tests/fabric_deployment.rs) verifies correction, export, and teardown without replacing the sandbox or registrations.

## Qualification Limits

The tests use owned temporary processes and protocol fixtures; they send no real model requests and create no live deployment containers.
The actual adapter-process failure uses Fabric's installed fixture with controlled startup errors, not a Pi model-catalog lookup or a native OpenClaw process.
The modified Fabric wheel was built and tested locally; complete agent images were not rebuilt or published for this qualification.
The richer runtime codes require an image rebuilt with both the updated bridge and patched Fabric wheel, plus the matching provider bundle.
Older image bridges can still replace the code with a generic failure.

The patch does not add plan-time native model-catalog discovery.
Pi can still accept descriptor planning and reject a missing native model during startup; use the [Pi metadata example](../../examples/fabric-pi.yaml) when its catalog does not contain the selected model.
Unknown codes, raw exception messages, and arbitrary detail fields remain excluded from deployment diagnostics.

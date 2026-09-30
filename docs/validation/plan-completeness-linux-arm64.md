<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Resource Plan Completeness on Linux ARM64

The [issue #12471](https://github.com/NVIDIA/NemoClaw/issues/12471) regressions passed at implementation commit `a137d6fa2399579e61b10b398c702e71b611fb34`.
Complete resource plans now report supplemental catalog discovery and apply-time service readiness separately as unverified checks.
The tested bundle is `0.1.0-dev.cc80d185c3f5fdd9`, built with Rust 1.98.1 and OpenTofu 1.12.6 on Linux ARM64 on 2026-09-29.
Tests use temporary state, local HTTP/OpenShell fixtures, and an isolated SSH/Docker simulator.
They create no live containers or model services and send no model or agent requests.

## Reproduction and Observed Behavior

Against the previous bundle, `0.1.0-dev.0911a3f5927ef9ea`, an unchanged managed vLLM deployment and an Anthropic endpoint without a model catalog both returned `complete: false` with no resource changes.
The SDK classification and CLI rendering regressions also failed before the fix.
The fix retains mandatory planning prerequisites in `deferred` and reports supplemental checks separately in `unverified`; see the [CLI result contract](../reference/cli.md#output-and-failure).

The [catalog fixture](../../crates/nemoclaw-e2e/tests/inference_discovery.rs) passed for Anthropic and OpenAI-compatible endpoints returning HTTP 404, HTTP 401, or a response without the catalog shape.
SDK and CLI resource plans had no changes or deferrals; CLI JSON reported `complete: true` and retained unknown/unavailable catalog and authentication observations with `api_verified: false`.
A subsequent valid catalog cleared the advisory without claiming verified inference.
Plan preserved resource state, intent, and fixture mutation counts.
Required provider-refresh failure still rejected planning without losing state.
The recorded HTTP requests were model-list GETs only.

The [managed-service fixtures](../../crates/nemoclaw-e2e/tests/remote_service.rs) passed, including readiness failure injected after export and unchanged reapply.
Plan remained complete with readiness unverified and no resource mutations or host-capacity collection; apply failed its readiness gate and recovered after an explicit corrected retry.
The shared report logic also preserves unknown or false service-readiness values; it does not turn them into successful readiness observations.

Focused checks passed: 56 SDK deployment tests and 19 CLI formatting tests.
Workspace checks passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` (930 passed, zero failed, 128 ignored).
Ignored tests require explicit selection and are not counted as workspace passes.
All 54 explicitly selected fixture tests passed: 28 deployment, four export-observation, 12 Fabric, one multiple-provider, seven managed-service, and two catalog tests.
Documentation validation passed with zero errors and one existing Fern warning.

## Qualification Limits

These tests qualify resource-plan reporting and retained lifecycle behavior through real OpenTofu and the production provider with simulated services.
They do not qualify live GPU capacity, model loading, upstream credentials, native agent responses, Docker/Podman compatibility, or other platforms.
The managed-service lifecycle cases select vLLM and Ollama; no live Ollama-proxy deployment was rerun.
A complete plan does not promise successful apply or healthy services; review `unverified` and the typed observations, then use [unchanged reapply](../usage.md#verify-an-unchanged-reapply) and separate inference verification.

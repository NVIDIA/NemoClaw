<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Web Search Export on Linux ARM64

The fix for [issue #12466](https://github.com/NVIDIA/NemoClaw/issues/12466) passed SDK and bundled CLI export fixtures for Brave and Tavily on Linux ARM64.
The implementation is `ab590ca3b9`.
The test bundle is `0.1.0-dev.0911a3f5927ef9ea`, built with Rust 1.98.1 and OpenTofu 1.12.6 on 2026-09-29.
Tests use isolated OpenShell gRPC fixtures and temporary state directories.
They start no Docker workloads or inference services and send no live search or agent requests.

## Reproduction and Coverage

The [SDK regression](../../crates/nemoclaw-sdk/src/deployment/export.rs) first failed with `observed provider is not selected` for an unchanged Tavily registration.
The [CLI lifecycle case](../../crates/nemoclaw-e2e/tests/deployment.rs) reproduced the same failure against the previous bundle, `0.1.0-dev.cd6226d7d290f34a`.
Brave already had a separate export path; the fix classifies search registrations through the shared supported-provider type.

All seven focused SDK export tests passed after the fix.
The search regression covers both providers at deployment, sandbox, and agent scope, preserving the document while rejecting changed or missing provider type, endpoint, credential reference, name, workspace, owner, or generation.
The existing inference-provider export tests also passed.

The [mixed-search fixture](../../crates/nemoclaw-e2e/tests/export_observations.rs) declares OpenClaw with deployment-level Tavily, Hermes with sandbox-level Brave, and Pi with inline Brave using the same credential reference as Hermes.
It retains an unused integration definition and expects two search registrations plus the inference registration.
It passed SDK and CLI export without resolving search credentials, preserved authored scopes and references, rejected registration drift without saved-state changes, completed unchanged reapply, and tore down without search keys.
Both search providers and all three sandbox identities remained unchanged through reapply.

All 45 explicitly selected deployment, export-observation, [Fabric lifecycle](../../crates/nemoclaw-e2e/tests/fabric_deployment.rs), and [multiple-provider fixtures](../../crates/nemoclaw-e2e/tests/multiple_providers.rs) passed against the final bundle.
Workspace checks passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` (928 passed, zero failed, 127 ignored).
Ignored tests require explicit selection and are not counted as workspace passes.
Documentation validation passed with zero errors and one Fern warning.

## Qualification Limits

These fixtures exercise real OpenTofu and the production provider with simulated gateway and Fabric responses.
They do not qualify native search execution, upstream Brave or Tavily authentication, model or agent responses, or Docker/Podman runtime behavior.
The results apply to the named Linux ARM64 bundle; other platforms were not rerun.
Follow [unchanged reapply](../usage.md#verify-an-unchanged-reapply) with the deployment's matching bundle and state.

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Runtime Image Compatibility on Linux ARM64

The [issue #12473](https://github.com/NVIDIA/NemoClaw/issues/12473) compatibility and image-only cleanup regressions passed at implementation commit `bf3007a7ffa4f1b1e8a9adf2cb9ca8152e204268`, using bundle `0.1.0-dev.652ef254724527fe`.
The bundle was built with Rust 1.98.1 and OpenTofu 1.12.6 on Linux ARM64 on 2026-09-29.
Tests use temporary state, local OpenShell fixtures, and an isolated SSH/Docker simulator.
They create no live containers or model services and send no model or agent requests.

## Reproduction and Observed Behavior

The previous bundle, `0.1.0-dev.cc80d185c3f5fdd9`, accepted an already loaded runtime image without a compatible runtime-spec label during plan.
The runtime diagnostic and builder-label regressions also failed before implementation.
The shared runtime contract now supplies the image label, builder metadata, compiled service requirement, and provider compatibility check; see [runtime image compatibility](../provider.md#runtime-image-compatibility).

The [service fixtures](../../crates/nemoclaw-e2e/tests/remote_service.rs) reject missing, stale, and untrusted runtime-spec label values during plan and apply without exposing those values or mutating resources.
For a missing image, plan reports compatibility as deferred.
The vLLM and Ollama pull-rejection cases verify that apply acquires the image, rejects its incompatible contract, and creates no model-cache volume, credential volume, network, container, or OpenShell resource.
Destroy removes the recorded image binding without requiring compatibility or deleting the locally retained image.
These cases also exposed an empty teardown resource block rejected by OpenTofu; the corrected compiler omits that block when no storage was established.
The established-service cases preserve intent and provider state when compatibility later fails, then destroy the bound workloads without requiring a compatible image.

Provider tests verify read-only inspection, required labels, platform and image identity, and rejection of authentication, transport, and incomplete observations.
Runtime tests verify declared field locations and the expected version without echoing configuration values or user-defined map keys.
Builder fixtures verify the version label passed to the image build and reject loaded images that lack the required version.
The SDK-free builder checks passed with 19 tests and two ignored tests, including dependency-closure checks.
No real OCI image was built for this qualification.

Workspace checks passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace -- --test-threads=4` (932 passed, zero failed, 130 ignored).
Ignored tests require explicit selection and are not counted as workspace passes.
All 54 explicitly selected fixture tests passed against the same bundle: nine managed-service, 28 deployment, four export-observation, 12 Fabric, and one multiple-provider test.
Documentation validation passed with zero errors and one existing Fern warning.

## Qualification Limits

These checks qualify compatibility enforcement and failure recovery through real OpenTofu and the production provider with simulated engine responses.
They do not qualify live image loading, GPU capacity, model preparation, inference, native agent responses, or other platforms.
The runtime-spec label declares a contract version rather than an exact source revision; developers must bump it for incompatible serialized or validation changes.
Operators must [rebuild the matching runtime artifact and update its digest](../build.md#retained-sources-and-compatibility) after a mismatch.
A compatible label does not establish model readiness or successful inference.

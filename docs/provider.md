<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Understand the OpenTofu Provider

The native bundle includes the production NemoClaw OpenTofu provider.
The SDK compiles desired-state YAML into a resource graph and runs bundled OpenTofu, which invokes the provider's backend operations.
Use [the SDK](sdk.md) or [CLI](reference/cli.md) for the documented deployment workflow.

## Resource and State Ownership

OpenTofu owns graph execution and resource state.
The SDK retains desired intent, validates plans, coordinates runtime stages, and checks ownership and durable identity.
The provider adapts resource operations to shared backend contracts.

The [provider implementation](../crates/nemoclaw-provider/src/provider.rs) currently defines these resource groups:

| Group | Resource kinds |
|---|---|
| OpenShell deployment | `workspace`, `provider`, `provider_profile`, `route`, `sandbox` |
| Managed gateway | `managed_gateway`, `gateway_storage` |
| Managed vLLM | `inference_service`, `inference_storage` |
| Managed Ollama | `ollama_service`, `ollama_service_storage` |
| External Ollama with managed proxy | `ollama_proxy`, `ollama_proxy_storage`, `ollama_external_model` |

The existence of these resources does not establish a supported standalone HCL workflow.
Do not edit SDK-generated graphs or share a deployment state directory between independently managed workflows.

## Packaging and Qualification

Follow [bundle building](build.md) for matched CLI, SDK contract, provider, schema, and OpenTofu versions.
The bundle uses a source-derived provider version to prevent stale provider reuse.

[Schema tests](../crates/nemoclaw-provider/tests/schema.rs), [planning tests](../crates/nemoclaw-provider/tests/planning.rs), and [refresh tests](../crates/nemoclaw-provider/tests/refresh.rs) cover provider contracts.
[Fixture qualification](testing/fixtures.md) covers real OpenTofu protocol/lifecycle execution with explicit bundle inputs.

## Direct OpenTofu Usage

Public provider distribution and installation instructions: **TBD**.
Supported user-authored HCL examples and their lifecycle/retention contract: **TBD**.
Import, adoption, remote-state backends, and compatibility across provider releases: **TBD**.

These sections need verified implementations and test results before they can recommend a direct-use workflow.

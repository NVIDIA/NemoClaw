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

## Gateway Capabilities

The SDK's deployment graph reads `data.nemoclaw_gateway_capabilities.current` through the provider's configured OpenShell connection.
The data source takes the required compute drivers and reports the observed gateway version, driver names and aliases, and whether they satisfy the SDK's compatibility contract.
Compatibility requires the pinned OpenShell version and exactly one initialized driver that matches every required driver name.
Missing metadata, authentication failures, and transport failures stop the observation.
The read is bounded to 30 seconds and does not modify the gateway.

Every deployment resource has a blocking precondition on the compatibility result.
The earlier runtime graph omits this data source so managed gateway creation can finish before the deployment graph queries it.
Unknown data-source inputs defer the read until their dependencies resolve.

OpenTofu can retain known data-source results in a saved plan.
The SDK therefore checks gateway compatibility again immediately before applying deployment changes, while retaining its existing preflight check.
Observed data never becomes a durable resource binding, and teardown omits the capability gate so a version or driver mismatch alone does not prevent cleanup.

[Gateway protocol tests](../crates/nemoclaw-e2e/tests/opentofu_openshell.rs) cover incompatible and incomplete observations, unchanged state after failures, and deferred reads.
[Deployment fixtures](../crates/nemoclaw-e2e/tests/deployment.rs) cover a gateway change between plan and apply and subsequent recovery and teardown.

## Hardware Validation

The provider validates known managed resource specifications through the SDK during OpenTofu configuration validation, without contacting an execution host.
Invalid hardware profiles, architecture selections, and memory settings produce errors attached to the resource's `spec` attribute.
The specification remains serialized; diagnostics identify the failed hardware requirement within it.

During planning, managed vLLM and Ollama resources use the SDK's collectors to check hardware compatibility and total-memory budgets on their selected execution host.
An incompatible host or failed observation stops planning without changing resources or replacing retained bindings.
Unknown configuration values defer dependent checks until OpenTofu resolves them.
Numeric profile and dedicated-hardware requirement mismatches report required and observed values; raw host output and credentials are omitted.

Saved-plan application repeats provider planning, and the runtime backend also checks capacity before creating or starting a stopped service.
The SDK's deployment preflight and pre-start checks enforce available-memory and disk requirements; provider planning permits replacements while the old process still holds its memory.
Available memory can change after a plan; the resident memory guard remains active after startup.
The SDK retains combined-budget checks for services sharing an engine, and destroy planning does not require available GPU capacity.

[Provider validation tests](../crates/nemoclaw-provider/tests/validation.rs), [host observation fixtures](../crates/nemoclaw-sdk/src/managed/planning_tests.rs), and [OpenTofu protocol tests](../crates/nemoclaw-e2e/tests/provider_protocol.rs) cover these boundaries without live GPU resources.

## Network and Image Validation

During planning, managed gateway, vLLM, and Ollama resources check existing network ownership and configuration through the SDK.
Resources that create a network also check for overlapping subnets when that network is absent.
A service's absent shared gateway network is deferred because a dependency can create it during the same apply; the runtime backend still requires it before creating the service.

Planning inspects locally available runtime images for Linux OS, architecture compatibility, and required service labels without pulling images.
A missing image stops planning when the effective `imagePullPolicy` is `Never`; `IfNotPresent` and `Always` allow acquisition during apply.
An incompatible local image or failed network or image observation stops planning.
These checks use the selected execution engine and repeat during saved-plan application; image acquisition and network creation retain their own checks immediately before use.

[SDK planning fixtures](../crates/nemoclaw-sdk/src/managed/planning_tests.rs) cover gateway and local and remote service checks.
The [production provider protocol fixture](../crates/nemoclaw-e2e/tests/provider_protocol.rs) verifies that changed gateway prerequisites stop saved-plan application without engine mutations.
See [integration-test instructions](testing/fixtures.md#opentofu-and-bundle-lifecycle) for prerequisites and commands.

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

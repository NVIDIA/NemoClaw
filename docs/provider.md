<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Understand the OpenTofu Provider

The native bundle includes the NemoClaw and Docker OpenTofu providers.
The SDK compiles desired-state YAML into resource graphs and runs bundled OpenTofu.
Docker manages disposable service compute; NemoClaw manages OpenShell operations, gateway infrastructure, and retained data bindings.
Use [the SDK](sdk.md) or [CLI](reference/cli.md) for the documented deployment workflow.

## Resource and State Ownership

OpenTofu owns graph execution and resource state.
The SDK retains desired intent, validates plans, coordinates runtime stages, and checks application readiness.
The NemoClaw provider verifies durable data and credential identity; the Docker provider reconciles its native resource state.

Before planning, the SDK checks configuration, locks state, and validates retained intent and local bindings.
OpenTofu refresh and provider planning perform environmental checks; the SDK does not run a separate environmental preflight.
The SDK then checks the saved plan against its ownership and recovery rules before authorizing changes.
Inference and proxy containers may be recreated or replaced while their independent storage bindings remain unchanged.
Managed gateways retain their stronger process and credential identity checks.
The refreshed gateway running state determines whether the OpenShell stage can be planned or must wait for gateway creation or recovery.

The generated graphs use these resource groups:

| Owner | Resources |
|---|---|
| NemoClaw provider | OpenShell workspace, provider, profile, route, and sandbox |
| NemoClaw provider | Managed gateway and gateway storage |
| NemoClaw provider | Retained inference, Ollama, and proxy storage; external Ollama model observation |
| Docker provider | Inference and proxy containers, service-owned networks, and acquired images |
| Docker provider data source | Local images selected with `imagePullPolicy: Never` |

The existence of these resources does not establish a supported standalone HCL workflow.
Do not edit SDK-generated graphs or share a deployment state directory between independently managed workflows.

## Gateway Capabilities

The SDK's deployment graph reads `data.nemoclaw_gateway_capabilities.current` through the provider's configured OpenShell connection.
The data source takes the required compute drivers and reports the observed gateway version, driver names and aliases, and whether they satisfy the SDK's compatibility contract.
Compatibility requires the pinned OpenShell version and exactly one initialized driver that matches every required driver name.
Missing metadata, authentication failures, and transport failures stop the observation.
The read is bounded to 30 seconds and does not modify the gateway.

NemoClaw deployment resources and translated proxy containers have a blocking precondition on the compatibility result.
Docker image and network resources use their provider dependencies; the SDK also checks compatibility before applying the deployment graph.
The earlier runtime graph omits this data source so managed gateway creation can finish before the deployment graph queries it.
Unknown data-source inputs defer the read until their dependencies resolve.

OpenTofu can retain known data-source results in a saved plan.
The SDK therefore checks gateway compatibility again immediately before applying deployment changes.
Observed data never becomes a durable resource binding, and teardown omits the capability gate so a version or driver mismatch alone does not prevent cleanup.

[Gateway protocol tests](../crates/nemoclaw-e2e/tests/opentofu_openshell.rs) cover incompatible and incomplete observations, unchanged state after failures, and deferred reads.
[Deployment fixtures](../crates/nemoclaw-e2e/tests/deployment.rs) cover a gateway change between plan and apply and subsequent recovery and teardown.

## Runtime Capacity and Readiness

Configuration validation checks hardware profiles, architecture selections, and memory settings without contacting an execution host.
The default service graph does not invoke the SSH host-capacity collector, resolve model registries, or inspect model-file inventories during planning.
A successful plan therefore does not establish that a model will fit or load.

The hosted runtime checks its hardware, startup headroom, model artifacts, and available memory before serving.
Its resident supervisor continues protecting host memory after the CLI exits and does not automatically restart a stopped workload.
The SDK waits for a current application status from the provider's container ID; it does not repeat model-file verification to reinterpret a ready result.
See [runtime ownership](design/runtime.md) and [recovery](models.md#diagnose-and-recover-a-stopped-runtime).

## Combined Service Capacity

The optional `nemoclaw_service_capacity` data source remains available for explicit capacity observation.
It reports required and observed bytes and compatibility using the selected execution host's measurements.
The SDK's default service graph does not use it as an admission gate.
Per-service runtime protection does not reserve capacity across deployments or schedule shared GPUs.
Operators must choose budgets appropriate for the shared host.

## Network and Image Reconciliation

The Docker provider creates, refreshes, replaces, and removes disposable service containers and their private networks.
These resources use native provider IDs; labels are diagnostic metadata rather than a second compute-ownership mechanism.
A missing service container may be recreated during explicit apply.
Missing or substituted bound storage remains an error.
Managed gateway networking retains its application-specific storage and namespace contract.

The Docker provider acquires pinned service images and keeps downloaded images on destroy.
The `Never` policy uses its local image data source; a missing local image fails that observation.
This does not lock the image against concurrent removal before container creation; see the [policy limits](usage.md#control-container-image-downloads).
See [image acquisition policies](usage.md#control-container-image-downloads) for supported modes.
Plan does not pull images, and container creation does not establish application health or model compatibility.

Provider reconciliation checks the attributes refreshed by that provider; it does not guarantee detection of every out-of-band Docker configuration change.
The deployment lock excludes other NemoClaw operations using the same state directory, not concurrent Docker administrators.

## Packaging and Qualification

Follow [bundle building](build.md) for matched CLI, SDK contract, provider, schema, and OpenTofu versions.
The NemoClaw provider uses a source-derived version to prevent stale reuse.
The Docker provider has a fixed release version and checksum-pinned native archives, with its upstream license retained in the bundle.

[Schema tests](../crates/nemoclaw-provider/tests/schema.rs), [planning tests](../crates/nemoclaw-provider/tests/planning.rs), and [refresh tests](../crates/nemoclaw-provider/tests/refresh.rs) cover provider contracts.
[Fixture qualification](testing/fixtures.md) covers real OpenTofu protocol/lifecycle execution with explicit bundle inputs.

## Direct OpenTofu Usage

Public provider distribution and installation instructions: **TBD**.
Supported user-authored HCL examples and their lifecycle/retention contract: **TBD**.
Import, adoption, remote-state backends, and compatibility across provider releases: **TBD**.

These sections need verified implementations and test results before they can recommend a direct-use workflow.

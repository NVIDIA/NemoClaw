<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Understand the OpenTofu Provider

The native bundle includes the NemoClaw and Docker OpenTofu providers.
The SDK compiles desired-state YAML into resource graphs and runs bundled OpenTofu.
Docker manages disposable service compute and Docker gateway processes; NemoClaw manages OpenShell operations, Podman gateway processes, initialization, retained gateway bridges, and durable data bindings.
Use [the SDK](sdk.md) or [CLI](reference/cli.md) for the documented deployment workflow.

## Resource and State Ownership

OpenTofu owns graph execution and resource state.
The SDK retains desired intent, validates plans, coordinates runtime stages, and checks application readiness.
The NemoClaw provider verifies durable data and credential identity; the Docker provider reconciles its native resource state.

Before planning, the SDK checks configuration, locks state, and validates retained intent and local bindings.
OpenTofu refresh and provider planning perform environmental checks; the SDK does not run a separate environmental preflight.
The SDK then checks the saved plan against its ownership and recovery rules before authorizing changes.
Docker gateway, inference, and proxy containers may be recreated or replaced while their independent storage bindings remain unchanged.
Podman gateways retain their stronger process identity checks.
Docker gateway storage independently binds signing and encryption keys; its verified mountpoint supplies the process mount through OpenTofu.
The refreshed gateway running state determines whether the OpenShell stage can be planned or must wait for gateway creation or recovery.

The generated graphs manage these objects and observations:

| Owner | Managed objects and observations |
|---|---|
| NemoClaw provider | OpenShell workspace, provider, profile, sandbox, and Pi runtime configuration |
| NemoClaw provider | Podman gateway process (`nemoclaw_managed_gateway`); gateway storage, initialization, and retained bridge (`nemoclaw_gateway_storage`) |
| NemoClaw provider | Retained inference credentials and proxy storage; external Ollama model observation |
| Docker provider | Docker gateway, inference, and proxy containers; model-cache volumes, service-owned networks and acquired images |
| Docker provider data source | Local images selected with `imagePullPolicy: Never` |

The [standalone HCL fixture](testing/fixtures.md#standalone-cache-and-credential-resources) verifies cache and credential resource composition without SDK orchestration.
It does not qualify a complete standalone OpenShell deployment workflow.
Do not edit SDK-generated graphs or share a deployment state directory between independently managed workflows.

## Gateway Capabilities

The deployment graph reads `data.nemoclaw_gateway_capabilities.current` during planning through the provider's configured OpenShell connection.
The data source reports the observed gateway version, driver names and aliases, driver-entry count, and compatibility with the required compute drivers.
Compatibility requires the pinned OpenShell version and exactly one initialized driver matching every required name.
OpenTofu lifecycle conditions report required and observed values when they differ.
Missing metadata, authentication failures, and transport failures stop ordinary planning without changing runtime resources.
Each API read is bounded to 30 seconds.

The optional `wait_timeout_seconds` accepts zero to 300 seconds; omission or zero means one bounded API read.
A positive timeout retries only transport failures, not authentication failures, incomplete metadata, or incompatibility.
For a managed gateway, the earlier runtime graph sets this timeout to 90 seconds and orders its capability read after gateway reconciliation.
The capability postcondition must succeed before OpenShell resource refresh proceeds.

A known data-source result can be retained in a saved plan.
The deployment graph also declares `data.nemoclaw_gateway_capabilities.apply`, with a `read_trigger` that is unknown during planning.
OpenTofu defers that read until apply and checks its compatibility postcondition before dependent resources can change, including on an otherwise unchanged apply.
The compiler uses `timestamp() != ""`: it is unknown during planning but resolves to a stable `true`, so the trigger does not create perpetual state differences.
The optional trigger is a scheduling input, not another compatibility check; a literal `true` alone would not defer the read.
The SDK does not make a separate pre-apply gateway request.
This observation is not a lock against concurrent gateway administrators.

Observed data never becomes a durable resource binding.
A failed apply may record new observations and condition results while retaining managed-resource state.
After correcting compatibility or access, reapply the same configuration with its retained state.
Teardown omits the capability gates so a version or driver mismatch alone does not prevent cleanup.

[Gateway protocol tests](../crates/nemoclaw-e2e/tests/opentofu_openshell.rs) exercise the production provider and pinned OpenTofu without SDK orchestration: early planning errors, saved-plan drift, unchanged apply, failed observation, recovery, and teardown.
[Deployment fixtures](../crates/nemoclaw-e2e/tests/deployment.rs) and [Pi lifecycle fixtures](../crates/nemoclaw-e2e/tests/fabric_deployment.rs) verify that the SDK uses the same apply-time protection.
Pi configuration writes are owned by `nemoclaw_pi_configuration`; unchanged apply does not rewrite the hosted runtime.

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

The Docker provider creates, refreshes, replaces, and removes Docker gateway and service containers, and service-owned private networks.
These resources use native provider IDs; labels are diagnostic metadata rather than a second compute-ownership mechanism.
A missing service container may be recreated during explicit apply.
Missing or substituted bound credentials and gateway storage remain errors.
A missing model-cache volume may be recreated; its original creation time and daemon ID are not application identity.
The generated graph retains caches with `prevent_destroy`; SDK teardown keeps those volume resources declared.
OpenTofu cannot enforce `prevent_destroy` after its resource declaration is removed, so the SDK still rejects ordinary removal of retained cache declarations.
The gateway bridge serves OpenShell sandboxes and remains part of the retained storage namespace; the Docker gateway process uses host networking.
Gateway initialization consumes the provider-acquired image before the process is created.
Podman initialization retains its existing image acquisition path.

The Docker provider acquires pinned Docker gateway and service images and keeps downloaded images on destroy.
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

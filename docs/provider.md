<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Understand the OpenTofu Provider

The native bundle includes the NemoClaw and Docker OpenTofu providers.
The SDK compiles desired-state YAML into resource graphs and runs bundled OpenTofu.
Docker manages disposable service compute and Docker gateway processes; NemoClaw manages OpenShell operations, Podman gateway processes, initialization, retained gateway bridges, and durable data bindings.
Use [the SDK](sdk.md) or [CLI](reference/cli.md) for the documented deployment workflow.

## Resource and State Ownership

OpenTofu owns graph execution and resource state.
The SDK retains desired intent, validates plans, coordinates runtime stages, and reports provider observations.
The NemoClaw provider verifies durable data and credential identity; the Docker provider reconciles its native resource state.

Before planning, the SDK checks configuration, locks state, and validates retained intent and local bindings.
OpenTofu refresh and provider planning perform environmental checks; the SDK does not run a separate environmental preflight.
The SDK then checks the saved plan against its deployment scope, retained bindings, and recovery rules before authorizing changes.
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
| NemoClaw provider data source | Gateway capabilities, vLLM/Ollama service or proxy readiness, and sandbox completion |
| Docker provider | Docker gateway, inference, and proxy containers; model-cache volumes, service-owned networks and acquired images |
| Docker provider data source | Local images selected with `imagePullPolicy: Never` |

The [standalone HCL fixture](testing/fixtures.md#standalone-cache-and-credential-resources) verifies cache and credential resource composition without SDK orchestration.
It does not qualify a complete standalone OpenShell deployment workflow.
Do not edit SDK-generated graphs or share a deployment state directory between independently managed workflows.

## OpenShell Resource Lifecycles

The shared [resource lifecycle contract](../crates/nemoclaw-sdk/src/backend.rs) distinguishes reconstructible configuration from protected identity and sandbox data.
The provider owns observation and update/replacement behavior; OpenTofu owns action ordering and resource state.
The SDK checks deployment scope and recovery constraints without imposing a second blanket ban on OpenShell changes.
For reconstructible resources, OpenTofu and the provider own confirmed absence, physical identity, and replacement cleanup; the SDK does not require a second drift history to report those actions.

| Resource | Ordinary reconciliation | Protection |
|---|---|---|
| Provider profile and registration | Update supported fields, replace immutable configuration, remove unused declarations, and recreate after confirmed absence | Verify ownership and established identity before mutation; preserve bindings on failed observation |
| Pi runtime configuration | Update model configuration and reconcile its resource lifecycle | Verify the parent sandbox identity; a model change can restart Pi and lose its in-memory conversation |
| Sandbox | Create and observe the declared sandbox | Refuse ordinary deletion, replacement, or recreation of a missing binding because deletion loses native files and history |
| Workspace | Create, observe, and retain | Refuse replacement, deletion, or automatic recreation of a missing binding |

OpenShell refuses deletion of profiles referenced by registrations and registrations attached to sandboxes.
The registration's endpoint, provider type, and authentication mode require replacement, matching its profile's configuration contract.
The graph orders registration deletion before profile deletion when both change.
Standalone HCL must declare the matching configuration and dependency on its profile.
Recreating an absent profile with unchanged configuration does not itself replace its registration.
The SDK creates registrations only for definitions selected by sandboxes; unused YAML definitions have no resource lifecycle.
The standalone provider supports ordinary registration removal and replacement, while removing a last selection in SDK YAML also changes the protected sandbox specification.
Replacing a registration still attached to a protected sandbox is not a supported shortcut around sandbox lifecycle rules.
Endpoint and policy changes that also change a sandbox's launch specification remain protected; see [change paths](usage.md#choose-the-change-path).

The provider's `destroy` setting authorizes explicit sandbox teardown; reconstructible registrations and configuration do not require it.
It never authorizes deleting the workspace or bypassing identity checks.
Removing Pi configuration releases its resource binding without deleting or stopping the sandbox-owned runtime.
The SDK's destroy operation still retains durable storage and the workspace.
See [deletion and retention](state.md#deletion-and-retention) before removing workloads.

An observation error is not absence.
Authentication, transport, and incomplete observations preserve prior state and stop planning.
The backend verifies ownership again immediately before mutation because objects can change after planning.
Creation readback must match the physical ID, owner, and generation established by the creation response.
If readback fails or identifies a substituted object, the provider returns the original established binding together with the error.
OpenTofu retains that failed creation as tainted state; automatic untainting is not a recovery guarantee.
OpenShell deletion is name-addressed without a conditional ID/version check; an immediate identity check does not make the API operation atomic.

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
The runtime graph uses `nemoclaw_service_readiness` to wait for current application status from the Docker provider's container ID.
The data source validates the runtime specification and container identity, reads the service's status contract, and checks generated vLLM credential permissions when authentication is enabled.
It does not repeat model-file verification, collect hardware inventory, or request model responses.
Startup phases may be polled; stopped services, failed observations, and malformed status fail the read.

The data source requires `spec` and `container_id`.
Its optional `wait_timeout_seconds` accepts zero to 32400 seconds; omission means 32400 seconds, and zero requests one bounded observation.
Successful reads return `ready: true`; unsuccessful reads report an error.
The optional `read_trigger` has the same scheduling semantics as the gateway trigger above.
The compiler references the container's `id` and uses `timestamp() != ""` to defer readiness until apply, including unchanged apply.
The runtime graph must succeed before the SDK proceeds to the OpenShell graph.
The OpenShell graph uses the same data source for Ollama proxies, with a 30-second wait and dependencies from their selected provider registrations.
A proxy specification contains `kind: "ollama_proxy"`, an engine endpoint, and the compiled `proxy` specification.
Its observation verifies the recorded container ID and name, running state, credential file permissions, and the upstream model digest through read-only metadata.
It waits for an initially missing key only while the container runs and the volume has no initialization marker; initialized missing keys and invalid permissions fail immediately.
The SDK no longer runs service readiness loops.

The [standalone readiness fixture](testing/fixtures.md#standalone-service-readiness) exercises this contract without SDK deployment orchestration.
A failed read retains managed bindings, and SDK teardown omits readiness gates.
See [runtime ownership](design/runtime.md) and [recovery](models.md#diagnose-and-recover-a-stopped-runtime).

## Sandbox Completion

The OpenShell graph uses `nemoclaw_sandbox_readiness` after sandbox creation and any runtime configuration resource.
Its required `sandbox` map carries the sandbox resource's binding and configuration; the provider checks startup and configuration before requesting Fabric health.
It does not invoke an agent or model.
The optional string `read_trigger` uses `uuid()` in generated graphs, making the read unknown during planning and recording a fresh token on every apply.

The data source returns `ready`, nullable `health_json`, and nullable `error_message`.
Runtime observation failures return `ready: false` with an error message; a valid Fabric response is retained in `health_json`, including unsupported health.
The graph must enforce `ready` with a lifecycle postcondition: a data-source observation alone does not reject an unsuccessful result.
Failed postconditions retain observations and resource bindings for recovery.
The SDK reads these values through OpenTofu JSON and preserves structured Fabric health in its result or error.
SDK-generated graphs defer health until apply; export and teardown omit the observation.
Standalone configurations with known inputs may read during planning unless the trigger defers them.
Existing sandbox resource refresh still verifies configuration.

The [standalone sandbox fixture](testing/fixtures.md#standalone-sandbox-completion) checks this contract through the production provider without SDK deployment orchestration.
The shared backend still contains harness-specific configuration checks; this observation does not implement the broader [Fabric management contract](design/fabric-management.md#result-and-adoption-gates).

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

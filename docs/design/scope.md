<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Accepted Scope and Invariants

Accepted by maintainer cvillela on 2026-09-14.
This page defines implementation requirements; the [architecture guide](architecture.md) explains them.

## Responsibilities

NemoClaw provides a public desired-state SDK, CLI, and OpenTofu provider.

| Owner | Responsibility |
|---|---|
| SDK | Deployment behavior |
| CLI | Arguments, terminal output, and exit codes |
| OpenTofu | Graph execution and resource state |
| Docker provider | Docker gateway, inference, and proxy containers; images, model-cache volumes, and service-owned networks |
| NemoClaw provider | OpenShell operations, Podman gateway processes, gateway initialization and retained bridges, and application-specific persistence |
| Hosted runtime | Startup capacity checks, model preparation, and application health |
| Fabric | Agent runtime health semantics and adapter checks |

Add a crate only for an existing consumer and a justified dependency or deployment boundary.
Backward compatibility with earlier schemas, SDK APIs, or state formats is not required; reject unsupported state without adopting, replacing, or deleting its resources.

## Ownership and Recovery

- Validate configuration strictly; retain intent, digests, secret references, and durable data bindings.
- Lock deployment state during operations; retain provider state and progress for partial-creation and deletion recovery.
- Verify ownership, generation, and durable identity before modifying gateway storage, credentials, Podman gateway processes, or OpenShell resources.
- Let the Docker provider reconcile disposable containers, service networks, and reproducible caches during explicit apply without requiring stable physical IDs.
- Let OpenTofu reconcile reconstructible OpenShell profiles, registrations, and Fabric configuration through provider lifecycle contracts.
- Protect sandbox replacement and missing bindings: ordinary apply must not discard files or conversation history that lack separate retained storage.
- Only confirmed absence may remove a resource from state; authentication, transport, extension, query, and incomplete-observation failures must stop planning and preserve bindings.
- Retain storage on destroy by default, and persistent data and provider state after readiness failure; recovery need not reuse the same container.
- Missing or substituted bound credential storage must stop planning before compute changes; keep credentials in separate durable volumes.

## Operations and Runtime

Plan must not mutate runtime resources.
Apply checks resources, configuration, and readiness; model or agent responses require an explicit request.
Report hosted-runtime observations while preserving unknown and unsupported results.
Refresh and export must share typed observations verified against their source APIs or host interfaces.
Mutations, conditional-write checks, active probes, and local credential or state reads remain direct.

Memory protection must stay beside inference after the CLI exits, without automatic restart loops.
The engine and its provider own container limits and image acquisition; orchestration consumes application readiness.
The runtime rebuilds artifacts when explicit apply recreates a missing model cache.
Model-specific tools belong to versioned recipe artifacts with their upstream licenses and source notices.
See [runtime](runtime.md), [execution targets](execution-targets.md), and [recipes](recipes.md) for rationale.

SDK errors and progress must not expose secrets.
OpenShell transport must use the pinned Rust SDK, with its supported raw clients where the high-level API omits required operations or fields, telemetry disabled, mTLS, bearer credential references, bounded calls, and no automatic mutation retry.
Call supported SDK operations directly; keep NemoClaw code for deployment ownership and reconciliation, without pass-through client wrappers.
Verify certificate trust in both directions independently of plaintext protocol tests.

## Validation

Use behavioral tests for ownership, observation failures, drift, replacement, partial creation, recovery, unchanged apply, export/reapply, and destroy.
Exercise SDK apply, CLI export, SDK unchanged apply, and CLI destroy against the same state.
Qualify the provider against pinned OpenTofu and use an explicitly verified bundle for deployment tests.
Separate deterministic tests from opt-in live qualification; record revision, platform, and environment in [validation records](../validation/README.md).
Compilation alone does not qualify migration or platforms.

## Kubernetes Development Branch

The user requested a Kubernetes backend on a branch from `v1` on 2026-09-22.
This branch accepts `runtime.provider: kubernetes` through an exactly version-matched OpenShell Kubernetes gateway and preserves the SDK's lifecycle and ownership rules.
Kubernetes uses external inference connections; local managed gateway and inference service configurations are rejected.
On 2026-09-23, the user clarified that this path must use an existing Kubernetes cluster independently of kind and reuse the Docker path's credential-reference mechanism.
The external-gateway path takes the platform-owned OpenShell gateway endpoint and existing `credential.env` references; it does not create a cluster or read an ambient kubeconfig.
On 2026-09-28, the user authorized managed Kubernetes provisioning within SDK plan, apply, export, recovery, and destroy, selected generated development authentication, and permitted owned prerequisites to be installed when absent.
The managed path requires `gateway.management: managed`, an explicit `kubernetes` target with a kubeconfig environment reference, context, namespace, Agent Sandbox prerequisite management, and `authentication.profile: development`.
It uses an existing cluster without depending on kind and requires an explicit HTTPS endpoint at `127.0.0.1` with a nonzero port for the per-command port forward.
Plan remains observational; only explicit apply may provision resources.
The SDK may install the pinned upstream OpenShell chart and generated development authentication resources and, when `prerequisites.agentSandbox.management: managed` is selected, install owned pinned Agent Sandbox prerequisites when absent, including their cluster-wide resources.
Existing compatible prerequisites remain externally owned; a conflicting or incompatible installation must fail without adoption or replacement.
Generated credentials and gateway storage must remain private and retained after destroy; teardown must not remove preexisting prerequisites or foreign resources.
This authentication profile is an explicit development qualification choice, not a production identity service.
Existing production issuers continue to use the external-gateway credential-reference path.
Kind remains an explicitly selected local test fixture, and its endpoint, issuer, credentials, and image-loading procedure are not deployment defaults.
Deployment variables and generic examples use Kubernetes or cluster naming; kind-specific runtime inputs belong only to the optional local test fixtures.
A separate, explicitly invoked local installer may create one owned kind cluster and deploy the pinned upstream OpenShell chart, its Agent Sandbox prerequisite, an enforcing CNI, and a scoped development authentication fixture.
The optional pinned CPU inference fixture and Kubernetes builds of the existing agent images may be deployed there for lifecycle and inference tests.
Those builds must preserve private workspace permissions while matching the upstream Kubernetes driver's non-root identity.
The SDK owns OpenShell resources in both paths and the provisioning resources it installs in the managed path.
In the external-gateway path, the platform installer owns the Kubernetes prerequisites and retains them after SDK destroy.
This decision does not create a maintained OpenShell fork, a NemoClaw Kubernetes operator, or production and compatibility claims.
See the [Kubernetes procedure](../kubernetes.md) for credential custody and retained state, and the [kind test guide](../testing/kubernetes-kind.md) for local setup and explicit cluster cleanup.

On 2026-09-30, the user requested OpenShift alongside Kubernetes in this development branch and selected offline validation because no OpenShift test cluster is available.
The authored `runtime.provider: openshift` selects an OpenShift profile of the upstream Kubernetes driver; it does not introduce an OpenShell driver or fork.
Managed deployments declare `gateway.kubernetes.distribution: openshift`, verify OpenShift APIs, and bind the namespace-assigned UID/GID allocation before provisioning workloads.
Keep mutual TLS, bearer authentication, capability removal, non-root execution, and the existing command-scoped tunnel.
Do not grant a privileged or anyuid SCC, change cluster security policy, install ingress, or create a Route as part of this profile.
Preserve externally owned prerequisites and require supported namespace allocation and kernel isolation capabilities; missing or changed inputs fail closed.
This request permits source changes, generated schema, examples, and deterministic tests; it does not establish live OpenShift compatibility.

Integration with current v1 requires image-owned Fabric runtime metadata before sandbox creation.
Kubernetes and OpenShift deployments may obtain this metadata from a bounded local OCI metadata bundle referenced by `image.metadata.env`, without inspecting a Docker engine during deployment.
Accept a single Linux manifest or an index with one Linux platform and attestations; multi-platform indexes require a later per-architecture runtime contract.
Verify the authored image digest and every selected index, manifest, and configuration blob before using the image's catalog; never substitute a bundled default runtime or executable list.
The local image-build tools may export the metadata from an existing immutable image without publishing or pulling it.
The optional local test fixture supplies this artifact automatically; deployment inputs and credential values remain outside Git.

On 2026-10-02, the user requested running development tests while native Fabric health remains unsupported.
The optional cluster E2E test may explicitly continue after an apply whose only failures are fresh, matching `fabric_health_unsupported` readiness observations for fully configured, retained sandboxes.
It must reject failed or unknown health, incomplete provisioning, malformed or stale observations, and unrelated errors; invocation, state identity, export/reapply, and destroy assertions remain required.
This exception belongs only to the opt-in test and must report Fabric health as unverified.
It does not change the normal CLI/SDK apply contract, the manifest schema, or the meaning of a successful native health check.

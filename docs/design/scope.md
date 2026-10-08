<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Scope and Invariants

This page defines implementation requirements; the [architecture guide](architecture.md) explains them.

## Responsibilities

NemoClaw provides a public desired-state SDK, CLI, and OpenTofu provider.

| Owner | Responsibility |
|---|---|
| SDK | Deployment behavior |
| CLI | Arguments, terminal output, and exit codes |
| OpenTofu | Graph execution and resource state |
| Docker provider | Docker gateway, inference, and proxy containers; images, model-cache volumes, and service-owned networks |
| Helm provider | Installation, upgrade, and removal of the pinned OpenShell chart release |
| OpenShell provider | OpenShell workspaces, provider registrations and profiles, sandboxes, and gateway capability reads |
| NemoClaw provider | Fabric runtime configuration and readiness, Podman gateway processes, gateway initialization and retained bridges, Kubernetes storage and development authentication, readiness observations, and application-specific persistence |
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
Separate deterministic tests from opt-in live qualification; record a live run's revision, platform, and environment in its CI results or the commit that relies on it.
Compilation alone does not qualify migration or platforms.

## Local Container Connection Decision

Decision: Accept, authorized by San Dang in the operator conversation on October 6, 2026: “Ok let's do it from nemoclaw side as well.”
Accountable maintainer: San Dang.
Reason: the fresh DGX Station VoiceClaw manual test needs to connect to the gateway that NemoClaw installs, rather than an externally provisioned HTTPS/OIDC gateway.
Placement: the existing generic container connection validator, compiler, and protected descriptor delivery; VoiceClaw owns the matching application transport.

The development-only connection explicitly selects `authentication.mode: none`, `refreshMode: none`, and `tls.trust: none`, without an OpenShell credential reference.
It is restricted to this deployment's managed local Docker gateway and the same owned Docker network and engine.
The compiler derives the gateway container's private IPv4 address and listen port; an authored endpoint must match that binding exactly.
The gateway's host publication stays on loopback.
HTTPS/OIDC behavior remains unchanged, and authentication or transport failure never selects anonymous mode automatically.

This profile provides neither encryption nor client authentication or per-application authorization.
Any process able to reach the gateway can use its API; use only for an isolated, trusted local development deployment, not production or shared untrusted workloads.
No issuer, proxy, Docker socket grant to the application, operator credential copying, new lifecycle manager, or native-health claim is accepted.
Protected speech input delivery, target/workspace binding, application health, owned removal, and dependency preservation remain unchanged.

Validation: deterministic parser/schema, compilation, provider-side binding, descriptor, export/reapply, and negative transport/authentication/placement tests, followed by the separate manual Station installation and voice turn.
Local tests do not establish image or live qualification.
Changing network exposure, authentication authority, supported platforms, or application transport requires a new joint decision.

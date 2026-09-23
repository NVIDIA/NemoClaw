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
- Let OpenTofu reconcile reconstructible OpenShell profiles, registrations, and Pi configuration through provider lifecycle contracts.
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
Verify certificate trust in both directions independently of plaintext protocol tests.

## Validation

Use behavioral tests for ownership, observation failures, drift, replacement, partial creation, recovery, unchanged apply, export/reapply, and destroy.
Exercise SDK apply, CLI export, SDK unchanged apply, and CLI destroy against the same state.
Qualify the provider against pinned OpenTofu and use an explicitly verified bundle for deployment tests.
Separate deterministic tests from opt-in live qualification; record revision, platform, and environment in [validation records](../validation/README.md).
Compilation alone does not qualify migration or platforms.

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Accepted Scope and Invariants

Decision: Accept.
Maintainer cvillela owns this design and its acceptance, recorded on 2026-09-14.

NemoClaw provides a public desired-state SDK, its CLI, and an OpenTofu provider.
The SDK owns deployment behavior; the CLI owns arguments, terminal output, and exit codes.
OpenTofu owns graph execution and resource state.
The Docker provider owns managed inference and proxy containers, their images, and service-owned networks.
The NemoClaw provider owns OpenShell operations, managed gateways, and resources with application-specific persistence contracts.
Add a crate only when it has a consumer and a dependency or deployment boundary that justifies it.

The [architecture](architecture.md), [runtime](runtime.md), [execution-target](execution-targets.md), and [recipe](recipes.md) guides explain these boundaries and the implementation and tests behind them.

## Ownership and Recovery

Backward compatibility with earlier schemas, SDK APIs, or state formats is not required.
Reject unsupported state without silently adopting, replacing, or deleting its resources.

- Validate configuration strictly and retain intent, configuration digests, secret references, and durable data bindings across operations.
- Lock deployment state while coordinating an operation and retain provider state and operation progress to recover from partial creation or deletion.
- Treat inference and proxy containers and service-owned networks as disposable compute; the Docker provider may recreate or replace them during explicit apply.
- Verify ownership, generation, and durable identity for persistent data, credentials, managed gateways, and OpenShell resources before modification.
- Use provider resource identities and reconciliation for disposable compute instead of requiring stable physical IDs across recovery.
- Only confirmed absence may remove a resource from state.
- Authentication, transport, extension, query, and incomplete-observation failures must stop planning and preserve prior bindings.
- Plan must not create or mutate runtime resources.
- Apply checks resources, configuration, and readiness without requesting model or agent responses; checking model responses requires an explicit request.
- Fabric owns runtime health semantics and adapter checks; NemoClaw transports and reports observations from the hosted runtime, preserving unknown and unsupported results.
- Storage survives destroy by default; failed readiness must retain persistent data and recorded provider state, without requiring the next apply to reuse the same container.

## Runtime and Observation

Refresh and export share typed observations.
Verify each collector against the API or host interface it reads.
Mutations, conditional-write checks, active probes, and local credential or state reads remain direct.

Memory protection stays active beside inference after the CLI exits and must not trigger an automatic restart loop.
The hosted runtime owns startup capacity checks, model preparation, and application health.
Container resource limits and image acquisition belong to the engine and its provider; orchestration consumes application readiness rather than implementing model execution.
Reproducible model caches and durable credentials have different recovery requirements; a volume containing both retains the stronger durable-data contract.
Model-specific tools belong to versioned recipe artifacts; retain applicable upstream licenses and source notices.
SDK errors and progress must not expose secret values.

OpenShell transport must retain mTLS, bearer credential references, bounded calls, and no automatic mutation retry.
Use the pinned generated OpenShell clients with telemetry disabled.
Verify certificate trust in both directions independently of plaintext protocol tests.

## Validation

Use behavioral tests for ownership, observation failures, drift, replacement, partial creation, recovery, unchanged apply, export/reapply, and destroy.
Exercise SDK apply, CLI export, SDK unchanged apply, and CLI destroy against the same state.
Qualify the provider against the pinned OpenTofu binary and use an explicitly verified bundle for deployment tests.
Keep deterministic tests separate from opt-in live qualification, and identify the tested revision, platform, and environment.
Compilation alone does not establish state migration or platform qualification.

[Retained validation records](../validation/README.md) describe tested contracts and their limits.

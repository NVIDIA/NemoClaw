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
| OpenShell provider | OpenShell workspaces, provider registrations and profiles, sandboxes, and gateway capability reads; Podman gateway processes, gateway initialization and retained bridges, and Kubernetes gateway storage and development authentication |
| Fabric provider | Fabric runtime configuration and readiness in agent sandboxes |
| vLLM and Ollama providers | Inference service storage, readiness observations, and application-specific persistence |
| Host provider | Engine and image observations, and application container health |
| Hosted runtime | Startup capacity checks, model preparation, and application health |
| Fabric | Agent runtime health semantics and adapter checks |

Every OpenTofu resource and data source must take the inputs its backend uses, written in HCL, not documents compiled by the SDK.
Fabric configurations and Fabric runtime bindings remain JSON strings, because their open schemas have no fixed OpenTofu type.

Add a crate only for an existing consumer and a justified dependency or deployment boundary.
Backward compatibility with earlier schemas, SDK APIs, or state formats is not required; reject unsupported state without adopting, replacing, or deleting its resources.

## Upstream Boundaries

NemoClaw composes OpenShell, OpenTofu, Fabric, agent harnesses, inference servers, container engines, and Kubernetes; it must not reimplement what they provide.
NemoClaw's own promises are mapping desired state to resources, deployment state and durable identities, ownership checks before mutation, data retained on destroy, hardware fit and memory protection for managed model services, and documentation of how the components fit together.

| Upstream | NemoClaw relies on it for |
|---|---|
| OpenTofu | Graph execution and resource state |
| OpenShell | Gateway configuration, sandbox isolation, network policy enforcement and destination checks, and credential storage and delivery |
| Fabric | Adapter discovery, native configuration validation and mapping, the agent process, and the harness versions its adapters support |
| Agent harnesses | Their own settings, limits, and dependency locks |
| Ollama | Model pulls, model storage, and reported digests |
| vLLM and Hugging Face | Serving, health, and authentication; snapshot downloads and their checksums |
| Docker, Podman, and Kubernetes | Container lifecycle, restarts, resource limits, image pulls, and registry authentication |
| Platform operators | Secret stores, host and cluster recovery, and cluster prerequisites |

Before adding behavior, answer these questions in its issue or pull request:

1. Does an upstream component already provide it? Rely on that component, and check only what NemoClaw needs to proceed.
2. Is NemoClaw the right place to observe or do it? A check from the OpenTofu host does not establish what a sandbox can reach.
3. Would an experienced OpenTofu user expect NemoClaw to do it?
4. Does it need a patch, a workaround, or a reimplementation of another component's format beyond its documented inputs? If so, stop and discuss it first.
5. Which NemoClaw promise does it serve?

When an upstream gap blocks a feature, leave the feature unavailable instead of working around it.
File a `v1` issue, add the limit to [current limits](../limits.md), and ask upstream only when the gap is theirs to fix.
Setting configuration that an upstream component documents is not a workaround.
An exception needs its reason recorded here and an issue that tracks its removal.

NemoClaw keeps these by decision, as its own promises:

- Managed Docker and Podman gateways, so that one file can create a working local deployment ([#13474](https://github.com/NVIDIA/NemoClaw/issues/13474)). An OpenShell-installed gateway with `gateway.management: external` remains the alternative.
  NemoClaw writes only the keys it owns into the gateway's configuration and passes the rest through from [`spec.gateway.config`](../usage.md#configure-a-managed-gateway), in OpenShell's format ([#13473](https://github.com/NVIDIA/NemoClaw/issues/13473)).
- The vLLM supervisor's route allowlist, which is the reverse proxy that vLLM's [security guide](https://github.com/vllm-project/vllm/blob/v0.32.0/docs/usage/security.md) asks deployers to provide ([#13471](https://github.com/NVIDIA/NemoClaw/issues/13471)).
- The OpenClaw image pin: OpenClaw's npm package has no lockfile, so the agent image copies OpenClaw's published image by digest, and Fabric's adapter refuses versions it doesn't support ([#13476](https://github.com/NVIDIA/NemoClaw/issues/13476)). See [updating the pin](../build.md#update-the-openclaw-pin).
- No model-specific recipe images: preparation tools and runtime patches belong to the recipe's authors and to vLLM, and NemoClaw keeps only the generic [recipe contract](../recipes.md) ([#13472](https://github.com/NVIDIA/NemoClaw/issues/13472)).
- Agent image assembly, for now: NemoClaw builds and publishes the images that hold Fabric and each harness's native agent, so it installs and pins those agents in the [agent Dockerfile](../../image/fabric/Dockerfile). Image building moves to the Fabric repository later; Fabric owns each adapter's behavior and its tests.

## Ownership and Recovery

- Validate configuration strictly; retain intent, digests, secret references, and durable data bindings.
- Lock deployment state during operations; retain provider state and progress for partial-creation and deletion recovery.
- Verify ownership, generation, and durable identity before modifying gateway storage, credentials, Podman gateway processes, or OpenShell resources.
- Let the Docker provider reconcile disposable containers, service networks, and reproducible caches during explicit apply without requiring stable physical IDs.
- Let OpenTofu reconcile reconstructible OpenShell profiles, registrations, and Fabric configuration through provider lifecycle contracts.
- Replace a sandbox with its agent, so each sandbox runs one agent runtime; the plan shows the replacement, and durable data belongs on mounted volumes.
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
Keep tests that need live resources opt-in; record a live run's revision, platform, and environment in its CI results or the commit that relies on it.
Compilation alone does not qualify migration or platforms.
Tests cover NemoClaw's promises, not whether upstream components enforce their own behavior.

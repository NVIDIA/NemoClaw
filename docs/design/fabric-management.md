<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric Runtime Management Experiment

Status: proposed upstream contract, with a local prototype; not a deployment backend.
The experiment tests whether one management interface can serve different Fabric adapters without teaching the OpenTofu provider their configuration schemas.
It does not replace the existing SDK orchestration or `nemoclaw_pi_configuration` resource.

## Proposed Responsibility Boundary

| Component | Responsibility |
|---|---|
| NemoClaw | Deployment intent, versioned recipes, credential references, durable-data policy |
| OpenTofu | Resource graph, dependencies, desired configuration and recorded bindings |
| OpenShell | Sandbox lifecycle, isolation, authenticated transport to its hosted runtime |
| Fabric | Configuration validation, adapter selection, runtime management and health semantics |
| Provider | Translate the shared Fabric management contract into resource operations |

A recipe may supply a Fabric-native configuration containing adapter settings.
The provider should pass that document through and consume shared management results; it should not enumerate adapters or extract Pi model fields.
Adding a Fabric adapter must not require changing the provider implementation.
Credentials should reach the runtime through references, rather than being copied into configuration documents or management responses.
The prototype does not enforce a credential policy.

## Existing Fabric Primitives and the Missing Contract

The experiment uses Fabric revision [`6c08337b`](https://github.com/NVIDIA/NeMo-Fabric/tree/6c08337bcb11d6c0f2d5118f8f0c98a5b2a1a421), pinned by the [agent Dockerfile](../../image/fabric/Dockerfile).
`Fabric.plan()` validates and resolves native configuration without starting a runtime.
`Fabric.start_runtime()` starts the selected adapter; `Runtime.stop()` stops that runtime.
The pinned SDK's `Runtime.status` is local lifecycle bookkeeping, not a fresh process or application-health observation.

The [experimental controller](../../tools/fabric_management/controller.py) composes these primitives behind four operations:

| Operation | Prototype behavior |
|---|---|
| `plan(document)` | Resolve through Fabric; return `start`, `none`, or `restart` and a canonical configuration digest; no start or stop |
| `observe()` | Return the controller revision, last successful configuration digest, runtime identity, local lifecycle and unsupported health |
| `apply(document, expected_revision, allow_session_reset)` | Reject stale revisions; preserve an unchanged active handle; otherwise start or explicitly restart |
| `stop(expected_revision)` | Stop the bound runtime, retaining its identity and last successful configuration digest |

The revision combines a unique controller-instance identity with a mutation counter.
One in-process lock serializes conditional writes.
A stale revision cannot mutate a newer binding, including when two callers submit the same revision concurrently.
Configuration is validated before the current runtime is stopped.
A restart requires explicit consent to lose session state; the prototype promises no conversation continuity.

If the caller loses a successful response while the controller remains alive, observing the controller reveals the completed result.
If a Fabric mutation itself raises or is cancelled, the controller records `unknown`, keeps any previous binding, and refuses further mutations.
It does not retry, declare absence, or guess whether startup or shutdown took effect.
This conservative quarantine is not a recovery implementation.
An `empty` controller has no record; it does not establish that no runtime exists elsewhere.

## Run the Experiment

Use an ARM64 Docker engine and the [image-build prerequisites](../build.md).
Run these commands from the repository root; they build local images without publishing them:

```bash
AGENT_PLATFORM=linux/arm64 IMAGE_PREFIX=nc-fabric-management docker buildx bake pi deepagents --load
python3 -B -m unittest discover -s tools/fabric_management -p 'test_*.py'
for harness in pi deepagents; do
  python3 tools/fabric_management/run.py --image "nc-fabric-management:$harness" \
    --config "tools/fabric_management/fixtures/$harness.json"
done
```

The runner resolves the explicitly selected local image to an immutable ID and starts a uniquely named disposable container with networking disabled.
It mounts only the experiment and the selected fixture, both read-only, and uses a dummy credential inside the container.
It removes its container on completion or failure and has a 180-second execution timeout.
It does not access deployment state, mount durable storage, or request model responses.

The shared scenario reads a Fabric-native JSON fixture; only the fixtures differ between the Python DeepAgents adapter and TypeScript Pi adapter.
It checks planning, initial startup, unchanged apply, invalid configuration, consent to restart, observation after a discarded response, stop and explicit recovery.
The [contract tests](../../tools/fabric_management/test_controller.py) additionally cover stale and concurrent writes, ambiguous startup and shutdown, and cancellation.
The [image workflow](../../.github/workflows/images.yml) repeats the two-adapter scenario on ARM64.

## Result and Adoption Gates

On 2026-09-21, the shared scenario passed against both adapters using Fabric `6c08337b` on Linux ARM64.
Each scenario started three runtimes, recorded zero invocations, and reported health as unsupported.
All 11 deterministic contract tests passed.
This establishes a shared configuration and lifecycle experiment; it does not establish readiness, persistent management, OpenShell transport integration, or an independently usable OpenTofu resource.

Before adopting a provider resource, Fabric needs a supported management contract with:

- Durable logical identity and configuration binding, plus attachment or recovery after the management host restarts.
- Fresh runtime observation and explicit unknown or unsupported health; a remembered active handle is insufficient for drift detection.
- Defined mutation-outcome recovery and conditional writes across the lifetime of that durable binding.
- Declared update behavior, including whether a change can preserve a session or requires an explicit reset.
- A versioned transport contract usable through OpenShell without embedding adapter semantics in the provider.

The controller lives under `tools/` to make the experiment reviewable; shipping it in NemoClaw would retain the management responsibility we intend to move to Fabric.
The next step is to develop this contract upstream, then qualify one generic provider resource against at least these two adapters.
Only after that qualification should we remove the Pi-specific resource, host protocol and SDK prepare/configure sequence.

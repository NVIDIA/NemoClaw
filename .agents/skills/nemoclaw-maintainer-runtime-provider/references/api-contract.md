<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Bundle API Contract

Use this reference when implementing or reviewing a `RuntimeProviderBundle`. Treat
`src/lib/onboard/runtime-provider/contract.ts` and `registry.ts` in the commit under review as the
source of truth.

## Registration Unit

`RuntimeProviderBundle` is the sole registration unit. It contains one identity and these 13
surfaces:

| Surface | Candidate registration contract |
| --- | --- |
| `plan` | Always supported. Selects the `nemoclaw` or `openshell` gateway launcher. |
| `capabilities` | Always supported. Declares host-local inference, direct lifecycle, legacy gateway inspection, workload cleanup, and read-only host-mount behavior. |
| `preflightDoctor` | Always supported. Implements host inspection and lifecycle preflight. |
| `gateway` | Always supported. Declares the launcher and legacy-container inspection posture. |
| `workload` | Always supported. Declares managed-image or native-artifact support and receipt acceptance. |
| `hostLocalInference` | Optional for a candidate. Lists services and creates a provider-owned operation. |
| `lifecycle` | Optional for a candidate. Implements start, started-state verification, stop hooks, and channel-stop transport. |
| `mutationAuthority` | Optional for a candidate. Lists the state-changing operations that the provider authorizes. |
| `bootstrap` | Optional for a candidate. Binds provider-owned create, readiness, and create-recovery operations for its workload type. |
| `snapshot` | Optional for a candidate. Implements versioned preflight, capture, restore validation, and restore. |
| `recovery` | Optional for a candidate. Reconciles one persisted sandbox with its runtime. |
| `cleanup` | Optional for a candidate. Prepares destroy, plans owned-workload cleanup, and performs removal. |
| `containerEngine` | Optional for a candidate. Declares operation-scoped engine identities. |

Every surface must exist. An optional unsupported surface must use `supported: false` and include a
non-empty reason. Production activation requires a stricter posture.

## Identity and Registry Invariants

The provider key and `identity.id` must match. The ID starts with a lowercase letter, contains only
lowercase letters, digits, and hyphens, and has at most 63 characters. Do not use a display name or
runtime command as the provider ID.

The registry enforces these invariants:

- `identity.contractVersion` matches `RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION`.
- Every surface has the same `providerId` as `identity.id`.
- Bundle values use cloneable plain data and functions accepted by the registry.
- Registration deep-clones and freezes the bundle.
- Duplicate provider IDs fail registration.
- `plan.gatewayLauncher` equals `gateway.launcher`.
- Capability booleans equal the registered surface support states.
- Workload profiles use unique accepted platforms, architectures, agents, and contract versions.
- Receipts and resource handles remain bounded and provider-bound.

Do not maintain a second provider registry or a partial bundle in another module.

## Surface Obligations

### Plan, capabilities, preflight, and gateway

`preflightDoctor.inspectHost()` returns one normalized host check. `preflightLifecycle()` returns
`null` for success or one normalized failure result. A preflight must not begin the lifecycle
operation that it checks.

The current gateway surface declares the launcher and legacy-container inspection posture. If a
new provider needs provider-owned transport, reachability, launch environment, or resource
authority that the surface cannot express, extend the shared contract through an accepted design
decision. Do not put the provider behavior in generic gateway code.

### Workload and host-local inference

The workload profile declares the accepted immutable workload identity. `acceptsReceipt()` must
validate the receipt kind, platform, and contract versions. Do not accept a tag when the active
contract requires a digest.

A supported host-local inference surface lists unique accepted services. `createOperation()`
returns a provider-owned `HostLocalInferenceOperation`. Keep credentials out of runtime receipts
and failure evidence. Store route and engine authority in provider-owned stores.

### Lifecycle and bootstrap

Lifecycle methods return normalized results. `verifyStarted()` must verify the selected sandbox and
gateway after provider startup. `stop()` executes the supplied `beforeStop` hook at the required
boundary and reports an already-stopped or stopped state when known.

Bootstrap supplies provider-owned creation, readiness, and create-recovery operations. A
native-artifact provider must bind its atomic `verifyAndCreate`, `verifyReadiness`, and
`recoverCreate` operations when it constructs the bundle. The generic caller supplies only the
bootstrap input and cannot replace these operations.

Each operation must bind the provider ID, persisted sandbox identity, lifecycle generation, and
provider resource handle to the same runtime resource. The provider assigns the deterministic
handle before mutation. Atomic `verifyAndCreate` must verify the exact artifact and executable
identities under one stable authority before it creates the resource. Readiness evidence must
repeat that identity. An unknown create result or a failed readiness check after matching create
evidence must use the handle for provider-owned, idempotent recovery. Creation evidence that does
not match the plan cannot authorize plan-only recovery or removal and must report that the resource
may remain. Separated measurement and creation do not satisfy this contract.

### Mutation authority

Mutation authority lists only operations that the provider implements. The current operation set
is defined by `RuntimeProviderMutationOperation`.

### Snapshot, recovery, and cleanup

Snapshot contract version 1 binds preflight, runtime receipt, lifecycle state, lifecycle
generation, provider handle, and managed-profile authority. Validate source and target provider
identities before restore.

Recovery reconciles persisted sandbox state with the provider-owned runtime. It does not infer a
provider from a command name, socket, image, or resource name.

Cleanup must:

1. capture destroy and workload ownership authority;
2. detach provider bindings and report every failure;
3. produce a side-effect-free retain, remove, or block plan;
4. revalidate the same authority before mutation; and
5. return the engine and immutable reference for removal results.

Block destructive cleanup when authority is missing, ambiguous, reused, or drifted.

### Operation-scoped engine identity

A supported `containerEngine` surface declares one identity for each implemented operation scope:

- `host-doctor`
- `gateway-inspection`
- `host-local-inference`
- `sandbox-lifecycle`
- `workload-cleanup`

Each identity contains an operation, engine ID, and display name. Provider-specific command
execution stays behind provider-owned helpers. Do not expose a global Docker or Podman switch to
generic orchestration.

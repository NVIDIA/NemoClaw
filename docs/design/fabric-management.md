<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric Runtime Management

NemoClaw projects deployment intent once into public Fabric configuration.
Fabric discovers adapters, validates their settings and constraints, maps native configuration, and starts their runtimes.
The shared [sandbox host](../../image/fabric/fabric.py) owns transport, generation checks, and the runtime lifecycle.
Its image-installed [Fabric backend](../../image/fabric/backend.py) calls Fabric's public planner and runtime API; the host contains no adapter registry or native settings translation.
Its [bridge protocol](../../image/fabric/bridge_protocol.py) owns command parsing, size limits, response envelopes, and response validation without importing Fabric.

## Responsibility Boundary

| Component | Responsibility |
|---|---|
| SDK | Deployment references, credential registrations, security grants, ownership and resource recovery |
| OpenTofu and providers | Resource dependencies, reads, retained bindings and explicit configuration reconciliation |
| OpenShell | Sandbox lifecycle, isolation and authenticated transport |
| Fabric | Adapter discovery, schemas, native validation, native mapping and execution |
| Authoring | Generic questions from owner schemas, accepted intent and unresolved work |

`fabric_agent_configuration` applies the public Fabric document after sandbox creation and route setup.
Unchanged configuration preserves the active handle; a changed document stops the previous runtime before its replacement starts.
A host process restart waits for explicit apply before starting Fabric so that persisted configuration cannot outrun current gateway routes.
This resource is reconstructible and separate from immutable sandbox identity and retained deployment bindings.
It does not promise conversation continuity across a native runtime restart.

## Bridge Commands

Images provide `fabric-agent` on `PATH`.
The provider uses the image’s advertised command through authenticated OpenShell execution, with each flag and value passed as a separate argument.
`--config` and `--input` take a file path, or `-` to read one JSON object from stdin.
Fabric receives invocation input unchanged, except for an adapter that takes only text, today Hermes in `service` mode: it receives the string from `{"text": "..."}`, and any other object is refused with `text_input_required` before anything is sent.
Only an exact `-` selects stdin; commands leave stdin unread otherwise and reject a terminal or an empty or oversized stream.
The provider sends configuration and invocation input on stdin in the same execution as the command, so it writes no files into the sandbox.

| Command | Behavior |
|---|---|
| `validate --agent NAME --config FILE` | Validate locally through the installed backend, without a control socket or running host. |
| `prepare --agent NAME --config FILE --expected-generation TOKEN` | Validate, then stop the runtime, including when its configuration is unchanged. |
| `configure --agent NAME --config FILE --expected-generation TOKEN` | Keep a matching runtime or replace it after validation. |
| `check --agent NAME [--live\|--active\|--ready\|--operational]` | Return a coherent snapshot and request the selected health level; default to `--live`. |
| `invoke --agent NAME --input FILE` | Send one explicit request and preserve Fabric's result. |
| `serve --agent NAME` | Own the control socket and wait for explicit configuration. |

Every command except `serve` emits one JSON response with `operation`, `status`, `changed`, `result`, and `error`.
Success exits 0; failure and unsupported operations exit 1.
Requests are limited to 512 KiB and responses to 4 MiB, including the socket newline.
A timeout, malformed response, or disconnection leaves the outcome unconfirmed; callers do not replay mutations or invocation.

Prepare and configure compare a generation token atomically before changing the runtime.
Lifecycle attempts invalidate the token even when they fail; rejected requests and confirmed no-ops preserve it.
Snapshot reads remain available during invocation and stop.
Apply uses configure directly; prepare is a separate bridge operation.
OpenTofu orders dependency changes before agent configuration through its resource graph.
The protocol adds no separate maintenance gate, consumer inventory, or requirement to stop agents before dependency updates.
The deployment’s existing apply lock and resource ownership checks still apply.

The host allows four seconds for graceful shutdown, removes only its own socket, and retains agent files.
Before recovering or replacing a failed host, the caller must request OpenShell sandbox stop and confirm that compute has stopped.
A failed health check or an exited host alone does not confirm sandbox termination.
Automatic cleanup on every host exit is not an additional image requirement.
The bridge does not discover or adopt orphaned processes, and its graceful shutdown does not prove sandbox-wide termination.
OpenShell stop completion and retained-data behavior still require qualification against the selected driver.

## Image Contract and Reference Implementation

Every packaged `fabric-agent` image exposes `/opt/nemoclaw/bridge.json` and the matching `io.nemoclaw.fabric.bridge` label.
The manifest contains exactly `interface_version`, the six `operations`, and a cumulative prefix of native `health_checks` (`live`, `active`, `ready`); consumers reject other fields.
The current command and response interface remains version 1.
Fabric image catalogs embed the same capability object; the builder rejects disagreement.
Fabric revision remains provenance for validation responses; missing provenance does not invalidate a configuration that the installed validator accepts.

The [dummy backend](../../image/fabric/dummy_backend.py) is an executable reference with no Fabric, native-agent, model, or credential dependency.
It is installed only in the separate `dummy` target; it is never a fallback for a real adapter.
All production adapter images install the Fabric backend and use the same host and capability generation.
The dummy image intentionally has no Fabric descriptor catalog and is not a deployable SDK harness.
See [building the reference image](../build.md#reference-contract-image).

The dummy configuration uses `metadata.name` and `harness.adapter_id: org.nemoclaw.dummy`.
Its optional `harness.settings` fields are `reply` (string), `ready` (boolean), `fail_start` (boolean), and `fail_stop` (boolean).
These controls belong only to the reference fixture.
Invocation accepts `message` (string), optional `delay_ms` (integer from 0 to 10000), and optional `fail` (boolean).
The native result contains `status` and an `output.message`; the host preserves that result.
Without an explicit `reply`, the dummy echoes the supplied message.

The backend owns validation, startup, runtime handles, native health, and native error classification.
For a supported health level it returns a success decision and its native report; the host preserves the report and adds the runtime snapshot.
Health checks have a ten-second deadline and do not acquire the lifecycle/invocation lock.
If the generation, runtime identity, or lifecycle state changes during a check, the host discards the report and returns an unconfirmed health result with the current snapshot.
An unsuccessful or unknown native check fails the command while retaining configuration.
Operational checks remain unsupported and never invoke an agent.

Standalone validation can now run in the selected image before a deployment host exists.
The SDK's pre-provisioning path has not yet migrated: it still uses the compiled Fabric planner and exact-revision catalog checks.
Connecting that consumer to image validation and replacing revision equality with agreed contract compatibility remains NemoClaw work.
The Docker reference tests do not establish an OpenShell recovery or deployment integration.

### Image Metadata

`cargo images build` ([source](../../crates/nemoclaw-build/src/images.rs)) runs Fabric discovery in each installed image without starting an adapter and attaches the result as `io.nemoclaw.fabric.catalog`.
It selects installed-package records using Fabric provenance and preserves the descriptor contents.
Direct Docker Bake builds attach no metadata.

| Image file | Contents |
|---|---|
| [`/opt/nemoclaw/runtime.json`](../../image/fabric/runtime.json) | Bridge command, environment, required read paths, and default filesystem and process policy; `schema_version: 1` |
| `/opt/nemoclaw/runtime-files.json` | Additional runtime directories for each adapter, written by its Dockerfile stage; the catalog records them as `runtime_files` |
| `/opt/nemoclaw/bridge.json` | Bridge capabilities, also embedded in the catalog |

Installed catalog generation records the runtime manifest under `runtime`.
[`runtime_metadata.py`](../../image/fabric/runtime_metadata.py) resolves each descriptor's `requirements.binaries` through the declared `PATH` and records canonical executable paths beside the unchanged descriptor.
Each adapter also records the `ADAPTER_PYTHON` interpreter path, because the host runs Python adapters in-process.
A missing manifest, required path, or executable fails catalog generation; image tests check that runtime directories exist and are readable by the runtime user.

The SDK validates this metadata during image discovery and compiles it into each sandbox's launch and policy, retaining the binding in state and OpenShell annotations for refresh and teardown.
Explicit filesystem grants are checked against the image-owned paths without adding requirements to Fabric descriptors.
Provider profiles use the selected adapter's executable list; inference and search registrations are scoped by image and adapter identity, so different images never combine executable permissions.
An explicit sandbox policy replaces the image's filesystem and process defaults while keeping deployment-managed endpoint grants.

The bundled [`catalog.json`](../../image/fabric/catalog.json) is an offline Fabric discovery snapshot at the revision and checksum pinned in the Dockerfile.
It records canonical descriptors and provenance only, and supports offline authoring; it says nothing about an installed bridge, health, credentials, or inference readiness.
[Regenerate it](../build.md#regenerate-the-bundled-catalog) when the Fabric pin changes.

## Upstream Ownership

All implementation changes for this reference and rollout remain in NemoClaw.
The following boundaries need coordination; these notes do not claim upstream acceptance.

| Owner | Work or agreement |
|---|---|
| NeMo-Fabric | Supply native `live`, `active`, and `ready` health through supported APIs; the pinned backend advertises no health checks until that exists. |
| NeMo-Fabric | Preserve invalid versus unverified validation outcomes through supported APIs; the existing local error-code patch remains necessary at this pin. |
| NeMo-Fabric / NemoClaw | Agree versioned discovery metadata for authoring and configuration/response compatibility, without duplicating Fabric validation in NemoClaw. |
| NeMo-Fabric / NemoClaw | Transfer image, bridge, and shared contract-test ownership when Fabric accepts it; preserve the six-command interface and jointly review contract changes. |
| OpenShell | Qualify completed sandbox stop as the boundary that terminates all old workload processes before start, while retaining required data; request implementation changes only for demonstrated gaps. |

## Observation Limits

The pinned Fabric API exposes a runtime handle's lifecycle state, not a fresh native process or configuration observation.
The host snapshot therefore establishes its remembered public configuration and active handle only.
It records configuration only after successful startup and clears it after a confirmed stop.
Any native file validation performed by an adapter belongs to Fabric; the generic host does not establish that it occurred.
The pinned Fabric has no health API, so every check level returns unsupported with a snapshot and no health report.
Operational checks remain deferred.
Unsupported health fails apply; plan and refresh can still use the snapshot.
See [Fabric health during apply](../usage.md#fabric-health-during-apply) for the user-visible result.
The SDK does not substitute adapter-specific filesystem checks or model prompts.
Deployment ownership, missing bindings, route drift and observation failures continue to use the SDK's existing resource contracts.

## Validation

[Protocol tests](../../image/fabric/test_protocol.py) cover flags and request limits without Fabric, so they also run in the dummy image.
[Host tests](../../image/fabric/test_host.py) cover response limits, generation conflicts, socket ownership, and bounded shutdown.
[Runtime contract tests](../../image/fabric/test_runtime_contract.py) cover configuration readback and installed Fabric invocation.
[Reference tests](../../image/fabric/test_reference.py) exercise positive and failed health, lifecycle failures, validation, and concurrent observations.
The [image command suite](../../image/test_agent_contract.py) exercises the same executable interface in the dummy and every production image.
Its successful dummy health results do not qualify a real adapter’s native health or cleanup through OpenShell.
The existing installed Fabric fixture adapter remains authored and packaged in Fabric.
The separate dummy backend is authored in NemoClaw and exercises the image interface without Fabric.
The [discovery tests](../../crates/nemoclaw-provider/tests/contract/discovery.rs) read that installed discovery output and image metadata through the real OpenTofu/provider planner.
[Bundle fixtures](../contributing/integration-tests.md#opentofu-and-bundle-lifecycle) separately exercise deployment recovery, export/reapply and ownership.

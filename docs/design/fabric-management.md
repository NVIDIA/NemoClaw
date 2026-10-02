<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric Runtime Management

NemoClaw projects deployment intent once into public Fabric configuration.
Fabric discovers adapters, validates their settings and constraints, maps native configuration, and starts their runtimes.
The shared [sandbox host](../../image/fabric/fabric.py) owns command parsing, transport, generation checks, and response envelopes.
Its image-installed [Fabric backend](../../image/fabric/backend.py) calls Fabric's public planner and runtime API; the host contains no adapter registry or native settings translation.

## Responsibility Boundary

| Component | Responsibility |
|---|---|
| SDK | Deployment references, credential registrations, security grants, ownership and resource recovery |
| OpenTofu and providers | Resource dependencies, reads, retained bindings and explicit configuration reconciliation |
| OpenShell | Sandbox lifecycle, isolation and authenticated transport |
| Fabric | Adapter discovery, schemas, native validation, native mapping and execution |
| Authoring | Generic questions from owner schemas, accepted intent and unresolved work |

`nemoclaw_agent_configuration` applies the public Fabric document after sandbox creation and route setup.
Unchanged configuration preserves the active handle; a changed document stops the previous runtime before its replacement starts.
A host process restart waits for explicit apply before starting Fabric so that persisted configuration cannot outrun current gateway routes.
This resource is reconstructible and separate from immutable sandbox identity and retained deployment bindings.
It does not promise conversation continuity across a native runtime restart.

## Bridge Commands

Images provide `fabric-agent` on `PATH`.
The provider uses the image’s advertised command through authenticated OpenShell execution, with each flag and value passed as a separate argument.
`--config` and `--input` take a file path, or `-` to read one JSON value from stdin.
Configuration must be an object; invocation input may be an object or a JSON string and is passed unchanged to Fabric.
For a text-only adapter such as Hermes service mode, supply a JSON string, including its quotes, rather than an object containing a message.
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
Ordinary apply uses configure directly; prepare is an explicit bridge operation.
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
The manifest contains `interface_version`, the six `operations`, a cumulative prefix of native `health_checks` (`live`, `active`, `ready`), and the supported `input_sources`: `file` and `stdin`.
Fields added within an interface version are additive; consumers ignore fields they do not recognize.
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

[Protocol tests](../../image/fabric/test_protocol.py) cover flags, response limits, generation conflicts, socket ownership, and bounded shutdown.
[Runtime contract tests](../../image/fabric/test_runtime_contract.py) cover configuration readback and installed Fabric invocation.
[Reference tests](../../image/fabric/test_reference.py) exercise positive and failed health, lifecycle failures, validation, and concurrent observations.
The [image command suite](../../image/test_agent_contract.py) exercises the same executable interface in the dummy and every production image.
Its successful dummy health results do not qualify a real adapter’s native health or cleanup through OpenShell.
The existing installed Fabric fixture adapter remains authored and packaged in Fabric.
The separate dummy backend is authored in NemoClaw and exercises the image interface without Fabric.
The [production-path test](../../crates/nemoclaw-e2e/tests/discovery.rs) consumes that installed discovery output, calls the real OpenTofu/provider planner, and sends the SDK's configuration through the generic host to the actual Fabric runner.
[Bundle fixtures](../testing/fixtures.md#opentofu-and-bundle-lifecycle) separately exercise deployment recovery, export/reapply and ownership.

## Earlier Experiment

The September 21 experiment used Fabric `6c08337b` with Pi and DeepAgents and passed its local lifecycle scenarios.
It did not establish durable runtime management or fresh native health.
Its NemoClaw controller, mutation ledger and adapter-specific runner have been removed; OpenTofu resource state and Fabric's public runtime API now serve their respective responsibilities.
Historical native qualification records retain their original revisions and do not qualify this implementation.

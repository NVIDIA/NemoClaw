<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric Runtime Management

NemoClaw projects deployment intent once into public Fabric configuration.
Fabric discovers adapters, validates their settings and constraints, maps native configuration, and starts their runtimes.
The generic [sandbox host](../../image/fabric/fabric.py) calls Fabric's public planner and runtime API; it contains no adapter registry or native settings translation.

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
Configuration and invocation input travel in private temporary files inside the sandbox; the provider removes them after the call.

| Command | Behavior |
|---|---|
| `validate --agent NAME --config FILE` | Use the installed Fabric planner without starting a runtime. |
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
The pinned OpenShell does not guarantee that every descendant terminates when the host exits; full process cleanup remains an upstream requirement.
The bridge does not discover or adopt orphaned processes.

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
These tests do not establish native health or cleanup of every descendant through OpenShell.
The installed fixture adapter is authored and packaged solely in Fabric.
The [production-path test](../../crates/nemoclaw-e2e/tests/discovery.rs) consumes that installed discovery output, calls the real OpenTofu/provider planner, and sends the SDK's configuration through the generic host to the actual Fabric runner.
[Bundle fixtures](../testing/fixtures.md#opentofu-and-bundle-lifecycle) separately exercise deployment recovery, export/reapply and ownership.

## Earlier Experiment

The September 21 experiment used Fabric `6c08337b` with Pi and DeepAgents and passed its local lifecycle scenarios.
It did not establish durable runtime management or fresh native health.
Its NemoClaw controller, mutation ledger and adapter-specific runner have been removed; OpenTofu resource state and Fabric's public runtime API now serve their respective responsibilities.
Historical native qualification records retain their original revisions and do not qualify this implementation.

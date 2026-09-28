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

## Observation Limits

The pinned Fabric API exposes a runtime handle's lifecycle state, not a fresh native process or configuration observation.
The host's status therefore establishes its remembered public configuration and active handle only.
Any native file validation performed by an adapter belongs to Fabric; the generic host does not establish that it occurred.
Missing health and probe contracts remain unsupported or unknown in NemoClaw.
The SDK must not replace them with adapter-specific filesystem checks or model prompts.
Deployment ownership, missing bindings, route drift and observation failures continue to use the SDK's existing resource contracts.

## Validation

[Runtime contract tests](../../image/fabric/test_runtime_contract.py) cover unchanged apply, rejected configuration, restart behavior and generic invocation.
The installed fixture adapter is authored and packaged solely in Fabric.
The [production-path test](../../crates/nemoclaw-e2e/tests/discovery.rs) consumes that installed discovery output, calls the real OpenTofu/provider planner, and sends the SDK's configuration through the generic host to the actual Fabric runner.
[Bundle fixtures](../testing/fixtures.md#opentofu-and-bundle-lifecycle) separately exercise deployment recovery, export/reapply and ownership.

## Earlier Experiment

The September 21 experiment used Fabric `6c08337b` with Pi and DeepAgents and passed its local lifecycle scenarios.
It did not establish durable runtime management or fresh native health.
Its NemoClaw controller, mutation ledger and adapter-specific runner have been removed; OpenTofu resource state and Fabric's public runtime API now serve their respective responsibilities.
Historical native qualification records retain their original revisions and do not qualify this implementation.

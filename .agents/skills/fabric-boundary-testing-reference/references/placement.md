<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Placement Rules

Choose the component that decides the outcome, then the cheapest layer in that component's repository that can observe it.
These are placement rules, not a coverage inventory.

## Paired Layers

| Layer | NemoClaw | NeMo Fabric |
|---|---|---|
| Fast | Compilation, validation, configuration projection, mount payloads, graph changes, and CLI rules | Adapter mapping, tool policy, skill paths, state selection, validation, and runtime rules |
| Integration | Plan and apply, target-only replacement, bindings, ownership checks, and recovery, against fixtures | Native loading, dispatch, interfaces, session resume, cancellation, and effects, through the packaged native runtime |
| End to end | Deploy, use, and retain through real images, forwarding, mounts, and an engine or cluster | A complete runtime journey that lower layers can't observe |

In NemoClaw's suites, fast is the unit layer, integration is the contract and integration layers, and end to end is live E2E.
[`write-tests`](../../write-tests/SKILL.md#3-choose-the-layer) picks the suite, and [test layers](../../../../internal-docs/contributing/testing.md#test-layers) describes each.
Fabric's layers follow what a test runs, not its directory; read Fabric's [contributor guidance](evidence.md#read-fabric-at-the-pin) at the pin.

- **Deployed proof** belongs to NemoClaw: real images, forwarding, mount access, physical retention, and engine or cluster recovery, driven through NemoClaw.
- **Runtime proof** belongs to Fabric: a supported Fabric entrypoint through the packaged native runtime to an observable result and cleanup.
- Keep upstream isolation and native semantics with their owners, and keep only thin composition checks at the consumer boundary.

## Lifecycle Phases

Name the phase in which the outcome must hold.
The [upstream boundaries](../../../../internal-docs/design/scope.md#upstream-boundaries) decide the owner; this table only says where to start looking.

| Phase | Start with |
|---|---|
| Configure | NemoClaw's projection of desired state into Fabric configuration; Fabric's validation and native mapping |
| Launch | NemoClaw's sandbox, runtime, and bindings; Fabric's native process start; OpenShell's isolation |
| Interact | Fabric's dispatch of native tools, skills, plugins, and interfaces; OpenShell's network policy; NemoClaw's reported access |
| Change | NemoClaw's plan and target-only replacement; Fabric's handling of the new configuration at start |
| Resume | NemoClaw's retained storage and rebinding; Fabric's and the harness's restoration of native state and sessions |
| Clean up | NemoClaw's destroy and retained data; Fabric's runtime stop |

## Split Composite Requirements

A user-facing requirement often has parts with different owners.
For example, "a plugin the agent installed is still usable after a runtime restart" splits into:

1. NemoClaw keeps the artifacts volume and binds it to the new runtime: a NemoClaw fast or integration test of the graph.
2. The adapter keeps native state on the artifact root rather than in a temporary directory: a Fabric test of the adapter.
3. The native harness loads the installed plugin again in a new runtime: a Fabric integration test through the native runtime.
4. The plugin's files survive a real restart and the agent uses it: a NemoClaw end-to-end assertion, only if parts 1 to 3 can't observe the physical retention.

Place each part separately, and recommend live work only for the part no lower layer can observe.

## Evidence Strength

- A scripted model makes a native process's inputs repeatable. The test still runs the native process, so it is an integration test, and it proves nothing about model behavior.
- A test whose native objects are mocks proves the adapter's handling of them, not native behavior.
- A directory such as `tests/e2e/` or `tests/adapters/` doesn't establish strength; read what the test starts and what it asserts.
- A test that skips without its harness or credentials is evidence only where the owner's CI provides them; check the workflow.
- Configuration or an advertised tool list doesn't prove native execution, denial, or loading.
- An API reply, an HTML fetch, or an allocated pseudo-terminal doesn't prove a usable browser or terminal session.
- Retained bytes don't prove a resumed conversation, and reuse within one runtime doesn't prove resume in a new one.

## Live Assertions

Add a live assertion only for what needs real images, mounts, forwarding, an engine or cluster, or the deployment lifecycle.

- Extend an existing small journey, such as a scenario in `crates/nemoclaw-e2e/tests/e2e/hcl/tests/`, instead of adding a deployment per assertion.
- Keep permutations, such as each mount mode or each tool policy, at lower layers.
- Keep a deployed failure or recovery that no fixture can produce, such as OpenShell refusing a connection or a real engine restarting a container; inject the others at the contract or integration layer.
- Don't multiply harnesses, models, and lifecycle phases into a matrix, and don't raise a time budget; make the test faster or split it.

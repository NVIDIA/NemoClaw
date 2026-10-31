<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric Runtime Management

NemoClaw projects deployment intent once into public Fabric configuration.
Fabric validates adapter settings and constraints, maps native configuration, and runs each sandbox's agent runtime.
Agent images run Fabric's own sandbox bridge, `fabric-agent-ctl`; NemoClaw adds no bridge, adapter registry, or native settings translation of its own.

## Responsibility Boundary

| Component | Responsibility |
|---|---|
| SDK | Deployment references, credential registrations, security grants, ownership and resource recovery |
| OpenTofu and providers | Resource dependencies, reads, retained bindings and explicit configuration reconciliation |
| OpenShell | Sandbox lifecycle, isolation and authenticated transport |
| Fabric | Adapter descriptors, schemas, native validation, native mapping, the sandbox bridge, and runtime execution |
| Authoring | Generic questions from owner schemas, accepted intent and unresolved work |

`fabric_agent` starts the public Fabric document its typed inputs compose, after sandbox creation and route setup.
NemoClaw runs one runtime per sandbox, so any configuration change replaces the sandbox; see [Fabric agents](../provider.md#fabric-agents).
The resource is reconstructible and separate from immutable sandbox identity and retained deployment bindings.
It does not promise conversation continuity across a sandbox replacement.

## Bridge Commands

The image's runtime command is `/opt/fabric/bin/fabric-agent-ctl`.
An OpenShell sandbox launches `fabric-agent-ctl serve`, which owns the control socket at `/sandbox/fabric.sock` and waits for one runtime.
The provider runs the other commands through authenticated OpenShell execution, with each flag and value passed as a separate argument.
It sends configuration and invocation input on stdin in the same execution as the command, so it writes no files into the sandbox.

| Command | Use in NemoClaw |
|---|---|
| `start --agent NAME --config -` | Create a `fabric_agent`: Fabric validates the configuration and starts the sandbox's one runtime, returning its `runtime_id`. |
| `invoke --agent NAME --runtime-id ID --input -` | Send one explicit request; Fabric's run result is returned unchanged. |
| `stop --agent NAME --runtime-id ID` | Remove a `fabric_agent`, or stop a runtime that stopped running before another starts. |
| `check --agent NAME --runtime-id ID` | Refresh a `fabric_agent`: whether its runtime still runs. |

Each command emits one JSON response with `operation`, `status`, `changed`, `result`, and `error`.
Success exits 0; failure and unsupported operations exit 1.
Requests are limited to 512 KiB and responses to 4 MiB.
Diagnostics carry only Fabric's fixed stages and codes, never its messages.
A timeout, malformed response, or disconnection leaves the outcome unconfirmed; callers do not replay starts or invocations.
Fabric's [runtime server documentation](https://github.com/NVIDIA/NeMo-Fabric/blob/e7913b6c473a15095a1b4c3583a127e558e0c124/sdk/python/nemo-fabric-runtime/src/nemo_fabric/runtime_server/README.md) defines the commands.

Fabric can start another runtime in a sandbox after a stop.
After a start whose effects Fabric reports as uncertain, another start returns `runtime_exists`, which the provider reports with guidance to replace the sandbox.
A start whose reply was lost can't be retried safely, because Fabric would start a second runtime beside one the lost start may have left ([NVIDIA/NeMo-Fabric#487](https://github.com/NVIDIA/NeMo-Fabric/issues/487)).
The SDK replaces the sandbox itself whenever a plan would create an agent in an existing one.
`fabric-agent-ctl` does not confirm that an agent's descendant processes stopped; deleting the sandbox does.

## Image Contract and Reference Implementation

Every agent image installs Fabric's runtime, its adapters, and `fabric-agent-ctl` in `/opt/fabric`.
It sets `ADAPTER_PYTHON` to that environment's interpreter, which Fabric uses to run Python adapters.

The dummy reference image installs NemoClaw's [test-only adapter](../../image/fabric/test-adapter) into the same Fabric runtime.
The adapter is packaged like Fabric's own adapters, with its [descriptor](../../image/fabric/test-adapter/dummy.fabric-adapter.json) where Fabric finds installed adapters.
It is installed only in the separate `dummy` target; it is never a fallback for a real adapter.
A deployment runs it with `harness.kind: org.nemoclaw.dummy` and the image's immutable reference; the bundled catalog does not list it.
See [building the reference image](../build.md#reference-contract-image).

The dummy configuration uses `metadata.name` and `harness.adapter_id: org.nemoclaw.dummy`.
Its optional `harness.settings` fields are `reply` (string), `fail_start` (boolean), and `fail_stop` (boolean).
Invocation accepts text, or an object with optional `message` (string), `delay_ms` (integer from 0 to 10000), and `fail` (boolean).
The run result's `output.message` is the configured `reply`, or else the message.
These controls belong only to the reference fixture.

### Image Metadata

`cargo images build` ([source](../../crates/nemoclaw-build/src/images.rs)) builds each image's `catalog` stage, which runs [`catalog.py`](../../image/fabric/catalog.py) without starting an adapter, then its `labeled` stage with the result as `io.nemoclaw.fabric.catalog`.
A Dockerfile can't set a label from something its own build computes, so the catalog passes between the two builds as a build argument, and the `labeled` stage fails unless it matches the installed catalog.
Each harness stage declares its adapters, their files, their executables, and any paths their harness writes beyond the image's default policy in `/opt/nemoclaw/adapters.json`.
The catalog adds those paths, such as the terminal devices the Hermes image declares for browser chat, to that image's `runtime.policy.filesystem_policy.read_write`; other images' default policies are unchanged.
The descriptors come unmodified from Fabric's `nemo-fabric-adapter-catalog` package; an adapter Fabric does not publish, such as the test adapter, declares the descriptor file its package installed.
Direct Docker Bake builds attach no metadata.

| Image file | Contents |
|---|---|
| [`/opt/nemoclaw/runtime.json`](../../image/fabric/runtime.json) | The `fabric-agent-ctl` command, environment, required read paths, and default filesystem and process policy; `schema_version: 1` |
| `/opt/nemoclaw/runtime-files.json` | Additional runtime directories for each adapter, written by its Dockerfile stage; the catalog records them as `runtime_files` |

Installed catalog generation records the runtime manifest under `runtime`.
[`runtime_metadata.py`](../../image/fabric/runtime_metadata.py) resolves each adapter's declared executables through the declared `PATH` and records canonical paths beside the unchanged descriptor.
Each adapter also records the `ADAPTER_PYTHON` interpreter path, because Fabric runs Python adapters with it.
A missing manifest, required path, or executable fails catalog generation; image tests check that runtime directories exist and are readable by the runtime user.

The SDK validates this metadata during image discovery and compiles it into each sandbox's launch and policy, retaining the binding in state and OpenShell annotations for refresh and teardown.
Explicit filesystem grants are checked against the image-owned paths without adding requirements to Fabric descriptors.
Provider profiles use the selected adapter's executable list; inference and search registrations are scoped by image and adapter identity, so different images never combine executable permissions.
An explicit sandbox policy replaces the image's filesystem and process defaults while keeping deployment-managed endpoint grants.

The bundled [`catalog.json`](../../image/fabric/catalog.json) is the descriptors of the adapters NemoClaw builds images for, from Fabric's catalog package at the revision and checksum pinned in the Dockerfile.
It supports offline authoring; it says nothing about an installed runtime, credentials, or inference readiness.
[Regenerate it](../build.md#regenerate-the-bundled-catalog) when the Fabric pin changes.

## Upstream Ownership

The following boundaries need coordination; these notes do not claim upstream acceptance.

| Owner | Work or agreement |
|---|---|
| NeMo-Fabric | Report a harness process that exited as failed rather than unknown, so refresh can start it again ([NVIDIA/NeMo-Fabric#298](https://github.com/NVIDIA/NeMo-Fabric/issues/298)). |
| NeMo-Fabric | Configuring OpenClaw's web search ([#13361](https://github.com/NVIDIA/NemoClaw/issues/13361)). |
| NeMo-Fabric | Reporting each runtime's interfaces from its handle, instead of the P0 conventions NemoClaw follows ([NVIDIA/NeMo-Fabric#565](https://github.com/NVIDIA/NeMo-Fabric/issues/565)), and interface tokens the agent's own tools can't read, an interface check, and exposed service URLs ([NVIDIA/NeMo-Fabric#566](https://github.com/NVIDIA/NeMo-Fabric/issues/566)). |
| OpenShell | Qualify completed sandbox stop as the boundary that terminates all old workload processes before start, while retaining required data; request implementation changes only for demonstrated gaps. |

## Observation Limits

Refresh asks Fabric's `check` whether the recorded runtime still runs, and apply starts a stopped runtime again in its sandbox.
Fabric doesn't report the configuration a runtime applied, and reports a harness process that exited as unknown, which counts as running; such a runtime is found at its next invocation.
The SDK does not substitute adapter-specific filesystem checks or model prompts.
Deployment ownership, missing bindings, route drift and observation failures continue to use the SDK's existing resource contracts.

## Validation

[Reference tests](../../image/fabric/test_reference.py) run the dummy agent through a real `fabric-agent-ctl` in the reference image.
[`cargo images qualify`](../../crates/nemoclaw-build/src/images.rs) starts, invokes, and stops a runtime through `fabric-agent-ctl` in the dummy image; production images get only its assembly checks, since Fabric tests its own adapters.
[Catalog tests](../../image/fabric/test_catalog_contract.py) cover image catalogs and runtime metadata.
The provider's [bridge client tests](../../crates/nemoclaw-e2e/tests/fabric_bridge.rs) and the [Fabric contract tests](../../crates/fabric-provider/tests/contract) cover starts, invocations, stops, and lost replies against the fake gateway.
[Bundle fixtures](../contributing/integration-tests.md#opentofu-and-bundle-lifecycle) separately exercise deployment recovery, export and reapply, and ownership.

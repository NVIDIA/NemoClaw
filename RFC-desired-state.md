<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Desired-state SDK experiment

This document records the architecture being tested on the Rust `v1` branch.
The accepted experimental scope and accountable maintainer are in [DESIGN.md](DESIGN.md).
Project adoption remains a separate decision. The historical RFC and Go evidence
remain on `v1-poc`, pinned at `b549ccd43e6102b72aa9c65ee17abfe3c429fc0b`.

## Public contract

The SDK owns `plan`, `apply`, `export`, and `destroy`. The CLI delegates those
operations and handles arguments, terminal output, signals, and exit codes.
Programmatic callers use the same validation, deployment lock, saved-plan checks,
resource bindings, secret references, cancellation, and recovery paths.

```sh
nemoclaw plan < deployment.yaml
nemoclaw apply < deployment.yaml
nemoclaw export > exported.yaml
nemoclaw plan --destroy
nemoclaw destroy
```

A deployment UID identifies intent. Random generation tokens identify creation
operations. OpenTofu state records physical identities and the configurations
actually established. Intent may describe a replacement while state still binds
the old process; deletion must verify that old configuration.

Unknown fields, inline credentials, conflicting provider forms, mutable artifact
pins, and unsupported combinations fail validation before runtime mutation.
Agent image, runtime and isolation defaults belong to the schema version.
A managed inference service declares a qualified backend, pinned image and model,
bounded serving settings, and memory policy. There are no shell hooks or arbitrary
argument fields.

## What the implementation has confirmed

The Rust provider can use the existing OpenTofu protocol as a separate process.
The CLI bundle contains the CLI, OpenTofu, and one provider executable in a known
mirror path. Source-derived provider versions prevent stale installations from
being reused after a build. The public SDK does not embed OpenTofu or expose its
raw graph as a user configuration mechanism.

Refresh and export share typed readers. The pinned Go reference retired osquery
in favor of the owning OpenShell, Docker, and model APIs; the Rust port follows
that boundary. The relevant observations are resource identities, configuration,
policy, and complete model inventories. A host inventory collector would not
replace the owning APIs for these checks. Capacity uses local host and GPU facts;
credential references, intent and OpenTofu state remain local. Mutations and
active readiness or inference probes remain direct.

Only confirmed resource absence permits removal from provider state. Failed
authentication, permission checks, transport, incomplete results, and identity
or policy mismatches stop planning and retain bindings. Bound persistent storage
must never be recreated automatically, even when its absence is confirmed.
Export writes YAML only after all required observations succeed.

The managed graph separates gateway storage, gateway process, model storage,
and inference process. The gateway storage binding covers its database volume,
bridge, initializer and signing identity. The gateway process additionally binds
the persisted encryption key. A bound initializer cannot generate credentials
again. Inference storage retains both the exact model snapshot and prepared data.
Process replacement requires an independently verified storage binding.

OpenShell cannot be planned before a new managed gateway exists. Apply therefore
executes two separately checked graphs: runtime infrastructure, then OpenShell
registration, routing, and sandbox resources. A fresh plan reports the second
graph as deferred. Plan never starts containers, downloads models, prepares data,
or invokes the upstream launcher's `--no-launch` path.

Configuration and readiness are separate. A process can exit immediately after
start while retaining valid identity and storage. Managed `running` is computed
and becomes unknown during create or an explicit restart, so OpenTofu does not
taint a valid resource merely because startup failed. The runtime has the full
configured loading budget; model download and preparation have separate bounds.
The resident supervisor samples memory independently of readiness probes, stops
its own process group, and latches after a protective shutdown. Docker restart is
disabled. Explicit apply rechecks capacity before recovery.

Destroy checks both complete saved plans before the first deletion, removes
OpenShell children before managed processes, and persists the completed graph
boundary. It retains the workspace, storage, keys, bridge, initializer, images,
and local state. An interrupted destroy can resume after the gateway disappears.
It cannot infer ownership from missing local state or delete a whole workspace
with an unverified cascading operation.

## Costs and hypotheses still to test

Rust does not remove protocol or packaging work. The pinned high-level OpenShell
Rust client omits mTLS, so the SDK uses its generated tonic clients with explicit
certificate and bearer references. The real OpenTofu test exposed a Rustls
backend-selection panic after HTTP dependencies were added. Selecting the plugin
transport's crypto backend explicitly fixed that failure. Protocol tests run
against the complete production binary. Authenticated wire tests now cover valid
mTLS/bearer references and reject incorrect server trust, client trust, bearer
values, and missing key files without mutation or disclosure. A stalled exec
stream demonstrated that a gRPC deadline alone was insufficient; the SDK now
bounds the complete call and retains uncertainty about invocation effects.

Native builds need a C toolchain and Protocol Buffers compiler. Native bundles
and protocol/lifecycle fixtures pass on Linux ARM64/x64, macOS ARM64/Intel, and
Windows x64. Managed gateway and GPU execution are qualified on Linux ARM64.
Native CLI availability does not establish container or GPU backend support on
every platform. Podman topology still requires its own evidence.

The model runtime retains the recipe archive, original and patched sources,
preparation tools, licenses, Rust source and vendored dependency licenses. The
builder normalizes timestamps and rejects changing source inputs during a build.
An independent offline rebuild from another extraction directory produced an
identical supervisor binary hash. The archive must include OpenShell protobuf
inputs omitted by Cargo vendoring, and the build must use that exact vendor
layout to avoid dependency-path differences. Source
packaging and dependency maintenance count toward the architecture's cost.

The Go Ollama boundary combines a container and model volume, with a separate
model resource. A stopped parent prevents authoritative model inventory, which
can block repair planning. Destroy remains unsupported for that combined resource.
The Rust SDK/provider bundle now passes plan, initial apply, export/reapply,
no-op, and failed-inventory tests with one container creation and one model pull.
Parity preserves the explicit destroy limitation; splitting it requires a separate
recovery and storage-retention contract.

Managed apply also exposed a Rust async allocation cost that the release CLI
hid: composing several debug-build SDK calls overflowed a normal executor
thread stack. Public plan/apply now heap-allocate their orchestration future,
with a tested per-operation stack-size budget. SDK qualification must exercise
its public API directly as well as its CLI consumer.

The live watchdog run also exposed an inherited observation assumption:
`MemAvailable` is an estimate after kernel reserves, so it may be less than
`MemFree`. Validate each against total memory independently. The old supervisor
reported pressure and sampling failure identically; that message could not
establish the cause of its live stop. Distinct diagnostics and measured pressure
values are required for recovery evidence. See the [kernel memory field definitions](https://www.kernel.org/doc/html/v6.5/filesystems/proc.html).

## Acceptance evidence

[Validation records](docs/validation/) distinguish deterministic failure tests,
protocol qualification, native runtime execution, and remaining platform limits.
The Rust gateway experiment passed initial create, no-op, retained-storage
destroy, and explicit recovery. The [Spark run](docs/validation/rust-spark-linux-arm64.json)
passed a fresh model download, verified PLE preparation, actual OpenClaw reply,
unchanged apply without download or preparation, export/reapply, safe capacity
rejection, and watchdog shutdown followed by explicit recovery. Image replacement
changed only the inference process identity. Initial loading took 670 seconds,
confirming the need for a multi-minute loading budget with headroom. Deterministic
fixtures cover interrupted preparation, failed startup, and failed observations;
live interrupted downloads resumed without losing their storage or binding.

The [parity matrix](docs/validation/README.md) covers the supported Fabric and
native agent interfaces, real Ollama reconciliation, five native bundle targets,
and their documented limitations. The Rust implementation now meets that pinned
experimental scope. No reduction in maintained code or overall maintenance cost
has been measured.

Live qualification also found a compatibility boundary absent from YAML shape:
Hermes rejects the Spark service's 32K context at startup because it requires
at least 64K. Its retained Go-compatible Ollama/Qwen3 path passed a short native
response; that does not establish long-context capability. Do not falsify model
metadata or widen isolation policy to make readiness pass. Backend/agent
compatibility needs evidence beyond successful provider registration.

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
transport's crypto backend explicitly fixed that failure. Protocol tests must
run against the complete production binary, not only a fixture provider.

Native builds need a C toolchain and Protocol Buffers compiler. Native Linux
ARM64 bundle and managed-gateway execution are qualified. Building and executing
on macOS and Windows remain distinct gates; selecting a target is not evidence
of runtime support. Podman topology also requires its own evidence.

The model runtime retains the recipe archive, original and patched sources,
preparation tools, licenses, Rust source and vendored dependency licenses. The
builder normalizes timestamps and rejects changing source inputs during a build.
Reproducibility must be demonstrated with matching artifact digests. Source
packaging and dependency maintenance count toward the architecture's cost.

The Go Ollama boundary combines a container and model volume, with a separate
model resource. A stopped parent prevents authoritative model inventory, which
can block repair planning. Destroy remains unsupported for that combined resource.
Parity preserves this explicit limitation; splitting it requires a separate
recovery and storage-retention contract.

## Acceptance evidence

[Validation records](docs/validation/) distinguish deterministic failure tests,
protocol qualification, native runtime execution, and outstanding live gates.
The Rust gateway experiment has passed initial create, no-op, retained-storage
destroy, and explicit recovery. The full Spark gate still requires an actual
agent reply, unchanged apply without download or preparation, export/reapply,
safe capacity rejection, and watchdog shutdown followed by explicit recovery.
Failure fixtures must cover interrupted downloads and preparation, failed startup,
and observation failures without accidental recreation or data loss.

Parity also includes the supported Fabric and native agent interfaces, Ollama
operations, the five bundle targets, and their documented limitations. Passing a
subset does not establish parity or a measured reduction in maintained code.

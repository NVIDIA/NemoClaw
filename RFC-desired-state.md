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

## Runtime boundaries

The runtime crate follows process lifetime, not hardware identity. It builds one
`nemoclaw-runtime` executable. Within the existing crates:

| Concern | Owner |
|---|---|
| Process lifetime, cancellation, status, readiness deadline | Shared runtime supervisor |
| Memory measurements, GPU detection, capacity and protection rules | Hardware modules and validated profiles |
| Snapshot pins, preparation identity, PLE tools, patches and model tuning | Versioned recipe artifacts and their typed adapter |
| Launch arguments and readiness probe | Backend modules |

The recipe selects a qualified backend/hardware combination. The existing YAML
backend identifier remains unchanged for compatibility; this refactor does not
add supported combinations or an arbitrary launch-argument mechanism. A new
hardware profile or backend normally adds a module and qualification evidence.
A crate is justified by a dependency or deployment boundary, not a new GPU name.

Acceptance uses a real fixture process with no Spark configuration to exercise
supervisor deadlines, cancellation, readiness, pressure and failed observations.
A separate HTTP fixture exercises backend readiness. Reference preparation keys,
capacity decisions and the observed pre-refactor vLLM argument vector protect
compatibility. The live image-upgrade gate must preserve storage receipts and all
independent resource identities, then return an actual agent response and an
unchanged export/reapply. These tests establish separation for this recipe; a
second real backend remains the next test of how well the modules generalize.

The [refactor acceptance run](docs/validation/rust-runtime-boundaries-linux-arm64.json)
passed the live image upgrade in 646 seconds. Only the inference process identity
changed; cached artifact receipts and every independent binding were preserved.
The agent replied `FOUR`, followed by unchanged apply and export/reapply. An
independent offline rebuild produced the same runtime executable hash. This
qualifies the separation against the existing recipe, not another backend.

## One OpenClaw deployment path

OpenClaw uses Fabric (`harness: openclaw`) for both external and
managed dependencies. The standalone Node bootstrap and its image recipe are
removed. Gateway and inference ownership do not require a different agent
launcher. Fabric owns the native OpenClaw gateway; native commands and channel
settings remain available through sandbox access. Other harnesses retain their
external-service qualification boundary.

Missing or unsupported runtime labels are failed observations, never absence.
Old standalone state is not silently converted; its previous bundle remains
necessary for export or teardown. Sandbox identities and agent data are not
migrated by changing the agent type in YAML.

The agent schema has only `name`, `harness`, and `inference`. A constant
`type: fabric` added no selection, so it is removed. The harness still determines
the same `fabric-<harness>` runtime identity and OpenTofu resource graph.
Configuration digests change because the serialized document changes; old
retained intent is not automatically migrated.

## Model choice is data, not a compiled recipe constant

The generic `vllm` backend accepts a public Hugging Face repository and immutable
commit without a model allowlist. Runtime image compatibility is bound to the
backend, not to a model revision label. The served model name follows the
repository, and model storage identity includes both repository and revision.

The model resolver discovers a checksummed inference snapshot. Plan may read
remote metadata but cannot download weights into runtime storage or prepare a
model. Apply retains the manifest and resumable downloads; subsequent observation
uses that retained manifest and completion receipts. Authentication, transport,
partial inventories and changed artifacts are errors, never resource absence.

The experiment keeps the PLE recipe for Qwen3.8 separate from ordinary safetensors
loading. A different model must not inherit its memory estimate, MTP, parser,
cache dtype or preparation tools. Generic serving declares a total GPU budget
and optional native parsers; the existing hardware profile and resident memory
protection remain shared. Compatibility still depends on the selected image,
model architecture and available capacity. Supporting arbitrary repository names
does not establish support for remote model code or every checkpoint format.

Live model selection exposed two independent compatibility boundaries. Qwen3-0.6B
loaded and answered the first agent probe, but failed the repeated reply contract.
Qwen3-4B required 4.5 GiB of KV cache for a 32K context, so the initial 4 GiB
setting failed startup safely; declaring 6 GiB allowed it to load from the retained
snapshot. Weight size alone cannot prove that serving settings or agent behavior
will work. Keep those failures explicit rather than treating a downloadable model
as a qualified agent backend or weakening the agent probe.

With the corrected settings, Qwen3-4B passed actual Fabric OpenClaw replies,
unchanged apply, export/reapply, and watchdog stop with explicit recovery. Resource
identities and snapshot receipts stayed stable during recovery; intentional destroy
retained storage, and a later apply reused it. The same generic runtime image served
both tested models. See the [retained evidence](docs/validation/rust-selected-model-linux-arm64.json).

## Execution-target preparation

Decision: Accept for the preparatory experiment requested by cvillela. Keep the
existing YAML, resource addresses and binding encodings during connection-plumbing
work. cvillela owns acceptance; two-engine fixtures and a separately recorded live
OpenShell/Podman proof are the validation gates. This does not qualify Podman or
remote deployment merely because a Docker-compatible client connects.

A connection alias selects transport details. A durable execution target identifies
the daemon and its storage/account namespace. A hostname, socket pathname or alias
is not sufficient identity. Rootless and rootful engines on one host are different
targets. Changing connection details may preserve a target only after observing
and matching its identity; changing target requires explicit migration, never
adoption or cleanup by resource name. Credential rotation does not migrate a
resource. Missing or failed identity observations stop operations. This preparation
keeps the existing stricter endpoint-change behavior until migration is implemented.

One gateway owns one sandbox execution target. Inference may be elsewhere, reached
through an explicitly resolved inference connection. No per-sandbox engine placement
is promised. Validate OpenShell's configured Docker-compatible socket before adding
engine selection to YAML. Do not introduce a generic provider framework or remote
observation agent in this preparation.

Capacity observations belong to an execution host, while `/proc` and `nvidia-smi`
belong to the process that reads them. A remote daemon's architecture does not prove
that local memory, GPU or disk observations belong to it. Missing remote capacity
must fail, never fall back to local measurements. The resident supervisor remains
responsible for its own execution host's immediate checks and memory protection.

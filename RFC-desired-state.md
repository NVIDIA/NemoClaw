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

The first extraction introduces an explicit host-observation boundary. Capacity
rules consume measurements tagged with the selected daemon identity; missing,
incomplete, or mismatched observations fail. The default collector is still the
qualified local Linux collector. An injected observer never falls back to it.
This establishes a test seam, not remote-host detection or a remote observation
agent. In-process SDK connection injection does not serialize transport clients
or observers into OpenTofu subprocesses; those still use the explicit compiled
endpoints. Remote placement must address that boundary before it is exposed.

Inference connection resolution now returns the upstream URL and credential
reference as one value, independently of sandbox engine selection. The current
managed local topology still publishes through its bridge; that remains a local
publication rule, not a proposed cross-host address. External inference keeps its
explicit URL. Plan performs no reachability probe. Apply tests the route from the
sandbox through OpenShell; a failed probe retains bindings for explicit recovery.

Upstream inspection found a native OpenShell Podman driver in the pinned gateway.
It uses Podman image volumes, secrets and rootless networking rather than merely
substituting a socket in the Docker driver. Manual qualification must exercise
that driver and record daemon identity behavior by rootless/rootful namespace.
The rootless Linux ARM64 proof now exercises the native driver on Podman 4.9.3.
It accepts the client's v5.0.0 API requests and runs Fabric OpenClaw with inference
on the existing Docker host. Isolated egress returns a policy denial, while the
OpenShell inference route returns an actual agent reply. Unchanged apply and
export/reapply preserve sandbox and hosted-runtime identities.

Two assumptions failed in this proof. Podman's Docker-compatible `/info.ID`
changes across requests to the same API service, so it cannot back our durable
execution-target binding. Podman resource support needs a separately qualified,
persistent namespace identity; do not derive it from a socket, hostname or this
compatibility field. The fixture identity contract remains valid, but its Docker
implementation is not a Podman implementation.

The native driver's 45-second graceful stop also exceeds the SDK's old 30-second
RPC deadline. Sandbox deletion now has a bounded 90-second budget; ordinary reads
remain bounded at 30 seconds. The failed first deletion retained state, and an
explicit destroy reconciled confirmed absence. No automatic mutation retry was
added. The live proof and a delayed-delete fixture protect the correction.

This result covers an external native OpenShell gateway and rootless Podman
sandboxes on this Linux host. Managed Podman gateway/inference resources, rootful
operation, remote placement and other operating systems remain unqualified.
See the [Podman evidence](docs/validation/rust-podman-rootless-linux-arm64.json).

The next transport slice accepts explicit `ssh://user@host:port` Docker endpoints
in the SDK. It uses OpenSSH and `docker system dial-stdio`, requires existing host
trust, and does not retry mutations. Remote capacity defaults to unavailable;
selecting SSH never assigns the local host collector. Real loopback SSH tests
exercise daemon identity, absence, denied authentication/host trust and artifact
upload/download. They qualify the transport, not remote provisioning, network
reachability between hosts, or remote GPU observation. No engine-selection YAML
or inference tunnel is introduced by this slice.

The remote-model slice accepts independent service placement and publication.
Decision: Accept for the v1 experiment at the user's direction; the requesting
maintainer owns the experiment and its separate-host qualification gate. A
service's placement selects a Docker SSH connection and private container
network. Its publication selects the private host interface and URL that
OpenShell can reach. An external gateway may use the qualified native Podman
driver. There is no inference tunnel, generic provider framework, or per-sandbox
engine selection in this change.

Implementation found that the remote model must not depend on a gateway
container or gateway storage. Its process depends only on its retained model
storage, and it creates its own owned network. Gateway connection changes do not
alter the remote model specification. Destroy checks the storage required by
each process rather than assuming every process has gateway storage. Explicit
SSH placement and publication are optional, preserving existing local specs.

The SDK and provider subprocess reconstruct the same fixed, read-only SSH host
collector. It reads Linux memory, GPU and Docker-storage capacity on the selected
execution host, associates measurements with the daemon ID, and rejects missing
or mismatched observations. It requires existing host trust, Python 3, Docker
and NVIDIA tooling; it installs nothing and accepts no shell hooks. Capacity
preflight and immediate startup checks remain direct. Refresh and export retain
the shared typed osquery observation path. This bounded collector does not yet
justify an installed remote observation agent.

Fixture qualification covers read-only plan, insufficient and missing capacity,
failed startup with stable identity, explicit recovery, no-op, export/reapply,
transport failure, daemon retarget rejection and destroy with retained data.
Real loopback SSH qualifies the collector against this Spark's Docker daemon.
A separate-host GPU apply and an agent reply across that host boundary remain
required before claiming live remote deployment qualification. The example
requires preloaded pinned runtime images and a private routable IPv4 interface;
the current managed model hardware profile remains Linux ARM64 DGX Spark.

Preparing a second Docker daemon exposed a storage observation assumption before
live startup: volume verification hard-coded /var/lib/docker. It now checks the
selected daemon's reported DockerRootDir and rejects missing roots, traversal,
and volume paths outside that root. Ownership labels, generation, volume
configuration and durable daemon/container identities remain required. The
remote lifecycle fixture uses a non-default root to exercise this through the
CLI and provider; a fixture result does not qualify the two-daemon live setup.

The two-daemon live experiment now qualifies SSH-managed inference with an
external native OpenShell gateway and rootless Podman sandbox on this Spark.
The second Docker daemon had a separate containerd, data root, socket, daemon
identity and network namespace. OpenClaw answered FOUR through OpenShell using
the pinned Qwen3-4B service. Plan created no runtime resources; an oversized
capacity request failed before allocation.

An interrupted download retained partial files and the established container.
Explicit apply completed the snapshot without replacing the container.
No-op and export/reapply preserved model-file timestamps and runtime bindings.
Transport failure and retargeting the same SSH alias to the original daemon
stopped plan and preserved state bytes, despite identically named, owned
fixtures on both engines. Destroy touched only the selected engine and retained
the model volume and completion receipt.

The resident supervisor also handled its explicit protection-trip signal after
the CLI exited, stopped inference without an automatic restart, and recovered
on explicit apply with the same container and model data. Memory-threshold
behavior remains covered by fixtures; the live test did not exhaust host memory.
Managed applies still perform the actual agent-reply probe when resource plans
are unchanged.

The experiment confirms that connection selection, publication and durable
daemon identity are separate concerns. Both daemons share physical capacity:
a distinct daemon ID does not imply another GPU or memory pool. Network
namespaces exercise routing isolation but do not qualify a separate physical
host, WAN behavior, or another operating system. The daemon fixture must retain
cgroup mount visibility and use an isolated containerd; these are fixture
requirements, not reasons to add another product execution framework.

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed bootstrap protocol

This directory defines a dormant, driver-neutral transaction contract, its
first driver adapter, and an injectable sandbox-create lifecycle. Production
runtime bundles still report bootstrap as unsupported, so the candidate
lifecycle remains inert. The shared finalization path keeps existing Docker
recreation reversible through later Ready, GPU, and local-inference checks.

The protocol binds one random bootstrap identity to:

- the expected managed-image manifest digest and startup-profile fingerprint;
- the Ready sandbox and immutable runtime receipts;
- the exact captured supervisor `argv`;
- the replacement runtime, spec hashes, and image-owned completion receipt; and
- an identity-bound rollback receipt when any stage fails.

The coordinator deliberately exposes two phases. Preparation may create and
inspect a stopped replacement, but it cannot alter the Ready held workload.
Activation first records a complete, fingerprinted authority receipt through
the injected durable store; only then may the provider quiesce or replace the
original runtime. Provider results are copied into deeply frozen coordinator
authority. Rollback finalization receipts must prove either restoration of the
exact captured snapshot or exact workload absence. Commit receipts instead
prove the committed outcome without reporting rollback state and may leave
`heldWorkloadRemoved` false while provider-owned cleanup remains.

An incomplete `createHeldWorkload` call is cleanup-eligible only after its
`launch` callback returns a validated Ready receipt with the exact materialized
sandbox identity. A `createHeldWorkload` throw or return before that receipt
cannot trigger cleanup against the planned sandbox name; after receipt
validation, both the cleanup request and its result are bound to the exact
sandbox ID.

`scripts/managed-bootstrap-entrypoint.c` defines the image-owned native boundary
that the later all-agent packaging slice will compile as a freestanding Linux
amd64 or arm64 artifact and install as
`/usr/local/bin/nemoclaw-managed-bootstrap`. The artifact must have no dynamic
ELF interpreter, dynamic section, undefined symbol, or C library startup. Its
entry point uses direct Linux system calls. It copies the bounded supervisor
environment into a sealed in-memory file, reserves that transport as file
descriptor 9, and invokes absolute Bash with no startup files and a fixed
bootstrap environment. Environment values never enter bootstrap argv. The
non-executable `scripts/managed-bootstrap-trampoline.sh` body therefore cannot
expose a root dynamic loader or Bash interpreter to ambient process controls
before request validation.

The body validates the fixed, root-owned request and its identity binding,
verifies the matching completion, and closes the sealed transport for every
application and verification helper. It then re-enters the static boundary
through absolute `env` with only a fixed resume marker and the sealed descriptor.
The native resume mode verifies the seals and declared bounds, reconstructs the
byte-exact environment, marks the transport close-on-exec, and applies the
captured environment only to the final supervisor `execve`. This preserves
environment order, duplicate assignments, process-control values, and exact
supervisor argument boundaries. The values do not enter bootstrap argv or
bootstrap-helper environments. They are restored only for the long-lived
supervisor.

Bootstrap apply and verification run under their own `env -i` with the fixed
environment `HOME=/root`, `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`,
`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, and
`NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1`. Runtime providers remain
responsible for binding the complete replacement process specification,
including its supervisor environment, to immutable prepared authority before
activation. The native boundary introduces no driver-specific environment
policy.

The Docker-specific layers define a private, monotonic cutover journal, a
canonical launch-spec normalizer, and an injectable provider create lifecycle.
The candidate provider surface composes these layers without registering them
in a production runtime bundle. It remains inert, while the shared finalization
surface extends rollback ownership for the existing Docker compatibility and
startup recreation paths.

The Docker adapter creates and validates a stopped replacement under an
identity-derived staging name while the original remains running. It stages the
0400 envelope and returns exact cleanup authority without quiescing, renaming,
or otherwise mutating the original. Only after the coordinator durably records
that complete prepared authority may activation journal both full runtime IDs,
all three names, both launch-spec hashes, image identity, profile fingerprint,
and sandbox ID and then enter the destructive cutover. Post-cutover rollback
publishes `rollback-authorized` before exact replacement deletion; pre-cutover
staged cleanup removes only the exact prepared replacement without that journal
transition. Commit publishes `shared-state-committed` before exact backup
deletion. Cleanup is bound to full runtime IDs. Its private state root retains
versioned, identity-addressed transaction records containing the provider and
sandbox identities, plan and profile
fingerprints, exact original and replacement IDs, rollback target, and phase.
Exact commit and cleanup receipts are durable terminal records, so adapter
recreation does not depend on process-local transaction sets or tombstone maps.
The image-owned shared-state transaction uses the same identity-bound model: a
commit atomically moves its pending manifest and backups into a durable receipt
namespace, compacts that state to an exact commit receipt, and rejects rollback
when a later image-runtime invocation reads that receipt. The provider may
retire that receipt only after it proves the external rollback backup is gone,
so that this receipt does not block the next bootstrap attempt.
Direct identity lookup reconstructs one known transaction record. The bounded
[3.12b recovery slice](https://github.com/NVIDIA/NemoClaw/issues/7744) introduces
unfinished-record enumeration together with phase reconciliation and
cross-surface resume or rollback. The adapter reads mutable OpenShell names only
to detect ownership reuse. Unsafe name-only deletion returns a typed retention
error. The dormant adapter assumes the protocol's single coordinator;
multi-process lease/arbitration remains an explicit production-activation gate.
Activation must also inject the selected gateway's canonical state root.

## Architectural disposition

The runtime-provider bundle is the only bootstrap registration boundary. The
candidate Docker surface owns create routing, replacement construction,
native-to-compatibility fallback evidence, and deferred commit or rollback.
Central onboarding accepts that provider-neutral surface without a Docker or
Podman selection branch. Tests register an MXC-style surface through the same
bundle and render held launches for OpenClaw, Hermes, and LangChain Deep Agents
Code.

The coordinator remains the driver-neutral transaction authority: its receipt
shapes, normalization, state transitions, and rollback proofs form one cohesive
boundary, while provider-specific routing and runtime operations stay outside
it.

This is executable, bounded groundwork rather than an untested placeholder.
`adapter.test.ts` drives prepare, durable record, activation, finalization, and
failure rollback for OpenClaw, Hermes, and LangChain Deep Agents Code through an
MXC-named fake driver. `runtime-provider-contract.test.ts` registers both the
dormant Docker candidate and an MXC-style bootstrap surface through the same
provider bundle contract without changing the production registry.
`runtime-provider-source-shape.test.ts` separately inventories the protocol,
provider, and image-packaging surfaces and proves that production activation
does not select a driver-specific bootstrap implementation.

The native entrypoint source is intentionally not compiled into production
artifacts, and neither image-owned source is installed or selected in a runtime
image yet. Production onboarding imports only the provider-neutral create
contract; no activation path or registered provider imports or selects the
driver-specific Docker candidate. The current image definitions do not package
`nemoclaw-managed-startup-hold`,
`managed-startup-image-runtime.cjs`, or the shared-state bootstrap modes consumed
by the adapter. Later persistence and qualification slices must compile and
verify the freestanding entrypoint for amd64 and arm64 in every agent image, add
the image-runtime prerequisites, and provide the canonical durable authority
store. The remaining integration and qualification work is tracked in
[epic #7744](https://github.com/NVIDIA/NemoClaw/issues/7744). Until that complete
boundary passes protected E2E, every production runtime provider keeps
bootstrap unsupported.

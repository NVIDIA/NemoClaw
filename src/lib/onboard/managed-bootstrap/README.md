<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed bootstrap protocol

This directory defines a dormant, driver-neutral transaction contract. It does
not register a runtime provider or change sandbox creation, onboarding,
snapshot, clone, or restore behavior.

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

The first Docker-specific groundwork defines a private, monotonic cutover
journal and a canonical launch-spec normalizer. Each surface is independently
validated and remains dormant: no registered runtime provider imports either
module, and neither changes sandbox creation or lifecycle behavior.

## Architectural disposition

The coordinator deliberately lands as a dormant trust-boundary slice before a
provider or image activates it. This keeps the driver-neutral transaction
authority review separate from the first driver implementation instead of
making that implementation the de facto central contract. The coordinator
module remains cohesive because its receipt shapes, normalization, state
transitions, and rollback proofs form one authority boundary; provider-specific
logic must live outside it rather than growing this file.

This is executable, bounded groundwork rather than an untested placeholder.
`adapter.test.ts` drives prepare, durable record, activation, finalization, and
failure rollback for OpenClaw, Hermes, and LangChain Deep Agents Code through an
MXC-named fake driver. `runtime-provider-source-shape.test.ts` separately
inventories the protocol, provider, and image-packaging surfaces and proves that
production activation cannot import or package the protocol yet. The later
activation slice must add a registered-provider contract test for the same
transaction before removing those dormancy assertions.

The native entrypoint source is intentionally not compiled into production
artifacts, and neither source is packaged or selected yet. No production
TypeScript module imports this protocol. The current image definitions do not
package `nemoclaw-managed-startup-hold` or
`managed-startup-image-runtime.cjs`. A later
provider integration must compile and verify the freestanding entrypoint
natively for amd64 and arm64 in every agent image. It must add those
prerequisites together with their image-runtime bootstrap modes, implement
driver-specific prepare, durable-record, activate, exact cleanup, and rollback,
and only then wire the coordinator into create. The same contract is exercised
for OpenClaw, Hermes, and Deep Agents Code without a provider-specific central
switch. The remaining integration and qualification work is tracked in
[epic #7744](https://github.com/NVIDIA/NemoClaw/issues/7744) and its linked
implementation stack. Until that complete boundary lands, every registered
runtime provider keeps its bootstrap surface unsupported.

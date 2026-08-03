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

`scripts/managed-bootstrap-trampoline.sh` defines the image-owned executable
that the later all-agent packaging slice will install as
`/usr/local/bin/nemoclaw-managed-bootstrap`. It validates the fixed, root-owned
request and its identity binding, verifies the matching completion, clears its
private bootstrap variables and file descriptors, and then uses `exec "$@"`. The
documented trampoline guarantees are preservation of the captured supervisor
argument boundaries and removal of inherited `BASH_ENV` before Bash parses
startup files; it does not define preservation of every other environment
entry.

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
MXC-named fake driver. `runtime-provider-source-shape.test.ts` separately inventories the
protocol, provider, and image-packaging surfaces and proves that production
activation cannot import or package the protocol yet. The later activation
slice must add a registered-provider contract test for the same transaction
before removing those dormancy assertions.

The trampoline is intentionally not packaged or selected yet, and no production
TypeScript module imports this protocol. The current image definitions also do
not package `nemoclaw-managed-startup-hold` or
`managed-startup-image-runtime.cjs`. A later provider integration must add those
prerequisites together with their image-runtime bootstrap modes, implement
driver-specific prepare, durable-record, activate, exact cleanup, and rollback,
and only then wire the coordinator into create. The same contract is exercised
for OpenClaw, Hermes, and Deep Agents Code without a provider-specific central
switch. Until that complete boundary lands, every registered runtime provider
keeps its bootstrap surface unsupported.

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

`scripts/managed-bootstrap-entrypoint.c` defines the image-owned native boundary.
The OpenClaw, Hermes, and LangChain Deep Agents Code image definitions compile
it as a freestanding Linux amd64 or arm64 artifact and install it as
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
Rollback retains an `owner-cleanup-required` phase only after image-owned shared
state is restored and the exact replacement is absent. That phase keeps the
restored original quiescent and preserves the journal without a terminal
receipt until the owning sandbox service removes the exact runtime and the
provider proves its absence. Unknown runtime presence is a retryable durable
cleanup failure, never evidence of absence.
The image-owned shared-state transaction uses the same identity-bound model: a
commit atomically moves its pending manifest and backups into a durable receipt
namespace, compacts that state to an exact commit receipt, and rejects rollback
after a restart. The provider may retire that receipt only after it proves the
external rollback backup is gone, leaving the next bootstrap attempt unblocked.
Direct identity lookup reconstructs one known transaction record, while managed
create-lifecycle startup uses unfinished-record enumeration to ask the selected
provider to reconcile every identity-addressed record before a new sandbox
create begins. The Docker provider then resumes the durable phase monotonically:
staged work rolls back without entering cutover; cutover work follows a proven
image-owned commit forward or durably authorizes rollback; rollback-authorized
work completes exact restore and cleanup; and shared-state-committed work
completes exact backup cleanup and commit. Recovery persists an identity-bound
finalization receipt before removing the active journal, is idempotent across
another interruption, and enumerates durable identities before loading each
record so one unreadable transaction does not hide other results. The provider
returns bounded `{ receipts, failures }` evidence; the coordinator validates,
copies, freezes, and orders both arrays without routing on provider phases or
failure codes. A failure for the requested sandbox name, or one whose sandbox
identity cannot be proven, blocks create. An exact failure for another sandbox
is warned and retained without blocking the requested create. The code reads
mutable OpenShell names only to detect ownership reuse, and unsafe name-only
deletion returns a typed retention error. Docker mutations use the previously
journaled full container ID, whose identity cannot be rebound, then re-inspect
that same ID after quiescence. Multi-process lease/arbitration remains an
explicit production-activation gate. Activation must also inject the selected
gateway's canonical state root.

## Legacy journal drain (schema 1 and 2)

Schema 1 and schema 2 journal bodies predate durable agent identity. They cannot
be upgraded by guessing from a mutable sandbox name, image repository, or the
agent selected by a later command. Recovery therefore preserves the canonical
record and any decision sidecar, reports its exact bootstrap, provider, sandbox,
original-runtime, and replacement-runtime identities, and fences only that
sandbox name. A create for another sandbox may continue after warning about the
retained record.

When recovery reports one of these records:

1. Stop onboarding the named sandbox. Save the complete diagnostic and back up
   the canonical state root's
   `managed-bootstrap/<bootstrap-identity>.json` file and any adjacent decision
   sidecar without editing either record.
2. Inspect the reported full runtime IDs through the owning provider. Treat
   sandbox and container names as diagnostic text only. Never delete, rename,
   or adopt a runtime by name, and never copy agent identity from the current
   invocation into the old record.
3. If either exact runtime is present, or its presence cannot be proven, leave
   the journal in place and recover the provider-owned transaction using those
   immutable IDs. A legacy cutover decision may be newer than the journal-body
   phase, so the body alone never authorizes commit or rollback.
4. If both exact runtimes are proven absent, still preserve the journal and its
   image-owned shared-state evidence. Record the exact absence proof on
   [epic #7744](https://github.com/NVIDIA/NemoClaw/issues/7744) for the
   identity-checked retirement path. Until that path ships, use a different
   sandbox name rather than deleting durable authority.

Production activation must include the identity-checked retirement path and
protected recovery qualification. This candidate remains inert, so it does not
expose a runtime that could create these legacy records without that support.

## Architectural disposition

The runtime-provider bundle is the only bootstrap registration boundary. The
candidate Docker surface owns create routing, replacement construction,
native-to-compatibility fallback evidence, and deferred commit or rollback.
Central onboarding accepts that provider-neutral surface without a Docker or
Podman selection branch. Tests register an MXC-style surface through the same
bundle, render held launches for OpenClaw, Hermes, and LangChain Deep Agents
Code, and exercise recovery phases across all three agents.

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

The native entrypoint and composed managed-bootstrap image runtime are now
compiled and packaged in every managed agent image, but remain unselected by
production onboarding. The dormant image runtime composes the neutral
managed-startup APIs with modes that consume the protected bootstrap envelope,
bind shared-state authority to the exact attempt, publish an identity-bound
completion, and authenticate that completion together with the ordinary startup
handoff. The runtime retains the protected envelope through application and
completion publication so the same attempt can retry after interruption;
it atomically moves the authenticated inode into a root-private, same-filesystem
claim before application. The canonical request is the producer-visible fixed
bootstrap request path. If that path was replaced between authentication and
rename, the runtime exclusively hard-links the displaced request back to the
canonical path without overwriting a later request, then removes the private
candidate. Restart recovery restores a protected, parseable displaced request
when a crash leaves it private immediately after rename, and reconciles a crash
between the later link and unlink steps only when the canonical and private
paths are protected two-link aliases of the same inode. A second replacement makes restoration fail closed while
preserving both the latest canonical request and the displaced private file.
The private claim remains the sole retry authority after an application or
completion-write failure; restart recovery resumes it without moving, deleting,
or overwriting a newer canonical request. Success removes only the authenticated
private claim. This protocol assumes the OCI writable layer supports same-device
atomic rename and hard links, the producer writes only the canonical request
path, one bootstrap consumer owns that path at a time, and container uid 0 is
trusted. An unsupported cross-device rename or hard link fails closed before
application and leaves request data intact; the protocol does not claim
protection from a hostile root process that can mutate the private mode-0700
namespace. The trampoline only sequences the authoritative Node
recovery, apply, and verification modes; claim ownership and state transitions
remain in that runtime. Bootstrap completion verification adds the
bootstrap-identity receipt and then delegates the shared startup completion and
environment checks. The dependency direction is one-way: this
managed-bootstrap composition imports managed-startup, while managed-startup
does not import managed-bootstrap.
Production onboarding imports only the provider-neutral create contract; no
activation path or registered provider imports or selects the driver-specific
Docker candidate. OpenClaw, Hermes, and LangChain Deep Agents Code images
compile and package the freestanding amd64 or arm64 native entrypoint, its
non-executable shell body, the root-owned hold helper, the composed
`managed-bootstrap/image-runtime.ts` bundle, and the complete inert capability
union. Pull-request and publication workflows build the exact images and
exercise the protected envelope, native bootstrap, production held-command
renderer, and all-agent hold contracts without advertising buildless support.
No production provider can invoke these packaged modes yet. The remaining
provider activation, canonical durable authority, and protected qualification
work is tracked in
[epic #7744](https://github.com/NVIDIA/NemoClaw/issues/7744). Until that complete
boundary passes protected E2E, every production runtime provider keeps
bootstrap unsupported.

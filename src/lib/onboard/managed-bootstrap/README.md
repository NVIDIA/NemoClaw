<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed bootstrap protocol

This directory defines the driver-neutral bootstrap transaction, the Docker
implementation registered for stock managed-image onboarding and rebuild
handoffs, and a dormant Podman candidate. Ordinary OpenShell Docker-driver onboarding for
the shipped OpenClaw, Hermes, and LangChain Deep Agents Code agents selects an
immutable managed image. Portable onboarding, agents without a managed-image
contract, and explicit `--from` custom Dockerfiles retain their existing
workload paths. Podman remains absent from the production provider registry, and
its bootstrap surface remains unsupported.

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
The production Docker runtime bundle registers this surface for stock
managed-image onboarding of the shipped agents and for managed rebuild
handoffs. Portable onboarding, non-managed agents, and explicit custom
Dockerfiles do not select it. The shared finalization surface extends rollback
ownership for the existing Docker compatibility and startup recreation paths.

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
deletion. Cleanup is bound to full runtime IDs. Commit or rollback is claimed
synchronously before asynchronous finalization begins. Repeated calls for the
claimed outcome share its one pending result, while the opposite outcome remains
invalid even if acknowledgement of the first finalization is lost. Its private
state root retains versioned, identity-addressed transaction records containing
the provider and sandbox identities, plan and profile
fingerprints, exact original and replacement IDs, rollback target, and phase.
Exact commit and cleanup receipts are durable terminal records, so adapter
recreation does not depend on process-local transaction sets or tombstone maps.
Rollback retains an `owner-cleanup-required` phase after image-owned shared
state is restored and the exact replacement is absent. If
`DockerManagedStartupSharedStateRestoreError` reports a restoration failure,
rollback can retain the same phase only after it removes the exact replacement.
This path restores the exact original to its canonical name and keeps it
stopped. In both cases, the durable journal remains without a terminal receipt.
The owning sandbox service remains responsible for `destroy`, and the provider
must prove the exact runtime is absent. Unknown runtime presence is a retryable
durable cleanup failure, never evidence of absence.

The dormant Podman candidate keeps the same provider-neutral coordinator
boundary but owns its engine-specific authority internally. It binds one
operation-scoped Podman command adapter to the exact rootless endpoint, captures
one held OpenShell workload twice, and durably leases the watcher owner before
any cutover. Preparation creates and proves a stopped, final-labelled
replacement and its private managed state volume while retaining the exact
original. The journal records every mutation boundary before the next external
effect and preserves enough immutable identity to roll back without deleting by
name.

Image bootstrap accepts only that prepared authority. It stages one protected
root-apply envelope, starts the exact replacement, and authenticates the
image-owned completion for OpenClaw, Hermes, or LangChain Deep Agents Code.
The watcher remains stopped and the journal remains authoritative throughout.
These modules are intentionally absent from the production provider registry and
cannot be selected by the stock Docker managed-image path. Unit tests
exercise the dormant Podman bootstrap components in isolation. Later slices must
add persisted engine recovery, GPU and local inference, installer coverage,
protected E2E qualification, and accepted product activation.
The image-owned shared-state transaction uses the same identity-bound model: a
commit atomically moves its pending manifest and backups into a durable receipt
namespace, compacts that state to an exact commit receipt, and rejects rollback
after a restart. The provider may retire that receipt only after it proves the
external rollback backup is gone, leaving the next bootstrap attempt unblocked.
The parser accepts the exact canonical schema-v1 manifest written before
`bootstrapIdentity` was added only for the legacy null-identity path. It rejects
additional fields, missing historical fields, and legacy state presented as
identity-bound authority. Before rollback, the Docker adapter stops the
replacement and copies its writable-layer commit receipt to a protected host
path for verification. The immutable helper cannot obtain that receipt through
`--volumes-from`, which exposes volumes but not the replacement writable layer.
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

Any future support for retiring schema 1 or schema 2 legacy records must include
the identity-checked retirement path and protected recovery qualification. The
stock Docker managed-image path cannot create these legacy records, and the
dormant Podman candidate remains unsupported.

## Architectural disposition

The runtime-provider bundle is the only bootstrap registration boundary. The
production Docker bundle registers its create routing, replacement construction,
native-to-compatibility fallback evidence, and deferred commit or rollback for
stock managed-image onboarding and rebuild handoffs. Central onboarding accepts
that provider-neutral surface without a Docker or Podman selection branch.
Ordinary OpenShell Docker-driver onboarding selects it for the shipped OpenClaw, Hermes,
and LangChain Deep Agents Code agents. Tests register an MXC-style surface
through the same bundle and exercise recovery phases across all three agents.

The coordinator remains the driver-neutral transaction authority: its receipt
shapes, normalization, state transitions, and rollback proofs form one cohesive
boundary, while provider-specific routing and runtime operations stay outside
it.

This is executable, bounded groundwork rather than an untested placeholder.
`adapter.test.ts` drives prepare, durable record, activation, finalization, and
failure rollback for OpenClaw, Hermes, and LangChain Deep Agents Code through an
MXC-named fake driver. `runtime-provider-contract.test.ts` verifies the
production Docker registration and an MXC-style bootstrap surface through the
same provider bundle contract.

The native entrypoint and composed managed-bootstrap image runtime are compiled
and packaged in every managed agent image. Stock OpenShell Docker-driver onboarding and
managed rebuild handoffs select them for the shipped agents. The image runtime
composes the neutral managed-startup APIs with modes that consume the protected
bootstrap envelope,
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
The production Docker provider imports the provider-neutral create contract and
registers its driver-specific implementation for stock managed-image onboarding
and rebuild handoffs. Podman remains absent from the production
provider registry. OpenClaw, Hermes, and LangChain Deep Agents Code images
compile and package the freestanding amd64 or arm64 native entrypoint, its
non-executable shell body, the root-owned hold helper, the composed
`managed-bootstrap/image-runtime.ts` bundle, and the complete capability union.
Pull-request and publication workflows build the exact images and exercise the
protected envelope, native bootstrap, production held-command renderer, and
all-agent hold contracts. Ordinary OpenShell Docker-driver onboarding selects the exact
managed images for the shipped agents. Portable onboarding, non-managed agents,
and explicit `--from` custom Dockerfiles retain their previous workload paths;
native Podman remains disabled. Further provider expansion remains tracked in
[epic #7744](https://github.com/NVIDIA/NemoClaw/issues/7744).

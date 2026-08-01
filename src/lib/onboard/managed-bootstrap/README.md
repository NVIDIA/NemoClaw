# Managed bootstrap protocol

This directory defines a dormant, driver-neutral transaction contract and its
first driver adapter. It does not register a runtime provider or change sandbox
creation, onboarding, snapshot, clone, or restore behavior.

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
authority, and finalization receipts must either prove exact snapshot restore
or exact workload absence.

`scripts/managed-bootstrap-trampoline.sh` defines the image-owned executable
that the later all-agent packaging slice will install as
`/usr/local/bin/nemoclaw-managed-bootstrap`. It authenticates a fixed,
root-owned request, verifies an identity-bound completion, clears its private
bootstrap variables and file descriptors, and then uses `exec "$@"` to preserve
the captured supervisor argument boundaries.

The trampoline is intentionally not an entrypoint, and no production TypeScript
module imports this protocol or the Docker adapter.

The Docker adapter creates and validates a stopped replacement under an
identity-derived staging name while the original remains running. It stages the
0400 envelope and returns exact cleanup authority without quiescing, renaming,
or otherwise mutating the original. Only after the coordinator durably records
that complete prepared authority may activation journal both full runtime IDs,
all three names, both launch-spec hashes, image identity, profile fingerprint,
and sandbox ID and then enter the destructive cutover. Rollback publishes
`rollback-authorized` before exact replacement deletion; commit publishes
`shared-state-committed` before exact backup deletion. Cleanup is bound to full
runtime IDs. Its private state root now retains enumerable, versioned unfinished
records containing the provider and sandbox identities, plan and profile
fingerprints, exact original and replacement IDs, rollback target, and phase.
Exact commit and cleanup receipts are durable terminal records, so adapter
recreation does not depend on process-local transaction sets or tombstone maps.
The image-owned shared-state transaction uses the same identity-bound model: a
commit atomically moves its pending manifest and backups into a durable receipt
namespace, compacts that state to an exact commit receipt, and rejects rollback
after a restart. The provider may retire that receipt only after it proves the
external rollback backup is gone, leaving the next bootstrap attempt unblocked.
Enumeration reconstructs only unfinished records; the following recovery slice
owns phase reconciliation and cross-surface resume or rollback. Mutable
OpenShell names are read only to detect ownership reuse, and unsafe name-only
deletion returns a typed retention error. Multi-process lease/arbitration remains
an explicit production-activation gate. Activation must also inject the selected
gateway's canonical state root.

The current image definitions still do not package
`nemoclaw-managed-startup-hold`, `managed-startup-image-runtime.cjs`, or the
shared-state bootstrap modes consumed by this adapter. A later activation slice
must add those prerequisites and wire the coordinator into Docker create as one
boundary. The same contract is exercised for OpenClaw, Hermes, and DCode without
a provider-specific central switch. Until that complete boundary lands, every
registered runtime provider keeps bootstrap unsupported.

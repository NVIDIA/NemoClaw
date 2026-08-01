# Managed bootstrap protocol

This directory defines a dormant, driver-neutral transaction contract, its
first driver adapter, and an injectable sandbox-create lifecycle. Production
runtime bundles still report bootstrap as unsupported, so this integration does
not change onboarding, snapshot, clone, or restore behavior.

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

The trampoline is intentionally not an entrypoint. The launch renderer can
produce its identity-bound hold command only when a caller supplies a managed
startup request.

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
At lifecycle startup, the driver-neutral coordinator asks the selected provider
to reconcile every unfinished record before a new sandbox create begins. The
Docker provider then resumes the durable phase monotonically: pre-cutover work
rolls back, rollback-authorized work completes exact restore and cleanup, and
shared-state-committed work completes exact backup cleanup and commit. Recovery
persists an identity-bound finalization receipt before removing the active
journal, is idempotent across another interruption, and returns normalized,
provider-owned receipts in stable identity order. Mutable OpenShell names are
read only to detect ownership reuse, and unsafe name-only deletion returns a
typed retention error. Multi-process lease/arbitration remains an explicit
production-activation gate. Activation must also inject the selected gateway's
canonical state root.

The runtime-provider bundle is the only bootstrap registration boundary. The
candidate Docker surface owns create routing, replacement construction,
native-to-compatibility fallback evidence, and deferred commit or rollback.
Central onboarding accepts that provider-neutral surface without a Docker or
Podman selection branch. Tests register an MXC-style surface through the same
bundle and render held launches for OpenClaw, Hermes, and DCode.

The current image definitions still do not package
`nemoclaw-managed-startup-hold`, `managed-startup-image-runtime.cjs`, or the
shared-state bootstrap modes consumed by this adapter. Later persistence and
qualification slices must add those prerequisites and provide the canonical
durable authority store. Until that complete boundary passes protected E2E,
every production runtime provider keeps bootstrap unsupported.

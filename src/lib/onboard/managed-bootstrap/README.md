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
authority, and finalization receipts must either prove exact snapshot restore
or exact workload absence.

`scripts/managed-bootstrap-trampoline.sh` is copied into each managed image as
`/usr/local/bin/nemoclaw-managed-bootstrap`. It authenticates a fixed,
root-owned request, verifies an identity-bound completion, clears its private
bootstrap variables and file descriptors, and then uses `exec "$@"` to preserve
the captured supervisor argument boundaries.

The trampoline is intentionally not an entrypoint and no production TypeScript
module imports this protocol. The current image definitions also do not package
`nemoclaw-managed-startup-hold` or
`managed-startup-image-runtime.cjs`. A later provider integration must add those
prerequisites together with their image-runtime bootstrap modes, implement
driver-specific prepare, durable-record, activate, exact cleanup, and rollback,
and only then wire the coordinator into create. The same contract is exercised
for OpenClaw, Hermes, and DCode without a provider-specific central switch.
Until that complete boundary lands, every registered runtime provider keeps
its bootstrap surface unsupported.

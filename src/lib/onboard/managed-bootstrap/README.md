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

`scripts/managed-bootstrap-trampoline.sh` is copied into each managed image as
`/usr/local/bin/nemoclaw-managed-bootstrap`. It authenticates a fixed,
root-owned request, verifies an identity-bound completion, clears its private
bootstrap variables and file descriptors, and then uses `exec "$@"` to preserve
the captured supervisor argument boundaries.

The trampoline is intentionally not an entrypoint and no production TypeScript
module imports this protocol or the Docker adapter.

The Docker adapter creates and validates a stopped replacement under an
identity-derived staging name while the original remains running. It stages the
0400 envelope, then durably journals both full runtime IDs, all three names,
both launch-spec hashes, image identity, profile fingerprint, and sandbox ID.
Only a durable `cutover` transition permits stopping the original. Rollback
publishes `rollback-authorized` before exact replacement deletion; commit
publishes `shared-state-committed` before exact backup deletion. All cleanup is
by full runtime ID. Mutable OpenShell names are read only to detect ownership
reuse, and unsafe name-only deletion returns a typed retention error.
The dormant adapter assumes the protocol's single coordinator; multi-process
lease/arbitration is an explicit production-activation gate.
Activation must also inject the selected gateway's canonical state root.

The current image definitions still do not package
`nemoclaw-managed-startup-hold`, `managed-startup-image-runtime.cjs`, or the
shared-state bootstrap modes consumed by this adapter. A later activation slice
must add those prerequisites and wire the coordinator into Docker create as one
boundary. Until then every registered runtime provider keeps bootstrap
unsupported.

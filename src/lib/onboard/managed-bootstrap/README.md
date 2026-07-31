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
driver-specific exact-runtime replacement and rollback, and only then wire the
coordinator into create. Until that complete boundary lands, every registered
runtime provider keeps its bootstrap surface unsupported.

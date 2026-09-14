# Desired-state Rust implementation

Decision: Accept. Requested by maintainer cvillela on 2026-09-14, who owns this
experiment and its acceptance. Placement: independent orphan origin/v1 branch.
The Go implementation remains origin/v1-poc. Reference revision:
`b549ccd43e6102b72aa9c65ee17abfe3c429fc0b`, including Fabric and native messaging.

The public nemoclaw-sdk owns desired-state behavior. The CLI consumes it; terminal
formatting, argument parsing, and process exit codes belong to the CLI. OpenTofu
continues to own graph execution and resource state. A Rust provider adapts its
protocol to shared typed backend operations. No Rust/Go FFI is required.

Start with the contracts most likely to invalidate the port, in green commits:

1. Durable identity and observation semantics in the public SDK.
2. Qualify the Rust provider against a real pinned OpenTofu binary: refresh,
   confirmed absence, failed observations, state retained after partial creation,
   no-op, drift, and replacement.
3. Strict configuration parsing and validated typed SDK inputs, then compilation
   and read-only plan through a thin CLI.
4. Apply, export, and destroy with deployment locking, retained intent, secret
   references, recovery, and the same ownership and generation checks.
5. Backend integration, managed storage/process lifecycle, and Spark supervisor.
6. Explicit live qualification and cross-platform bundle evidence.

Each implementation commit records its red/green evidence. Add crates only when
there is a consumer: SDK, CLI, provider, and a private unpublished e2e crate.
The e2e crate consumes an explicit verified runtime bundle, not sibling Cargo
binary discovery. Keep deterministic process tests separate from opt-in live
resource creation. Exercise SDK apply -> CLI export -> SDK unchanged apply ->
CLI destroy when those operations exist.

Compatibility includes resource addresses, durable IDs, ownership generations,
configuration digests, secret references, artifact receipts, and persistent data.
Verify compatibility with fixtures from the pinned Go reference; do not claim
state migration or platform qualification from compiling successfully.
Only confirmed absence may remove state. Authentication, transport, extension,
query, and partial-result failures stop planning and preserve prior bindings.
Refresh and export share typed observations. Mutations, conditional-write checks,
active probes, and local credential/state reads remain direct. Choose collectors
from implementation evidence; do not change observation behavior during a port.

Storage survives destroy by default. Plan does not create runtime resources.
Failed readiness must preserve established identities. The watchdog stays active
after CLI exit and must not trigger an automatic restart loop. Retain upstream
licenses and source notices when porting runtime artifacts. SDK errors and
progress must not expose secret values.

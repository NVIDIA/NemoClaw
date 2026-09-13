# Local desired-state prototype

Decision: Accept for a local experiment, authorized by cv in this task on 2026-09-11.
Placement: the independent root of `codex/desired-state-prototype`.
Accountable maintainer: cv. Git commits may be pushed to `origin/v1`, as authorized
in this task. Artifact publication and migration of unrelated deployments remain
outside this experiment.

The experiment tests whether Go, OpenTofu, and OpenShell can implement
NemoClaw's desired-state workflow with a small amount of new code.
No existing NemoClaw source or documentation is copied into this branch.

## Fabric experiment

Authorized locally by cv on 2026-09-12: provision Fabric inside an OpenShell
sandbox and delegate harness execution to it. The supported adapters are Deep
Agents, Hermes and OpenClaw, using an external gateway and external inference endpoint; managed inference/gateway combinations remain a later slice.
NemoClaw owns infrastructure, ownership checks, desired state and teardown;
Fabric owns one persistent harness runtime, ordered invocations and run results.
The image builds Fabric revision `51a28c1aefec56abd877070b6973d0a32a1e3003`
from a checksum-verified archive, with locked Python dependencies. This is a
source build because the published packages lag that revision.

`type: fabric` with `harness: deepagents`, `harness: hermes` or `harness: openclaw` selects the immutable
sandbox launch specification. Existing OpenClaw configuration and launch specifications remain
valid. Changing harness on an established sandbox requires explicit teardown;
ordinary apply cannot replace it. NemoClaw owns only plan/apply/export/destroy.
The runtime host exposes a private readiness probe, with no invocation or channel
control API. Runtime access uses existing Fabric SDK or native harness interfaces;
OpenShell's existing connection/exec commands provide sandbox access.

Unchanged apply checks the initialized runtime and inference route without adding
a conversation turn. The live test checks actual agent replies, stable resource
and runtime identities across unchanged apply and export/reapply, and teardown.
Fabric artifacts and conversation state stay inside the sandbox and are removed
with it in the current OpenShell slice. Retained native OpenClaw state and workspace
support recreation in the Docker experiment; this does not imply OpenShell retained
storage support. There is no new public Fabric service API or messaging abstraction.
Hermes uses Fabric's pinned revision `29112bef099274229cadff79cdff7bf7b99c4b77`
in a separate image. NemoClaw selects the adapter through Fabric configuration;
only Fabric imports and runs the Hermes harness. The source checkout is retained
for Hermes's bundled assets. Relay metadata propagation is not configured.
OpenClaw uses a local prototype adapter; the pinned Fabric source has no such
adapter. Fabric owns its Python adapter process, and that process starts/stops
one OpenClaw gateway. The adapter submits gateway RPC calls with an invocation
idempotency key and a stable session key, waits for the terminal response, and
normalizes tool history. Uncertain RPC failure stops the gateway and quarantines
the adapter; no fallback, retry, or restart is attempted. The adapter is limited
to the fixed OpenShell primary route and timeout-bound SDK turns. Initial native
configuration disables cron, heartbeat, automatic updates, and memory indexing.
Subsequent native settings belong to OpenClaw. The adapter preserves the config
file and checks only deployment-owned gateway/inference/workspace settings.
The native image recipe is limited to Linux ARM64 with Python 3.13. Keep its live
evidence distinct from deterministic protocol fixtures and cross-platform builds.

The configuration analysis in issue #10904 supplies the resource vocabulary and
the constraints: explicit deployment UID, strict fields, secret references,
ownership checks, non-destructive omission, and recovery after partial effects.
This prototype is a subset, not implementation of the entire accepted epic.

## Slice

The user supplies YAML to `nemoclaw apply` and retrieves it with
`nemoclaw export`. Planning uses OpenTofu and is exposed through
`nemoclaw plan`. Execution location is an operational option.
Explicit teardown is now authorized through `nemoclaw destroy`, with
`nemoclaw plan --destroy` for preview. Its first slice removes bound workloads and
retains workspace and persistent storage bindings; cv remains the accountable
maintainer. Validation covers ordered deletion, read-only preview, ownership and
observation failures, interrupted deletion, data retention, and reapply. External
endpoints and the managed Spark layout are in scope; the earlier combined Ollama
resource needs a separate storage boundary before teardown can support it.

The first deployment attaches to an explicitly selected OpenShell gateway and
manages a deployment workspace, inference registrations/routes, and an OpenClaw
sandbox. The next authorized local experiment optionally manages one Ollama
container, named model volume, and selected CPU model on an existing Linux Docker
engine and network. Gateway provisioning remains a prerequisite. The upstream
gateway owns the sandbox's Docker or Podman integration; the new handler owns
only the separately declared inference service.

OpenTofu owns dependencies, refresh, diffs, saved plans, and resource state.
NemoClaw owns YAML validation, compilation, ownership enforcement, and recovery
of operations that may have completed before their response was recorded.
Provider refresh and export share direct resource readers over the OpenShell SDK
and Docker/model APIs. A successful complete read supplies configuration; only an
explicit owning-API NotFound establishes absence. Failed or incomplete reads stop
planning and export without discarding resource bindings. Ownership, generation,
durable identity, launch specification, and active policy checks remain enforced.
Mutations and their reconciliation, CLI preflight, active probes, and local
state/credential access use the same owning APIs and local sources.
Host reads run on the machine being observed; they do not pretend to inspect
a container guest.

Ollama refresh and export share direct typed readers for container configuration,
volume identity, and complete model inventory. The separate service/model resources
are also provisional: a stopped service makes model refresh fail and prevents
OpenTofu from planning its restart.
The live harness exposes this limitation and explicitly restarts the runtime to
continue; ordinary apply has no implicit repair outside the plan.

## Acceptance evidence

The next accepted local experiment is the pinned Qwen3.8 Flash Next recipe on
this DGX Spark. It owns a managed gateway, inference container and persistent
model/preparation storage, and the OpenClaw sandbox. cv remains accountable for
this experimental scope; it does not establish a supported product integration.
Validation must cover an actual agent reply, unchanged apply, interrupted
download/preparation, failed startup with retained identities, export/reapply,
safe capacity rejection, and watchdog shutdown followed by explicit recovery.
The runtime retains the upstream licenses and source notices. Host drivers,
kernel settings, system packages, and unrelated resources are outside its scope.
The implementation may correct the RFC's resource boundaries when recovery
evidence shows that a boundary prevents the parent runtime from being repaired.

1. Create a working agent from YAML against a real local OpenShell gateway.
2. Apply unchanged YAML with no resource changes.
3. Change the inference model without replacing the sandbox.
4. Interrupt an apply and reconcile the recorded intent without duplicates.
5. Export reusable, secret-free YAML and recreate the deployment in a fresh target.
6. Reject foreign ownership, changed identities, unknown fields, inline secrets,
   unsupported combinations, and deletion/replacement during ordinary apply.
7. Build native binaries for Linux, macOS, and Windows. Record native execution
   separately; cross-compilation is not platform qualification.

Tests will exercise real OpenTofu/provider process boundaries and a
protocol fixture for deterministic failure cases. Linux runtime evidence uses
only resources created for this prototype. Interrupted model streams and initial
volume allocation use deterministic API fixtures. Windows/macOS/Podman runtime
qualification, real download interruption through OpenTofu, stopped-parent repair,
adoption, pruning, migration, and the rest of the #10904 schema remain separate work.

## Native messaging interfaces

The earlier `fabric.channels.experimental/v1` experiment is retired. There are
no NemoClaw invoke/channel commands, adapter channel-control socket, generic channel
schema, or adapter resource declarations. OpenClaw's native commands handle setup,
pairing, status, and invocation. Fabric continues to own the gateway process through
its existing lifecycle contract and our local OpenClaw adapter. No upstream Fabric
changes or new Fabric client are required.

See [NATIVE_MESSAGING.md](NATIVE_MESSAGING.md) for the tested path and limits.
Ordinary OpenShell provisioning still needs generic egress, secrets and retained
storage capabilities for real messaging. Native channel settings themselves remain
outside the deployment document and stay in the native state directory.

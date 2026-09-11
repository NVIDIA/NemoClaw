# Local desired-state prototype

Decision: Accept for a local experiment, authorized by cv in this task on 2026-09-11.
Placement: the independent root of `codex/desired-state-prototype`.
Accountable maintainer: cv. No publication or existing-deployment migration is authorized.

The experiment tests whether Go, OpenTofu, OpenShell, and osquery can implement
NemoClaw's desired-state workflow with a small amount of new code.
No existing NemoClaw source or documentation is copied into this branch.

The configuration analysis in issue #10904 supplies the resource vocabulary and
the constraints: explicit deployment UID, strict fields, secret references,
ownership checks, non-destructive omission, and recovery after partial effects.
This prototype is a subset, not implementation of the entire accepted epic.

## Slice

The user supplies YAML to `nemoclaw config apply` and retrieves it with
`nemoclaw config export`. Planning uses OpenTofu and is exposed through
`nemoclaw config plan`. Execution location is an operational option.

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
Provider refresh and export share a typed osquery adapter over the four resource
tables. The extension uses the OpenShell SDK and emits explicit present, absent,
or failed observations. Empty or partial SQL output cannot remove resource state.
Ownership, generation, durable identity, launch specification, and active policy
checks remain enforced. Mutations and their reconciliation, CLI preflight, active
probes, and local state/credential access remain direct in this slice.
Host queries run on the machine being observed; they do not pretend to inspect
a container guest.

Ollama refresh and export share direct typed readers. osquery's built-in Docker
inventory returned empty successful output for an unavailable socket, so it does
not meet the absence contract. A custom table is deferred until its benefit is
established. The separate service/model resources are also provisional: a stopped
service makes model refresh fail and prevents OpenTofu from planning its restart.
The live harness exposes this limitation and explicitly restarts the runtime to
continue; ordinary apply has no implicit repair outside the plan.

## Acceptance evidence

1. Create a working agent from YAML against a real local OpenShell gateway.
2. Apply unchanged YAML with no resource changes.
3. Change the inference model without replacing the sandbox.
4. Interrupt an apply and reconcile the recorded intent without duplicates.
5. Export reusable, secret-free YAML and recreate the deployment in a fresh target.
6. Reject foreign ownership, changed identities, unknown fields, inline secrets,
   unsupported combinations, and deletion/replacement during ordinary apply.
7. Build native binaries for Linux, macOS, and Windows. Record native execution
   separately; cross-compilation is not platform qualification.

Tests will exercise real OpenTofu/provider/osquery process boundaries and a
protocol fixture for deterministic failure cases. Linux runtime evidence uses
only resources created for this prototype. Interrupted model streams and initial
volume allocation use deterministic API fixtures. Windows/macOS/Podman runtime
qualification, real download interruption through OpenTofu, stopped-parent repair,
adoption, pruning, migration, and the rest of the #10904 schema remain separate work.

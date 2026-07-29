<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# First-class CUA v1 contract

This contract defines the NemoClaw v1 boundary for one standalone computer-use
agent (CUA) and one separately managed desktop target. It is the implementation
contract for issue #7750. The public lifecycle records use
`schemas/cua-lifecycle.schema.json`.

The contract does not select an upstream runtime, target environment, cloud
provider, or qualification adapter. Runtime and target implementations must
record their exact artifacts and owners before they become supported.

## Supported topology

The CUA runs in one OpenShell-managed agent sandbox. It owns planning,
execution, task state, recovery, and evidence production. It controls one
dedicated, disposable, non-production desktop target.

The desktop target exposes three required capabilities:

- `browser`
- `computer`
- `terminal`

Each capability has its own protocol version and health result. Attachment
fails unless all three capabilities are healthy.

Another resident agent does not invoke the CUA in v1. Direct service mode,
cross-agent delegation, A2A, and MCP delegation are outside this contract.
NemoClaw does not provide a dashboard or messaging surface for the CUA.

## Runtime manifest

The ordinary agent discovery path reads `agents/*/manifest.yaml`. The current
terminal runtime shape represents the CUA discovery and launch requirements
without a new runtime kind:

- `runtime.kind` is `terminal`.
- `runtime.interactive_command` starts the interactive CUA surface.
- `runtime.headless_command` starts the headless CUA surface.
- `version_command` returns the exact runtime version.
- `runtime.smoke_commands` verify the runtime, managed inference, and command
  contract without attaching a target.

The CUA target and task lifecycle is not a terminal command convention. It uses
the versioned public lifecycle records in this contract. A runtime
implementation must use the same integrity-pinned runtime identity for
interactive and headless operation.

The production manifest must identify an integrity-pinned runtime artifact,
sandbox image, dependency graph, policy, and task protocol. The runtime issue
records their exact values, owner, release lifecycle, and compatibility policy
before the manifest is accepted.

## Ownership

| Owner | Required ownership |
| --- | --- |
| NemoClaw | Agent discovery, onboarding, managed inference, sandbox lifecycle, policy, compatibility validation, secret-free attachment state, bounded public task state, recovery, rebuild, backup, update, and destroy. |
| CUA runtime | Planning, visual grounding, computer/browser/terminal clients, active task state, results, events, plans, logs, cancellation, supported guidance, and evidence production. |
| Host target lifecycle | Target selection or provisioning, platform and target-administration credentials, private transport, immutable target and service attestation, reset, and destroy. |
| Qualification fixture | Synthetic accounts and data, deterministic target preparation, independent final-state verification, and private qualification evidence. |

The qualification adapter is scaffolding. It may map logical qualification
actions to public NemoClaw lifecycle operations. It must report the CUA worker
unavailable until those operations exist. It must not replace missing product
behavior with private shell or direct OpenShell operations.

## Public lifecycle

NemoClaw must expose these target operations:

- `target.attach`
- `target.status`
- `target.health`
- `target.detach`
- `target.reset`
- `target.destroy`

NemoClaw must expose these required task operations:

- `task.start`
- `task.status`
- `task.result`
- `task.events`
- `task.logs`
- `task.plans`
- `task.cancel`

A runtime may advertise these optional task operations:

- `task.pause`
- `task.guide`
- `task.respond`

NemoClaw also exposes these security operations:

- `security.verify`
- `security.status`

The runtime-readiness record always lists every required task operation and
lists an optional operation only when the runtime implements it. A request for
an unlisted optional operation returns `lifecycle_unavailable`; it is never
silently accepted.

Public command names, arguments, output envelopes, and exit codes are owned by
the target, task, and security implementation issues. They must produce records
that conform to this contract without reading runtime-private files.

Active task commands return the target attachment with its bounded
`activeTask` projection. Terminal commands return `task-result`.
`task.events`, `task.logs`, and `task.plans` return a
`task-evidence-index` containing only content-addressed private references.

## Compatibility identities

Every component identity contains:

- a component name;
- an immutable version;
- a SHA-256 digest;
- an accountable owner.

Runtime readiness identifies the runtime, sandbox image, policy, task protocol,
inference provider, and model. An attachment also identifies the target image,
target platform, target service bundle, and three capability protocol versions.
A task result binds all of those identities, the three capability protocol
versions, and the content identity of the attached target.

Mutable tags, `latest`, local paths, host names, provider selectors, and
environment-specific instance identifiers are not compatibility identities.

### Compatibility policy

NemoClaw accepts a component only when its observed name, version, owner, and
SHA-256 digest match the recorded identity. A tag or version match does not
override a digest mismatch.

CUA lifecycle consumers accept schema major 1 and reject unknown major
versions before reading the record. A minor or patch schema change may add no
authority and must preserve every required v1 field and invariant.

Target attachment requires the recorded target platform, image, service
bundle, and capability protocol versions. Recovery treats a changed target
identity as replacement, not as the prior attachment. It obtains fresh
authority only after compatibility validation succeeds.

Any runtime, sandbox image, target image, service bundle, policy, task
protocol, inference model, or dependency change requires the CUA compatibility
test before release qualification. Each upstream owner must publish immutable
release identities, supported successor rules, and an end-of-support decision
before NemoClaw records that implementation as supported.

## Cardinality and authority

One CUA worker has at most one attached target. One target has at most one
active task. A conflicting target returns `target_conflict`. A conflicting task
returns `task_conflict` without disturbing the current attachment or task.

Worker leases, attachment handles, task handles, service sessions, and
transport identifiers are opaque, non-durable authority. They are never
written to the public records, registry, backup, task input, or result.
Recovery obtains fresh authority after it validates immutable component
identities.

## State

| Class | State |
| --- | --- |
| NemoClaw persistent | Selected agent, compatibility identities, managed inference selection, policy identity, secret-free target attachment projection, content-free security attestation, and bounded completed-task metadata and evidence references. |
| User managed | Explicit onboarding choices and supported agent preferences. Secret values remain in their supported credential boundary. |
| Reconstructible | CUA sandbox, desktop target, browser profile, mutable fixture data, service sessions, and runtime caches. |
| Private | Screenshots, page and screen content, documents, downloads, detailed logs, task input, runtime observations, and detailed verification output. |
| Non-durable authority | Worker leases, attachment and task handles, service sessions, transport identifiers, host paths, and target-administration material. |

Backups contain only declared NemoClaw persistent and user-managed state.
Backups exclude reconstructible state, private artifacts, and non-durable
authority.

Rebuild and recovery validate all immutable identities before they replace or
reuse state. They obtain a fresh target attachment and service sessions.
Update fails before deleting the current sandbox when the replacement runtime
or managed inference route cannot be verified.

Detach invalidates target reachability and clears the attachment projection.
Reset reconstructs the target, browser profile, and fixture state. Destroy
removes target reachability, private artifacts subject to the retention policy,
and all NemoClaw-owned CUA state.

## Secret and artifact boundary

Public CUA records contain no credential values, credential-shaped fields,
service endpoints, host or instance identities, SSH or VNC details, arbitrary
commands, environment values, host paths, leases, sessions, or transport
identifiers. Producers construct component and inference identities from
trusted manifest or registry fields, never from runtime-authored output, and
apply NemoClaw's standard redaction before serialization.

The attachment record uses only a content identity for the target. Detailed
screenshots, logs, page content, documents, and task artifacts remain private.
Public results refer to private evidence by SHA-256 digest, media type, and
optional byte count. An evidence reference contains no path or URL.

An agent-authored result is not independent verification. A public task result
contains the agent's terminal status and a digest for its private result,
independent verification status and evidence digests, per-capability receipts,
and private evidence references as separate fields.

`task-result` records are terminal: `succeeded`, `failed`, or `cancelled`.
`input-required` is an active task status and cannot appear in a result. A
succeeded task requires both a succeeded agent result and passed independent
verification. A failed task cannot contain both of those success conditions.
The task and agent result must agree on cancellation.

NemoClaw retains at most the 16 most recent validated terminal results for
normal CLI reconnect inspection. It never persists task input. A task ID in
that retained set cannot be reused.

Before a task adapter runs, NemoClaw requires a current `security-attestation`
record. A trusted host-side verifier produces that content-free record only
after it validates the policy applied to the sandbox and target. The
attestation is bound to the exact runtime, sandbox image, target image, service
bundle, policy, task protocol, inference route, capability protocols, and
target identity.

The verifier must prove all of these conditions:

- network access defaults to deny and permits only managed inference plus the
  declared browser, computer, and terminal target services;
- unrelated Internet access, cloud metadata, undeclared loopback, host
  administration, host desktop access, and the host Docker socket are denied;
- provider, target, and service credentials remain in the host-side secret
  boundary and are absent from prompts, the sandbox filesystem, process
  arguments, logs, state, diagnostics, backups, public JSON, and build logs;
- the sandbox runs unprivileged as a non-root user without broad writable host
  mounts;
- screenshots, page and screen content, downloads, browser profiles, cookies,
  mutable target state, task content, results, logs, and documents are
  content-addressed, owner-only, metadata-bounded, excluded from backups, and
  removed by target reset or destroy according to the retention boundary; and
- qualification uses synthetic local fixtures, denies external side effects,
  and never lets task input, page or screen content, downloads, or runtime
  output expand authority.

The verifier owns any private endpoint and credential inspection needed to
make those assertions. Its request contains the sandbox name and public
runtime-readiness and target-attachment records, but no private verifier
authority; its attestation contains none of those private values. NemoClaw
rejects malformed, incomplete, or identity-stale attestations. Identity drift
makes an attestation stale and blocks task execution. Target reset, detach,
or destroy clears it after the target operation succeeds. Target health also
clears it when it records the target as unreachable, incompatible, or replaced,
and an explicit verification failure clears any prior attestation, so task
execution remains fail-closed until verification succeeds again.

## Failure families

Public failures use one deterministic family:

| Family | Condition |
| --- | --- |
| `lifecycle_unavailable` | A required public operation or optional runtime operation is unavailable. |
| `runtime_unavailable` | The CUA runtime cannot start or answer its version or smoke command. |
| `runtime_incompatible` | The runtime, sandbox image, dependency, or task protocol identity does not match. |
| `inference_unavailable` | The managed inference route cannot serve the runtime. |
| `policy_invalid` | The required policy is absent, malformed, changed, or cannot be applied. |
| `target_unreachable` | The recorded target cannot be reached through the supported attachment boundary. |
| `target_replaced` | The target identity changed after attachment. |
| `target_incompatible` | The target image or service bundle identity does not match. |
| `capability_unhealthy` | Browser, computer, or terminal health validation fails. |
| `target_conflict` | The worker already has a target. |
| `task_conflict` | The target already has an active task. |
| `task_timeout` | The task reaches its bounded execution limit. |
| `task_cancelled` | Cancellation reaches a terminal state. |
| `validation_failed` | Public input, output, evidence, or independent verification is malformed or fails. |

Failures identify the operation, family, retryability, and bounded component.
They do not include raw runtime output or private target details.

Attachment and task execution fail before mutation when required lifecycle
operations, identities, capability health, managed inference, or policy cannot
be validated.

## Qualification

Release qualification uses independent browser, computer, and terminal tests
plus one integrated task. Code outside the agent verifies final state. The
qualification receipt binds the exact runtime, sandbox, target, service,
inference, policy, task protocol, fixture, and verifier identities.

Qualification may run through a host-owned adapter, but the adapter must call
the supported public NemoClaw lifecycle. Private qualification evidence does
not enter the public issue, contract, or repository.

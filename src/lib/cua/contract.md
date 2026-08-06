<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# CUA browser-form candidate contract

This contract defines the first NemoClaw computer-use agent (CUA) candidate
slice for one standalone agent and one separately managed desktop target. It is
the implementation contract for issues #7750 and #7755. The public lifecycle
records use `schemas/cua-lifecycle.schema.json`.

Executable CUA lifecycle surfaces are disabled by default and require the exact
host setting `NEMOCLAW_CUA_ENABLED=1`. The image lane supplies a sanitized,
integrity-pinned runtime manifest, its declared payloads, and one immutable
sandbox image. Canonical onboarding discovers that external NemoCUA agent,
builds the existing OpenShell-managed sandbox, verifies the terminal runtime
and live managed inference authority, and records runtime readiness.

The contract does not select an upstream runtime, target environment, cloud
provider, or qualification adapter. Runtime and target implementations record
their exact artifacts and owners as candidate evidence. This slice does not
establish final CUA qualification or product support.

Every target attachment and task result carries the canonical SHA-256 identity
of the whole runtime-readiness record that authorized it. Adapter exchanges and
security attestations carry the same binding. A readiness change invalidates
derived CUA state; matching component names alone never authorize replay.

Every security attestation, active task, and task result also carries the
content-free identity of the effective OpenShell policy.
That `appliedPolicy` identity contains the active policy revision and SHA-256
digest. A policy change invalidates task authority even when every component
and inference identity remains unchanged.

## Candidate topology

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
The framework uses the existing OpenShell-managed agent sandbox. It does not
create a nested NemoCUA sandbox or invoke `nemocua sandbox create`.

## Runtime manifest and onboarding

The ordinary agent discovery path reads `agents/*/manifest.yaml`. When CUA is
enabled, NemoClaw instead discovers `nemocua` from the external runtime manifest
selected by all three required settings:

- `NEMOCLAW_CUA_RUNTIME_MANIFEST` is one canonical absolute path;
- `NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256` is the exact lowercase SHA-256 of the
  manifest's raw bytes; and
- `NEMOCLAW_CUA_SANDBOX_IMAGE_REF` is an immutable image reference whose digest
  matches the manifest's sandbox-image artifact.

The manifest and its parent directory must be owned by root or the effective
process user and must not be group-writable, world-writable, or symbolic links.
The manifest uses the exact closed `cua-runtime-manifest` v1 shape. It binds the
sanitized `cua.release.bundle/v1` receipt and declares the NemoCUA agent
manifest, policy additions, Dockerfiles, host CLI, sandbox and target images,
target services, and target, task, and security adapters. NemoClaw verifies the
size, raw digest, ownership, and no-follow identity of every declared file
before staging or executing it.

The external `manifest.yaml` uses the existing terminal runtime shape:

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

Run canonical onboarding with `nemoclaw onboard --agent nemocua`, or select the
same agent through `NEMOCLAW_AGENT=nemocua`. The `cua` and `nemo-cua` aliases
resolve to `nemocua`. Onboarding records readiness only after it proves the
exact clean NemoClaw source, verifies the external payload, verifies the
runtime version and smoke commands inside the sandbox, and observes a stable
managed inference route and provider authority. It does not create a nested
NemoCUA sandbox or invoke `nemocua sandbox create`.

The OpenShell command boundary resolves one absolute executable and copies its
bounded raw bytes into a private snapshot. Onboarding and later authority
observations invoke that snapshot. Runtime readiness records its component
identity as `components.openshell`, including the exact raw-byte digest but no
host path. Runtime readiness also records the exact manifest-bound target
adapter as `components.targetAdapter`. Candidate and final qualification
evidence must contain the same target-adapter digest.

The production manifest identifies an integrity-pinned runtime artifact,
sandbox image, dependency graph, policy, task protocol, and verifier. Its
qualified compatibility record embeds immutable qualification evidence and
names a distinct exact final source commit.

Both manifest-bound Dockerfiles use strict UTF-8, LF line endings, and one
instruction per line. The base Dockerfile contains only one `ARG`,
`ARG NEMOCUA_RUNTIME_IMAGE`, and uses `${NEMOCUA_RUNTIME_IMAGE}` as its sole
`FROM` base. The agent Dockerfile contains only one `ARG`, `ARG BASE_IMAGE`
with an optional default, and uses `${BASE_IMAGE}` as its sole `FROM` base.
They reject parser directives, continuations, `ADD`, external stages, and broad
build-context copies. The base Dockerfile cannot copy context files;
the agent Dockerfile can copy only one exact manifest-declared payload from
`agents/nemocua` per instruction. Every build-time `RUN` uses only BuildKit
`--network=none`, without mounts or alternate build entitlements. The agent
build context contains only those declared payloads and the staged Dockerfile;
it does not transfer the NemoClaw checkout to the builder.

## Runtime readiness

The public readiness record contains `agent`, `status`, `sourceRevision`,
`sourceClean`, `runtimeManifestDigest`, `providerAuthorityDigest`,
`qualification`, component and inference identities, commands, limits,
capabilities, and operation lists. `providerAuthorityDigest` is a secret-free
digest of the observed gateway, provider, model, provider resource version,
and credential and configuration key names. It contains no credential values.
The component set includes the exact OpenShell executable identity used for
those observations.

For a live checkout, build cleanliness is re-observed with the fixed
`/usr/bin/git` executable, a bounded environment, and repository execution
features disabled. The observation rejects Git replace refs, staged changes,
untracked paths, and `assume-unchanged` or `skip-worktree` index flags. It also
compares every ordinary tracked filesystem object, mode, and byte with the
exact commit tree. For a canonical Git LFS pointer, it compares the
materialized payload with the size and SHA-256 digest committed in that
pointer. A Git observation failure is not clean evidence. A packaged
install instead uses the closed `dist/cua-build-identity.json` stamp from a
non-writable authority path. On Linux, the stamp and all path ancestors must be
root-owned. The stamped revision must match the executing NemoClaw build.

Candidate readiness is accepted only when both `NEMOCLAW_CUA_ENABLED=1` and
`NEMOCLAW_CUA_QUALIFICATION=1` are active. It also requires
`NEMOCLAW_CUA_QUALIFICATION_ENVIRONMENT` to name a regular, authority-owned,
no-follow JSON file from 2 bytes through 64 KiB. That environment binds the
exact clean candidate commit, launchable identity, GPU identity, and raw digest
of the sanitized release-bundle receipt. Public status reports `candidate`
only while the process remains in qualification mode.

The schema reserves a qualified-manifest form for a later promotion decision.
This slice accepts only candidate readiness in explicit qualification mode.
Its browser-form evidence does not authorize `available` readiness or product
support.

## Ownership

| Owner | Required ownership |
| --- | --- |
| NemoClaw | Agent discovery, onboarding, managed inference, sandbox lifecycle, policy, compatibility validation, secret-free attachment state, bounded public task state, recovery, rebuild, backup, update, and destroy. |
| CUA runtime | Planning, visual grounding, browser-form task state, results, cancellation, and private evidence production. |
| Host target lifecycle | Target selection or provisioning, platform and target-administration credentials, private transport, immutable target and service attestation, detach, and destroy. |
| Qualification fixture | Synthetic accounts and data, deterministic target preparation, independent final-state verification, and private qualification evidence. |

The qualification adapter maps logical qualification actions to the same public
NemoClaw lifecycle operations used by production. It must not replace product
behavior with private shell or direct OpenShell operations.

## Public lifecycle

NemoClaw must expose these target operations:

- `target.attach`
- `target.status`
- `target.health`
- `target.detach`
- `target.destroy`

NemoClaw must expose these task operations:

- `task.start`
- `task.status`
- `task.result`
- `task.cancel`

NemoClaw also exposes these security operations:

- `security.verify`
- `security.status`

The CLI retains these known compatibility commands:

- `target.reset`
- `task.pause`
- `task.guide`
- `task.respond`
- `task.events`
- `task.logs`
- `task.plans`

Readiness does not advertise a compatibility command. Each compatibility
command returns `lifecycle_unavailable` before it reads a private input file,
resolves an adapter, or invokes an adapter.

Public command names, arguments, output envelopes, and exit codes are owned by
the target, task, and security implementation issues. They must produce records
that conform to this contract without reading runtime-private files.

`nemoclaw <name> status --json` exposes validated CUA state as `cuaRuntime`,
`cuaTarget`, and `cuaSecurity`. All three fields are `null` when CUA is disabled
or runtime readiness is missing, unavailable, incompatible, or invalid. Valid
candidate readiness is projected only in qualification mode. With valid
candidate readiness, the target and security fields remain `null` until their
lifecycle states exist. `nemoclaw <name> doctor` re-observes the
exact OpenShell executable, live provider authority, and effective policy
before it validates stored runtime, target, and security state.

If the effective policy does not match the stored attestation, status hides the
attestation and projects `activeTask` as `null`. It preserves the possible
external task under `cuaReconciliation`. Normal lifecycle operations remain
unavailable until an independent status observation and explicit task and
target cleanup reconcile that external state. Task authority returns only
after cleanup and after the trusted verifier records a new attestation for the
effective policy.

Every advertised target, task, and security command first holds the shared
per-sandbox mutation lease used by inference, policy, shields, and snapshot
changes, then the shared per-gateway route-mutation lease. The lifecycle holds
the registry lock only long enough to snapshot the complete sandbox row and to
compare-and-swap that exact row after the adapter returns. The adapter never
runs under the age-expiring registry lock. Route and provider authority are
re-observed before authority is granted and again before adapter output is
accepted. Any concurrent row, route, provider authority, build, manifest,
qualification, policy, target, or readiness-digest change fails closed without
overwriting the newer registry state.

Active task commands return the target attachment with its bounded
`activeTask` projection. Terminal commands return `task-result`.

## Compatibility identities

Every component identity contains:

- a component name;
- an immutable version;
- a SHA-256 digest;
- an accountable owner.

Runtime readiness identifies the exact OpenShell executable, runtime, sandbox
image, target adapter, policy, task protocol, security verifier, inference
provider, and model.
The `components.securityVerifier.digest` value is the SHA-256 digest of the
trusted verifier executable's raw bytes. An attachment also identifies the target
image, target platform, target service bundle, and three capability protocol
versions. A task result binds all of those identities and the content identity
of the attached target. Its exercised capability set contains exactly
`browser`.

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
protocol, inference model, or dependency change invalidates candidate
authority and requires new candidate evidence.

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
Destroy removes target reachability, mutable browser and fixture state, private
artifacts subject to the retention policy, and all NemoClaw-owned CUA state.

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

`task-result` records are terminal: `succeeded`, `failed`, or `cancelled`. A
succeeded task requires both a succeeded agent result and passed independent
verification. Its `capabilities` list contains exactly `browser`. It also
requires exactly one completed browser receipt with at least one evidence
digest. The verification record contains at least one check and at least one
evidence digest; verification evidence cannot consist only of the agent-result
digest. A failed task cannot contain both success conditions. The task and
agent result must agree on cancellation.

NemoClaw retains at most the 16 most recent validated terminal results for
normal CLI reconnect inspection. It never persists task input. A task ID in
that retained set cannot be reused.

Before a task adapter runs, NemoClaw requires a current `security-attestation`
record. A trusted host-side verifier produces that content-free record only
after it validates the policy applied to the sandbox and target. The
attestation is bound to the exact OpenShell executable, runtime, sandbox image,
target image, service bundle, declared policy, applied policy, task protocol,
security verifier, inference route, capability protocols, and target identity.
Its `bindings.appliedPolicy` field records the effective policy revision and
SHA-256 digest observed through OpenShell.

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
  removed by target detach or destroy according to the retention boundary; and
- qualification uses synthetic local fixtures, denies external side effects,
  and never lets task input, page or screen content, downloads, or runtime
  output expand authority.

The verifier owns any private endpoint and credential inspection needed to
make those assertions. Its request contains the sandbox name and public
runtime-readiness and target-attachment records plus the content-free
`appliedPolicy` identity, but no private verifier authority; its attestation
contains none of those private values.

For `security verify --adapter`, NemoClaw compares the executable's raw bytes
with `components.securityVerifier.digest`. The path must directly name a regular
executable from 1 byte through 64 MiB, and NemoClaw does not follow symbolic
links. It rejects a mismatch without running that executable. It executes a
private snapshot of the verified bytes, so a path replacement after validation
cannot change the invoked executable. The returned `attestation.verifier`
identity must exactly match `components.securityVerifier`.

NemoClaw rejects a verifier digest mismatch and a malformed, incomplete, or
identity-stale attestation as `policy_invalid`. Identity drift makes an
attestation stale and blocks task execution. Target detach or destroy clears it
after the target operation succeeds. Target health also clears it when it
records the target as unreachable, incompatible, or replaced. An explicit
verification failure clears any prior attestation, so task execution remains
fail closed until verification succeeds again.

Every non-null `target-attachment.activeTask` and `task-result` carries the same
`appliedPolicy` identity. NemoClaw re-observes that policy before lifecycle
admission and after each adapter call. Policy drift preserves the external
target and active task under a durable reconciliation gate while making the
attestation and retained results unavailable. Normal lifecycle operations
remain blocked across restart until an independent target or task status
observation records the actual external state, the exact observed task is
cancelled when present, and target destroy proves cleanup.

NemoClaw writes the same reconciliation gate before every side-effecting
target, task, or security adapter call. A timeout, malformed result, authority
change, or registry compare-and-swap conflict cannot erase the possible
external effect. Onboarding, inference changes, snapshot restore, and sandbox
destruction must preserve the gate and refuse reuse until cleanup succeeds.

## Failure families

Public failures use one deterministic family:

| Family | Condition |
| --- | --- |
| `lifecycle_unavailable` | An advertised lifecycle operation is unavailable, or a known compatibility command is not advertised by this slice. |
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

Candidate qualification uses one browser-form scenario. The task enters text,
selects an option, scrolls, and submits the seeded form. Code outside the agent
verifies the exact submitted JSON. The qualification receipt binds the exact
runtime, sandbox, target, service, inference, policy, task protocol, fixture,
and verifier identities. Its `components.securityVerifier` digest must match
both the runtime-readiness component and the recorded security attestation's
`verifier` identity.

Qualification may run through a host-owned adapter, but the adapter must call
the advertised public NemoClaw lifecycle. Private qualification evidence does
not enter the public issue, contract, or repository.

The browser scenario receipt records one `fixtureStateDigest` separately from its
final `stateDigest` and `evidenceDigests`. The gate executes the sealed fixture
snapshot directly, without a shell, exactly once before it starts the browser
scenario task. Its closed argument protocol is:

```text
prepare --protocol cua.qualification.fixture/v1 --scenario browser --task-id <safe-id> --sandbox <safe-id> --target-identity-digest <sha256-digest> --runtime-readiness-digest <sha256-digest> --task-input <absolute-sealed-path>
```

Other than the sealed task-input path, argv contains only content-free IDs and
digests. It contains no receipt path or expected observation.
Its stdout is one exact object containing `schemaVersion: "1.0.0"`,
`kind: "cua-qualification-fixture-state"`, `scenario`, `taskId`, `sandboxName`,
`targetIdentityDigest`, `runtimeReadinessDigest`, and `fixtureStateDigest`.
The gate requires every output identity, including `sandboxName`, to match the
invocation and requires `fixtureStateDigest` to match the scenario receipt.

After the public task result is available, the gate executes the sealed oracle
snapshot directly and exactly once. Its closed argument protocol is:

```text
observe --protocol cua.qualification.oracle/v1 --scenario browser --task-id <safe-id> --sandbox <safe-id> --target-identity-digest <sha256-digest> --runtime-readiness-digest <sha256-digest>
```

Its stdout contains only `schemaVersion: "1.0.0"`,
`kind: "cua-qualification-oracle-observation"`, `scenario`, `taskId`,
`sandboxName`, `targetIdentityDigest`, `runtimeReadinessDigest`, `stateDigest`,
and `evidenceDigests`. Every output identity, including `sandboxName`, must
match the invocation. The oracle receives no expected fixture, final-state, or
evidence digest. The gate compares the independent observation with the
receipt and the public task result and evidence after execution. It also
rejects a task-input payload that contains a receipt state or evidence digest,
with or without the `sha256:` prefix.

Both executable snapshots have mode `0500`. Their direct executions use a
minimal credential-free environment, bounded timeouts, and bounded stdout.
Qualification authority setup enters its cleanup boundary as soon as the
private directory exists. A staging, permission, write, or seal failure
restores the directory mode when needed and removes the partial authority
state through the same idempotent cleanup path.

Candidate fixture and oracle execution also requires the exact root-installed
qualification artifact runner. Each invocation enters fresh mount and process
ID namespaces, mounts private memory-backed scratch and `/tmp` filesystems,
and runs as a dedicated non-login user. The runner clears supplementary
groups and Linux capabilities, enables `no-new-privileges`, and supplies only
a fixed credential-free environment. Ordinary lifecycle execution does not use
this candidate-only runner.

The candidate manifest, bounded authority-owned qualification environment, and
sanitized bundle receipt bind one exact clean candidate before the gate starts.
Canonical onboarding records `candidate` readiness only in explicit
qualification mode. The harness then validates raw hashes for the environment,
qualification receipt, bundle receipt, runtime manifest, target manifest, and
task input. It copies those inputs, the launchable, OpenShell executable,
fixture, oracle, runtime payload, and adapters into one exact-set private
authority directory. The sealed directory has mode `0500`, and its regular
children have mode `0400` or `0500`. The harness consumes only those snapshots.
It compares the complete public component, inference, and
`providerAuthorityDigest` authority with the candidate readiness record.
The OpenShell digest in the receipt must match `components.openshell` and the
exact executable used by every live observation.
The target-adapter digest in the receipt must match
`components.targetAdapter` and the exact adapter used by every target
operation.

The receipt contains exactly one `browser` scenario record. It has no
recreation scenario. The browser task ID, fixture-state digest, final-state
digest, and evidence digests are distinct and bound to the one candidate run.

The live gate exercises every advertised target, security, and task operation.
For the onboarded runtime, the task set is exactly `task.start`, `task.status`,
`task.result`, and `task.cancel`. It also exercises four required fail-closed
outcomes: target-adapter substitution, task-adapter substitution,
security-adapter substitution, and an undeclared full-access policy entry.
Each receipt entry binds one fixed public failure outcome digest.

The GPU probe image digest must equal the candidate manifest's `targetImage`
digest. The gate runs that immutable image without a network, with a read-only
filesystem, all capabilities dropped, `no-new-privileges`, a numeric non-root user, and
bounded process, CPU, memory, and file-descriptor resources. It re-observes the
host and probe-image GPU identities.

The live gate invokes one canonical absolute Node.js executable and the exact
`bin/nemoclaw.js` from the candidate checkout. It rejects another
`NEMOCLAW_CLI_BIN` value and does not resolve the launcher through caller
`PATH`. Before completion, the gate revalidates the exact candidate checkout
and launcher, destroys the target, and verifies that every authority payload
retains its original raw digest.

The receipt has no trusted cleanup completion flags. Its `cleanup` object binds
the final public target-destroy record and four content-free sandbox
observations.
The gate accepts those observations only after canonical NemoClaw destroy
succeeds, public NemoClaw status reports absence, the local registry has no
sandbox row, and OpenShell inventory has no sandbox entry.

Final promotion is outside this slice. Candidate evidence does not authorize
`available` readiness or product support.

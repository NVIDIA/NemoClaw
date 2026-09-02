<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboarding lifecycle contract map (#6225, epic #6224)

This is a behavior-preserving inventory of onboarding and runtime-mutation journeys.
It records current ownership, effect boundaries, checkpoints, secret handling, recovery, and known gaps; it is not a target design.
The completed #6226, #6227, and #6228 work established the current create-intent, recovery, and checkpoint contracts.
References use stable symbols and modules rather than line numbers.

Related guides: [`README.md`](README.md) describes package placement, [`machine/README.md`](machine/README.md) describes the FSM, and [`../messaging/AGENTS.md`](../messaging/AGENTS.md) describes manifest-first messaging.

## Shared vocabulary

| Term | Contract | Current artifact |
|---|---|---|
| **intent** | Deterministic, serializable desired outcome; carries logical bindings, never secret values or live handles | `SandboxCreateIntent` in `sandbox-create-intent-types.ts`, produced by `resolveSandboxCreateIntent` |
| **plan** | Intent plus observed state, ready to apply | `MessagingWorkflowPlanner.buildPlan`; `materializeSandboxCreatePlan` |
| **apply** | Effectful phase that binds credentials and live capabilities | `bindMessagingTokenDefs`; create, rebuild, and mutation executors |
| **checkpoint** | Durable, secret-minimized state from which a later process can continue | onboard session and machine snapshot; registry; backup/recovery manifests |
| **result** | Handler outcome: advance, retry, branch, pause, complete, or fail | `OnboardStateResult`, applied by `OnboardRuntime` through `OnboardRuntimeBoundary` |
| **compensation** | Effect that undoes or limits a partial apply | failed-create source cleanup, `cancel-rollback.ts`, `rollbackChannelAdd`, recovery-registry restore |
| **reconcile** | Align recorded and live state without replaying the full journey | sandbox drift checks, `reconcileSandboxMessaging`, `mergeOpenClawRestoredConfig` |

A **lifecycle contribution** is an internal, data-first plan input such as a policy preset, provider binding, package, host forward, resource profile, or runtime setup entry. It is not a public SDK. A **managed agent package** is recorded desired state for an agent runtime. An **agent-native plugin** is interpreted by the selected agent. “NemoClaw plugin SDK” remains reserved for the #6229 decision.

## Machine ownership

The 13 states are defined in `machine/definition.ts`; legal edges are defined in `machine/transitions.ts`.

```text
init -> preflight -> gateway -> provider_selection -> inference
inference --retry--> provider_selection
inference --advance--> sandbox
sandbox --branch--> openclaw -> policies -> finalizing -> post_verify -> complete
sandbox --branch--> agent_setup -> policies -> finalizing -> post_verify -> complete
post_verify --pause--> post_verify (retryable handoff without a state transition)
each nonterminal state --failure--> failed
```

Every nonterminal state has one production owner or an explicit internal designation:

| State | Production owner |
|---|---|
| `init` | Synthetic phase in `machine/flow-slices.ts`, applied by the strict initial-flow runner |
| `preflight` | `machine/handlers/preflight.ts` |
| `gateway` | `machine/handlers/gateway.ts` |
| `provider_selection`, `inference` | `machine/handlers/provider-inference.ts` |
| `sandbox` | `machine/handlers/sandbox.ts`, with resume and messaging decisions delegated to `sandbox-resume.ts` and `sandbox-messaging.ts` |
| `openclaw`, `agent_setup` | `machine/handlers/agent-setup.ts` |
| `policies` | `machine/handlers/policies.ts` |
| `finalizing` | `handleFinalizationState` in `machine/handlers/finalization.ts` |
| `post_verify` | `handlePostVerifyState` in `machine/handlers/finalization.ts` |
| `complete`, `failed` | Terminal; no handler |

The initial, core, and final flows give the strict runner ownership from the durable entry state. If a saved session is later than a slice entry, the flow runs earlier handlers as prerequisite repairs. Each repair emits a `state.repair.started` event and then a `state.repair.completed` or `state.repair.failed` event. A repair must return a legal, update-free transition chain and leave the durable state unchanged. The flow validates but does not apply the repair transitions. The repaired context then feeds the strict runner at a state or the next flow slice.

FSM transitions remain step-granular.
For OpenClaw onboarding, the sandbox handler additionally checkpoints each completed secret-free prompt group: sandbox name, web search selection, messaging selection and non-secret configuration, and resource profile.
After the sandbox name and web search are checkpointed, the handler reconciles and checkpoints messaging before provider registration.
It then registers the validated web-search and messaging provider groups, in that order, before the resource prompt.
Each successful registration saves a secret-free provider-binding receipt.
The versioned checkpoint also records durable sandbox identity and completed web-search provider, messaging provider, sandbox-create, and sandbox-register effect groups.
Resume skips an effect only after its live postcondition is revalidated.
The machine still cannot resume inside gateway startup, an individual credential upsert, sandbox creation, policy application, or another handler-owned effect group.

## Onboarding policy authority

When `--apf-interceptor` is not selected, fresh onboarding passes the operator-selected initial policy to sandbox creation. When it is selected, onboarding creates the sandbox without `--policy`. OpenShell owns and stores the sandbox policy. For an existing sandbox, policy-dependent operations read the current live policy through the sandbox's recorded gateway.

Completed onboarding stores no policy authority, policy receipt, policy copy, policy hash, policy version, preset list, or desired policy tier. Incomplete operations retain only the bounded transaction data required for recovery and cleanup.

## Effect-order flows

`*` marks a durable checkpoint and `!` marks the sandbox-delete boundary. In-place destructive effects that occur earlier are called out in the matrix.

```text
fresh OpenClaw onboard
  resolve entry options -> save session/machine* -> host preflight
  -> gateway/inference-provider effects -> checkpoint name/identity and web prompts*
  -> checkpoint messaging prompts*
  -> create or update web-search provider + save binding receipt*
  -> create or update messaging providers + save binding receipts*
  -> checkpoint resource prompt*
  -> resolve complete sandbox-create intent
  -> materialize create plan -> create -> ready -> live validation -> register
  -> record create/register receipts*
  -> finalize session*

--fresh entry reset
  clear prior session (local destructive reset) -> save new session*
  -> force base-image resolution -> follow new-onboard or live-recreate flow

ordinary live recreate
  resolve drift/conflicts + complete create intent -> conditional backup* -> provider cleanup -> ! delete
  -> preserve source registry row -> materialize plan -> create -> ready -> restore/validate
  -> commit replacement registration over source row*

resume drift
  load versioned checkpoint* -> reject hint conflicts -> revalidate current bindings
  -> resolve complete create intent -> ordinary path conditional backup* -> ! delete
  -> preserve source registry row -> materialize plan -> create -> ready -> restore/validate
  -> commit replacement registration over source row*

not-ready repair
  load session* -> resolve complete create intent -> repair event -> ! delete
  -> preserve source registry row -> materialize plan -> create -> ready -> validate
  -> commit replacement registration over source row*

rebuild / installer upgrade
  registry (+ guarded session fallback) -> preflight -> optional backup/recovery manifest*
  -> mutation-edge recheck
  -> ! delete -> recreate session* -> inner onboard create+register/session*
  -> outer restore -> post-restore registry/policy/MCP reconciliation*

runtime mutation
  load registry/session -> command-specific validation+applicable locks
  -> mutate gateway/config/registry -> session/audit*
  -> optional queued rebuild for changes that require image recreation
```

## Journey matrix

| Journey and entry | Desired state, planning, and assembly | Visible and destructive boundaries | Checkpoint and secret boundary | Compensation, coverage, and gaps |
|---|---|---|---|---|
| **New interactive or non-interactive onboard** — `onboard()` and `resolveOnboardEntryOptions` | Current flags, environment, and prompts. `MessagingWorkflowPlanner.buildPlan`, `prepareSandboxMessagingPreflight`, resource-profile selection, `resolveSandboxCreateIntent`, and `materializeSandboxCreatePlan` assemble policy, provider, package, resource, host-forward, and runtime-setup contributions. Non-interactive mode replaces prompts with defaults or hard aborts. | Consent/session/lock setup and preflight can persist local state, install OpenShell, or clean stale gateway artifacts before the gateway handler. Gateway reuse/recovery/start is the first provider-routing effect; inference-provider upserts follow. For OpenClaw, messaging selection and plan reconciliation complete before web-search or messaging provider registration. Each validated provider group is then created or updated and checkpointed before resource selection. A name with no live sandbox has no sandbox-destructive boundary; an existing target enters the recreate contract below. | Whole-step session plus machine snapshot. OpenClaw adds narrow checkpoints after each completed secret-free sandbox prompt group; sandbox registry registration is deferred until readiness and live validation. The session stores credential environment names, redacted endpoint metadata, legacy-value digests, and non-secret names of web-search and messaging providers registered for resume; real values remain process- or gateway-bound. | Readiness, post-create policy verification, dashboard forwarding, and cancellation failures preserve the live sandbox and an independent identity-bound recovery record. A later `destroy` refuses mutable-name deletion while that sandbox is live. After administrator identity-bound removal, destroy uses the record to qualify immutable runtime identity and, for Docker-backed sandboxes, exact container identities before residual cleanup and record retirement. A different explicit sandbox name starts a fresh session without changing the retained record. Exact provider-owned GPU cleanup can proceed through its owner receipt. NemoClaw attempts to remove temporary policy and build-context sources and reports cleanup failures with the onboarding error; post-create failures retain recovery state. Cancellation before sandbox creation can leave the session resumable. Shared inference providers remain gateway configuration and are not sandbox cleanup targets. Coverage: `transition-traces.test.ts`, `sandbox-create-intent-boundary.test.ts`, `sandbox-create-plan.test.ts`, and the focused cancellation, readiness, GPU cleanup, dashboard, policy-authority, destroy, and retained-recovery tests. Gap: gateway upserts can outlive a failed or interrupted create. |
| **`--fresh` onboard** — `resolveOnboardEntryOptions`, `prepareFreshSession`, `createBaseImageResolutionContext` | Current flags/environment/prompts replace resumable intent. `--fresh` disables auto-resume and forces base-image resolution; it does not prove that the selected sandbox name is unused. | The first destructive effect is local: the prior onboard session is cleared before a new session is saved. A matching live sandbox can later reuse or recreate through the normal sandbox decision; `--fresh` does not itself delete it. | The new session and machine snapshot replace the old resume checkpoint. Credential and effect boundaries then match new onboard or live recreate. | The discarded resume checkpoint is not restored on later failure. Covered by `entry-options.test.ts`, `session-bootstrap.test.ts`, and base-image resolution tests. |
| **Resume, re-onboard, or recreate** — `onboard()`, `prepareOnboardSession`, `decideSandboxResume`, live-sandbox handling in `createSandbox` | For `--resume`, the recorded session is authoritative and conflicting current name/provider/model/image/tool-disclosure hints are rejected. A new re-onboard run takes current flags, environment, and prompts as intent while registry/gateway state provides drift evidence. The machine resolves a complete secret-free create intent, including policy, messaging/provider, GPU, resource, disabled-channel, and agent inputs, before repair/removal or live recreation. | Ordinary live recreation conditionally backs up before provider cleanup, **delete**, and image removal. The recreate journal preserves the source registry row after deletion. Replacement registration commits the new row after readiness and validation. A selected pre-upgrade backup suppresses a new one; an explicit override permits recreation without backup. Resume registry removal and `repair-and-recreate` occur only after complete intent validation. Temporary policy/build artifacts remain materialization effects after the delete boundary. | Resume continues the recorded session/machine snapshot; non-resume re-onboard writes a new session first. OpenClaw records completed sandbox name, web search, messaging, and resource choices with explicit progress markers, including explicit `null` choices, while the complete create intent stays process-local and is not persisted or emitted. Raw credential values remain outside the session. A missing process value can be rebound only when the same OpenClaw session recorded successfully registering that provider and its live provider name, provider type, and credential key still match; otherwise interactive resume requests it again and non-interactive resume exits with environment-variable guidance. Credentials are checked before mutation and again immediately before materialization. | A failed replacement keeps the source registry row. Restore failures warn and can still publish the replacement; managed-DCode live-selection failure leaves a running, unregistered sandbox with manual-delete guidance. Checkpoint replay reuses an exact live sandbox after an interrupted create and backfills missing create/register receipts. Cancel rollback is not armed and there is no rebuild-style receipt rollback. Coverage: transition traces, create-intent characterization, checkpoint replay and resume guards, and sandbox-handler crash recovery. Gaps: early backup asymmetry and no rebuild-style cross-effect rollback. |
| **Rebuild or installer-driven upgrade** — `rebuildSandbox` in `rebuild-pipeline.ts`; `upgradeSandboxes` | Registry state is authoritative. A matching session may fill guarded legacy gaps only when its selection agrees; an unrelated/global session is never used. Ambient provider/model selection is quarantined by `isolateAmbientRecreateEnv`, apart from narrowly scoped legacy recovery. Legacy and custom-image rebuilds retain and fingerprint a prepared build context. Managed-image rebuilds instead stage an immutable image and startup-profile handoff, skip Dockerfile image preflight, and revalidate provider-bound workload authority before each deletion boundary. | Consent persistence, target-gateway selection/recovery, and target-preflight registry updates can precede disposable image build/probes. Backup is the first durable recovery checkpoint when available. MCP detach/scrub and NIM stop are destructive in-place effects before the **sandbox delete** boundary. Legacy and custom-image paths recheck prepared context and mutation-edge conditions before delete. Managed-image paths revalidate the provider-bound handoff before delete. | Durable checkpoints are the backup/recovery manifest when one exists and the rewritten recreate session; stale recovery can reach deletion without a manifest, making that session its first new durable checkpoint. Rollback receipts/snapshots are process-local. Credential metadata comes from the target or guarded fallback; raw credentials/providers are checked against current process/gateway state, while prepared installer recovery may reconstruct a missing gateway provider from a validated host credential. | In-process rollback best-effort restores registry/MCP retry metadata, but process death after non-MCP delete can still lose it. The inner onboarding consumes the managed-workload handoff or selects the legacy resource profile after deletion. Covered by rebuild, managed-workload authority, image-preflight, DCode, and messaging tests. Gaps: health-before-delete and atomic swap. Closed issue #5801 records the original gap; #6835 fixed only the printed recovery path. |
| **Stock Docker-driver managed-image onboarding** — managed-workload selection in `onboard-orchestration.ts` | Ordinary onboarding through the OpenShell Docker driver validates one complete all-agent catalog, immutable release and platform contracts, and selected-provider capabilities before selecting OpenClaw, Hermes, or LangChain Deep Agents Code. Portable onboarding, non-managed agents, and explicit `--from` custom images retain their legacy or custom workload paths. | The managed path skips Dockerfile build materialization, creates provider-bound bootstrap authority for the immutable image and startup profile, launches that workload, and registers the managed-workload receipt only after readiness. | Catalog contracts, bootstrap authority, and workload receipts are secret-free and identity-bound. Raw provider credentials retain their existing process and gateway boundaries. | Preparation and provider failures stop before registration; provider-owned bootstrap rollback and durable recovery own partial activation. Catalog, bootstrap, managed-image activation, and protected-runtime tests cover the shipped Docker-driver path. Native Podman remains outside the production provider registry and supported surface. |
| **Managed snapshot clone handoff and provider transaction (internal and dormant)** — `prepareManagedWorkloadCloneHandoff`; `prepareManagedCloneProviderTransaction` | The current source registry row owns mutable operator intent; the selected snapshot owns immutable managed-workload and provider-runtime history. Handoff preparation proves the selected runtime provider and its `clone` capability, exact current registry generation and live-identity fingerprint, snapshot/source workload equivalence, snapshot runtime generation, and the state layer's selected-manifest/payload digest. It rebinds the secret-free startup profile, messaging intent, dashboard identity, and provider-owned contributions for OpenClaw, Hermes, or DCode without a central Podman-specific switch. Provider preparation then resolves active application bindings plus provider-contributed bindings, treating a live exact provider as reusable only when the destination registry independently proves that same logical binding. | The handoff and provider plan are inert. The internal materializer can create only bindings proven absent at preflight; it never updates or deletes an existing destination-owned provider. Immediately before each create it revalidates the source and optional destination registry rows plus the exact `SnapshotRestoreAuthority`. Production snapshot restore does not invoke this transaction and continues to reject cross-sandbox managed-image restore through `rejectManagedSnapshotCloneUntilRebind`; no user-visible clone support is advertised. | Both plans are deeply frozen and secret-free. A successful create produces an exact process-local ownership receipt; a non-zero create reconciled to an exact provider remains ambiguous and unowned. The receipt ledger remembers completed cleanup so a repeated cleanup cannot delete a later same-name provider. Raw credentials exist only in the explicit apply environment and one OpenShell child environment. | Failure rolls back only providers confirmed created by the exact in-process receipt, preserves collisions and ambiguous creates, reports incomplete cleanup for retry, and never rewrites a reused provider. `src/lib/onboard/managed-workload-clone-handoff.test.ts`, `src/lib/onboard/managed-startup-clone-rebinder.test.ts`, and `src/lib/actions/sandbox/snapshot-managed-clone-handoff-dormancy.test.ts` cover the all-agent, Docker/MXC-style provider, canonical-name, and fail-closed boundaries; provider transaction tests cover race, force-replace, disappearing-credential, rollback, and idempotent cleanup. This PR intentionally covers only the dormant contract. Epic [#7744](https://github.com/NVIDIA/NemoClaw/issues/7744) tracks destination creation/bootstrap, filesystem mutation-edge invocation, Hermes broker activation, durable recovery, protected E2E, and user-visible activation. |
| **Channel add/remove/start/stop** — `addSandboxChannel`, `removeSandboxChannel`, `sandboxChannelsSetEnabled` in `policy-channel.ts` | Add compiles and merges a manifest-derived channel delta with `MessagingWorkflowPlanner`. Start, stop, and remove transform the registry plan and rehydrate executable render/build/runtime/forward details from current manifests. | Token-backed add can mutate gateway credentials before policy and plan persistence; QR/in-sandbox-auth add skips that credential upsert. Start persists the enabled plan before policy; stop persists the disabled plan before the rebuild prompt. Remove clears QR-backed durable state when applicable, detaches gateway/bridge state, removes policy, then persists the plan. During `channels remove`, OpenClaw WeChat can clear its manifest-declared legacy state and current plugin account state from an identity-pinned stopped Docker volume after normal cleanup fails. If that cleanup fails, the command stops before policy and plan teardown. A queued rebuild has a separate delete boundary. | The compact registry messaging plan is authoritative; render/build/runtime/state/health entries and nested host-forward details are rehydrated rather than persisted. Channel mutations persist the registry plan but do not rewrite `Session.messagingPlan` or matching-session `policyPresets`. Raw tokens stay in process/gateway bindings. | `rollbackChannelAdd`, re-disable after failed start, and fail-closed QR-state cleanup provide partial compensation. Covered by `policy-channel*.test.ts`, `workflow-planner.test.ts`, and channel integration tests. Gaps: channel add has a separate `--force` conflict policy; add/remove effects can precede plan persistence, and persistence failures are not fully rolled back. |
| **Provider, model, or credential-binding change** — `runInferenceSet` | CLI intent plus registry/session metadata. Target resolution and OpenShell preparation occur before locking. The target is re-resolved under the sandbox lifecycle lock; that phase validates provider/model syntax, selected agent, and local reachability before the first write. | First mutation is the gateway route, then a minimal registry write, API-family/config resolution, registry refresh, best-effort config/hash sync, matching-session update, and audit. An OpenClaw API-family change can then restart the managed gateway while the sandbox lock remains held. No sandbox deletion. | Registry and matching session store logical provider/model/credential-environment metadata. Audit records the action, sandbox, and reason rather than credentials; raw values remain gateway-bound. | Forward-only; no rollback. `rebuild` is the repair path for degraded state. Covered by `inference-set*.test.ts`. Gap: several stores can diverge after a mid-sequence failure. |
| **Credential rotation** — `configRotateToken` in `src/lib/sandbox/config.ts`; `rotateSandboxToken` in `src/lib/sandbox/config-rotate-token.ts` | A session with `credentialEnv` selects the provider and binding. A non-null different `sandboxName` is rejected, but a legacy/null session name is accepted for the requested sandbox. The new value comes from a named environment variable, stdin, or a secret prompt; it is trimmed, then rejected when empty or still containing internal whitespace. | An OpenAI provider profile is validated before credential staging. When that profile is missing, its import is the first external mutation. `saveCredential` then stages the value in the current process. OpenShell provider update follows, with provider create as a fallback; audit is last. Other provider types begin with `saveCredential`. No sandbox deletion. | The logical binding is unchanged, so session and registry are not rewritten. The raw value exists only in process memory/environment and the gateway provider; audit records action/sandbox/reason without the value. | Profile validation or import failure stops credential staging and provider mutation. No rollback follows a successful profile import or provider update; an audit failure can report failure after the credential is already active. Covered by `test/security/config-rotate-token-provider-profile.test.ts` and the rotate-token case in `test/security/config-set-nested-ssrf.test.ts`. Gap: a null-name legacy session is not strongly bound to the requested sandbox. |
| **Config, policy, resource, port-forward, and runtime setup contributions** — `configSet`; `prepareInitialSandboxCreatePolicy`; `selectResourceProfileForSandbox`; manifest compiler/runtime appliers; dashboard and channel forward helpers | Config uses validated dotpaths and SSRF-safe URL rewriting. Create/rebuild contributions are assembled by `sandbox-create-plan.ts` and `MessagingWorkflowPlanner`: policy presets/keys, resource flags, package/build steps, `hostForward`, runtime node preloads, env aliases, and secret scans. | Config’s first effect is a compare-and-swap sandbox write. Build-time contributions inherit the enclosing create/recreate boundary. Forward helpers can stop an existing forward and start its replacement in place after readiness, without recreating the sandbox. | Durable owners are compact registry messaging/policy/inference metadata, current manifests used for plan rehydration, onboard session, sandbox config/hash, and gateway provider state. An interrupted onboarding session records the selected resource values or an explicit OpenShell-default choice; the resolved create intent remains process-local. Logical bindings are serializable; raw provider values are not. | CAS rejects stale config writes; OpenClaw/Hermes commit config and integrity hashes together, while other agents may refresh a path hash afterward. Audit and optional restart are post-commit and forward-only. Forward recovery can re-establish declared forwards. Gaps: no cross-contribution effect transaction/checkpoint. |

## Durable resumed recreate journal

A resumed same-name replacement writes a secret-free journal before the lower create path can delete the source sandbox.
The journal binds the session, sandbox, selected gateway, source registry row, source OpenShell ID fingerprint, target intent, target generation, and the replacement OpenShell ID fingerprint after creation.

Recovery accepts only these states:

- The source row and live ID match, so deletion can continue.
- The source row remains and OpenShell reports no sandbox, so creation can continue.
- The journaled replacement ID matches both the registry row and the ready live sandbox, and the registry row has the target generation, so the replacement can be accepted.

All other combinations stop before the current run reuses, deletes, or creates a sandbox.
The lower create path stamps the target generation and hashed OpenShell ID into the replacement row.
The handler clears the journal after it records both create and registration receipts.

This slice covers resumed onboard replacement, including not-ready repair and non-default gateways.
Rebuild and non-resumed re-onboard now open the same journal.

## Journal-bound pre-upgrade backup selection

Pre-upgrade backup selection consumes the journal rather than registry and gateway booleans.
`selectPreUpgradeBackupForCreate` requires a source proof with the transaction identifier, sandbox name, gateway name and port, source registry fingerprint, source OpenShell ID fingerprint, deletion confirmation, and target generation.
When OpenShell reports the source sandbox as missing, selection continues only after the journal confirms source deletion.
It rejects all source-proof mismatches before backup lookup, deletion, creation, or registry mutation.

The installer upgrade path, where the registry row survives but OpenShell reports no sandbox, opens the journal before selection and abandons it if the custom-image plugin-provenance check blocks recreation.
A journal is abandoned only while its revision is still zero, so no recorded lifecycle effect can be discarded.

Selection asks for the proof only after the installer signals restore intent.
Without that signal nothing restores onto the replacement, so the run opens no journal and leaves no transaction for the create path to complete.

Once a run binds a gateway authority, a same-name replacement that cannot open a journal stops instead of deleting the sandbox or removing its registry row.
Every same-name replacement deletes through `SandboxRecreateRuntime.beginDelete`, and the no-transaction runtime refuses there, so a new caller that skips the journal fails before the OpenShell delete rather than passing an unproven source through.
Custom-image plugin provenance, explicit installer restore intent, the absent-backup warning, managed-MCP routing to `rebuild`, and fail-closed handling of unknown OpenShell state stay separate contracts.

## Managed snapshot and rebuild restore authority

Managed-image backups use one provider-neutral authority path for explicit snapshot creation, `backup-all`, stopped-sandbox backup retries, and rebuild backups.
The contract applies to OpenClaw, Hermes, and Deep Agents Code.
The path records the managed workload receipt and a versioned runtime receipt from the sandbox's registered provider.
The state layer copies and sanitizes the backup before it invokes the provider fence.
The fence re-reads the registry row and re-observes the provider runtime.
The state layer publishes the manifest atomically only when the workload, provider, lifecycle generation, runtime identity, and acceleration receipt still match.
It removes the unpublished backup directory when the fence rejects publication.

A managed restore binds the selected manifest and every backup payload to one content digest.
The state layer recomputes that digest after local restore staging and before its first remote filesystem mutation.
At the same mutation edge, central orchestration asks the registered provider to revalidate the target runtime and managed startup profile.
After state restoration, the provider must prove the managed profile and runtime state again.
Explicit snapshot restore and rebuild restore use this same boundary.

The snapshot provider facet has its own contract version.
Provider inputs are detached and deeply frozen at the extension boundary, and central orchestration retains only normalized receipts.
Docker lifecycle inspection and GPU inspection remain inside the Docker provider adapter.
The provider-neutral receipt can represent another provider, including an MXC-style implementation, without adding provider switches to snapshot or rebuild orchestration.

Legacy and custom-image snapshots retain their state-only backup and restore path.
The managed authority path backs ordinary Docker onboarding and recreation for the shipped managed agents without activating another runtime provider.
The raw state layer still rejects a managed manifest unless both content authority and a runtime-validation fence are present.
Cross-provider clone and rebind, durable interrupted-restore recovery, and provider expansion remain separately reviewable units tracked by the [incremental runtime epic](https://github.com/NVIDIA/NemoClaw/issues/7744).
If provider proof fails after filesystem restoration, NemoClaw reports that state changed and requires the operator to retry the same selected snapshot after the runtime stabilizes.

## Podman managed-bootstrap authority

The Podman candidate owns a separate `managed-bootstrap` command scope bound
to one rootless engine authority. Before a bootstrap mutation, it
discovers and stably inspects exactly one held OpenShell workload and acquires a
durable lease over the watcher process and lifecycle owner. Ambiguous
workloads, watcher ownership, PID reuse, endpoint drift, or a competing lease
fail closed.

Preparation creates a private managed state volume and a stopped,
final-labelled replacement while retaining the original. Its monotonic
journal records the engine authority, watcher lease, immutable original and
replacement identities, image and specification fingerprints, state volume,
and rollback decision before each external effect. Pre-commit rollback removes
only the proven stopped replacement and owned volume, restores the original, and leaves the watcher lease with the caller until a healthy owner is independently requalified.

The image transaction accepts only that prepared authority. It stages one
protected root-apply request, starts the replacement, and authenticates
the image-owned completion for OpenClaw, Hermes, or LangChain Deep Agents Code.
The watcher stays stopped and the journal remains authoritative throughout.
The registered native Podman provider consumes this authority when
`NEMOCLAW_GATEWAY_RUNTIME=podman` selects it for standard managed-image
onboarding. Persisted post-commit recovery, provider-owned cleanup, state-root
preparation, and the supported E2E matrix fail closed on ambiguous or changed
authority. The portable experimental profile remains an independent lifecycle
and does not consume this selection.

## Agent-specific differences

| Agent | Lifecycle difference |
|---|---|
| OpenClaw | `sandbox -> openclaw`; supports messaging render targets and OpenClaw config/plugin reconciliation. |
| Hermes | `sandbox -> agent_setup`; adds auth method, tool-gateway, dashboard, and credential-preflight drift axes. |
| Deep Agents Code (DCode) | `sandbox -> agent_setup`. Onboard filters unsupported channel selections, rebuild clears/skips messaging state, and `channels add` rejects DCode. Its specialized preflight replaces the generic image preflight; a normal live rebuild proves managed context and selected route at the delete edge, while recovery skips the live-route proof (`rebuild-dcode-preflight.ts`, #6214). |

## Persisted field ownership

The schema and sanitation authority is `Session` plus `normalizeSession`/`filterSafeUpdates` in `src/lib/state/onboard-session.ts`. `undefined` in an update means “leave unchanged”; accepted `null` means “clear.” On disk, many nullable fields still collapse never selected, explicitly declined, and explicitly cleared into the same `null` representation. `sandboxPromptProgress` records which of the checkpointed sandbox name, web search, messaging, and resource choices completed. The dedicated versioned `checkpoint` field (`src/lib/state/onboard-checkpoint.ts`) resolves the remaining ambiguity for those choices by modelling each as an explicit `unset`/`declined`/`selected` decision (#6228, #6227/#5783). Live decision reads use the checkpoint when it exists. When a session has no checkpoint, sandbox identity matching accepts the legacy name only if `sandboxPromptProgress.sandboxName` records completion. `deriveCheckpointFromSession` uses legacy fields only to migrate a session that has no checkpoint.

| Field group | Fields | Writer/owner and state meaning |
|---|---|---|
| Session envelope | `version`, `sessionId`, `mode`, `startedAt`, `updatedAt`, `status`, `resumable` | `createSession`, save/update helpers, and completion/failure paths. Values are always known after creation. |
| Progress and recovery | `lastStepStarted`, `lastCompletedStep`, `failure`, `steps`, `machine`, `sandboxPromptProgress`, `stagedCredentialProviders`, `checkpoint` | Step helpers record step-progress bookkeeping and context updates accepted by `filterSafeUpdates`. `OnboardRuntime` owns machine transitions, terminal state, and machine events. Explicit session recovery and the process-exit failure backstop are separate recovery boundaries. The OpenClaw sandbox handler owns prompt-group completion markers. `stagedCredentialProviders` contains only names registered before sandbox setup so OpenClaw resume can require both durable ownership and a live binding. A recreate journal handed to this run by the driver that owns the replacement — matching sandbox name and target-intent fingerprint, and past the delete boundary at `deleted` — is the equivalent ownership proof for a replacement that reset the session and can no longer read a host credential, and it stays paired with the same live binding check. A journal merely resident in the session is not that proof, because nothing binds it to this run: one survives a failed attempt, and one is opened straight at `deleted` when the sandbox is already missing. Provider-effect replay requires the receipt provider set to match the providers selected by the current web search configuration or messaging plan. Each persisted and live provider name, provider type, and credential key must match before the handler skips registration. After a successful replay, the handler replaces obsolete bindings owned by that effect group before sandbox creation and preserves bindings owned by the other provider effect group. A marker is trusted only when its matching persisted value is present and valid, including an explicit `null` where supported. `checkpoint` is the dedicated versioned resume contract: a secret-free tri-state decision record plus durable sandbox identity, effect-group receipts, and logical web-search and messaging provider bindings, serialized alongside the session under its own `schemaVersion` with fail-closed handling of an unknown future version. The primary inference provider binding remains owned and revalidated by the provider and inference phases instead of entering this checkpoint ledger. |
| Target identity | `agent`, `sandboxName`, `metadata.gatewayName`, `metadata.fromDockerfile` | Onboard selection, sandbox handler/registration, and rebuild session preparation. A completed sandbox step or valid `sandboxPromptProgress.sandboxName` marker is the trust gate for a recorded name. |
| Inference intent | `provider`, `model`, `endpointUrl`, `credentialEnv`, `preferredInferenceApi`, `compatibleEndpointReasoning`, `nimContainer`, `webSearchConfig` | Provider/inference handlers and `runInferenceSet`. Known credential state is an environment-variable name or presence metadata, never the value. `redactUrl` masks userinfo and fragments, redacts values under sensitive parameter names, and redacts canonical token-shaped values even under benign parameter names. |
| Agent intent | `hermesAuthMethod`, `toolDisclosure`, `hermesToolGateways` | Agent setup owns these choices. Policy selection is derived from the live OpenShell policy for the active operation. Completed onboarding retains no policy authority or policy copy. Nullable fields conflate unset, declined, and cleared where the CLI makes those distinctions. |
| Messaging intent | `messagingPlan`, `telegramConfig`, `wechatConfig` | `../messaging/plan-authority.ts` selects the registry messaging plan for an existing sandbox. Consumers with a known sandbox target resolve registry authority before they read a staged environment plan. Disabled-channel resolution also skips session loading when registry state is authoritative. A valid staged plan can still resolve a different target during implicit configuration lookup. For a new or pending target, a staged plan takes precedence over a matching session plan. `telegramConfig` and `wechatConfig` provide legacy configuration fallback. Raw credential values remain outside the session. |
| Resource choice | `resourceProfile` | The sandbox handler records concrete CPU/RAM values or `null` for an explicit OpenShell-default choice after the prompt completes. Environment overrides still take precedence on the recovery run. |
| Runtime metadata | `routerPid`, `routerCredentialHash`, `gpuPassthrough` | Router and sandbox setup/recovery. PID is a live-process hint; credential hash is a digest; GPU is a concrete boolean. |
| Legacy migration proof | `migratedLegacyValueHashes` | Onboard legacy migration writes SHA-256 digests keyed by environment name; session filtering guarantees string records but does not independently validate digest shape. |

The registry is separately owned by `src/lib/state/registry.ts`; backup and recovery manifests are owned by their rebuild and recreate modules. Step helpers do not change the machine snapshot or emit machine events.

## Duplicated decision points

1. **Messaging intent source:** `../messaging/plan-authority.ts` owns messaging plan selection. The registry plan is authoritative for an existing sandbox. For a new or pending target, a staged plan takes precedence over a matching session plan. Conflict and persistence policy remain separate work.
2. **Ambient environment policy:** onboard treats provider/model variables as intent; rebuild quarantines ambient selection except for narrowly target-scoped legacy recovery. Recommended owner: one target-resolution module.
3. **Conflict policy:** onboard and rebuild share `enforceMessagingChannelConflicts` with different prompt/abort policies; channel add uses the separate hand-built `checkChannelAddConflict` with `--force`. Recommended owner: one declarative conflict policy.
4. **Backup/restore policy:** rebuild and ordinary live recreate back up, while not-ready resume repair deletes before the generic backup; installer restore and channel mutation checkpoint different state again. Recommended owner: one backup/restore policy module.
5. **Registry lifecycle:** create registers post-ready; same-name replacement preserves the source row until replacement registration commits; rebuild records removals and restores retry metadata through `rebuild-registry-rollback.ts`. Recommended owner: `sandbox-registration.ts` plus the existing durable pre-create identity.
6. **Replacement validation:** legacy and custom-image rebuilds retain and fingerprint a prepared build context; managed-image rebuilds retain an immutable workload/profile handoff and revalidate provider-bound authority before deletion; normal live DCode rebuild adds route and managed-context proofs; re-onboard still stages legacy replacement work after delete. Health-before-delete and atomic swap remain unresolved. Closed issue #5801 records the original gap; #6835 fixed only the printed recovery path.

OpenShell policy authority is not a duplicated decision point. Each operation on an existing sandbox derives policy selection from the live OpenShell policy, and completed onboarding stores neither policy authority nor a policy copy.

## Bug-to-contract-gap map

| Issue | Gap | Current status |
|---|---|---|
| #5961 | Interrupted onboard lacks durable sandbox identity/effect-group metadata | Fixed by #7022. The checkpoint records durable identity and effect-group receipts; replay reuses a surviving exact-identity sandbox or recreates under that same identity. |
| #6040 | Resume aborts after restoring the preflight cache | Fixed by #7022 and verified on macOS and DGX Spark with v0.0.88. |
| #6179 | Stale handler results can reach an invalid transition | Fixed by #6253. Transition validation prevents a terminal `failed` state from re-entering an agent or flow state. |
| #5954 | Rebuild conflict was discovered after delete | Fixed by #5955 |
| #6099 | Late dashboard-forward failure could roll back a healthy sandbox | Fixed by #6116 and #6833. |
| #6195 | DCode rebuild deleted before replacement validation | Fixed by #6214 |
| #6743 | Resume repeated completed sandbox prompts | Fixed by secret-free sandbox prompt checkpoints |

PR #6218 separated secret-free create intent from effectful materialization.
PR #6742 moved complete create-intent validation before destructive onboarding effects.
PR #6253 made terminal recovery and transition validation explicit.
PR #7022 added versioned checkpoint migration, durable identity, effect-group replay, and fail-closed binding revalidation.
PR #6214 added DCode-specific pre-delete replacement validation; generic rebuild now also retains and revalidates a prebuilt context.
PR #5955 moved the rebuild messaging conflict check before destruction.

## Characterization coverage

| Contract | Executable evidence | Uncovered boundary |
|---|---|---|
| Fresh, resumed, recreate, successful, and failed machine event order | `machine/transition-traces.test.ts`, `machine/prerequisite-repair.test.ts` | None at this boundary. Sandbox-handler replay tests cover effect-group crash recovery. |
| Detailed recreate decisions and repair branches | `machine/handlers/sandbox-resume.test.ts`, `machine/handlers/sandbox.test.ts` | Cross-handler effect transaction |
| Legal edges, result kinds, runtime event shapes, runner sequencing | `machine/transitions.test.ts`, `machine/runtime.test.ts`, `machine/runner*.test.ts` | None at the unit boundary |
| Create intent/provider ordering and fail-closed credential drift | `sandbox-create-plan.test.ts` | Cross-module pre-delete ordering has no behavioral seam |
| Messaging conflict validation before recreate | `sandbox-messaging-preflight.test.ts`, rebuild preflight tests | One shared declarative policy across all callers |
| Resume identity | `checkpoint-replay.test.ts`, `checkpoint-resume-guard.test.ts`, `machine/handlers/sandbox-checkpoint-crash-recovery.test.ts` | Live process-termination E2E with a real OpenShell sandbox |
| Session sanitation, sandbox prompt checkpoints, and no-secret persistence | `src/lib/state/onboard-session-sandbox-prompts.test.ts`, `src/lib/state/onboard-checkpoint.test.ts`, `machine/handlers/sandbox-create-intent-boundary.test.ts` | Tri-state decisions remain scoped to checkpointed sandbox choices. |
| Versioned checkpoint schema, tri-state decisions, migration, and unknown-future fail-safe | `src/lib/state/onboard-checkpoint.test.ts`, `src/lib/state/onboard-checkpoint-migrate.test.ts`, `checkpoint-replay.test.ts` | Legacy sandbox identity remains a bounded runtime fallback and migration input only when no checkpoint exists. |
| Resumable create replay, durable identity, and stale-binding fail-closed | `src/lib/onboard/checkpoint-replay.test.ts`, `src/lib/onboard/checkpoint-resume-guard.test.ts`, `machine/handlers/sandbox-checkpoint-crash-recovery.test.ts` | None at the sandbox-handler boundary. |
| Managed snapshot workload, content, and provider authority across explicit and rebuild flows | `src/lib/actions/sandbox/snapshot/backup-authority.test.ts`, `restore-authority.test.ts`, `managed-profile.test.ts`, `provider-lifecycle.test.ts`, and `snapshot-managed-provider-restore-order.test.ts` | Durable interrupted-restore recovery and user-visible runtime activation remain separate review units. |
| Dormant managed clone handoff and fail-closed production boundary | `src/lib/onboard/managed-workload-clone-handoff.test.ts`, `src/lib/onboard/managed-startup-clone-rebinder.test.ts`, and `src/lib/actions/sandbox/snapshot-managed-clone-handoff-dormancy.test.ts` | Provider materialization, destination bootstrap, rollback, recovery, protected E2E, and activation remain tracked by [#7744](https://github.com/NVIDIA/NemoClaw/issues/7744). |

When lifecycle behavior changes one of these contracts, update the map and the narrow owning test in that same PR. Do not add source-text scans or production scaffolding solely to preserve current orchestration order.

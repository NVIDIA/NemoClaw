<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboarding lifecycle contract map (#6225, epic #6224)

This is a behavior-preserving inventory of onboarding and runtime-mutation journeys. It records current ownership, effect boundaries, checkpoints, secret handling, recovery, and known gaps; it is not a target design. Target refactors belong to #6226, #6227, and #6228. References use stable symbols and modules rather than line numbers.

Related guides: [`README.md`](README.md) describes package placement, [`machine/README.md`](machine/README.md) describes the FSM, and [`../messaging/AGENTS.md`](../messaging/AGENTS.md) describes manifest-first messaging.

## Shared vocabulary

| Term | Contract | Current artifact |
|---|---|---|
| **intent** | Deterministic, serializable desired outcome; carries logical bindings, never secret values or live handles | `SandboxCreateIntent` in `sandbox-create-intent-types.ts`, produced by `resolveSandboxCreateIntent` |
| **plan** | Intent plus observed state, ready to apply | `MessagingWorkflowPlanner.buildPlan`; `materializeSandboxCreatePlan` |
| **apply** | Effectful phase that binds credentials and live capabilities | `bindMessagingTokenDefs`; create, rebuild, and mutation executors |
| **checkpoint** | Durable, secret-minimized state from which a later process can continue | onboard session and machine snapshot; registry; backup/recovery manifests |
| **result** | Handler outcome: advance, retry, branch, complete, or fail | `OnboardStateResult`, applied by `OnboardRuntime` through `OnboardRuntimeBoundary` |
| **compensation** | Effect that undoes or limits a partial apply | failed-create deletion, `cancel-rollback.ts`, `rollbackChannelAdd`, recovery-registry restore |
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
each nonterminal state --failure--> failed
```

Every nonterminal state has one production owner or an explicit internal designation:

| State | Production owner |
|---|---|
| `init` | Internal entry state advanced by `onboard()` before the first flow slice |
| `preflight` | `machine/handlers/preflight.ts` |
| `gateway` | `machine/handlers/gateway.ts` |
| `provider_selection`, `inference` | `machine/handlers/provider-inference.ts` |
| `sandbox` | `machine/handlers/sandbox.ts`, with resume and messaging decisions delegated to `sandbox-resume.ts` and `sandbox-messaging.ts` |
| `openclaw`, `agent_setup` | `machine/handlers/agent-setup.ts` |
| `policies` | `machine/handlers/policies.ts` |
| `finalizing`, `post_verify` | `machine/handlers/finalization.ts` |
| `complete`, `failed` | Terminal; no handler |

The FSM checkpoint is step-granular. It cannot resume inside gateway startup, credential upserts, sandbox creation, policy application, or another handler-owned effect group.

## Effect-order flows

`*` marks a durable checkpoint and `!` marks the sandbox-delete boundary. In-place destructive effects that occur earlier are called out in the matrix.

```text
fresh onboard
  resolve entry options -> save session/machine* -> host preflight
  -> gateway/provider effects -> sandbox-create preflight
  -> materialize create plan -> create -> ready -> live validation -> register*
  -> finalize session*

--fresh entry reset
  clear prior session (local destructive reset) -> save new session*
  -> force base-image resolution -> follow new-onboard or live-recreate flow

ordinary live recreate
  resolve drift/conflicts -> conditional backup* -> provider cleanup -> ! delete
  -> remove registry -> materialize plan -> create -> ready -> restore/validate -> register*

resume drift
  load session* -> reject hint conflicts -> validate replacement credential
  -> optional early registry removal -> ordinary path conditional backup* -> ! delete
  -> remove registry -> materialize plan -> create -> ready -> restore/validate -> register*

not-ready repair
  load session* -> repair event -> ! delete -> remove registry
  -> materialize plan -> create -> ready -> validate -> register*

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
| **New interactive or non-interactive onboard** — `onboard()` and `resolveOnboardEntryOptions` | Current flags, environment, and prompts. `MessagingWorkflowPlanner.buildPlan`, `prepareSandboxMessagingPreflight`, resource-profile selection, `resolveSandboxCreateIntent`, and `materializeSandboxCreatePlan` assemble policy, provider, package, resource, host-forward, and runtime-setup contributions. Non-interactive mode replaces prompts with defaults or hard aborts. | Consent/session/lock setup and preflight can persist local state, install OpenShell, or clean stale gateway artifacts before the gateway handler. Gateway reuse/recovery/start is the first provider-routing effect; inference-provider upserts follow. A name with no live sandbox has no sandbox-destructive boundary; an existing target enters the recreate contract below. | Whole-step session plus machine snapshot; registry registration is deferred until readiness and live validation. The session stores credential environment names, redacted endpoint metadata, and legacy-value digests; real values are rebound from the process at apply time. | A non-Docker-GPU readiness failure attempts to delete the failed sandbox; the Docker-GPU patch path preserves it and emits patch-specific recovery diagnostics. Temp build-context cleanup is attempted inline with an exit-handler fallback; cancel rollback applies only to a brand-new sandbox. Coverage: `transition-traces.test.ts` and `sandbox-create-plan.test.ts`. Gap: gateway upserts can outlive a failed/interrupted create. |
| **`--fresh` onboard** — `resolveOnboardEntryOptions`, `prepareFreshSession`, `createBaseImageResolutionContext` | Current flags/environment/prompts replace resumable intent. `--fresh` disables auto-resume and forces base-image resolution; it does not prove that the selected sandbox name is unused. | The first destructive effect is local: the prior onboard session is cleared before a new session is saved. A matching live sandbox can later reuse or recreate through the normal sandbox decision; `--fresh` does not itself delete it. | The new session and machine snapshot replace the old resume checkpoint. Credential and effect boundaries then match new onboard or live recreate. | The discarded resume checkpoint is not restored on later failure. Covered by `entry-options.test.ts`, `session-bootstrap.test.ts`, and base-image resolution tests. |
| **Resume, re-onboard, or recreate** — `onboard()`, `prepareOnboardSession`, `decideSandboxResume`, live-sandbox handling in `createSandbox` | For `--resume`, the recorded session is authoritative and conflicting current name/provider/model/image/tool-disclosure hints are rejected. A new re-onboard run takes current flags, environment, and prompts as intent while registry/gateway state provides drift evidence. Recorded `sandboxName` is trusted only after the sandbox step completed. Replacement web-search credentials are checked before `applySandboxResumeDecision`; other create-plan validation can still occur later. | Ordinary live recreation conditionally backs up before provider cleanup, **delete**, image removal, and registry removal. A selected pre-upgrade backup suppresses a new one; an explicit override permits recreation without backup. Some resume-drift decisions remove the registry row earlier. `repair-and-recreate` deletes the not-ready sandbox and row before the normal create path, without the generic backup. Create-plan materialization follows deletion (#6226 gap). | Resume continues the recorded session/machine snapshot; non-resume re-onboard writes a new session first. Backup is fail-closed only when the ordinary path requires a new backup and no bypass is set; it does not protect early repair cleanup. Registration follows readiness, restore, and live validation. Raw credentials remain process/gateway inputs. | Restore failures warn and can still publish the replacement; managed-DCode live-selection failure leaves a running, unregistered sandbox with manual-delete guidance. Cancel rollback is not armed and there is no rebuild-style receipt rollback. Coverage: transition traces and sandbox handler tests. Gaps: #5961/#5783, #6040, early removal/backup asymmetry, and delete-to-register window (#6228). |
| **Rebuild or installer-driven upgrade** — `rebuildSandbox` in `rebuild-pipeline.ts`; `upgradeSandboxes` | Registry state is authoritative. A matching session may fill guarded legacy gaps only when its selection agrees; an unrelated/global session is never used. Ambient provider/model selection is quarantined by `isolateAmbientRecreateEnv`, apart from narrowly scoped legacy recovery. Preflight assembles target config, messaging/policy/runtime inputs, recovery inputs, and a retained replacement context. Generic agents use `preflightRebuildImage`; DCode uses its specialized managed-context preflight instead and proves the live route only for normal live rebuild. Resource profile is not part of preflight. | Consent persistence, target-gateway selection/recovery, and target-preflight registry updates can precede disposable image build/probes. Backup is the first durable recovery checkpoint when available. Shields unlock, MCP detach/scrub, and NIM stop are destructive in-place effects before the **sandbox delete** boundary. Prepared context and mutation-edge conditions are rechecked before delete, proving buildability/input identity but not replacement health or atomic swap. | Durable checkpoints are the backup/recovery manifest when one exists and the rewritten recreate session; stale recovery can reach deletion without a manifest, making that session its first new durable checkpoint. Rollback receipts/snapshots are process-local. Credential metadata comes from the target or guarded fallback; raw credentials/providers are checked against current process/gateway state, while prepared installer recovery may reconstruct a missing gateway provider from a validated host credential. | In-process rollback best-effort restores registry/MCP retry metadata, but process death after non-MCP delete can still lose it. The inner onboard selects resource profile after deletion from non-quarantined ambient input. Covered by rebuild, image-preflight, DCode, and messaging tests. Gaps: post-delete resource intent plus health-before-delete/atomic swap (#5801). |
| **Channel add/remove/start/stop** — `addSandboxChannel`, `removeSandboxChannel`, `sandboxChannelsSetEnabled` in `policy-channel.ts` | Add compiles and merges a manifest-derived channel delta with `MessagingWorkflowPlanner`. Start, stop, and remove transform the registry plan and rehydrate executable render/build/runtime/forward details from current manifests. | Token-backed add can mutate gateway credentials before policy and plan persistence; QR/in-sandbox-auth add skips that credential upsert. Start persists the enabled plan before policy; stop persists the disabled plan before the rebuild prompt. Remove clears QR-backed durable state when applicable, detaches gateway/bridge state, removes policy, then persists the plan. A queued rebuild has a separate delete boundary. | The compact registry messaging plan is authoritative; render/build/runtime/state/health entries and nested host-forward details are rehydrated rather than persisted. Session policy-preset sync is best-effort, and channel mutations do not rewrite `Session.messagingPlan`. Raw tokens stay in process/gateway bindings. | `rollbackChannelAdd`, re-disable after failed start, and fail-closed QR-state cleanup provide partial compensation. Covered by `policy-channel*.test.ts`, `workflow-planner.test.ts`, and channel integration tests. Gaps: channel add has a separate `--force` conflict policy; add/remove effects can precede plan persistence, and persistence failures are not fully rolled back. |
| **Provider, model, or credential-binding change** — `runInferenceSet` | CLI intent plus registry/session metadata. Target resolution and OpenShell preparation occur before locking. The target is re-resolved in the mutating phase under the sandbox lifecycle and timer-bound shields locks; that phase validates provider/model syntax, selected agent, shields state, and local reachability before the first write. | First mutation is the gateway route, then a minimal registry write, API-family/config resolution, registry refresh, best-effort config/hash sync, matching-session update, and audit. An OpenClaw API-family change can then restart the managed gateway after the shields lock is released but while the outer sandbox lock remains held. No sandbox deletion. | Registry and matching session store logical provider/model/credential-environment metadata. Audit records the action, sandbox, and reason rather than credentials; raw values remain gateway-bound. | Forward-only; no rollback. `rebuild` is the repair path for degraded state. Covered by `inference-set*.test.ts`. Gap: several stores can diverge after a mid-sequence failure. |
| **Credential rotation** — `configRotateToken` in `src/lib/sandbox/config.ts` | A session with `credentialEnv` selects the provider and binding. A non-null different `sandboxName` is rejected, but a legacy/null session name is accepted for the requested sandbox. The new value comes from a named environment variable, stdin, or a secret prompt; it is trimmed, then rejected when empty or still containing internal whitespace. | `saveCredential` first stages the value in the current process. OpenShell provider update is the first external mutation, with provider create as a fallback; audit follows. No sandbox deletion. | The logical binding is unchanged, so session and registry are not rewritten. The raw value exists only in process memory/environment and the gateway provider; audit records action/sandbox/reason without the value. | No rollback after a successful provider update; an audit failure can report failure after the credential is already active. Covered by the rotate-token cases in `test/config-set-nested-ssrf.test.ts`. Gap: a null-name legacy session is not strongly bound to the requested sandbox. |
| **Config, policy, resource, port-forward, and runtime setup contributions** — `configSet`; `prepareInitialSandboxCreatePolicy`; `selectResourceProfileForSandbox`; manifest compiler/runtime appliers; dashboard and channel forward helpers | Config uses validated dotpaths and SSRF-safe URL rewriting. Create/rebuild contributions are assembled by `sandbox-create-plan.ts` and `MessagingWorkflowPlanner`: policy presets/keys, resource flags, package/build steps, `hostForward`, runtime node preloads, env aliases, and secret scans. | Config’s first effect is a compare-and-swap sandbox write. Build-time contributions inherit the enclosing create/recreate boundary. Forward helpers can stop an existing forward and start its replacement in place after readiness, without recreating the sandbox. | Durable owners are compact registry messaging/policy/inference metadata, current manifests used for plan rehydration, onboard session, sandbox config/hash, gateway provider state, and shields audit. Resource-profile selection is only a create-time argument, not durable state. Logical bindings are serializable; raw provider values are not. | CAS rejects stale config writes; OpenClaw/Hermes commit config and integrity hashes together, while other agents may refresh a path hash afterward. Audit and optional restart are post-commit and forward-only. Forward recovery can re-establish declared forwards. Gaps: no cross-contribution transaction/checkpoint, and resource choice is not persisted. |

## Agent-specific differences

| Agent | Lifecycle difference |
|---|---|
| OpenClaw | `sandbox -> openclaw`; supports messaging render targets and OpenClaw config/plugin reconciliation. |
| Hermes | `sandbox -> agent_setup`; adds auth method, tool-gateway, dashboard, and credential-preflight drift axes. |
| Deep Agents Code (DCode) | `sandbox -> agent_setup`. Onboard filters unsupported channel selections, rebuild clears/skips messaging state, and `channels add` rejects DCode. Its specialized preflight replaces the generic image preflight; a normal live rebuild proves managed context and selected route at the delete edge, while recovery skips the live-route proof (`rebuild-dcode-preflight.ts`, #6214). |

## Persisted field ownership

The schema and sanitation authority is `Session` plus `normalizeSession`/`filterSafeUpdates` in `src/lib/state/onboard-session.ts`. `undefined` in an update means “leave unchanged”; accepted `null` means “clear.” On disk, many nullable fields still collapse never selected, explicitly declined, and explicitly cleared into the same `null` representation. That ambiguity is a #6228 contract gap, not an endorsed target.

| Field group | Fields | Writer/owner and state meaning |
|---|---|---|
| Session envelope | `version`, `sessionId`, `mode`, `startedAt`, `updatedAt`, `status`, `resumable` | `createSession`, save/update helpers, and completion/failure paths. Values are always known after creation. |
| Progress and recovery | `lastStepStarted`, `lastCompletedStep`, `failure`, `steps`, `machine` | Step-mutation helpers and `OnboardRuntime`; nullable progress fields mean no recorded value, not a separately modeled decline. |
| Target identity | `agent`, `sandboxName`, `metadata.gatewayName`, `metadata.fromDockerfile` | Onboard selection, sandbox handler/registration, and rebuild session preparation. Nullable identity currently conflates unset/cleared; a completed sandbox step is the trust gate for recorded name. |
| Inference intent | `provider`, `model`, `endpointUrl`, `credentialEnv`, `preferredInferenceApi`, `compatibleEndpointReasoning`, `nimContainer`, `webSearchConfig` | Provider/inference handlers and `runInferenceSet`. Known credential state is an environment-variable name or presence metadata, never the value. `redactUrl` masks userinfo, fragments, and sensitive-named parameters, but token-shaped values under benign parameter names remain a pending #6224 gap. |
| Agent and policy intent | `hermesAuthMethod`, `toolDisclosure`, `hermesToolGateways`, `policyPresets` | Agent setup and policy handling. Channel commands update matching-session `policyPresets` only best-effort. Nullable fields conflate unset, declined, and cleared where the CLI makes those distinctions. |
| Messaging intent | `messagingPlan`, `telegramConfig`, `wechatConfig` | Onboard/rebuild write the session plan; channel commands instead own the compact registry plan. `telegramConfig` and `wechatConfig` are legacy fallback/preserved fields, while current channel input comes from the plan/manifests. Tokens stay outside the session. |
| Runtime metadata | `routerPid`, `routerCredentialHash`, `gpuPassthrough` | Router and sandbox setup/recovery. PID is a live-process hint; credential hash is a digest; GPU is a concrete boolean. |
| Legacy migration proof | `migratedLegacyValueHashes` | Onboard legacy migration writes SHA-256 digests keyed by environment name; session filtering guarantees string records but does not independently validate digest shape. |

The registry is separately owned by `src/lib/state/registry.ts`; backup/recovery manifests are owned by their rebuild and recreate modules. Step helpers normally use `RECORD_ONLY_STEP_MUTATION_OPTIONS`; `LEGACY_MACHINE_STEP_MUTATION_OPTIONS` is the compatibility path that also moves the machine snapshot.

## Duplicated decision points

1. **Messaging intent source:** onboard environment plan, rebuild registry plan, resume fallback chain, and channel delta plans. Recommended owner: registry-persisted plan (#6226/#6228).
2. **Ambient environment policy:** onboard treats provider/model variables as intent; rebuild quarantines ambient selection except for narrowly target-scoped legacy recovery. Recommended owner: one target-resolution module (#6226).
3. **Conflict policy:** onboard and rebuild share `enforceMessagingChannelConflicts` with different prompt/abort policies; channel add uses the separate hand-built `checkChannelAddConflict` with `--force`. Recommended owner: one declarative conflict policy.
4. **Backup/restore policy:** rebuild and ordinary live recreate back up, while not-ready resume repair deletes before the generic backup; installer restore and channel mutation checkpoint different state again. Recommended owner: one backup/restore policy module (#6228).
5. **Registry lifecycle:** create registers post-ready; rebuild records removals and restores retry metadata through `rebuild-registry-rollback.ts`; some resume decisions remove the row before backup/create preparation and have no receipt-based compensation. Recommended owner: `sandbox-registration.ts` plus durable pre-create identity (#6228).
6. **Replacement validation:** generic rebuild retains and fingerprints a successfully built context; normal live DCode rebuild adds route and managed-context proofs; re-onboard still stages the replacement after delete. Health-before-delete and atomic swap remain #5801.
7. **Policy reconciliation:** registration records create-time presets, `handlePoliciesState` later persists the reconciled live set, and channel mutations synchronize their own plan/session preset state. Recommended owner: policy preset persistence/sync modules.

## Bug-to-contract-gap map

| Issue | Gap | Current status |
|---|---|---|
| #5961 | Interrupted onboard lacks durable sandbox identity/effect-group metadata | Open; #6227/#6228 |
| #6040 | Only selected malformed terminal snapshots are repaired | Open; #6227 |
| #6179 | Stale handler results can reach an invalid transition | Open; #6227 |
| #5954 | Rebuild conflict was discovered after delete | Fixed by #5955 |
| #6099 | Late dashboard-forward failure could roll back a healthy sandbox | Open; #6116 |
| #6195 | DCode rebuild deleted before replacement validation | Fixed by #6214 |

PR #6218 separated secret-free create intent from effectful materialization. PR #6214 added DCode-specific pre-delete replacement validation; generic rebuild now also retains and revalidates a prebuilt context. PR #5955 moved the rebuild messaging conflict check before destruction. The remaining ownership and recovery changes belong to the open child issues and should update this map and its focused traces when behavior intentionally changes.

## Characterization coverage

| Contract | Executable evidence | Uncovered boundary |
|---|---|---|
| Fresh, resumed, recreate, successful, and failed machine event order | `machine/transition-traces.test.ts` | Sub-step crash recovery and end-to-end delete-to-register effects |
| Detailed recreate decisions and repair branches | `machine/handlers/sandbox-resume.test.ts`, `machine/handlers/sandbox.test.ts` | Cross-handler effect transaction |
| Legal edges, result kinds, runtime event shapes, runner sequencing | `machine/transitions.test.ts`, `machine/runtime.test.ts`, `machine/runner*.test.ts` | None at the unit boundary |
| Create intent/provider ordering and fail-closed credential drift | `sandbox-create-plan.test.ts` | Cross-module pre-delete ordering has no behavioral seam |
| Messaging conflict validation before recreate | `sandbox-messaging-preflight.test.ts`, rebuild preflight tests | One shared declarative policy across all callers |
| Resume identity | `test/onboard.test.ts`, `handlers/sandbox-resume.test.ts` | Interrupted live-flow identity (#5961) |
| Session sanitation and no-secret persistence | `src/lib/state/onboard-session.test.ts` | Benign-name token-shaped URL values (#6224); unset/declined/cleared modeling (#6228) |

When a child issue changes one of these contracts, update the map and the narrow owning test in that same PR. Do not add source-text scans or production scaffolding solely to preserve current orchestration order.

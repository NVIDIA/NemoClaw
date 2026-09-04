// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";

import { isDecisionSelected } from "../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../state/onboard-checkpoint-migrate";
import type {
  CheckpointSandboxRecreatePhase,
  CheckpointSandboxRecreateTransaction,
  OnboardCheckpoint,
} from "../state/onboard-checkpoint-types";
import type { CompareAndSwapSessionResult, Session } from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
  RuntimeProviderSelectionError,
  type RuntimeProviderWorkloadCleanupResult,
  requireRuntimeProviderDestructiveCleanupAuthority,
} from "./runtime-provider/access";
import type { SandboxCreateIntent } from "./types";

const ORDERED_PHASES: readonly CheckpointSandboxRecreatePhase[] = [
  "planned",
  "deleting",
  "deleted",
  "creating",
  "created",
  "registry_committing",
  "completed",
];

export type ReplacedSandboxWorkloadCleanupResult =
  | RuntimeProviderWorkloadCleanupResult
  | { readonly status: "skipped"; readonly reason: "replacement-unproven" | "image-reused" };

export type ReplacedSandboxSourceEntry = Omit<SandboxEntry, "workload"> & {
  readonly workload?:
    | Exclude<NonNullable<SandboxEntry["workload"]>, { readonly kind: "legacy-dockerfile" }>
    | {
        readonly schemaVersion: 1;
        readonly kind: "legacy-dockerfile";
        readonly reference: string | null;
        readonly shared: boolean;
      };
};

interface ReplacedSandboxWorkloadCleanupDeps {
  readonly runtimeProviders?: RuntimeProviderBundleRegistry;
}

function providerCleanupSource(source: ReplacedSandboxSourceEntry): SandboxEntry {
  const { workload, ...entry } = source;
  if (!workload) return entry;
  if (workload.kind !== "legacy-dockerfile") return { ...entry, workload };
  return { ...entry, workload: { ...workload, shared: false } };
}

function workloadReference(workload: SandboxEntry["workload"]): string | null {
  return !workload || workload.kind === "native-artifact" ? null : workload.reference;
}

/** Remove an owned source image only after the journaled replacement is registered. */
export function retireReplacedSandboxWorkload(
  sandboxName: string,
  targetGeneration: string,
  targetLiveIdentityFingerprint: string | null,
  source: ReplacedSandboxSourceEntry,
  replacement: SandboxEntry | null,
  deps: ReplacedSandboxWorkloadCleanupDeps = {},
): ReplacedSandboxWorkloadCleanupResult {
  if (
    source.name !== sandboxName ||
    replacement?.name !== sandboxName ||
    replacement.lifecycleGeneration !== targetGeneration ||
    !targetLiveIdentityFingerprint ||
    replacement.lifecycleLiveIdentityFingerprint !== targetLiveIdentityFingerprint
  ) {
    return { status: "skipped", reason: "replacement-unproven" };
  }
  if (source.workload?.shared === true) {
    return { status: "skipped", reason: "shared-image" };
  }
  if (!source.imageTag) {
    return { status: "skipped", reason: "no-owned-image" };
  }
  if (
    typeof source.openshellDriver !== "string" ||
    source.openshellDriver.trim().length === 0 ||
    source.workload?.schemaVersion !== 1 ||
    source.workload.kind !== "legacy-dockerfile" ||
    source.workload.shared !== false ||
    source.workload.reference !== source.imageTag
  ) {
    return { status: "skipped", reason: "authority-unproven" };
  }

  const cleanupSource = providerCleanupSource(source);
  const providers = deps.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES;
  let authority;
  try {
    authority = requireRuntimeProviderDestructiveCleanupAuthority(
      sandboxName,
      cleanupSource,
      providers,
    );
  } catch (error) {
    if (!(error instanceof RuntimeProviderSelectionError)) throw error;
    return { status: "skipped", reason: "authority-unproven" };
  }
  const plan = authority.provider.cleanup.planOwnedWorkloadCleanup({
    sandbox: cleanupSource,
    sandboxName,
  });
  if (plan.action === "retain") {
    return { status: "skipped", reason: plan.reason };
  }
  if (plan.action !== "remove") {
    return { status: "skipped", reason: "authority-unproven" };
  }
  if (
    (replacement.workload?.kind !== "native-artifact" && replacement.imageTag === plan.reference) ||
    workloadReference(replacement.workload) === plan.reference
  ) {
    return { status: "skipped", reason: "image-reused" };
  }
  return authority.provider.cleanup.removeOwnedWorkload({ sandbox: cleanupSource, sandboxName });
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

function checkpointSourceWorkload(
  source: SandboxEntry,
): CheckpointSandboxRecreateTransaction["sourceWorkload"] {
  if (!source.imageTag) return null;
  return {
    openshellDriver: source.openshellDriver ?? null,
    imageTag: source.imageTag,
    workload:
      source.workload?.kind === "legacy-dockerfile"
        ? {
            kind: "legacy-dockerfile",
            reference: source.workload.reference,
            shared: source.workload.shared,
          }
        : null,
  };
}

export function sandboxRecreateSourceWorkloadEntry(
  transaction: CheckpointSandboxRecreateTransaction,
): ReplacedSandboxSourceEntry | null {
  const source = transaction.sourceWorkload;
  if (!source) return null;
  return {
    name: transaction.sandboxName,
    openshellDriver: source.openshellDriver,
    imageTag: source.imageTag,
    ...(source.workload
      ? {
          workload: {
            schemaVersion: 1,
            kind: "legacy-dockerfile" as const,
            reference: source.workload.reference,
            shared: source.workload.shared,
          },
        }
      : {}),
  };
}

export function fingerprintSandboxRecreateValue(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(canonicalJsonValue(value));
  return createHash("sha256").update(serialized).digest("hex");
}

const ROUTE_RESERVATION_FIELDS: readonly (keyof SandboxEntry)[] = [
  "pendingRouteReservation",
  "reservationSessionId",
  "provider",
  "model",
  "endpointUrl",
  "endpointSource",
  "credentialEnv",
  "preferredInferenceApi",
  "hostLocalInferenceReceipt",
  "hostLocalInferenceProvenance",
  "gatewayName",
  "gatewayPort",
];
// Rebuild may update these independently projected fields before delete.
// The source fingerprint still binds every sandbox, gateway, lifecycle, agent,
// and workload ownership field.
const RECEIPT_BOUND_PROJECTION_FIELDS: readonly (keyof SandboxEntry)[] = [
  "mcp",
  // `messaging` is a rehydrated projection, not durable sandbox identity: the
  // channel commands own it (`channels add|stop|start|remove` rewrite the plan
  // workflow label, disabledChannels, and the derived per-channel active,
  // disabled, and hostForward fields), and loading the registry re-derives the
  // rest of it from the built-in channel manifests and the ambient environment.
  // Binding it made a `channels stop` plus `channels start` between two rebuilds
  // change the fingerprint of an untouched sandbox, which left every later
  // rebuild rejecting its own journal (#10473).
  "messaging",
];

function fingerprintDurableSandboxEntry(
  entry: SandboxEntry,
  excluded: readonly (keyof SandboxEntry)[],
): string {
  const durable: Record<string, unknown> = { ...entry };
  for (const field of excluded) delete durable[field];
  return fingerprintSandboxRecreateValue(durable);
}

export function fingerprintSandboxRegistryEntry(entry: SandboxEntry): string {
  return fingerprintDurableSandboxEntry(entry, [
    ...ROUTE_RESERVATION_FIELDS,
    ...RECEIPT_BOUND_PROJECTION_FIELDS,
  ]);
}

/**
 * Accept a source row against a journal written before `messaging` left the
 * durable fingerprint.
 *
 * Such a journal recorded a digest that still covered the messaging projection,
 * so recomputing it the new way never matches. Because a journal parked past the
 * delete boundary outlives an upgrade, refusing it would strand a rebuild whose
 * source sandbox is already deleted. The compatibility digest reproduces the
 * exact pre-#10473 field set, so it accepts only what the previous release
 * already accepted.
 */
function sandboxRecreateSourceRowMatches(
  entry: SandboxEntry | null,
  recordedFingerprint: string,
): boolean {
  if (!entry) return recordedFingerprint === fingerprintSandboxRecreateValue(null);
  if (fingerprintSandboxRegistryEntry(entry) === recordedFingerprint) return true;
  return (
    fingerprintDurableSandboxEntry(entry, [
      ...ROUTE_RESERVATION_FIELDS,
      ...RECEIPT_BOUND_PROJECTION_FIELDS.filter((field) => field !== "messaging"),
    ]) === recordedFingerprint
  );
}

export function fingerprintSandboxLiveIdentity(getOutput: string): string | null {
  const clean = String(getOutput).replace(/\x1b\[[0-9;]*m/g, "");
  const match = clean.match(/^\s*Id:\s+(\S+)\s*$/im);
  if (!match?.[1] || match[1].length > 512) return null;
  return fingerprintSandboxRecreateValue(match[1]);
}

export interface SandboxRecreateObservation {
  readonly state: "missing" | "not_ready" | "ready";
  readonly liveIdentityFingerprint: string | null;
}

export type CreatedSandboxLifecycleRegistration = Required<
  Pick<SandboxEntry, "lifecycleGeneration" | "lifecycleLiveIdentityFingerprint">
>;

export interface CreatedSandboxLifecycleTarget {
  readonly sandboxName: string;
  readonly gatewayName: string;
}

export interface CreatedSandboxLifecycleRevalidationOptions {
  readonly allowNotReadyWithMatchingIdentity?: boolean;
}

type ObserveCreatedSandbox = (
  sandboxName: string,
  gatewayName: string,
) => SandboxRecreateObservation;

function requireLifecycleGeneration(sandboxName: string, lifecycleGeneration: string): void {
  if (
    lifecycleGeneration.length === 0 ||
    lifecycleGeneration.length > 512 ||
    lifecycleGeneration.trim() !== lifecycleGeneration
  ) {
    throw new Error(
      `Cannot register sandbox '${sandboxName}': its lifecycle generation is invalid.`,
    );
  }
}

function requireValidLiveIdentity(
  target: CreatedSandboxLifecycleTarget,
  observation: SandboxRecreateObservation,
): string {
  const fingerprint = observation.liveIdentityFingerprint;
  if (!fingerprint || !/^[0-9a-f]{64}$/u.test(fingerprint)) {
    throw new Error(
      `Cannot register sandbox '${target.sandboxName}': its owning gateway did not report a valid live identity.`,
    );
  }
  return fingerprint;
}

function requireReadyIdentity(
  target: CreatedSandboxLifecycleTarget,
  observation: SandboxRecreateObservation,
): string {
  if (observation.state !== "ready") {
    // `missing` and `not_ready` need different answers: one says the gateway cannot see the
    // sandbox at all, the other says it sees it and withholds Ready. Name which one was observed.
    throw new Error(
      `Cannot register sandbox '${target.sandboxName}': its owning gateway did not report it Ready (observed ${observation.state}).`,
    );
  }
  return requireValidLiveIdentity(target, observation);
}

function requireObservedIdentity(
  target: CreatedSandboxLifecycleTarget,
  observation: SandboxRecreateObservation,
  allowNotReadyWithMatchingIdentity: boolean,
): string {
  if (
    observation.state !== "ready" &&
    !(allowNotReadyWithMatchingIdentity && observation.state === "not_ready")
  ) {
    throw new Error(
      `Cannot register sandbox '${target.sandboxName}': its owning gateway did not report it Ready (observed ${observation.state}).`,
    );
  }
  return requireValidLiveIdentity(target, observation);
}

/** Pin the Ready sandbox identity observed from its owning gateway after creation. */
export function captureCreatedSandboxLifecycleRegistration(
  target: CreatedSandboxLifecycleTarget,
  lifecycleGeneration: string,
  lifecycleRegistrationFields: Pick<SandboxEntry, "lifecycleGeneration">,
  observe: ObserveCreatedSandbox,
): CreatedSandboxLifecycleRegistration {
  requireLifecycleGeneration(target.sandboxName, lifecycleGeneration);
  if (lifecycleRegistrationFields.lifecycleGeneration !== lifecycleGeneration) {
    throw new Error(
      `Cannot register sandbox '${target.sandboxName}': lifecycle setup did not preserve its generation.`,
    );
  }
  return {
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: requireReadyIdentity(
      target,
      observe(target.sandboxName, target.gatewayName),
    ),
  };
}

/** Preserve the recreate journal as the authority for replacement registration. */
export function selectCreatedSandboxLifecycleRegistration(
  sandboxName: string,
  observed: CreatedSandboxLifecycleRegistration,
  recreateTargetGeneration: string | undefined,
  recreateRegistration: Pick<
    SandboxEntry,
    "lifecycleGeneration" | "lifecycleLiveIdentityFingerprint"
  >,
): CreatedSandboxLifecycleRegistration {
  if (!recreateTargetGeneration) return observed;
  if (
    recreateTargetGeneration !== observed.lifecycleGeneration ||
    recreateRegistration.lifecycleGeneration !== observed.lifecycleGeneration ||
    recreateRegistration.lifecycleLiveIdentityFingerprint !==
      observed.lifecycleLiveIdentityFingerprint
  ) {
    throw new Error(
      `Cannot register sandbox '${sandboxName}': its recreate transaction no longer matches the created sandbox.`,
    );
  }
  return {
    lifecycleGeneration: recreateTargetGeneration,
    lifecycleLiveIdentityFingerprint: recreateRegistration.lifecycleLiveIdentityFingerprint,
  };
}

/** Re-observe the owner-scoped identity immediately before registry publication. */
export function revalidateCreatedSandboxLifecycleRegistration(
  target: CreatedSandboxLifecycleTarget,
  registration: CreatedSandboxLifecycleRegistration,
  observe: ObserveCreatedSandbox,
  options: CreatedSandboxLifecycleRevalidationOptions = {},
): CreatedSandboxLifecycleRegistration {
  requireLifecycleGeneration(target.sandboxName, registration.lifecycleGeneration);
  const liveIdentityFingerprint = requireObservedIdentity(
    target,
    observe(target.sandboxName, target.gatewayName),
    options.allowNotReadyWithMatchingIdentity === true,
  );
  if (liveIdentityFingerprint !== registration.lifecycleLiveIdentityFingerprint) {
    throw new Error(
      `Cannot register sandbox '${target.sandboxName}': its live identity changed before registry publication.`,
    );
  }
  return registration;
}

export interface CreatedSandboxLifecycle {
  readonly generation: string;
  recordExactIdentity(liveIdentityFingerprint: string): CreatedSandboxLifecycleRegistration;
  capture(
    lifecycleRegistrationFields: Pick<SandboxEntry, "lifecycleGeneration">,
  ): CreatedSandboxLifecycleRegistration;
  revalidate(
    registration: CreatedSandboxLifecycleRegistration,
    options?: CreatedSandboxLifecycleRevalidationOptions,
  ): CreatedSandboxLifecycleRegistration;
}

/** Coordinate sandbox setup and registry publication on one lifecycle generation. */
export function createCreatedSandboxLifecycle(
  runtime: SandboxRecreateRuntime,
  target: CreatedSandboxLifecycleTarget,
  observe: ObserveCreatedSandbox,
  generationOverride?: string,
): CreatedSandboxLifecycle {
  const generation = runtime.targetGeneration ?? generationOverride ?? randomUUID();
  requireLifecycleGeneration(target.sandboxName, generation);
  return {
    generation,
    recordExactIdentity: (liveIdentityFingerprint) =>
      runtime.recordExactIdentity(liveIdentityFingerprint),
    capture: (lifecycleRegistrationFields) => {
      const captured = captureCreatedSandboxLifecycleRegistration(
        target,
        generation,
        lifecycleRegistrationFields,
        observe,
      );
      runtime.recordCreated({
        state: "ready",
        liveIdentityFingerprint: captured.lifecycleLiveIdentityFingerprint,
      });
      return captured;
    },
    revalidate: (registration, options) => {
      const verified = revalidateCreatedSandboxLifecycleRegistration(
        target,
        registration,
        observe,
        options,
      );
      runtime.recordCreated({
        state: "ready",
        liveIdentityFingerprint: verified.lifecycleLiveIdentityFingerprint,
      });
      return selectCreatedSandboxLifecycleRegistration(
        target.sandboxName,
        verified,
        runtime.targetGeneration,
        runtime.registrationFields,
      );
    },
  };
}

export interface SandboxRecreateSourceProof {
  readonly transactionId: string;
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly sourceRegistryFingerprint: string;
  readonly sourceLiveIdentityFingerprint: string | null;
  readonly sourceConfirmedAbsent: boolean;
  readonly targetGeneration: string;
}

export class SandboxRecreateSourceMismatchError extends Error {
  readonly sandboxName: string;
  readonly reason: string;

  constructor(sandboxName: string, reason: string) {
    super(`Cannot prove the source of sandbox '${sandboxName}' before recreation: ${reason}.`);
    this.name = "SandboxRecreateSourceMismatchError";
    this.sandboxName = sandboxName;
    this.reason = reason;
  }
}

export function sandboxRecreateSourceProof(
  transaction: CheckpointSandboxRecreateTransaction,
): SandboxRecreateSourceProof {
  return {
    transactionId: transaction.id,
    sandboxName: transaction.sandboxName,
    gatewayName: transaction.gatewayName,
    gatewayPort: transaction.gatewayPort,
    sourceRegistryFingerprint: transaction.sourceRegistryFingerprint,
    sourceLiveIdentityFingerprint: transaction.sourceLiveIdentityFingerprint,
    sourceConfirmedAbsent: sandboxRecreatePhaseReached(transaction.phase, "deleted"),
    targetGeneration: transaction.targetGeneration,
  };
}

export interface SandboxRecreateSourceCheck {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly registryEntry: SandboxEntry | null;
  readonly observation: SandboxRecreateObservation;
}

export function assertSandboxRecreateSourceProof(
  proof: SandboxRecreateSourceProof | null,
  check: SandboxRecreateSourceCheck,
): SandboxRecreateSourceProof {
  const fail = (reason: string): never => {
    throw new SandboxRecreateSourceMismatchError(check.sandboxName, reason);
  };
  if (!proof) return fail("no active recreate transaction records the source sandbox");
  if (proof.sandboxName !== check.sandboxName) {
    return fail(`the active transaction records sandbox '${proof.sandboxName}'`);
  }
  if (proof.gatewayName !== check.gatewayName || proof.gatewayPort !== check.gatewayPort) {
    return fail(
      `the active transaction records gateway '${proof.gatewayName}:${String(proof.gatewayPort)}'`,
    );
  }
  if (!check.registryEntry) return fail("the source registry row is absent");
  if (!sandboxRecreateSourceRowMatches(check.registryEntry, proof.sourceRegistryFingerprint)) {
    return fail("the source registry row changed after the transaction recorded it");
  }
  if (check.observation.state === "missing") {
    if (!proof.sourceConfirmedAbsent) {
      return fail("the recreate journal has not confirmed source deletion");
    }
    return proof;
  }
  if (!check.observation.liveIdentityFingerprint) {
    return fail("the live same-name sandbox reports no OpenShell Id");
  }
  if (check.observation.liveIdentityFingerprint !== proof.sourceLiveIdentityFingerprint) {
    return fail("the live same-name sandbox is not the recorded source");
  }
  return proof;
}

function baseCheckpoint(session: Session): OnboardCheckpoint {
  return session.checkpoint ?? deriveCheckpointFromSession(session);
}

function activeTransaction(session: Session): CheckpointSandboxRecreateTransaction | null {
  return baseCheckpoint(session).sandboxRecreate;
}

export function selectSandboxRecreateTargetIntentFingerprint(
  transaction: CheckpointSandboxRecreateTransaction | null,
  requestedTargetIntentFingerprint: string,
  handedOffTargetIntentFingerprint: string | null | undefined,
): string {
  return transaction && transaction.targetIntentFingerprint === handedOffTargetIntentFingerprint
    ? transaction.targetIntentFingerprint
    : requestedTargetIntentFingerprint;
}

function assertSameTransaction(
  transaction: CheckpointSandboxRecreateTransaction,
  input: BeginSandboxRecreateTransactionInput,
): void {
  if (
    transaction.sandboxName !== input.sandboxName ||
    transaction.gatewayName !== input.gatewayName ||
    transaction.gatewayPort !== input.gatewayPort ||
    transaction.targetIntentFingerprint !== input.targetIntentFingerprint
  ) {
    throw new Error(
      `Sandbox '${input.sandboxName}' has a different recreate transaction in progress; resume or repair that transaction before changing its target.`,
    );
  }
}

export interface BeginSandboxRecreateTransactionInput {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly sourceEntry: SandboxEntry | null;
  readonly observation: SandboxRecreateObservation;
  readonly targetIntentFingerprint: string;
  readonly now?: string;
  readonly id?: string;
  readonly targetGeneration?: string;
}

function newSandboxRecreateTransaction(
  checkpoint: OnboardCheckpoint,
  input: BeginSandboxRecreateTransactionInput,
): CheckpointSandboxRecreateTransaction {
  if (input.observation.state !== "missing" && !input.observation.liveIdentityFingerprint) {
    throw new Error(
      `Cannot recreate sandbox '${input.sandboxName}': OpenShell did not report a stable sandbox Id.`,
    );
  }
  if (!input.sourceEntry && input.observation.state !== "missing") {
    throw new Error(
      `Cannot start sandbox '${input.sandboxName}' lifecycle journal without its source registry row while OpenShell reports a same-name sandbox.`,
    );
  }
  const now = input.now ?? new Date().toISOString();
  return {
    version: 1,
    id: input.id ?? randomUUID(),
    revision: 0,
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
    sourceRegistryFingerprint: input.sourceEntry
      ? fingerprintSandboxRegistryEntry(input.sourceEntry)
      : fingerprintSandboxRecreateValue(null),
    sourceLiveIdentityFingerprint: input.observation.liveIdentityFingerprint,
    sourceWorkload: input.sourceEntry ? checkpointSourceWorkload(input.sourceEntry) : null,
    targetIntentFingerprint: input.targetIntentFingerprint,
    targetGeneration: input.targetGeneration ?? randomUUID(),
    targetLiveIdentityFingerprint: null,
    phase: input.observation.state === "missing" ? "deleted" : "planned",
    startedAt: now,
    updatedAt: now,
  };
}

function setSandboxRecreateTransaction(
  session: Session,
  checkpoint: OnboardCheckpoint,
  transaction: CheckpointSandboxRecreateTransaction,
): void {
  session.checkpoint = {
    ...checkpoint,
    machineState: session.machine.state,
    updatedAt: transaction.updatedAt,
    sandboxRecreate: transaction,
  };
}

export function beginSandboxRecreateTransaction(
  session: Session,
  input: BeginSandboxRecreateTransactionInput,
): CheckpointSandboxRecreateTransaction {
  const existing = activeTransaction(session);
  if (existing) {
    assertSameTransaction(existing, input);
    return existing;
  }
  const checkpoint = baseCheckpoint(session);
  const transaction = newSandboxRecreateTransaction(checkpoint, input);
  setSandboxRecreateTransaction(session, checkpoint, transaction);
  return transaction;
}

function phaseIndex(phase: CheckpointSandboxRecreatePhase): number {
  return ORDERED_PHASES.indexOf(phase);
}

export function sandboxRecreatePhaseReached(
  phase: CheckpointSandboxRecreatePhase,
  target: CheckpointSandboxRecreatePhase,
): boolean {
  return phaseIndex(phase) >= phaseIndex(target);
}

export function advanceSandboxRecreateTransaction(
  session: Session,
  id: string,
  phase: CheckpointSandboxRecreatePhase,
  now = new Date().toISOString(),
): CheckpointSandboxRecreateTransaction {
  const checkpoint = baseCheckpoint(session);
  const current = checkpoint.sandboxRecreate;
  if (!current || current.id !== id) {
    throw new Error(
      "Sandbox recreate transaction ownership changed while applying a lifecycle phase.",
    );
  }
  if (current.phase === phase) return current;
  if (phaseIndex(phase) < phaseIndex(current.phase)) {
    throw new Error(
      `Sandbox recreate transaction cannot move backward from '${current.phase}' to '${phase}'.`,
    );
  }
  const next: CheckpointSandboxRecreateTransaction = {
    ...current,
    revision: current.revision + 1,
    phase,
    updatedAt: now,
  };
  session.checkpoint = {
    ...checkpoint,
    machineState: session.machine.state,
    updatedAt: now,
    sandboxRecreate: next,
  };
  return next;
}

export function recordSandboxRecreateTargetCreated(
  session: Session,
  id: string,
  observation: SandboxRecreateObservation,
  now = new Date().toISOString(),
): CheckpointSandboxRecreateTransaction {
  if (
    observation.state !== "ready" ||
    !observation.liveIdentityFingerprint ||
    !/^[0-9a-f]{64}$/u.test(observation.liveIdentityFingerprint)
  ) {
    throw new Error(
      "The journaled replacement must be Ready with a valid live identity fingerprint.",
    );
  }
  const checkpoint = baseCheckpoint(session);
  const current = checkpoint.sandboxRecreate;
  if (!current || current.id !== id) {
    throw new Error(
      "Sandbox recreate transaction ownership changed while recording the replacement identity.",
    );
  }
  if (
    current.targetLiveIdentityFingerprint &&
    current.targetLiveIdentityFingerprint !== observation.liveIdentityFingerprint
  ) {
    throw new Error("Sandbox recreate transaction already identifies a different replacement.");
  }
  if (
    current.phase === "created" &&
    current.targetLiveIdentityFingerprint === observation.liveIdentityFingerprint
  ) {
    return current;
  }
  if (current.phase !== "creating") {
    throw new Error(
      `Sandbox recreate transaction cannot record its replacement from phase '${current.phase}'.`,
    );
  }
  const next: CheckpointSandboxRecreateTransaction = {
    ...current,
    revision: current.revision + 1,
    phase: "created",
    targetLiveIdentityFingerprint: observation.liveIdentityFingerprint,
    updatedAt: now,
  };
  session.checkpoint = {
    ...checkpoint,
    machineState: session.machine.state,
    updatedAt: now,
    sandboxRecreate: next,
  };
  return next;
}

export function abandonSandboxRecreateTransaction(session: Session, id: string): void {
  const checkpoint = baseCheckpoint(session);
  const current = checkpoint.sandboxRecreate;
  if (!current || current.id !== id) {
    throw new Error("Sandbox recreate transaction ownership changed and cannot be abandoned.");
  }
  if (current.revision !== 0 || current.targetLiveIdentityFingerprint) {
    throw new Error(
      `Sandbox '${current.sandboxName}' recreate transaction already recorded a lifecycle effect and cannot be abandoned.`,
    );
  }
  const now = new Date().toISOString();
  session.checkpoint = {
    ...checkpoint,
    machineState: session.machine.state,
    updatedAt: now,
    sandboxRecreate: null,
  };
}

export function clearCompletedSandboxRecreateTransaction(session: Session, id: string): void {
  const checkpoint = baseCheckpoint(session);
  const current = checkpoint.sandboxRecreate;
  if (!current || current.id !== id || current.phase !== "completed") {
    throw new Error("Sandbox recreate transaction is not complete and cannot be cleared.");
  }
  const now = new Date().toISOString();
  session.checkpoint = {
    ...checkpoint,
    machineState: session.machine.state,
    updatedAt: now,
    sandboxRecreate: null,
  };
}

export type SandboxRecreateRecoveryPlan =
  | { readonly action: "continue_delete" }
  | { readonly action: "continue_create" }
  | { readonly action: "accept_target" }
  | { readonly action: "restart_from_source" }
  | { readonly action: "reject"; readonly reason: string };

function reject(reason: string): SandboxRecreateRecoveryPlan {
  return { action: "reject", reason };
}

/**
 * The gateway a piece of recreate evidence was gathered on.
 *
 * Structural so both a `SandboxEntry` and a probe target satisfy it without the
 * transaction module importing the probe module it already feeds.
 */
export interface SandboxRecreateGateway {
  readonly gatewayName: string;
  readonly gatewayPort: number;
}

/**
 * The same pairing as recorded on a registry row, where a legacy row may carry
 * neither field. A journal always records both, so an unset row fails closed.
 */
interface SandboxRecreateGatewayEvidence {
  readonly gatewayName?: string | null;
  readonly gatewayPort?: number | null;
}

/** Whether evidence names the gateway the journal recorded. Absent evidence never matches. */
function onSandboxRecreateGateway(
  transaction: CheckpointSandboxRecreateTransaction,
  gateway: SandboxRecreateGatewayEvidence | null | undefined,
): boolean {
  return (
    gateway?.gatewayName === transaction.gatewayName &&
    gateway.gatewayPort === transaction.gatewayPort
  );
}

/**
 * A journal whose replacement provably never happened.
 *
 * The caller has already ruled out the registered replacement, so the journal
 * still claims a replacement is in flight. When the registry row and a live
 * same-name sandbox name the same OpenShell identity, that claim is false: the
 * sandbox this row describes is intact and there is no unregistered replacement
 * to converge on. The recorded replacement is void, and the owner may retire it
 * and open a fresh transaction against the live source instead of refusing every
 * later rebuild for the rest of the session (#10473).
 *
 * The identity equality is what makes this safe. A replacement that was created
 * but not yet registered carries a fresh OpenShell Id while the preserved row
 * still carries the source's, so it can never satisfy this and stays protected
 * by the fail-closed refusals in `planUnregisteredReplacementRecovery`.
 *
 * The name equality binds the evidence to the journal. `checkpoint.sandboxRecreate`
 * holds one journal for the whole session, so a caller can present the row and
 * observation of a different sandbox; that pairing must keep refusing rather than
 * retire a journal protecting another sandbox's replacement.
 *
 * The gateway equality binds that evidence to the journal's own gateway. A
 * sandbox name identifies one row per registry, not one sandbox per fleet, and
 * `gatewayName`/`gatewayPort` sit in `ROUTE_RESERVATION_FIELDS` so the source
 * fingerprint cannot notice a row that moved gateways under an open journal.
 * The transaction owner evaluates this while `compareAndSwapSession` owns the
 * session writer boundary. Without the checks below, evidence gathered on
 * gateway B could replace a journal that still owns an unregistered replacement
 * on gateway A and orphan it. Requiring the row and observation to name the
 * journaled gateway keeps that decision fail-closed.
 */
function replacementIsVoid(
  transaction: CheckpointSandboxRecreateTransaction,
  observation: SandboxRecreateObservation,
  registryEntry: SandboxEntry | null,
  observedGateway: SandboxRecreateGateway | null | undefined,
): boolean {
  return Boolean(
    onSandboxRecreateGateway(transaction, observedGateway) &&
    onSandboxRecreateGateway(transaction, registryEntry) &&
    registryEntry?.name === transaction.sandboxName &&
    sandboxRecreateSourceRowMatches(registryEntry, transaction.sourceRegistryFingerprint) &&
    registryEntry.lifecycleLiveIdentityFingerprint &&
    transaction.sourceLiveIdentityFingerprint &&
    observation.state !== "missing" &&
    observation.liveIdentityFingerprint === registryEntry.lifecycleLiveIdentityFingerprint &&
    observation.liveIdentityFingerprint === transaction.sourceLiveIdentityFingerprint &&
    observation.liveIdentityFingerprint !== transaction.targetLiveIdentityFingerprint,
  );
}

/**
 * @param observedGateway The gateway `observation` was probed on. Omitting it
 * withholds the `restart_from_source` downgrade entirely, so a caller that
 * cannot name its gateway keeps the pre-#10473 refusal instead of retiring a
 * journal it never proved is void.
 */
export function planSandboxRecreateRecovery(
  transaction: CheckpointSandboxRecreateTransaction,
  observation: SandboxRecreateObservation,
  registryEntry: SandboxEntry | null,
  observedGateway?: SandboxRecreateGateway | null,
): SandboxRecreateRecoveryPlan {
  if (registryEntry?.lifecycleGeneration === transaction.targetGeneration) {
    if (!transaction.targetLiveIdentityFingerprint) {
      return reject("the journal did not record the replacement live identity");
    }
    if (
      registryEntry.lifecycleLiveIdentityFingerprint !== transaction.targetLiveIdentityFingerprint
    ) {
      return reject("the replacement registry row does not match the journaled live identity");
    }
    if (observation.state !== "ready") {
      return reject("the journaled replacement is registered but is not ready");
    }
    if (observation.liveIdentityFingerprint !== transaction.targetLiveIdentityFingerprint) {
      return reject("the ready same-name sandbox is not the journaled replacement");
    }
    return { action: "accept_target" };
  }

  const unregistered = planUnregisteredReplacementRecovery(transaction, observation, registryEntry);
  // Only deleted and creating can represent an interrupted replacement whose
  // source returned. The transaction owner can atomically replace that journal
  // when the live sandbox and registry row prove the source identity (#10473).
  if (
    (transaction.phase === "deleted" || transaction.phase === "creating") &&
    unregistered.action === "reject" &&
    replacementIsVoid(transaction, observation, registryEntry, observedGateway)
  ) {
    return { action: "restart_from_source" };
  }
  return unregistered;
}

/** The recovery decision for a journal whose replacement is not registered. */
function planUnregisteredReplacementRecovery(
  transaction: CheckpointSandboxRecreateTransaction,
  observation: SandboxRecreateObservation,
  registryEntry: SandboxEntry | null,
): SandboxRecreateRecoveryPlan {
  const sourceStateUnchanged = sandboxRecreateSourceRowMatches(
    registryEntry,
    transaction.sourceRegistryFingerprint,
  );
  if (transaction.phase === "completed") {
    return reject("the completed transaction no longer matches its replacement registry row");
  }
  if (transaction.phase === "planned" || transaction.phase === "deleting") {
    if (!sourceStateUnchanged) return reject("the source registry row changed before deletion");
    if (observation.state === "missing") return { action: "continue_create" };
    if (
      !transaction.sourceLiveIdentityFingerprint ||
      observation.liveIdentityFingerprint !== transaction.sourceLiveIdentityFingerprint
    ) {
      return reject("the live same-name sandbox no longer has the journaled source identity");
    }
    return { action: "continue_delete" };
  }
  if (transaction.phase === "deleted" || transaction.phase === "creating") {
    if (!sourceStateUnchanged) return reject("the preserved source registry row changed");
    return observation.state === "missing"
      ? { action: "continue_create" }
      : reject("a live same-name sandbox appeared before replacement registration committed");
  }
  if (
    (transaction.phase === "created" || transaction.phase === "registry_committing") &&
    transaction.sourceRegistryFingerprint === fingerprintSandboxRecreateValue(null)
  ) {
    if (!transaction.targetLiveIdentityFingerprint) {
      return reject("the journal did not record the created sandbox live identity");
    }
    if (observation.state !== "ready") {
      return reject("the journaled created sandbox is not ready");
    }
    if (observation.liveIdentityFingerprint !== transaction.targetLiveIdentityFingerprint) {
      return reject("the ready same-name sandbox is not the journaled created sandbox");
    }
    return reject("the journaled created sandbox has no matching registry row");
  }
  return reject("the replacement registration did not commit the journaled generation");
}

export function selectedGatewayForSandboxRecreate(
  checkpoint: OnboardCheckpoint | null | undefined,
  gatewayName: string,
): { gatewayName: string; gatewayPort: number } | null {
  if (!checkpoint || !isDecisionSelected(checkpoint.gatewayAuthority)) return null;
  const authority = checkpoint.gatewayAuthority.value;
  return authority.gatewayName === gatewayName
    ? { gatewayName: authority.gatewayName, gatewayPort: authority.gatewayPort }
    : null;
}

export function matchingSandboxRecreateTransaction(
  session: Session | null,
  input: {
    sandboxName: string;
    gatewayName: string;
    targetIntentFingerprint: string;
    transactionId: string;
    targetGeneration: string;
  },
): CheckpointSandboxRecreateTransaction {
  const transaction = session?.checkpoint?.sandboxRecreate;
  if (
    !transaction ||
    transaction.id !== input.transactionId ||
    transaction.sandboxName !== input.sandboxName ||
    transaction.gatewayName !== input.gatewayName ||
    transaction.targetIntentFingerprint !== input.targetIntentFingerprint ||
    transaction.targetGeneration !== input.targetGeneration
  ) {
    throw new Error(
      `Sandbox '${input.sandboxName}' recreate journal does not match the requested replacement.`,
    );
  }
  return transaction;
}

interface SandboxRecreateSessionStore {
  loadSession(): Session | null;
  updateSession(mutator: (session: Session) => Session | void): Session;
  compareAndSwapSession?(
    matches: (session: Session) => boolean,
    mutator: (session: Session) => Session | void,
    command?: string,
  ): CompareAndSwapSessionResult;
}

interface SandboxRecreateTransactionOwnerStore extends SandboxRecreateSessionStore {
  compareAndSwapSession(
    matches: (session: Session) => boolean,
    mutator: (session: Session) => Session | void,
    command?: string,
  ): CompareAndSwapSessionResult;
}

export interface OwnSandboxRecreateTransactionInput {
  readonly sessionStore: SandboxRecreateTransactionOwnerStore;
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly targetIntentFingerprint: string;
  readonly requireSourceEntry?: boolean;
  readonly readRegistryEntry: () => SandboxEntry | null;
  readonly observe: () => SandboxRecreateObservation;
  readonly decorateCheckpoint: (
    session: Session,
    checkpoint: OnboardCheckpoint,
    now: string,
  ) => OnboardCheckpoint;
}

export interface OwnedSandboxRecreateTransaction {
  readonly session: Session;
  readonly transaction: CheckpointSandboxRecreateTransaction;
  readonly recovery: SandboxRecreateRecoveryPlan;
  readonly replacedTransactionId: string | null;
  readonly registryEntry: SandboxEntry | null;
}

/** Open or atomically replace the recreate transaction owned by one session. */
export function ownSandboxRecreateTransaction(
  input: OwnSandboxRecreateTransactionInput,
): OwnedSandboxRecreateTransaction {
  const openingSession = input.sessionStore.loadSession();
  if (!openingSession) {
    throw new Error(`Cannot journal sandbox '${input.sandboxName}': no onboarding session exists.`);
  }
  const openingSessionId = openingSession.sessionId;
  const expectedOld = activeTransaction(openingSession);
  const expectedOldFingerprint = fingerprintSandboxRecreateValue(expectedOld);
  let freshRegistryEntry: SandboxEntry | null | undefined;
  let freshObservation: SandboxRecreateObservation | undefined;
  let recovery: SandboxRecreateRecoveryPlan = { action: "continue_delete" };
  let replacedTransactionId: string | null = null;
  let writtenTransaction: CheckpointSandboxRecreateTransaction | null = null;

  const result = input.sessionStore.compareAndSwapSession(
    (current) => {
      if (
        current.sessionId !== openingSessionId ||
        fingerprintSandboxRecreateValue(activeTransaction(current)) !== expectedOldFingerprint
      ) {
        return false;
      }
      freshRegistryEntry = input.readRegistryEntry();
      freshObservation = input.observe();
      if (input.requireSourceEntry && !freshRegistryEntry) {
        throw new Error(
          `Cannot start sandbox '${input.sandboxName}' recreate transaction without its source registry row.`,
        );
      }
      if (expectedOld) {
        if (
          expectedOld.sandboxName !== input.sandboxName ||
          expectedOld.gatewayName !== input.gatewayName ||
          expectedOld.gatewayPort !== input.gatewayPort ||
          expectedOld.targetIntentFingerprint !== input.targetIntentFingerprint
        ) {
          throw new Error(
            `Sandbox '${input.sandboxName}' has a different recreate transaction in progress; resume or repair that transaction before changing its target.`,
          );
        }
        recovery = planSandboxRecreateRecovery(expectedOld, freshObservation, freshRegistryEntry, {
          gatewayName: input.gatewayName,
          gatewayPort: input.gatewayPort,
        });
        if (recovery.action === "reject") {
          throw new Error(
            `Cannot resume sandbox '${input.sandboxName}' replacement: ${recovery.reason}.`,
          );
        }
        if (recovery.action === "restart_from_source") {
          replacedTransactionId = expectedOld.id;
        }
      }
      return true;
    },
    (current) => {
      if (freshRegistryEntry === undefined || !freshObservation) {
        throw new Error(`Cannot journal sandbox '${input.sandboxName}': fresh evidence is absent.`);
      }
      const now = new Date().toISOString();
      const checkpoint = input.decorateCheckpoint(current, baseCheckpoint(current), now);
      if (recovery.action === "restart_from_source" || !expectedOld) {
        writtenTransaction = newSandboxRecreateTransaction(checkpoint, {
          sandboxName: input.sandboxName,
          gatewayName: input.gatewayName,
          gatewayPort: input.gatewayPort,
          sourceEntry: freshRegistryEntry,
          observation: freshObservation,
          targetIntentFingerprint: input.targetIntentFingerprint,
          now,
        });
        setSandboxRecreateTransaction(current, checkpoint, writtenTransaction);
      } else {
        writtenTransaction = expectedOld;
        setSandboxRecreateTransaction(current, checkpoint, expectedOld);
      }
      return current;
    },
    `nemoclaw own sandbox '${input.sandboxName}' recreate transaction`,
  );
  if (result === "busy") {
    throw new Error(
      `Cannot journal sandbox '${input.sandboxName}': another onboarding writer owns the session lock.`,
    );
  }
  if (result !== "updated" || !writtenTransaction) {
    throw new Error(
      `Cannot journal sandbox '${input.sandboxName}': its onboarding session or recreate transaction changed.`,
    );
  }

  const storedSession = input.sessionStore.loadSession();
  if (
    !storedSession ||
    storedSession.sessionId !== openingSessionId ||
    fingerprintSandboxRecreateValue(activeTransaction(storedSession)) !==
      fingerprintSandboxRecreateValue(writtenTransaction)
  ) {
    throw new Error(
      `Cannot verify sandbox '${input.sandboxName}' recreate transaction after the write.`,
    );
  }
  return {
    session: storedSession,
    transaction: writtenTransaction,
    recovery,
    replacedTransactionId,
    registryEntry: freshRegistryEntry as SandboxEntry | null,
  };
}

export interface BeginSandboxRecreateDeleteInput {
  readonly sessionStore: SandboxRecreateTransactionOwnerStore;
  readonly openingSessionId: string;
  readonly expectedTransaction: CheckpointSandboxRecreateTransaction;
  readonly targetIntentFingerprint: string;
  readonly revalidateGatewayAuthority?: () => void;
  readonly readRegistryEntry: () => SandboxEntry | null;
  readonly observe: () => SandboxRecreateObservation;
}

/** Revalidate all source authority and journal deleting in one writer boundary. */
export function beginSandboxRecreateDelete(input: BeginSandboxRecreateDeleteInput): {
  readonly sourcePresence: SandboxRecreateSourcePresence;
  readonly transaction: CheckpointSandboxRecreateTransaction;
} {
  let observation: SandboxRecreateObservation | undefined;
  let nextTransaction: CheckpointSandboxRecreateTransaction | null = null;
  const result = input.sessionStore.compareAndSwapSession(
    (current) => {
      const transaction = activeTransaction(current);
      const firstDeleteEdge = input.expectedTransaction.phase !== "deleting";
      const ownsDeleteEdge =
        transaction?.id === input.expectedTransaction.id &&
        transaction.sandboxName === input.expectedTransaction.sandboxName &&
        transaction.gatewayName === input.expectedTransaction.gatewayName &&
        transaction.gatewayPort === input.expectedTransaction.gatewayPort &&
        transaction.targetGeneration === input.expectedTransaction.targetGeneration &&
        transaction.targetIntentFingerprint === input.targetIntentFingerprint &&
        (firstDeleteEdge
          ? fingerprintSandboxRecreateValue(transaction) ===
            fingerprintSandboxRecreateValue(input.expectedTransaction)
          : transaction.phase === "deleting" &&
            transaction.sourceRegistryFingerprint ===
              input.expectedTransaction.sourceRegistryFingerprint &&
            transaction.sourceLiveIdentityFingerprint ===
              input.expectedTransaction.sourceLiveIdentityFingerprint);
      if (current.sessionId !== input.openingSessionId || !transaction || !ownsDeleteEdge) {
        return false;
      }
      input.revalidateGatewayAuthority?.();
      const registryEntry = input.readRegistryEntry();
      if (!sandboxRecreateSourceRowMatches(registryEntry, transaction.sourceRegistryFingerprint)) {
        throw new Error(
          `Cannot delete sandbox '${transaction.sandboxName}': its source registry row changed.`,
        );
      }
      if (
        registryEntry?.gatewayName != null &&
        (registryEntry.gatewayName !== transaction.gatewayName ||
          registryEntry.gatewayPort !== transaction.gatewayPort)
      ) {
        throw new Error(
          `Cannot delete sandbox '${transaction.sandboxName}': its registry gateway authority changed.`,
        );
      }
      const gatewayAuthority = current.checkpoint?.gatewayAuthority;
      if (
        gatewayAuthority &&
        isDecisionSelected(gatewayAuthority) &&
        (gatewayAuthority.value.gatewayName !== transaction.gatewayName ||
          gatewayAuthority.value.gatewayPort !== transaction.gatewayPort)
      ) {
        throw new Error(
          `Cannot delete sandbox '${transaction.sandboxName}': its journaled gateway authority changed.`,
        );
      }
      observation = input.observe();
      if (
        observation.state !== "missing" &&
        (!transaction.sourceLiveIdentityFingerprint ||
          observation.liveIdentityFingerprint !== transaction.sourceLiveIdentityFingerprint)
      ) {
        throw new Error(
          `Cannot delete sandbox '${transaction.sandboxName}': the live same-name sandbox is not the journaled source.`,
        );
      }
      return true;
    },
    (current) => {
      const transaction = activeTransaction(current) as CheckpointSandboxRecreateTransaction;
      nextTransaction = sandboxRecreatePhaseReached(transaction.phase, "deleted")
        ? transaction
        : transaction.phase === "deleting"
          ? transaction
          : advanceSandboxRecreateTransaction(current, transaction.id, "deleting");
      return current;
    },
    `nemoclaw begin deleting sandbox '${input.expectedTransaction.sandboxName}'`,
  );
  if (result === "busy") {
    throw new Error(
      `Cannot delete sandbox '${input.expectedTransaction.sandboxName}': another onboarding writer owns the session lock.`,
    );
  }
  if (result !== "updated" || !observation || !nextTransaction) {
    throw new Error(
      `Cannot delete sandbox '${input.expectedTransaction.sandboxName}': its onboarding session or recreate transaction changed.`,
    );
  }
  const stored = input.sessionStore.loadSession();
  if (
    !stored ||
    stored.sessionId !== input.openingSessionId ||
    fingerprintSandboxRecreateValue(activeTransaction(stored)) !==
      fingerprintSandboxRecreateValue(nextTransaction)
  ) {
    throw new Error(
      `Cannot verify sandbox '${input.expectedTransaction.sandboxName}' deleting journal after the write.`,
    );
  }
  return {
    sourcePresence: observation.state === "missing" ? "missing" : "source",
    transaction: nextTransaction,
  };
}

export type SandboxRecreateSourcePresence = "missing" | "source";

export interface SandboxRecreateRuntime {
  readonly acceptedTarget: boolean;
  readonly targetGeneration: string | undefined;
  readonly journaledGatewayName: string | null;
  readonly sourceProof: SandboxRecreateSourceProof | null;
  readonly registrationFields: Pick<
    SandboxEntry,
    "lifecycleGeneration" | "lifecycleLiveIdentityFingerprint"
  >;
  advance(phase: CheckpointSandboxRecreatePhase): void;
  beginDelete(): SandboxRecreateSourcePresence;
  confirmDeleted(): void;
  recordExactIdentity(liveIdentityFingerprint: string): CreatedSandboxLifecycleRegistration;
  recordCreated(observation: SandboxRecreateObservation): void;
}

const NO_SANDBOX_RECREATE: SandboxRecreateRuntime = {
  acceptedTarget: false,
  targetGeneration: undefined,
  journaledGatewayName: null,
  sourceProof: null,
  registrationFields: {},
  advance: () => undefined,
  // Every same-name replacement deletes through this boundary. Refusing here is
  // what stops a new caller from removing a live sandbox it never journaled.
  beginDelete: (): SandboxRecreateSourcePresence => {
    throw new Error(
      "Cannot delete a same-name sandbox: no recreate transaction proves ownership of the source sandbox. Open the recreate journal before deleting.",
    );
  },
  confirmDeleted: () => undefined,
  recordExactIdentity: (_liveIdentityFingerprint) => {
    throw new Error(
      "Cannot record the created sandbox identity without an active recreate transaction.",
    );
  },
  recordCreated: (_observation) => undefined,
};

function requireRecordableCreatedIdentity(
  transaction: CheckpointSandboxRecreateTransaction,
  liveIdentityFingerprint: string,
): void {
  if (!/^[0-9a-f]{64}$/u.test(liveIdentityFingerprint)) {
    throw new Error("The created sandbox has an invalid live identity fingerprint.");
  }
  if (
    transaction.targetLiveIdentityFingerprint &&
    transaction.targetLiveIdentityFingerprint !== liveIdentityFingerprint
  ) {
    throw new Error("Sandbox recreate transaction already identifies a different replacement.");
  }
  if (
    transaction.phase !== "creating" &&
    !(
      transaction.phase === "created" &&
      transaction.targetLiveIdentityFingerprint === liveIdentityFingerprint
    )
  ) {
    throw new Error(
      `Sandbox recreate transaction cannot record its replacement from phase '${transaction.phase}'.`,
    );
  }
}

export function createSandboxRecreateRuntime(
  sessionStore: SandboxRecreateSessionStore,
  request: SandboxCreateIntent["recreateTransaction"] | undefined,
  sandboxName: string,
  gatewayName: string,
  registryEntry: SandboxEntry | null,
  observe: (sandboxName: string, gatewayName: string) => SandboxRecreateObservation,
  note: (message: string) => void,
  readRegistryEntry: () => SandboxEntry | null = () => registryEntry,
  revalidateGatewayAuthority?: () => void,
): SandboxRecreateRuntime {
  if (!request) return NO_SANDBOX_RECREATE;
  const openingSession = sessionStore.loadSession();
  const transaction = matchingSandboxRecreateTransaction(openingSession, {
    sandboxName,
    gatewayName,
    targetIntentFingerprint: request.targetIntentFingerprint,
    transactionId: request.id,
    targetGeneration: request.targetGeneration,
  });
  if (!openingSession) {
    throw new Error(`Sandbox '${sandboxName}' recreate journal has no owning session.`);
  }
  const openingSessionId = openingSession.sessionId;
  let currentTransaction = transaction;
  let phase: CheckpointSandboxRecreatePhase = transaction.phase;
  const advance = (next: CheckpointSandboxRecreatePhase): void => {
    sessionStore.updateSession((current) => {
      currentTransaction = advanceSandboxRecreateTransaction(current, transaction.id, next);
      phase = currentTransaction.phase;
      return current;
    });
  };
  let targetLiveIdentityFingerprint = transaction.targetLiveIdentityFingerprint;
  const recovery = planSandboxRecreateRecovery(
    transaction,
    observe(sandboxName, transaction.gatewayName),
    registryEntry,
    transaction,
  );
  if (recovery.action === "reject") {
    throw new Error(`Cannot resume sandbox '${sandboxName}' recreation: ${recovery.reason}.`);
  }
  // The caller owns journal replacement before handing this transaction off.
  if (recovery.action === "restart_from_source") {
    throw new Error(
      `Cannot resume sandbox '${sandboxName}' recreation: its journal no longer owns a replacement.`,
    );
  }
  if (recovery.action === "accept_target") {
    note(`  [resume] Recovering journaled replacement sandbox '${sandboxName}'.`);
  } else if (
    recovery.action === "continue_create" &&
    phaseIndex(transaction.phase) < phaseIndex("deleted")
  ) {
    advance("deleted");
  }
  return {
    acceptedTarget: recovery.action === "accept_target",
    targetGeneration: transaction.targetGeneration,
    journaledGatewayName: transaction.gatewayName,
    sourceProof: sandboxRecreateSourceProof(transaction),
    get registrationFields() {
      return {
        lifecycleGeneration: transaction.targetGeneration,
        ...(targetLiveIdentityFingerprint
          ? { lifecycleLiveIdentityFingerprint: targetLiveIdentityFingerprint }
          : {}),
      };
    },
    advance,
    beginDelete: () => {
      const compareAndSwap = sessionStore.compareAndSwapSession;
      if (!compareAndSwap) {
        throw new Error(
          `Cannot delete sandbox '${sandboxName}' without the writer-safe session update boundary.`,
        );
      }
      const begun = beginSandboxRecreateDelete({
        sessionStore: { ...sessionStore, compareAndSwapSession: compareAndSwap },
        openingSessionId,
        expectedTransaction: currentTransaction,
        targetIntentFingerprint: request.targetIntentFingerprint,
        revalidateGatewayAuthority,
        readRegistryEntry,
        observe: () => observe(sandboxName, transaction.gatewayName),
      });
      currentTransaction = begun.transaction;
      phase = currentTransaction.phase;
      return begun.sourcePresence;
    },
    confirmDeleted: () => {
      if (observe(sandboxName, transaction.gatewayName).state !== "missing") {
        throw new Error(
          `Cannot continue sandbox '${sandboxName}' recreation: OpenShell still reports the journaled source after delete.`,
        );
      }
      advance("deleted");
    },
    recordExactIdentity: (liveIdentityFingerprint) => {
      const compareAndSwap = sessionStore.compareAndSwapSession;
      if (!compareAndSwap) {
        throw new Error(
          `Cannot record sandbox '${sandboxName}' identity without the writer-safe session update boundary.`,
        );
      }
      const beforeWriteSession = sessionStore.loadSession();
      if (!beforeWriteSession || beforeWriteSession.sessionId !== openingSessionId) {
        throw new Error(
          `Cannot record sandbox '${sandboxName}' identity because its onboarding session changed.`,
        );
      }
      const beforeWriteTransaction = matchingSandboxRecreateTransaction(beforeWriteSession, {
        sandboxName,
        gatewayName,
        targetIntentFingerprint: request.targetIntentFingerprint,
        transactionId: request.id,
        targetGeneration: request.targetGeneration,
      });
      requireRecordableCreatedIdentity(beforeWriteTransaction, liveIdentityFingerprint);
      const expectedTransactionFingerprint =
        fingerprintSandboxRecreateValue(beforeWriteTransaction);
      const result = compareAndSwap(
        (current) => {
          const currentTransaction = current.checkpoint?.sandboxRecreate;
          return (
            current.sessionId === openingSessionId &&
            Boolean(currentTransaction) &&
            fingerprintSandboxRecreateValue(currentTransaction) === expectedTransactionFingerprint
          );
        },
        (current) => {
          recordSandboxRecreateTargetCreated(current, transaction.id, {
            state: "ready",
            liveIdentityFingerprint,
          });
          return current;
        },
        `nemoclaw record created sandbox '${sandboxName}' identity`,
      );
      if (result === "busy") {
        throw new Error(
          `Cannot record sandbox '${sandboxName}' identity because another onboarding writer owns the session lock.`,
        );
      }
      if (result !== "updated") {
        throw new Error(
          `Cannot record sandbox '${sandboxName}' identity because its recreate transaction changed.`,
        );
      }

      const storedSession = sessionStore.loadSession();
      if (!storedSession || storedSession.sessionId !== openingSessionId) {
        throw new Error(
          `Cannot verify sandbox '${sandboxName}' identity because its onboarding session changed after the write.`,
        );
      }
      const storedTransaction = matchingSandboxRecreateTransaction(storedSession, {
        sandboxName,
        gatewayName,
        targetIntentFingerprint: request.targetIntentFingerprint,
        transactionId: request.id,
        targetGeneration: request.targetGeneration,
      });
      if (
        !sandboxRecreatePhaseReached(storedTransaction.phase, "created") ||
        storedTransaction.targetLiveIdentityFingerprint !== liveIdentityFingerprint
      ) {
        throw new Error(
          `Cannot verify sandbox '${sandboxName}' identity in its recreate journal after the write.`,
        );
      }
      phase = storedTransaction.phase;
      targetLiveIdentityFingerprint = storedTransaction.targetLiveIdentityFingerprint;
      return {
        lifecycleGeneration: storedTransaction.targetGeneration,
        lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
      };
    },
    recordCreated: (observation) => {
      sessionStore.updateSession((current) => {
        targetLiveIdentityFingerprint = recordSandboxRecreateTargetCreated(
          current,
          transaction.id,
          observation,
        ).targetLiveIdentityFingerprint;
        return current;
      });
    },
  };
}

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
import type { Session } from "../state/onboard-session";
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
  "gatewayName",
  "gatewayPort",
];

export function fingerprintSandboxRegistryEntry(entry: SandboxEntry): string {
  const durable: Record<string, unknown> = { ...entry };
  for (const field of ROUTE_RESERVATION_FIELDS) delete durable[field];
  return fingerprintSandboxRecreateValue(durable);
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
  if (fingerprintSandboxRegistryEntry(check.registryEntry) !== proof.sourceRegistryFingerprint) {
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

export function beginSandboxRecreateTransaction(
  session: Session,
  input: BeginSandboxRecreateTransactionInput,
): CheckpointSandboxRecreateTransaction {
  const existing = activeTransaction(session);
  if (existing) {
    assertSameTransaction(existing, input);
    return existing;
  }
  if (input.observation.state !== "missing" && !input.observation.liveIdentityFingerprint) {
    throw new Error(
      `Cannot recreate sandbox '${input.sandboxName}': OpenShell did not report a stable sandbox Id.`,
    );
  }
  const checkpoint = baseCheckpoint(session);
  const now = input.now ?? new Date().toISOString();
  if (!input.sourceEntry) {
    throw new Error(
      `Cannot start sandbox '${input.sandboxName}' recreate transaction without its source registry row.`,
    );
  }
  const transaction: CheckpointSandboxRecreateTransaction = {
    version: 1,
    id: input.id ?? randomUUID(),
    revision: 0,
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
    sourceRegistryFingerprint: fingerprintSandboxRegistryEntry(input.sourceEntry),
    sourceLiveIdentityFingerprint: input.observation.liveIdentityFingerprint,
    sourceWorkload: checkpointSourceWorkload(input.sourceEntry),
    targetIntentFingerprint: input.targetIntentFingerprint,
    targetGeneration: input.targetGeneration ?? randomUUID(),
    targetLiveIdentityFingerprint: null,
    phase: input.observation.state === "missing" ? "deleted" : "planned",
    startedAt: now,
    updatedAt: now,
  };
  session.checkpoint = {
    ...checkpoint,
    machineState: session.machine.state,
    updatedAt: now,
    sandboxRecreate: transaction,
  };
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
  if (observation.state !== "ready" || !observation.liveIdentityFingerprint) {
    throw new Error("The journaled replacement must be ready with a stable OpenShell Id.");
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
  | { readonly action: "reject"; readonly reason: string };

function reject(reason: string): SandboxRecreateRecoveryPlan {
  return { action: "reject", reason };
}

export function planSandboxRecreateRecovery(
  transaction: CheckpointSandboxRecreateTransaction,
  observation: SandboxRecreateObservation,
  registryEntry: SandboxEntry | null,
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

  const sourceRegistered =
    registryEntry !== null &&
    fingerprintSandboxRegistryEntry(registryEntry) === transaction.sourceRegistryFingerprint;
  if (transaction.phase === "completed") {
    return reject("the completed transaction no longer matches its replacement registry row");
  }
  if (transaction.phase === "planned" || transaction.phase === "deleting") {
    if (!sourceRegistered) return reject("the source registry row changed before deletion");
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
    if (!sourceRegistered) return reject("the preserved source registry row changed");
    return observation.state === "missing"
      ? { action: "continue_create" }
      : reject("a live same-name sandbox appeared before replacement registration committed");
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
  recordCreated(): void;
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
  recordCreated: () => undefined,
};

export function createSandboxRecreateRuntime(
  sessionStore: SandboxRecreateSessionStore,
  request: SandboxCreateIntent["recreateTransaction"] | undefined,
  sandboxName: string,
  gatewayName: string,
  registryEntry: SandboxEntry | null,
  observe: (sandboxName: string, gatewayName: string) => SandboxRecreateObservation,
  note: (message: string) => void,
): SandboxRecreateRuntime {
  if (!request) return NO_SANDBOX_RECREATE;
  const transaction = matchingSandboxRecreateTransaction(sessionStore.loadSession(), {
    sandboxName,
    gatewayName,
    targetIntentFingerprint: request.targetIntentFingerprint,
    transactionId: request.id,
    targetGeneration: request.targetGeneration,
  });
  let phase: CheckpointSandboxRecreatePhase = transaction.phase;
  const advance = (next: CheckpointSandboxRecreatePhase): void => {
    sessionStore.updateSession((current) => {
      phase = advanceSandboxRecreateTransaction(current, transaction.id, next).phase;
      return current;
    });
  };
  let targetLiveIdentityFingerprint = transaction.targetLiveIdentityFingerprint;
  const recovery = planSandboxRecreateRecovery(
    transaction,
    observe(sandboxName, transaction.gatewayName),
    registryEntry,
  );
  if (recovery.action === "reject") {
    throw new Error(`Cannot resume sandbox '${sandboxName}' recreation: ${recovery.reason}.`);
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
      const live = observe(sandboxName, transaction.gatewayName);
      if (live.state !== "missing") {
        if (
          !transaction.sourceLiveIdentityFingerprint ||
          live.liveIdentityFingerprint !== transaction.sourceLiveIdentityFingerprint
        ) {
          throw new Error(
            `Cannot delete sandbox '${sandboxName}': the live same-name sandbox is not the journaled source.`,
          );
        }
      }
      if (!sandboxRecreatePhaseReached(phase, "deleted")) advance("deleting");
      return live.state === "missing" ? "missing" : "source";
    },
    confirmDeleted: () => {
      if (observe(sandboxName, transaction.gatewayName).state !== "missing") {
        throw new Error(
          `Cannot continue sandbox '${sandboxName}' recreation: OpenShell still reports the journaled source after delete.`,
        );
      }
      advance("deleted");
    },
    recordCreated: () => {
      const observation = observe(sandboxName, transaction.gatewayName);
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

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { createHermesCredentialEnvReconciliationRuntime } from "../../actions/sandbox/runtime/hermes-lifecycle";
import type { SandboxCreateOrchestrationRuntime } from "../../onboard";
import {
  assertRecordedPolicyAuthority,
  isPolicyAuthorityRefusalError,
  PolicyAuthorityRefusalError,
} from "../../adapters/openshell/policy-authority";
import type { SandboxPolicyAuthority } from "../../adapters/openshell/policy-authority";
import { HERMES_PORTABLE_OPENSHELL_VERSION } from "../../adapters/openshell/resolve-shared";
import { NEMOCLAW_CREATE_ATTEMPT_LABEL } from "../../adapters/openshell/sandbox-identity";
import type { AgentDefinition } from "../../agent/defs";
import type { WebSearchConfig } from "../../inference/web-search";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import type { BackupResult } from "../../state/sandbox";
import type { RetainedSandboxRecoveryContext, Session } from "../../state/onboard-session";
import type { SandboxEntry } from "../../state/registry";
import type {
  PendingSandboxPolicyVerification,
  QualifiedPendingSandboxCreateReservation,
} from "../../state/registry";
import type { HermesAuthMethod } from "../hermes-auth";
import * as policyAuthorityPreflight from "../policy-authority/preflight";
import type { PreparedSandboxBuildContext } from "../build-context-stage";
import type { DcodeSelectionDriftReader } from "../dcode-selection-drift";
import { assertProviderlessInterceptorEnvironment } from "../entry-options";
import type {
  ManagedHermesStateVolumeCleanupResult,
  ManagedHermesStateVolumeContext,
} from "../managed-workload/hermes-state-volume";
import type { OwnedSandboxRecreateRuntime } from "../onboard-recreate-journal";
import type { SandboxGpuConfig } from "../sandbox-gpu-mode";
import { cliName } from "../branding";
import type {
  CreatedSandboxLifecycle,
  CreatedSandboxLifecycleRegistration,
} from "../sandbox-recreate-transaction";
import type { PortableOnboardRuntimeContext } from "../session-bootstrap";
import type {
  InferenceRouteReservationAuthority,
  SandboxCreateIntent,
  VerifiedSandboxCreateEffectsContext,
  VerifiedSandboxPolicyBoundary,
  VerifiedSandboxPolicyRegistration,
} from "../types";
import * as sandboxCreatePlanMaterialization from "../sandbox-create-plan-materialization";
import {
  pendingSandboxPolicyVerificationForBoundary,
  revalidateCreatedSandboxPolicyRegistration,
  verifiedSandboxPolicyBoundaryFromPendingCheckpoint,
  verifyCreatedApfInterceptorPolicyRegistration,
  verifyCreatedSandboxPolicyRegistration,
} from "./policy-creation-receipt";
import {
  attachProvidersAfterSandboxCreation,
  publishAttachedProvidersBeforeDockerSandboxCreation,
  validateAttachedMessagingProvidersBeforeSandboxCreation,
} from "./provider-publication";
export const createOnboardPolicyAuthorityBindings =
  policyAuthorityPreflight.createOnboardPolicyAuthorityBindings;

function cancelRecoveryIdentity(
  liveExists: boolean,
  requireVerifiedPolicyGate: () => VerifiedSandboxPolicyBoundary,
): { readonly lifecycleLiveIdentityFingerprint?: string } {
  if (liveExists) return {};
  return {
    lifecycleLiveIdentityFingerprint: requireVerifiedPolicyGate().lifecycleLiveIdentityFingerprint,
  };
}

export function createOnboardCreatedSandboxRegistrationWithManagedLifecycle(input: {
  readonly sandboxName: string;
  readonly managedBootstrap: boolean;
  readonly sandboxGpuEnabled: boolean;
  readonly createdLifecycle: CreatedSandboxLifecycle;
  readonly getRecordedRegistration: () => CreatedSandboxLifecycleRegistration;
  readonly createRegistration: SandboxCreateOrchestrationRuntime["createOnboardCreatedSandboxRegistration"];
  readonly registration: Omit<
    Parameters<SandboxCreateOrchestrationRuntime["createOnboardCreatedSandboxRegistration"]>[0],
    "createdLifecycle"
  >;
}) {
  let createdLifecycle = input.createdLifecycle;
  if (input.managedBootstrap) {
    const capture = input.sandboxGpuEnabled
      ? input.createdLifecycle.capture
      : ({ lifecycleGeneration }: Pick<SandboxEntry, "lifecycleGeneration">) => {
          const recordedRegistration = input.getRecordedRegistration();
          if (lifecycleGeneration !== recordedRegistration.lifecycleGeneration) {
            throw new Error(
              `Cannot register sandbox '${input.sandboxName}': lifecycle setup did not preserve its generation.`,
            );
          }
          return recordedRegistration;
        };
    createdLifecycle = {
      ...input.createdLifecycle,
      capture,
      revalidate: (registration) =>
        input.createdLifecycle.revalidate(registration, {
          allowNotReadyWithMatchingIdentity: true,
        }),
    };
  }
  return input.createRegistration({ ...input.registration, createdLifecycle });
}

/** Persist one create-attempt recovery message through the onboard session owner. */
export function persistRetainedSandboxRecoveryMessage(
  input: {
    readonly sandboxName: string;
    readonly message: string;
    readonly sandboxIdentityFingerprint?: string;
    readonly recoveryContext: RetainedSandboxRecoveryContext;
  },
  markRetainedSandboxRecovery: (
    sandboxName: string,
    message: string,
    sandboxIdentityFingerprint: string | undefined,
    context: RetainedSandboxRecoveryContext,
  ) => unknown | null,
): boolean {
  return Boolean(
    markRetainedSandboxRecovery(
      input.sandboxName,
      input.message,
      input.sandboxIdentityFingerprint,
      input.recoveryContext,
    ),
  );
}

export class RetainedSandboxRecoveryPersistenceError extends Error {
  constructor(
    readonly stage: "registry publication" | "onboarding finalization",
    options?: ErrorOptions,
  ) {
    super(`NemoClaw could not save the retained sandbox recovery record after ${stage}.`, options);
    this.name = "RetainedSandboxRecoveryPersistenceError";
  }
}

export interface PostCreateRecoveryRetryOwner {
  record(recordRecovery: () => void): void;
}

export function installPostCreateRecoveryRetryOwner(
  options: {
    readonly log?: (message: string) => void;
    readonly registerExitHandler?: (handler: () => void) => void;
  } = {},
): PostCreateRecoveryRetryOwner {
  let pending: (() => void) | null = null;
  const log = options.log ?? ((message: string) => console.error(message));
  const attemptPending = (propagateFailure: boolean): void => {
    if (pending === null) return;
    const attempt = pending;
    try {
      attempt();
      if (pending === attempt) pending = null;
    } catch (error) {
      if (propagateFailure) throw error;
      log(
        "  NemoClaw still could not save the retained sandbox recovery record; the recovery-only session remains blocked for administrator recovery.",
      );
    }
  };
  const owner: PostCreateRecoveryRetryOwner = {
    record(recordRecovery): void {
      attemptPending(true);
      pending = recordRecovery;
      attemptPending(true);
    },
  };
  const register =
    options.registerExitHandler ??
    ((handler: () => void) => {
      process.on("exit", handler);
    });
  register(() => attemptPending(false));
  return owner;
}

function persistRetainedSandboxRecoveryWithRetry(
  retryOwner: PostCreateRecoveryRetryOwner | undefined,
  persist: () => boolean,
): boolean {
  let persisted = false;
  const attempt = (): void => {
    persisted = persist();
    if (!persisted) {
      throw new Error("NemoClaw could not save the retained sandbox recovery record.");
    }
  };
  if (retryOwner) retryOwner.record(attempt);
  else attempt();
  return persisted;
}

export function persistPostCreateRecovery(input: {
  readonly stage: "registry publication" | "onboarding finalization";
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly lifecycleGeneration: string;
  readonly exactIdentity?: string;
  readonly recoveryContext: RetainedSandboxRecoveryContext;
  readonly markRetainedSandboxRecovery: (
    sandboxName: string,
    message: string,
    sandboxIdentityFingerprint: string | undefined,
    context: RetainedSandboxRecoveryContext,
  ) => unknown | null;
}): void {
  const message =
    `Create-attempt label: ${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${input.recoveryContext.createAttemptNonce}. ` +
    `Sandbox '${input.sandboxName}' was retained after ${input.stage} failed. ` +
    `Gateway '${input.gatewayName}'. Lifecycle generation '${input.lifecycleGeneration}'. ` +
    "Do not delete the sandbox by mutable name; preserve it for identity-bound administrator recovery.";
  console.error(`  ${message}`);
  let persisted = false;
  try {
    persisted = persistRetainedSandboxRecoveryMessage(
      {
        sandboxName: input.sandboxName,
        message,
        ...(input.exactIdentity ? { sandboxIdentityFingerprint: input.exactIdentity } : {}),
        recoveryContext: input.recoveryContext,
      },
      input.markRetainedSandboxRecovery,
    );
  } catch (cause) {
    throw new RetainedSandboxRecoveryPersistenceError(input.stage, { cause });
  }
  if (!persisted) {
    throw new RetainedSandboxRecoveryPersistenceError(input.stage);
  }
}

function throwPostCreateFailure(error: unknown, recordRecovery: () => void): never {
  try {
    recordRecovery();
  } catch (recoveryError) {
    throw new AggregateError(
      [error, recoveryError],
      "The sandbox operation failed, and its retained recovery record could not be persisted.",
    );
  }
  throw error;
}

export async function runAsyncWithPostCreateRecovery<Result>(
  operation: () => Promise<Result>,
  recordRecovery: () => void,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    return throwPostCreateFailure(error, recordRecovery);
  }
}

export function runWithPostCreateRecovery<Result>(
  operation: () => Result,
  recordRecovery: () => void,
): Result {
  try {
    return operation();
  } catch (error) {
    return throwPostCreateFailure(error, recordRecovery);
  }
}

export type EffectiveVerifiedSandboxPolicyBoundary = VerifiedSandboxPolicyBoundary & {
  readonly policySourcePath: string;
};

interface VerifyCreatedSandboxEffectivePolicyInput {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string;
  readonly lifecycleLiveIdentityFingerprint: string;
  readonly route: import("../docker-gpu-route").SelectedDockerGpuRoute;
  readonly hermesPortable: boolean;
  readonly effectivePolicySourcePath?: string;
  readonly policySourcePathForRoute: () => string;
  readonly apfInterceptorRequested: boolean;
  readonly plannedAuthority: Exclude<SandboxPolicyAuthority, "owner-unknown">;
  readonly operation: string;
}

/** Bind post-create verification to the exact policy source used by this create. */
export function verifyCreatedSandboxEffectivePolicy(
  input: VerifyCreatedSandboxEffectivePolicyInput,
): EffectiveVerifiedSandboxPolicyBoundary {
  if (Boolean(input.effectivePolicySourcePath) !== input.hermesPortable) {
    throw new Error("Hermes portable create policy authority is incomplete.");
  }
  if (input.effectivePolicySourcePath && input.route === "compatibility") {
    throw new Error("Hermes portable create selected an unsupported GPU route.");
  }
  const policySourcePath = input.effectivePolicySourcePath ?? input.policySourcePathForRoute();
  const registrationInput = {
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
    lifecycleGeneration: input.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: input.lifecycleLiveIdentityFingerprint,
    policySourcePath,
    route: input.route,
    operation: input.operation,
  };
  const registration = input.apfInterceptorRequested
    ? verifyCreatedApfInterceptorPolicyRegistration(registrationInput)
    : verifyCreatedSandboxPolicyRegistration({
        ...registrationInput,
        plannedAuthority: input.plannedAuthority,
      });
  return {
    registration,
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
    lifecycleGeneration: input.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: input.lifecycleLiveIdentityFingerprint,
    route: input.route,
    policySourcePath,
  };
}

/** Select the policyless APF create plan only when no active global policy exists. */
export function resolveSandboxCreatePolicyAuthority(
  observedAuthority: "nemoclaw-managed" | "externally-managed",
  apfInterceptorRequested: boolean,
): "nemoclaw-managed" | "externally-managed" {
  if (!apfInterceptorRequested) return observedAuthority;
  if (observedAuthority !== "nemoclaw-managed") {
    throw new Error(
      "APF interceptor selection requires the active global policy to be absent before sandbox creation.",
    );
  }
  return "externally-managed";
}

/** Require the generic deferred-effect gate for explicit APF creation. */
export function assertApfCreateIntent(
  createIntent: Pick<
    SandboxCreateIntent,
    "apfInterceptorRequested" | "deferSandboxEffectsUntilPolicyVerification"
  > | null,
): void {
  if (
    createIntent?.apfInterceptorRequested === true &&
    createIntent.deferSandboxEffectsUntilPolicyVerification !== true
  ) {
    throw new Error("APF interceptor create intent is missing deferred-effect authority.");
  }
}

function assertProviderlessApfCreateInput(input: {
  readonly createIntent: SandboxCreateIntent | null;
  readonly agent: AgentDefinition | null;
  readonly model: string;
  readonly provider: string;
  readonly preferredInferenceApi: string | null;
  readonly webSearchConfig: WebSearchConfig | null;
  readonly enabledChannels: readonly string[] | null;
  readonly hermesToolGateways: readonly string[];
}): void {
  if (input.createIntent?.apfInterceptorRequested !== true) return;
  const resolved = input.createIntent.resolved;
  const requestedAgent = input.agent?.name.trim().toLowerCase() ?? "openclaw";
  const resolvedAgent = resolved?.policy.options.agentName?.trim().toLowerCase() || null;
  const hasProviderIntent =
    requestedAgent !== "openclaw" ||
    (resolvedAgent !== null &&
      (resolvedAgent !== "openclaw" || resolvedAgent !== requestedAgent)) ||
    input.webSearchConfig !== null ||
    input.createIntent.reuseRegisteredCredentials === true ||
    [
      input.provider,
      input.model,
      input.preferredInferenceApi,
      input.createIntent.endpointUrl,
      resolved?.inferenceProvider,
    ].some((value) => Boolean(value?.trim())) ||
    [
      input.enabledChannels,
      input.hermesToolGateways,
      input.createIntent.extraProviders,
      resolved?.activeMessagingChannels,
      resolved?.messagingProviderRequests,
      resolved?.reusableMessagingProviders,
      resolved?.extraProviders,
      resolved?.staleExtraProviders,
      resolved?.hermesToolGateways,
      resolved?.extraPlaceholderKeys,
    ].some((values) => (values?.length ?? 0) > 0);
  if (!hasProviderIntent) return;
  throw new Error(
    "Interceptor onboarding supports providerless sandbox creation only. No sandbox or provider was created.",
  );
}

type SandboxRecreateReasonInput = {
  sandboxName: string;
  recreateForAgentDrift: boolean;
  existingAgentName: string | null | undefined;
  requestedAgentName: string | null | undefined;
  needsProviderMigration: boolean;
  actionableSelectionDrift: boolean;
  sandboxGpuDrift: boolean;
  hermesToolGatewayDrift: boolean;
  hermesDashboardDrift: boolean;
  observabilityDrift: boolean;
  dcodeAutoApprovalDrift: boolean;
  toolDisclosureMigrationNote: string | null | undefined;
  credentialRotationChanged: boolean;
  existingSandboxState: string;
};

type RecreatedSourceHermesStateVolumeCleanupInput = {
  readonly sandboxName: string;
  readonly sourceEntry: SandboxEntry | null;
  readonly targetKeepsManagedHermesStateVolume: boolean;
};

type RecreatedSourceHermesStateVolumeCleanupDeps = {
  readonly normalizeRuntimeProviderIdentity: (driverName: string | null | undefined) => string;
  readonly removeManagedHermesStateVolume: (
    context: ManagedHermesStateVolumeContext,
  ) => ManagedHermesStateVolumeCleanupResult;
  readonly note: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly redact: (message: string) => string;
};

type RecreatedSourceHermesStateVolumeFinalizationInput =
  RecreatedSourceHermesStateVolumeCleanupInput & {
    readonly sourceConfirmedAbsent: boolean;
  };

type RecreatedSourceHermesStateVolumeFinalizationDeps =
  RecreatedSourceHermesStateVolumeCleanupDeps & {
    readonly removeSourceRegistryEntry: (entry: SandboxEntry, sandboxName: string) => void;
  };

export function cleanupRecreatedSourceHermesStateVolume(
  input: RecreatedSourceHermesStateVolumeCleanupInput,
  deps: RecreatedSourceHermesStateVolumeCleanupDeps,
): void {
  if (!input.sourceEntry || input.targetKeepsManagedHermesStateVolume) return;

  const cleanup = deps.removeManagedHermesStateVolume({
    agentName: input.sourceEntry.agent,
    runtimeProviderId: deps.normalizeRuntimeProviderIdentity(input.sourceEntry.openshellDriver),
    sandboxName: input.sandboxName,
    workloadKind: input.sourceEntry.workload?.kind ?? "",
  });
  if (cleanup.status === "failed") {
    throw new Error(
      `OpenShell confirmed that sandbox '${input.sandboxName}' is absent, but Docker could not remove its managed Hermes state volume '${cleanup.volumeName}': ${deps.redact(cleanup.detail)}. NemoClaw preserved the sandbox registry entry so a subsequent recreation can retry the volume removal.`,
    );
  }
  if (cleanup.status === "not-owned") {
    deps.warn(`  Left Docker volume '${cleanup.volumeName}' untouched because ${cleanup.detail}.`);
  } else if (cleanup.status === "removed") {
    deps.note(`  Removed managed Hermes state volume for '${input.sandboxName}'.`);
  }
}

export function finalizeRecreatedSourceHermesStateVolume(
  input: RecreatedSourceHermesStateVolumeFinalizationInput,
  deps: RecreatedSourceHermesStateVolumeFinalizationDeps,
): void {
  if (!input.sourceConfirmedAbsent || !input.sourceEntry) return;

  cleanupRecreatedSourceHermesStateVolume(input, deps);
  deps.removeSourceRegistryEntry(input.sourceEntry, input.sandboxName);
}

export function readManagedDcodeCreateSelectionDrift(
  input: {
    sandboxName: string;
    provider: string;
    model: string;
    preferredInferenceApi: string | null;
    createIntent: Pick<SandboxCreateIntent, "endpointUrl"> | null;
  },
  readDcodeSelectionDrift: DcodeSelectionDriftReader,
) {
  return readDcodeSelectionDrift(
    input.sandboxName,
    input.provider,
    input.model,
    input.preferredInferenceApi,
    input.createIntent?.endpointUrl ?? null,
  );
}

function reportSandboxRecreateReason(
  input: SandboxRecreateReasonInput,
  deps: {
    formatSandboxAgentName(agentName: string | null | undefined): string;
    note(message: string): void;
  },
): void {
  const { sandboxName } = input;
  if (input.recreateForAgentDrift) {
    deps.note(
      `  Sandbox '${sandboxName}' exists as ${deps.formatSandboxAgentName(input.existingAgentName)} — recreating as ${deps.formatSandboxAgentName(input.requestedAgentName)}.`,
    );
  } else if (input.needsProviderMigration) {
    console.log(`  Sandbox '${sandboxName}' exists but messaging providers are not attached.`);
    console.log("  Recreating to ensure credentials flow through the provider pipeline.");
  } else if (input.actionableSelectionDrift) {
    deps.note(
      `  Sandbox '${sandboxName}' exists — recreating because its live model/provider selection is stale or unreadable.`,
    );
  } else if (input.sandboxGpuDrift) {
    deps.note(`  Sandbox '${sandboxName}' exists — recreating to apply sandbox GPU settings.`);
  } else if (input.hermesToolGatewayDrift) {
    deps.note(
      `  Sandbox '${sandboxName}' exists — recreating to apply Hermes managed-tool changes.`,
    );
  } else if (input.hermesDashboardDrift) {
    deps.note(`  Sandbox '${sandboxName}' exists — recreating to apply Hermes dashboard settings.`);
  } else if (input.observabilityDrift) {
    deps.note(`  Sandbox '${sandboxName}' exists — recreating to apply observability settings.`);
  } else if (input.dcodeAutoApprovalDrift) {
    deps.note(
      `  Sandbox '${sandboxName}' exists — recreating to apply DCode auto-approval settings.`,
    );
  } else if (input.toolDisclosureMigrationNote) {
    deps.note(input.toolDisclosureMigrationNote);
  } else if (input.credentialRotationChanged) {
    // Message already printed above during backup.
  } else if (input.existingSandboxState === "ready") {
    deps.note(`  Sandbox '${sandboxName}' exists and is ready — recreating by explicit request.`);
  } else {
    deps.note(`  Sandbox '${sandboxName}' exists but is not ready — recreating it.`);
  }
}

export async function completeHermesPortableSandboxRegistration(input: {
  readonly sandboxName: string;
  readonly completeRegistration: () => Promise<unknown>;
  readonly readRegistry: (sandboxName: string) => SandboxEntry | null;
}): Promise<SandboxEntry> {
  await input.completeRegistration();
  const registered = input.readRegistry(input.sandboxName);
  if (!registered) {
    throw new Error("Hermes portable sandbox registration returned no authority.");
  }
  return registered;
}

type CreatedHermesCredentialEnvReconciliationDeps = {
  readonly reconcileCredentialEnv: (
    plan: SandboxMessagingPlan,
    revalidatePolicyAuthority: (operation: string) => void,
  ) => {
    readonly changed: boolean;
  };
  readonly restartGateway: (
    sandboxName: string,
    revalidatePolicyAuthority: (operation: string) => void,
  ) => {
    readonly status: number;
    readonly stdout: string;
    readonly stderr: string;
  } | null;
  readonly parseRestartCompletion: (
    result: {
      readonly status: number;
      readonly stdout: string;
      readonly stderr: string;
    } | null,
  ) => unknown | null;
  readonly waitForGateway: (
    sandboxName: string,
    revalidatePolicyAuthority: (operation: string) => void,
  ) => boolean;
  readonly revalidatePolicyAuthority: (operation: string) => void;
};

/**
 * Reconcile credentials rendered by an older managed Hermes image before
 * onboarding reports success. A changed env file is not effective until the
 * exact managed gateway supervisor restarts and passes its authenticated probe.
 */
export function reconcileCreatedHermesCredentialEnvironment(
  input: {
    readonly sandboxName: string;
    readonly plan: SandboxMessagingPlan | null;
  },
  deps: CreatedHermesCredentialEnvReconciliationDeps,
  recordRecovery: () => void,
): void {
  return runWithPostCreateRecovery(() => {
    if (input.plan?.agent !== "hermes") return;

    deps.revalidatePolicyAuthority(
      `reconciling Hermes messaging credentials for sandbox '${input.sandboxName}'`,
    );
    const reconciliation = deps.reconcileCredentialEnv(input.plan, deps.revalidatePolicyAuthority);
    deps.revalidatePolicyAuthority(
      `confirming Hermes messaging credential reconciliation for sandbox '${input.sandboxName}'`,
    );
    if (!reconciliation.changed) return;

    const restart = deps.restartGateway(input.sandboxName, deps.revalidatePolicyAuthority);
    if (!deps.parseRestartCompletion(restart)) {
      throw new Error(
        `Hermes messaging credential reconciliation changed the gateway environment for sandbox '${input.sandboxName}', but the managed gateway restart did not complete.`,
      );
    }
    if (!deps.waitForGateway(input.sandboxName, deps.revalidatePolicyAuthority)) {
      throw new Error(
        `Hermes messaging credential reconciliation restarted sandbox '${input.sandboxName}', but the managed gateway did not remain healthy.`,
      );
    }
    deps.revalidatePolicyAuthority(
      `completing Hermes messaging credential reconciliation for sandbox '${input.sandboxName}'`,
    );
  }, recordRecovery);
}

export async function finalizeCreatedSandboxBeforeHermesCredentialReconciliation<T>(
  completeRegistration: () => Promise<T>,
  reconcileCredentialEnvironment: () => void,
): Promise<T> {
  const registration = await completeRegistration();
  reconcileCredentialEnvironment();
  return registration;
}

/**
 * Keep every effect after an unverified create behind one exact-identity policy gate.
 *
 * The create callback owns the create transaction. It must await the supplied gate
 * immediately after OpenShell returns the exact created identity and before provider,
 * credential, service, runtime, registry, or completion effects.
 */
export async function runSandboxCreateWithPolicyAuthorityChecks<
  Created,
  Evidence,
  Result = Created,
>(input: {
  readonly sandboxName: string;
  readonly revalidate: (sandboxIsLive: boolean, operation: string) => void;
  readonly create: (verifyCreatedSandbox: (created: Created) => Promise<string>) => Promise<Result>;
  readonly captureCreatedSandboxIdentity: (created: Created) => string;
  readonly captureCreatedSandboxCreateAttemptNonce?: (created: Created) => string;
  readonly persistCreatedSandboxIdentity: (created: Created, exactIdentity: string) => void;
  readonly revalidateCreatedSandboxIdentity: (expectedIdentity: string, operation: string) => void;
  readonly verifyCreatedPolicy: (created: Created, exactIdentity: string) => Evidence;
  readonly persistVerifiedPolicy: (
    created: Created,
    exactIdentity: string,
    evidence: Evidence,
  ) => void;
  readonly revalidateVerifiedPolicy: (
    created: Created,
    exactIdentity: string,
    evidence: Evidence,
    operation: string,
  ) => void;
  readonly runVerifiedCreateEffects?: (
    created: Created,
    exactIdentity: string,
    evidence: Evidence,
  ) => Promise<void>;
  readonly persistRetainedSandboxRecovery?: (
    message: string,
    exactIdentity: string | null,
    evidence: Evidence | null,
    created: Created | null,
  ) => boolean;
  readonly retainedSandboxRecoveryRetryOwner?: PostCreateRecoveryRetryOwner;
  readonly cleanupTemporarySources: () => void;
}): Promise<Result> {
  input.revalidate(false, `creating sandbox '${input.sandboxName}'`);
  let exactIdentity: string | null = null;
  let createAttemptNonce: string | null = null;
  let observedPolicyEvidence: Evidence | null = null;
  let observedCreatedSandbox: Created | null = null;
  let cleanupAttempted = false;
  let recoveryAttempted = false;
  const cleanupTemporarySources = (): unknown[] => {
    if (cleanupAttempted) return [];
    cleanupAttempted = true;
    try {
      input.cleanupTemporarySources();
      return [];
    } catch (error) {
      return [error];
    }
  };
  const refuseAfterCreate = (validationError: unknown): never => {
    recoveryAttempted = true;
    const validationDetail =
      validationError instanceof Error && isPolicyAuthorityRefusalError(validationError)
        ? validationError.message
        : null;
    const identityGuidance = exactIdentity
      ? `Durable sandbox identity fingerprint: ${exactIdentity}. Use it only to compare the surviving sandbox with the failed create.`
      : "OpenShell did not return a durable sandbox identity fingerprint for comparison.";
    const createAttemptGuidance = createAttemptNonce
      ? `Create-attempt label: ${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${createAttemptNonce}. `
      : "";
    const recoveryGuidance =
      createAttemptGuidance +
      `NemoClaw left sandbox '${input.sandboxName}' in place after post-create verification or finalization failed. ` +
      `${identityGuidance} NemoClaw did not run OpenShell's mutable-name deletion command because the name may now identify a replacement sandbox. ` +
      `Do not delete the sandbox by mutable sandbox name. Run '${cliName()} ${input.sandboxName} destroy' to use the retained identity. ` +
      "If destroy cannot prove that identity, stop. Ask the OpenShell administrator to inspect the surviving sandbox and use an identity-bound recovery or removal procedure.";
    const compensationErrors: unknown[] = [];
    if (input.persistRetainedSandboxRecovery) {
      try {
        persistRetainedSandboxRecoveryWithRetry(input.retainedSandboxRecoveryRetryOwner, () =>
          input.persistRetainedSandboxRecovery!(
            recoveryGuidance,
            exactIdentity,
            observedPolicyEvidence,
            observedCreatedSandbox,
          ),
        );
      } catch (error) {
        compensationErrors.push(error);
      }
    }
    compensationErrors.push(...cleanupTemporarySources());
    compensationErrors.push(new Error(recoveryGuidance));
    throw new AggregateError(
      [validationError, ...compensationErrors],
      `Sandbox post-create verification or finalization failed${validationDetail ? `: ${validationDetail}` : ""}; automatic sandbox cleanup was not safe. ${recoveryGuidance}`,
    );
  };
  const verifyCreatedSandbox = async (created: Created): Promise<string> => {
    observedCreatedSandbox = created;
    try {
      const capturedCreateAttemptNonce = input.captureCreatedSandboxCreateAttemptNonce?.(created);
      if (
        capturedCreateAttemptNonce !== undefined &&
        !/^[0-9a-f]{62}$/u.test(capturedCreateAttemptNonce)
      ) {
        throw new Error(
          `OpenShell did not return one exact create-attempt label for sandbox '${input.sandboxName}'.`,
        );
      }
      createAttemptNonce = capturedCreateAttemptNonce ?? null;
      const capturedIdentity = input.captureCreatedSandboxIdentity(created);
      if (!/^[0-9a-f]{64}$/u.test(capturedIdentity)) {
        throw new Error(
          `OpenShell did not return one exact durable identity for sandbox '${input.sandboxName}'.`,
        );
      }
      exactIdentity = capturedIdentity;
      input.persistCreatedSandboxIdentity(created, capturedIdentity);
      input.revalidateCreatedSandboxIdentity(
        capturedIdentity,
        `verifying effective policy for sandbox '${input.sandboxName}'`,
      );
      const evidence = input.verifyCreatedPolicy(created, capturedIdentity);
      input.revalidateCreatedSandboxIdentity(
        capturedIdentity,
        `recording verified policy for sandbox '${input.sandboxName}'`,
      );
      observedPolicyEvidence = evidence;
      input.persistVerifiedPolicy(created, capturedIdentity, evidence);
      input.revalidateVerifiedPolicy(
        created,
        capturedIdentity,
        evidence,
        `continuing onboarding for sandbox '${input.sandboxName}'`,
      );
      await input.runVerifiedCreateEffects?.(created, capturedIdentity, evidence);
      input.revalidateCreatedSandboxIdentity(
        capturedIdentity,
        `confirming verified effects for sandbox '${input.sandboxName}'`,
      );
      return capturedIdentity;
    } catch (validationError) {
      return refuseAfterCreate(validationError);
    }
  };
  let result: Result;
  try {
    result = await input.create(verifyCreatedSandbox);
  } catch (error) {
    if (exactIdentity !== null && !recoveryAttempted) return refuseAfterCreate(error);
    const cleanupErrors = cleanupTemporarySources();
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Sandbox creation failed, and temporary source cleanup did not complete.",
      );
    }
    throw error;
  }
  const verifiedIdentity = exactIdentity;
  if (verifiedIdentity === null) {
    return refuseAfterCreate(
      new Error(
        `Sandbox '${input.sandboxName}' creation returned before its exact post-create verification boundary ran.`,
      ),
    );
  }
  try {
    input.revalidateCreatedSandboxIdentity(
      verifiedIdentity,
      `completing sandbox creation for '${input.sandboxName}'`,
    );
  } catch (validationError) {
    return refuseAfterCreate(validationError);
  }
  return result;
}

function assertHermesPortablePolicyAuthority(
  hermesPortableLifecycle: boolean,
  policyAuthority: string,
): void {
  if (!hermesPortableLifecycle || policyAuthority === "nemoclaw-managed") return;
  throw new Error("Hermes portable sandbox creation requires NemoClaw-managed policy authority.");
}

export function hasManagedMcpRebuildHandoff(
  createIntent: SandboxCreateIntent | null | undefined,
): boolean {
  const handoff = createIntent?.recreateJournalTargetIntentFingerprint;
  return Boolean(handoff && createIntent?.recreateTransaction?.targetIntentFingerprint === handoff);
}

function shouldRefuseManagedMcpRecreate(
  preservedMcpState: unknown,
  managedMcpRebuildHandoff: boolean,
): boolean {
  return Boolean(preservedMcpState) && !managedMcpRebuildHandoff;
}

function hasPreservedManagedMcpRebuildHandoff(
  preservedMcpState: unknown,
  createIntent: SandboxCreateIntent | null | undefined,
): boolean {
  return Boolean(preservedMcpState) && hasManagedMcpRebuildHandoff(createIntent);
}

export function backfillVerifiedExternalSandboxPolicyAuthority(input: {
  readonly sandboxName: string;
  readonly existingEntry: SandboxEntry | null;
  readonly policyAuthority: "nemoclaw-managed" | "externally-managed";
  readonly updateSandbox: (
    sandboxName: string,
    updates: { policyAuthority: "nemoclaw-managed" | "externally-managed" },
  ) => boolean;
}): void {
  if (
    !input.existingEntry ||
    input.existingEntry.policyAuthority ||
    input.policyAuthority !== "externally-managed"
  ) {
    return;
  }
  if (input.updateSandbox(input.sandboxName, { policyAuthority: input.policyAuthority })) return;
  throw new Error(`Could not record policy authority for sandbox '${input.sandboxName}'.`);
}

type ApplyRecreatePolicyCarryForward = (
  sandboxName: string,
  nonInteractive: boolean,
  note: (message: string) => void,
  rebuildPolicyPresets?: readonly string[],
) => void;

/** Carry managed rebuild policy intent only while the recorded authority remains current. */
export function applyManagedSandboxRebuildPolicyCarryForward(
  input: {
    readonly sandboxName: string;
    readonly policyAuthority: "nemoclaw-managed" | "externally-managed";
    readonly nonInteractive: boolean;
    readonly note: (message: string) => void;
    readonly rebuildPolicyPresets?: readonly string[];
    readonly revalidatePolicyAuthority: (operation: string) => void;
  },
  applyRecreatePolicyCarryForward: ApplyRecreatePolicyCarryForward,
): void {
  if (input.policyAuthority !== "nemoclaw-managed") return;
  input.revalidatePolicyAuthority(
    `carrying forward managed policy presets for sandbox '${input.sandboxName}'`,
  );
  applyRecreatePolicyCarryForward(
    input.sandboxName,
    input.nonInteractive,
    input.note,
    input.rebuildPolicyPresets,
  );
}

/** Reseed an outer rebuild after its owned delete leaves no live source branch. */
export function applyAbsentSandboxRebuildPolicyCarryForward(
  input: {
    readonly sandboxName: string;
    readonly liveExists: boolean;
    readonly policyAuthority: "nemoclaw-managed" | "externally-managed";
    readonly nonInteractive: boolean;
    readonly note: (message: string) => void;
    readonly rebuildPolicyPresets?: readonly string[];
    readonly revalidatePolicyAuthority: (operation: string) => void;
  },
  applyRecreatePolicyCarryForward: ApplyRecreatePolicyCarryForward,
): void {
  if (input.liveExists || !Array.isArray(input.rebuildPolicyPresets)) return;
  applyManagedSandboxRebuildPolicyCarryForward(input, applyRecreatePolicyCarryForward);
}

async function validatePortableManagedWorkloadSelection(input: {
  readonly portableLifecycle: boolean;
  readonly selectionNeedsValidation: boolean;
  readonly prepareWorkload: () => Promise<unknown>;
}): Promise<void> {
  if (!input.portableLifecycle || !input.selectionNeedsValidation) return;
  await input.prepareWorkload();
}

export function proveRecreateSourceBeforePolicyCarryForward<T>(input: {
  readonly createRecreateRuntime: () => T;
  readonly carryForward: () => void;
}): T {
  const runtime = input.createRecreateRuntime();
  input.carryForward();
  return runtime;
}

type ProviderPreparationInput = Parameters<
  typeof validateAttachedMessagingProvidersBeforeSandboxCreation
>[0];
type ProviderPreparationDeps = Parameters<
  typeof validateAttachedMessagingProvidersBeforeSandboxCreation
>[1];

type ProviderEffectBoundary = {
  readonly validateBeforeCreate: () => void;
  readonly publishBeforeCreate: () => void;
  readonly runAfterVerifiedCreate:
    | ((context: VerifiedSandboxCreateEffectsContext) => Promise<void>)
    | undefined;
};

export function createProviderEffectBoundary(input: {
  readonly deferred: boolean;
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly preparationInput: ProviderPreparationInput;
  readonly preparationDeps: ProviderPreparationDeps;
  readonly runVerifiedSandboxCreateEffects: import("../types").VerifiedSandboxCreateEffects | null;
  readonly activateDeferredProviderEffects:
    | ((revalidatePolicyRequirements: (operation: string) => void) => readonly string[])
    | null;
  readonly revalidatePolicyAuthorityBeforeCreate: () => void;
}): ProviderEffectBoundary {
  const validate = () =>
    validateAttachedMessagingProvidersBeforeSandboxCreation(
      input.preparationInput,
      input.preparationDeps,
    );
  const publish = () =>
    publishAttachedProvidersBeforeDockerSandboxCreation(
      input.preparationInput,
      input.preparationDeps,
    );
  if (!input.deferred) {
    return {
      validateBeforeCreate: validate,
      publishBeforeCreate: () => {
        input.revalidatePolicyAuthorityBeforeCreate();
        publish();
      },
      runAfterVerifiedCreate: undefined,
    };
  }
  return {
    validateBeforeCreate: () => undefined,
    publishBeforeCreate: () => undefined,
    runAfterVerifiedCreate: async (context) => {
      context.revalidatePolicyRequirements(
        `starting deferred provider effects for sandbox '${input.sandboxName}'`,
      );
      await input.runVerifiedSandboxCreateEffects?.(context);
      context.revalidatePolicyRequirements(
        `activating deferred providers for sandbox '${input.sandboxName}'`,
      );
      const providerNames =
        input.activateDeferredProviderEffects?.(context.revalidatePolicyRequirements) ?? [];
      validate();
      context.revalidatePolicyRequirements(
        `publishing deferred providers for sandbox '${input.sandboxName}'`,
      );
      publish();
      context.revalidatePolicyRequirements(
        `attaching deferred providers to sandbox '${input.sandboxName}'`,
      );
      attachProvidersAfterSandboxCreation({
        sandboxName: input.sandboxName,
        gatewayName: input.gatewayName,
        providerNames,
      });
    },
  };
}

type SandboxProviderCleanupAuthority =
  | {
      readonly revalidateSandboxIdentity: (operation: string) => void;
    }
  | {
      readonly observeSandbox: () => ReturnType<
        SandboxCreateOrchestrationRuntime["getSandboxRecreateObservation"]
      >;
      readonly revalidatePolicyAuthority: (operation: string) => void;
    };

export function runAuthorityBoundProviderCleanup(
  input: {
    readonly sandboxName: string;
    readonly runProviderPreDeleteCleanup: SandboxCreateOrchestrationRuntime["runSandboxProviderPreDeleteCleanup"];
    readonly runOpenshell: SandboxCreateOrchestrationRuntime["runOpenshell"];
    readonly redact: SandboxCreateOrchestrationRuntime["redact"];
    readonly tolerateMissingSandbox?: boolean;
  } & SandboxProviderCleanupAuthority,
): void {
  const revalidateSandboxIdentity =
    "observeSandbox" in input
      ? (operation: string): void => {
          if (input.observeSandbox().state !== "missing") {
            throw new Error(
              `Cannot clean up providers for sandbox '${input.sandboxName}': a sandbox with that name appeared after absence was verified while ${operation}.`,
            );
          }
          input.revalidatePolicyAuthority(operation);
        }
      : input.revalidateSandboxIdentity;
  revalidateSandboxIdentity(`cleaning up providers for sandbox '${input.sandboxName}'`);
  input.runProviderPreDeleteCleanup(input.sandboxName, {
    runOpenshell: input.runOpenshell,
    redact: input.redact,
    ...(input.tolerateMissingSandbox ? { tolerateMissingSandbox: true } : {}),
    revalidateSandboxIdentity,
  });
}

export function readSandboxRecreateRegistryEntry(input: {
  readonly sandboxName: string;
  readonly recreateTransaction: boolean;
  readonly existingEntry: SandboxEntry | null;
  readonly readRegistry: (sandboxName: string) => SandboxEntry | null;
}): SandboxEntry | null {
  if (!input.recreateTransaction) return input.existingEntry;
  return input.readRegistry(input.sandboxName);
}

function pendingVerifiedCreateCheckpointForSession(input: {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly liveExists: boolean;
  readonly entry: SandboxEntry | null;
  readonly session: Session | null;
  readonly request: SandboxCreateIntent["recreateTransaction"];
}): PendingSandboxPolicyVerification | null {
  const checkpoint = input.entry?.pendingPolicyVerification;
  if (
    !checkpoint ||
    input.entry?.pendingRouteReservation !== true ||
    !input.liveExists ||
    !input.session ||
    !input.request ||
    input.entry.reservationSessionId !== input.session.sessionId
  ) {
    return null;
  }
  const transaction = input.session.checkpoint?.sandboxRecreate;
  if (
    !transaction ||
    transaction.id !== input.request.id ||
    transaction.sandboxName !== input.sandboxName ||
    transaction.gatewayName !== input.gatewayName ||
    transaction.targetIntentFingerprint !== input.request.targetIntentFingerprint ||
    transaction.targetGeneration !== input.request.targetGeneration ||
    transaction.phase !== "created" ||
    transaction.targetLiveIdentityFingerprint !== checkpoint.sandboxIdentityFingerprint ||
    transaction.targetGeneration !== checkpoint.lifecycleGeneration ||
    checkpoint.sandboxName !== input.sandboxName ||
    checkpoint.gatewayName !== input.gatewayName ||
    input.entry.gatewayName !== checkpoint.gatewayName ||
    input.entry.gatewayPort !== checkpoint.gatewayPort ||
    input.entry.lifecycleGeneration !== checkpoint.lifecycleGeneration ||
    input.entry.lifecycleLiveIdentityFingerprint !== checkpoint.sandboxIdentityFingerprint
  ) {
    throw new Error(
      `Cannot resume sandbox '${input.sandboxName}' because its verified create checkpoint and lifecycle journal disagree.`,
    );
  }
  return checkpoint;
}

function readAcceptedPendingVerifiedCreate(input: {
  readonly acceptedTarget: boolean;
  readonly openingCheckpoint: PendingSandboxPolicyVerification | null;
  readonly sandboxName: string;
  readonly readEntry: () => SandboxEntry | null;
}): PendingSandboxPolicyVerification | null {
  const entry = input.acceptedTarget ? input.readEntry() : null;
  const checkpoint =
    entry?.pendingRouteReservation === true ? (entry.pendingPolicyVerification ?? null) : null;
  if (input.openingCheckpoint && !isDeepStrictEqual(checkpoint, input.openingCheckpoint)) {
    throw new Error(
      `Cannot resume sandbox '${input.sandboxName}' because its verified create checkpoint changed during recovery.`,
    );
  }
  return checkpoint;
}

function runForNewSandboxCreate(resuming: boolean, operation: () => void): void {
  if (!resuming) operation();
}

function assertCreateLifecycleJournal(input: {
  readonly portableLifecycle: boolean;
  readonly runtimeGeneration: string | null;
  readonly createdGeneration: string;
  readonly sandboxName: string;
}): void {
  if (!input.portableLifecycle && input.runtimeGeneration !== input.createdGeneration) {
    throw new Error(
      `Cannot create sandbox '${input.sandboxName}' without an active lifecycle journal.`,
    );
  }
}

function shouldInspectExistingSandbox(input: {
  readonly liveExists: boolean;
  readonly portableLifecycle: boolean;
  readonly resumingVerifiedCreate: boolean;
}): boolean {
  return input.liveExists && !input.portableLifecycle && !input.resumingVerifiedCreate;
}

type PortableAgentReceiptGenerationObservation =
  | { readonly kind: "absent" | "openclaw" }
  | {
      readonly kind: "hermes";
      readonly gatewayName: string;
      readonly lifecycleGeneration: string;
    };

function readHermesPortableLifecycleGeneration(input: {
  readonly enabled: boolean;
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly inspect: (sandboxName: string) => PortableAgentReceiptGenerationObservation;
}): string | undefined {
  if (!input.enabled) return undefined;
  const receipt = input.inspect(input.sandboxName);
  return receipt.kind === "hermes" && receipt.gatewayName === input.gatewayName
    ? receipt.lifecycleGeneration
    : undefined;
}

export function createSandboxWithBaseImageResolution(runtime: SandboxCreateOrchestrationRuntime) {
  const postCreateRecoveryRetryOwner = installPostCreateRecoveryRetryOwner();
  return async function createSandboxWithBaseImageResolution(
    baseImageResolutionContext: import("../base-image-resolution-flow").BaseImageResolutionContext,
    portableRuntimeContext: PortableOnboardRuntimeContext | null,
    computePlan: import("../compute/plan").OpenShellComputePlan,
    managedWorkloadRebuild: import("../workload/rebuild").ManagedWorkloadRebuildHandoff | null,
    tempManagedRuntime: boolean,
    tempManagedRuntimeCatalog: string | null,
    dashboardPortReservationScope: import("../dashboard-port").DashboardPortReservationScope,
    hermesApiPortReservationScope: import("../../agent/onboard").HermesApiPortReservationScope,
    gpu: ReturnType<typeof import("../../inference/nim").detectGpu>,
    model: string,
    provider: string,
    preferredInferenceApi: string | null = null,
    sandboxNameOverride: string | null = null,
    webSearchConfig: WebSearchConfig | null = null,
    enabledChannels: string[] | null = null,
    fromDockerfile: string | null = null,
    agent: AgentDefinition | null = null,
    controlUiPort: number | null = null,
    sandboxGpuConfig: SandboxGpuConfig | null = null,
    resourceProfile: import("../../resources-cmd").ResourceProfile | null = null,
    hermesToolGateways: string[] = [],
    hermesAuthMethod: HermesAuthMethod | null = null,
    inferenceRouteReservationAuthority: InferenceRouteReservationAuthority | null = null,
    createIntent: import("../types").SandboxCreateIntent | null = null,
    runVerifiedSandboxCreateEffects: import("../types").VerifiedSandboxCreateEffects | null = null,
    preparedBuildContext: PreparedSandboxBuildContext | null = null,
  ) {
    const portableRuntimeAuthority = portableRuntimeContext?.authority ?? null;
    const {
      DASHBOARD_PORT,
      GATEWAY_NAME,
      GATEWAY_PORT,
      ROOT,
      SCRIPTS,
      agentDefs,
      agentOnboard,
      applyExtraProviderReconciliation,
      assessHost,
      baseImageResolutionFlow,
      cliDisplayName,
      cliName,
      completeOrdinaryOnboardSandboxCreation,
      confirmRecreateForSelectionDrift,
      createOnboardCreatedSandboxCompletion,
      createOnboardCreatedSandboxRegistration,
      createSandboxRecreateProtection,
      dashboardRuntime,
      dcodeAutoApprovalFlow,
      detectMessagingCredentialRotation,
      ensureAgentFixedForward,
      ensureDashboardForward,
      filterEnabledChannelsByAgent,
      formatSandboxAgentName,
      formatSandboxBuildEstimateNote,
      getDashboardForwardPort,
      readDcodeSelectionDrift,
      getDefaultSandboxNameForAgent,
      getDockerDriverGatewayStateDir,
      getHermesToolGatewayBroker,
      getRequestedSandboxAgentName,
      getSandboxAgentDrift,
      getSandboxRecreateObservation,
      getSandboxReuseState,
      getSandboxRuntimeRegistryFields,
      getSelectionDrift,
      hasSandboxGpuDrift,
      inferenceConfig,
      inspectSandboxForCreate,
      isLinuxDockerDriverGatewayEnabled,
      isNonInteractive,
      isRecreateSandbox,
      isWsl,
      managedWorkloadOnboard,
      messagingChannelSetup,
      nim,
      normalizeHermesAuthMethod,
      normalizeHermesToolGatewaySelections,
      note,
      observabilityCommandFlag,
      observabilityPolicy,
      onboardHermesDashboard,
      onboardSession,
      onboardSessionBootstrap,
      openshellArgv,
      path,
      planRegisteredExtraProviders,
      policyPresetCarry,
      preparedDcodeRebuild,
      promptValidatedSandboxName,
      promptYesNoOrDefault,
      providerExistsInGateway,
      recreateJournal,
      registry,
      requiresSelectionRecreate,
      reserveCreateSandboxDashboardPort,
      resolveSandboxGpuConfig,
      runCaptureOpenshell,
      runOpenshell,
      runSandboxProviderPreDeleteCleanup,
      sandboxAgent,
      sandboxBuildPatchConfig,
      sandboxCancelRollback,
      sandboxCreateIntentResolver,
      sandboxGpuCreateFlow,
      sandboxLifecycle,
      sandboxMutationLock,
      sandboxRecreateTransaction,
      sandboxRegistration,
      sandboxRegistryMetadata,
      sandboxReuse,
      shouldSkipPreRecreateBackup,
      sleepSeconds,
      step,
      stringSetsEqual,
      toolDisclosureFlow,
      upsertMessagingProviders,
      usesManagedDcodeIdentity,
      validateName,
      verifyDirectSandboxGpu,
      waitForSandboxRecreateDeleteAbsence,
      wasSandboxDefault,
      updateReusedSandboxMetadata,
      getSandboxInferenceConfig,
      redact,
      openshellShellCommand,
      discloseInitialSandboxPolicy,
      compactText,
      runFile,
      dockerInfoFormat,
      runCapture,
    } = runtime;

    assertApfCreateIntent(createIntent);
    assertProviderlessApfCreateInput({
      createIntent,
      agent,
      model,
      provider,
      preferredInferenceApi,
      webSearchConfig,
      enabledChannels,
      hermesToolGateways,
    });
    assertProviderlessInterceptorEnvironment(
      createIntent?.apfInterceptorRequested === true,
      process.env,
    );
    step(6, 8, "Creating sandbox");
    const sandboxName = validateName(
      sandboxNameOverride ?? (await promptValidatedSandboxName(agent)),
      "sandbox name",
    );
    preparedDcodeRebuild.assertPreparedDcodeTarget(preparedBuildContext, agent, fromDockerfile);
    const effectiveAgent = sandboxAgent.getEffectiveSandboxAgent(agent);
    const requestedAgentName = getRequestedSandboxAgentName(effectiveAgent);
    const legacyDockerfilePath =
      effectiveAgent.dockerfilePath ??
      effectiveAgent.legacyPaths?.dockerfile ??
      path.join(ROOT, "Dockerfile");
    enabledChannels = filterEnabledChannelsByAgent(enabledChannels, agent);
    const effectiveSandboxGpuConfig =
      sandboxGpuConfig ?? resolveSandboxGpuConfig(gpu, { flag: null, device: null });
    const agentCreateInput = sandboxGpuCreateFlow.resolveAgentCreateInput(
      agent,
      isLinuxDockerDriverGatewayEnabled(),
    );
    const preparedCreateIntent = await sandboxCreateIntentResolver.resolvePortableLifecycle(
      {
        sandboxName,
        inferenceProvider: provider,
        enabledChannels,
        webSearchConfig,
        agent,
        sandboxGpuConfig: effectiveSandboxGpuConfig,
        resourceProfile,
        hermesToolGateways,
        baselineExclusions: sandboxRegistration.baselineExclusionsForCreate(sandboxName),
        ...(createIntent?.reuseRegisteredCredentials ? { reuseRegisteredCredentials: true } : {}),
        ...(createIntent?.policyTier !== undefined ? { policyTier: createIntent.policyTier } : {}),
      },
      {
        hermesPortable: agentCreateInput.hermesPortableLifecycle,
        requestedExtraProviders: createIntent?.extraProviders,
        resolvedIntent: createIntent?.resolved,
        planOrdinaryExtraProviders: () =>
          planRegisteredExtraProviders(GATEWAY_NAME, { runOpenshell }),
      },
    );
    const resolvedCreateIntent = preparedCreateIntent.intent;
    const policyRequirementIntent: typeof resolvedCreateIntent = {
      ...resolvedCreateIntent,
      policy: {
        ...resolvedCreateIntent.policy,
        options: {
          ...resolvedCreateIntent.policy.options,
          additionalPresets: policyAuthorityPreflight.requiredOnboardPolicyPresets({
            additionalPresets: resolvedCreateIntent.policy.options.additionalPresets,
            provider,
            webSearchConfig,
            agentName: agent?.name,
            observabilityEnabled: createIntent?.observabilityEnabled === true,
            hostLocalInferenceRouteOnly:
              resolvedCreateIntent.policy.options.hostLocalInferenceRouteOnly,
          }),
        },
      },
    };
    const messagingCapabilities = preparedCreateIntent.messagingCapabilities;
    const manageDashboard = sandboxGpuCreateFlow.shouldManageHermesPortableDashboard(
      dashboardRuntime.shouldManageDashboardForAgent(agent),
      agent,
    );
    const isManagedDcodeAgent = usesManagedDcodeIdentity(agent?.name, fromDockerfile);
    let effectivePort = 0,
      chatUiUrl = "",
      hermesApiPortReservationInput = {
        agentName: agent?.name,
        sandboxName,
        env: process.env,
        getSandbox: registry.getSandbox,
        captureForwardList: () => runCaptureOpenshell(["forward", "list"], { ignoreError: true }),
        warn: (message: string) => console.warn(message),
      };
    if (manageDashboard) {
      const dashboardSelection = await reserveCreateSandboxDashboardPort({
        sandboxName,
        controlUiPort,
        chatUiUrlEnv: process.env.CHAT_UI_URL,
        persistedPort: registry.getSandbox(sandboxName)?.dashboardPort ?? null,
        agentForwardPort: dashboardRuntime.getAgentPrimaryForwardPort(agent, DASHBOARD_PORT),
        defaultPort: DASHBOARD_PORT,
        forwardListOutput: runCaptureOpenshell(["forward", "list"], { ignoreError: true }),
        warn: (message: string) => console.warn(message),
      });
      ({ effectivePort, chatUiUrl } = dashboardSelection);
      dashboardPortReservationScope.current = dashboardSelection.reservation;
    }
    const hermesDashboardForwarding = onboardHermesDashboard.createHermesDashboardOnboardForwarding(
      {
        agentName: agent?.name,
        env: process.env,
        ensureForward: ensureAgentFixedForward,
        note,
        runOpenshell,
        getApiForwardPort: () => getDashboardForwardPort(chatUiUrl),
      },
    );
    const hermesDashboardState = hermesDashboardForwarding.resolveStateForPort(effectivePort);
    const { messagingTokenDefs, hasMessagingTokens } = messagingCapabilities;

    const {
      existingEntry,
      preservedMcpState,
      liveExists,
      effectiveToolDisclosure,
      toolDisclosureMigrationNeeded,
      toolDisclosureMigrationNote,
    } = agentCreateInput.hermesPortableLifecycle
      ? toolDisclosureFlow.prepareHermesPortableToolDisclosure(createIntent?.toolDisclosure ?? null)
      : toolDisclosureFlow.prepareSandboxToolDisclosure(
          sandboxName,
          preparedBuildContext?.rebuildTarget?.fromDockerfile
            ? preparedBuildContext.stagedDockerfile
            : fromDockerfile,
          isRecreateSandbox(createIntent?.recreate),
          inspectSandboxForCreate,
          createIntent?.toolDisclosure ?? null,
        );
    const observabilityDrift = observabilityPolicy.hasRegisteredDcodeObservabilityDrift(
      liveExists,
      isManagedDcodeAgent,
      existingEntry,
      createIntent?.observabilityEnabled,
    );
    const dcodeAutoApprovalPlan = dcodeAutoApprovalFlow.prepareDcodeAutoApprovalCreatePlan(
      {
        sandboxName,
        liveExists,
        managedDcodeAgent: isManagedDcodeAgent,
        registryEntry: existingEntry,
        requestedMode: createIntent?.dcodeAutoApprovalMode,
      },
      { error: console.error, exitProcess: (code) => process.exit(code) },
    );
    const envMessagingState =
      messagingChannelSetup.MessagingHostStateApplier.readPlanStateFromEnv();
    const plannedMessagingState =
      envMessagingState?.plan.sandboxName === sandboxName ? envMessagingState : undefined;
    const managedWorkloadRuntime = managedWorkloadOnboard.createManagedWorkloadOnboardRuntime(
      {
        computePlan,
        managedWorkloadRebuild,
        tempManagedRuntime,
        stockManagedRuntime: managedWorkloadOnboard.shouldActivateStockManagedRuntime({
          portableLifecycle: sandboxGpuCreateFlow.resolvePortableLifecycleMode(agent),
          hermesPortableLifecycle: agentCreateInput.hermesPortableLifecycle,
          agentName: requestedAgentName,
        }),
        tempManagedRuntimeCatalog,
        agentName: requestedAgentName,
        legacyDockerfilePath,
        customDockerfilePath:
          fromDockerfile ?? (preparedBuildContext ? preparedBuildContext.stagedDockerfile : null),
        rootDir: ROOT,
        model,
        provider,
        preferredInferenceApi,
        endpointUrl: createIntent?.endpointUrl ?? null,
        startupProfile: {
          chatUiUrl,
          effectiveDashboardPort: effectivePort,
          manageDashboard,
          dashboardBindAddress: process.env.NEMOCLAW_DASHBOARD_BIND,
          wslExposure: requestedAgentName === "openclaw" && isWsl(),
          hermesDashboardState,
          webSearch: webSearchConfig,
          toolDisclosure: effectiveToolDisclosure,
          hermesToolGateways,
          messagingPlan: plannedMessagingState?.plan ?? null,
          dcodeAutoApprovalMode: dcodeAutoApprovalPlan.mode,
          observabilityEnabled: createIntent?.observabilityEnabled === true,
          environment: process.env,
        },
        note,
        fallbackBuildEstimate: () =>
          process.env.NEMOCLAW_IGNORE_RUNTIME_RESOURCES === "1"
            ? null
            : formatSandboxBuildEstimateNote(assessHost()),
      },
      {
        resolveAgentInferenceApi: inferenceConfig.resolveAgentInferenceApi,
        getSandboxInferenceConfig,
      },
    );
    const ensurePreparedSandboxWorkload = () =>
      agentCreateInput.hermesPortableLifecycle
        ? managedWorkloadOnboard.prepareHermesPortableSandboxWorkloadForLifecycle(
            managedWorkloadRuntime,
            legacyDockerfilePath,
          )
        : managedWorkloadOnboard.prepareSandboxWorkloadForPortableLifecycle(
            managedWorkloadRuntime,
            sandboxGpuCreateFlow.resolvePortableLifecycleMode(agent),
          );
    const prepareHermesStateVolumeLifecycle = (
      workload: Awaited<ReturnType<typeof ensurePreparedSandboxWorkload>>,
    ) =>
      managedWorkloadOnboard.createManagedHermesStateVolumeOnboardLifecycle({
        agentName: requestedAgentName,
        runtimeProvider: managedWorkloadRuntime.runtimeProvider,
        sandboxName,
        workloadKind: workload.source.kind,
      });
    const finalizeRecreatedSourceHermesVolume = (
      sourceConfirmedAbsent: boolean,
      sourceEntry: SandboxEntry | null,
      targetKeepsManagedHermesStateVolume: boolean,
    ) =>
      finalizeRecreatedSourceHermesStateVolume(
        {
          sandboxName,
          sourceConfirmedAbsent,
          sourceEntry,
          targetKeepsManagedHermesStateVolume,
        },
        {
          normalizeRuntimeProviderIdentity: managedWorkloadOnboard.normalizeRuntimeProviderIdentity,
          removeManagedHermesStateVolume: managedWorkloadOnboard.removeManagedHermesStateVolume,
          removeSourceRegistryEntry: sandboxLifecycle.removeSandboxUnlessSessionReservation,
          note,
          warn: (message) => console.warn(message),
          redact,
        },
      );
    await validatePortableManagedWorkloadSelection({
      portableLifecycle: agentCreateInput.portableLifecycle,
      selectionNeedsValidation: tempManagedRuntime || managedWorkloadRebuild !== null,
      prepareWorkload: ensurePreparedSandboxWorkload,
    });
    const apfInterceptorRequested = createIntent?.apfInterceptorRequested === true;
    let verifiedPolicyGate: EffectiveVerifiedSandboxPolicyBoundary | null = null;
    let pendingPolicyVerification: PendingSandboxPolicyVerification | null = null;
    let admittedCreateReservation: QualifiedPendingSandboxCreateReservation | null = null;
    let verifiedPolicyRegistrationFinalized = false;
    const policyAuthoritySession = onboardSession.loadSession();
    const sessionPolicyAuthority = policyAuthoritySession?.policyAuthority ?? null;
    const currentSessionId = policyAuthoritySession?.sessionId ?? null;
    const openingPendingPolicyVerification = pendingVerifiedCreateCheckpointForSession({
      sandboxName,
      gatewayName: GATEWAY_NAME,
      liveExists,
      entry: existingEntry,
      session: policyAuthoritySession,
      request: createIntent?.recreateTransaction,
    });
    const qualifyPolicyAuthority = (
      sandboxIsLive = liveExists,
      operation = `prepare sandbox '${sandboxName}'`,
    ) => {
      const recordedSandbox = sandboxIsLive ? registry.getSandbox(sandboxName) : existingEntry;
      return policyAuthorityPreflight.qualifySandboxPolicyAuthority({
        sandboxName,
        gatewayName: GATEWAY_NAME,
        liveExists: sandboxIsLive,
        recordedAuthorities: [existingEntry?.policyAuthority, sessionPolicyAuthority],
        recordedSandbox,
        readRecordedSandbox: registry.getSandbox,
        currentSessionId,
        prepareRequiredPolicy: () =>
          sandboxCreatePlanMaterialization.prepareSandboxCreatePolicy(policyRequirementIntent)
            .initialSandboxPolicy,
        operation,
      });
    };
    const initialPolicyAuthority =
      openingPendingPolicyVerification?.policyAuthority ?? qualifyPolicyAuthority().authority;
    const resolvedPolicyAuthority = resolveSandboxCreatePolicyAuthority(
      initialPolicyAuthority,
      apfInterceptorRequested,
    );
    const revalidatePolicyAuthority = (sandboxIsLive: boolean, operation: string): void => {
      if (
        sandboxIsLive &&
        !verifiedPolicyRegistrationFinalized &&
        (openingPendingPolicyVerification || apfInterceptorRequested)
      ) {
        revalidateVerifiedPolicyRegistration(requireVerifiedPolicyGate(), operation);
        return;
      }
      const inspection = qualifyPolicyAuthority(sandboxIsLive, operation);
      if (apfInterceptorRequested) {
        if (sandboxIsLive) {
          assertRecordedPolicyAuthority("externally-managed", inspection.authority, operation);
        } else {
          resolveSandboxCreatePolicyAuthority(inspection.authority, true);
        }
        return;
      }
      assertRecordedPolicyAuthority(resolvedPolicyAuthority, inspection.authority, operation);
    };
    assertHermesPortablePolicyAuthority(
      agentCreateInput.hermesPortableLifecycle,
      resolvedPolicyAuthority,
    );
    runForNewSandboxCreate(Boolean(openingPendingPolicyVerification), () => {
      backfillVerifiedExternalSandboxPolicyAuthority({
        sandboxName,
        existingEntry,
        policyAuthority: resolvedPolicyAuthority,
        updateSandbox: registry.updateSandbox,
      });
    });
    onboardSession.updateSession((session) => {
      session.policyAuthority =
        resolvedPolicyAuthority === "externally-managed" && !apfInterceptorRequested
          ? "externally-managed"
          : null;
      if (session.policyAuthority === "externally-managed") session.policyPresets = null;
    });
    const recreateRegistryEntry = readSandboxRecreateRegistryEntry({
      sandboxName,
      recreateTransaction: Boolean(createIntent?.recreateTransaction),
      existingEntry,
      readRegistry: registry.getSandbox,
    });
    // Prove the preserved source row before replacing its stale preset list.
    // Policy carry-forward is an owned post-delete mutation, but applying it
    // before recreate recovery makes the journal correctly reject that row as
    // changed before the replacement can be created.
    let recreateRuntime:
      | import("../sandbox-recreate-transaction").SandboxRecreateRuntime
      | OwnedSandboxRecreateRuntime = proveRecreateSourceBeforePolicyCarryForward({
      createRecreateRuntime: () =>
        sandboxRecreateTransaction.createSandboxRecreateRuntime(
          onboardSession,
          createIntent?.recreateTransaction,
          sandboxName,
          GATEWAY_NAME,
          recreateRegistryEntry,
          getSandboxRecreateObservation,
          note,
        ),
      carryForward: () =>
        applyAbsentSandboxRebuildPolicyCarryForward(
          {
            sandboxName,
            liveExists,
            policyAuthority: resolvedPolicyAuthority,
            nonInteractive: isNonInteractive(),
            note,
            rebuildPolicyPresets: createIntent?.rebuildPolicyPresets,
            revalidatePolicyAuthority: (operation) => revalidatePolicyAuthority(false, operation),
          },
          policyPresetCarry.applyRecreatePolicyCarryForward,
        ),
    });
    const acceptedTargetPendingCheckpoint = readAcceptedPendingVerifiedCreate({
      acceptedTarget: recreateRuntime.acceptedTarget,
      openingCheckpoint: openingPendingPolicyVerification,
      sandboxName,
      readEntry: () => registry.getSandbox(sandboxName),
    });
    const resumingVerifiedCreate = acceptedTargetPendingCheckpoint !== null;
    const restoreReusedSandboxDashboard = async (selectionVerified: boolean): Promise<void> => {
      ({ chatUiUrl } = await sandboxReuse.restoreReusedSandboxDashboardState({
        sandboxName,
        chatUiUrl,
        env: process.env,
        agent,
        model,
        provider,
        selectionVerified,
        sandboxGpuConfig: effectiveSandboxGpuConfig,
        gatewayName: GATEWAY_NAME,
        gatewayPort: GATEWAY_PORT,
        manageDashboard,
        ensureDashboardForward,
        hermesDashboardForwarding,
        updateReusedSandboxMetadata,
        releaseDashboardPort: dashboardPortReservationScope.release,
        revalidatePolicyRequirements: (operation) => revalidatePolicyAuthority(true, operation),
      }));
    };
    if (recreateRuntime.acceptedTarget && !resumingVerifiedCreate) {
      await restoreReusedSandboxDashboard(true);
      return sandboxName;
    }
    // #4614: capture default AFTER prune so a stale registry row isn't read as a live sandbox.
    const sandboxWasLiveDefault =
      liveExists && wasSandboxDefault(registry.getDefault(), sandboxName);

    let pendingStateRestore: BackupResult | null = null;
    let notReadyRecreateInProgress = false;
    const customOpenClawImage =
      Boolean(fromDockerfile) && getRequestedSandboxAgentName(agent) === "openclaw";
    const recreateProtection = createSandboxRecreateProtection({
      sandboxName,
      sandboxEntry: existingEntry,
      customOpenClawImage,
      note,
    });
    const openRecreateJournal = (): OwnedSandboxRecreateRuntime =>
      recreateJournal.openOnboardRecreateJournal({
        target: { sandboxName, gatewayName: GATEWAY_NAME, gatewayPort: GATEWAY_PORT },
        agentName: getRequestedSandboxAgentName(agent) || "openclaw",
        note,
        observe: (probeTarget) =>
          getSandboxRecreateObservation(probeTarget.sandboxName, probeTarget.gatewayName),
        intent: {
          agent: getRequestedSandboxAgentName(agent) || null,
          fromDockerfile: fromDockerfile ?? null,
          provider: provider ?? null,
          model: model ?? null,
          preferredInferenceApi: preferredInferenceApi ?? null,
          sandboxGpuConfig: effectiveSandboxGpuConfig ?? null,
          gatewayName: GATEWAY_NAME,
          gatewayPort: GATEWAY_PORT,
          toolDisclosure: effectiveToolDisclosure,
          dcodeAutoApprovalMode: createIntent?.dcodeAutoApprovalMode ?? null,
          observabilityEnabled: createIntent?.observabilityEnabled === true,
          policyTier: createIntent?.policyTier ?? null,
        },
      });
    let pendingStateRestoreBackupPath: string | null = null,
      preparedSandboxWorkload!: Awaited<ReturnType<typeof ensurePreparedSandboxWorkload>>,
      hermesStateVolumeLifecycle!: ReturnType<typeof prepareHermesStateVolumeLifecycle>;
    if (!liveExists && existingEntry)
      ({ runtime: recreateRuntime, backupPath: pendingStateRestoreBackupPath } =
        recreateProtection.selectJournalBoundPreUpgradeBackup({
          runtime: recreateRuntime,
          openJournal: createIntent?.recreateTransaction ? null : openRecreateJournal,
          gatewayName: GATEWAY_NAME,
          gatewayPort: GATEWAY_PORT,
          readRegistryEntry: () => registry.getSandbox(sandboxName),
          observe: () => getSandboxRecreateObservation(sandboxName, GATEWAY_NAME),
        }));

    if (
      shouldInspectExistingSandbox({
        liveExists,
        portableLifecycle: agentCreateInput.hermesPortableLifecycle,
        resumingVerifiedCreate,
      })
    ) {
      const existingSandboxState = getSandboxReuseState(sandboxName);
      const agentDrift = getSandboxAgentDrift(sandboxName, requestedAgentName);
      let recreateForAgentDrift = agentDrift.changed && isRecreateSandbox(createIntent?.recreate);

      if (agentDrift.changed && !isRecreateSandbox(createIntent?.recreate)) {
        console.log(
          `  Sandbox '${sandboxName}' already exists as ${formatSandboxAgentName(agentDrift.existingAgentName)}.`,
        );
        console.log(
          `  ${cliDisplayName()} is onboarding ${formatSandboxAgentName(agentDrift.requestedAgentName)} for this sandbox name.`,
        );
        console.log(
          "  Side-by-side agents are supported, but each sandbox name has one agent type.",
        );
        if (isNonInteractive()) {
          console.error(
            `  Aborting: choose a different name or set NEMOCLAW_RECREATE_SANDBOX=1 to recreate '${sandboxName}'.`,
          );
          console.error(
            `  Example: ${cliName()} onboard --name ${getDefaultSandboxNameForAgent(agent)}`,
          );
          process.exit(1);
        }
        if (
          await promptYesNoOrDefault(
            `  Delete and recreate '${sandboxName}' as ${formatSandboxAgentName(agentDrift.requestedAgentName)}?`,
            null,
            false,
          )
        ) {
          recreateForAgentDrift = true;
        } else {
          console.error("  Aborted. Existing sandbox left unchanged.");
          console.error(
            `  Re-run with a different name, for example: ${cliName()} onboard --name ${getDefaultSandboxNameForAgent(agent)}`,
          );
          process.exit(1);
        }
      }

      // Check whether messaging providers are missing from the gateway. Only
      // force recreation when at least one required provider doesn't exist yet —
      // this avoids destroying sandboxes already created with provider attachments.
      const needsProviderMigration =
        hasMessagingTokens &&
        messagingTokenDefs.some(({ name, token }) => token && !providerExistsInGateway(name));
      const selectionDrift = isManagedDcodeAgent
        ? readManagedDcodeCreateSelectionDrift(
            { sandboxName, provider, model, preferredInferenceApi, createIntent },
            readDcodeSelectionDrift,
          )
        : getSelectionDrift(sandboxName, provider, model, { runOpenshell });
      const actionableSelectionDrift = requiresSelectionRecreate(
        selectionDrift,
        isManagedDcodeAgent,
      );
      const sandboxGpuDrift = hasSandboxGpuDrift(sandboxName, effectiveSandboxGpuConfig);
      const existingSandboxEntry = registry.getSandbox(sandboxName);
      const recordedHermesToolGateways = normalizeHermesToolGatewaySelections(
        existingSandboxEntry?.hermesToolGateways,
      );
      const hermesToolGatewayDrift = !stringSetsEqual(
        recordedHermesToolGateways,
        hermesToolGateways,
      );
      const hermesDashboardDrift = onboardHermesDashboard.hasHermesDashboardDrift({
        agentName: agent?.name,
        existing: existingSandboxEntry,
        state: hermesDashboardState,
      });

      // Detect whether any messaging credential has been rotated since the
      // sandbox was created. Provider credentials are resolved once at sandbox
      // startup, so a rotated token requires a rebuild to take effect.
      const credentialRotation = hasMessagingTokens
        ? detectMessagingCredentialRotation(sandboxName, messagingTokenDefs)
        : { changed: false, changedProviders: [] };

      if (
        !isRecreateSandbox(createIntent?.recreate) &&
        !recreateForAgentDrift &&
        !needsProviderMigration &&
        !sandboxGpuDrift &&
        !credentialRotation.changed &&
        !hermesToolGatewayDrift &&
        !hermesDashboardDrift &&
        !toolDisclosureMigrationNeeded &&
        !observabilityDrift &&
        !dcodeAutoApprovalPlan.hasDrift
      ) {
        // Guard against reusing a CPU-only sandbox when GPU passthrough is enabled.
        // Placed before the non-interactive / interactive split so all reuse
        // paths are covered (interactive prompt, non-interactive ready, unknown drift).
        // Note: legacy registries had gpuEnabled always true (bug fixed in this PR),
        // so gpuEnabled=true on a legacy entry doesn't guarantee GPU support.
        // The gateway Docker-inspect check (above) catches legacy CPU-only gateways
        // before we reach this point, so a legacy sandbox behind a verified GPU
        // gateway is safe to reuse — the sandbox will be recreated if needed.
        if (effectiveSandboxGpuConfig.sandboxGpuEnabled) {
          const entry = registry.getSandbox(sandboxName);
          if (entry && !entry.gpuEnabled) {
            console.error(
              `  Sandbox '${sandboxName}' exists but was created without GPU passthrough.`,
            );
            console.error(
              "  Pass --recreate-sandbox to recreate with GPU, or destroy and re-onboard:",
            );
            console.error(`    nemoclaw onboard --recreate-sandbox`);
            process.exit(1);
          }
        }

        if (isNonInteractive()) {
          if (existingSandboxState === "ready") {
            if (actionableSelectionDrift) {
              note("  [non-interactive] Recreating sandbox due to provider/model drift.");
            } else {
              revalidatePolicyAuthority(true, `reusing sandbox '${sandboxName}'`);
              policyPresetCarry.seedReusedSandboxPolicyPresets(sandboxName, isNonInteractive());
              // Upsert messaging providers even on reuse so credential changes take
              // effect without requiring a full sandbox recreation.
              upsertMessagingProviders(messagingTokenDefs, {
                revalidatePolicyRequirements: (operation) =>
                  revalidatePolicyAuthority(true, operation),
              });
              if (selectionDrift.unknown) {
                note(
                  "  [non-interactive] Existing provider/model selection is unreadable; reusing sandbox.",
                );
                note(
                  "  [non-interactive] Set NEMOCLAW_RECREATE_SANDBOX=1 (or --recreate-sandbox) to force recreation.",
                );
              } else {
                note(
                  `  [non-interactive] Sandbox '${sandboxName}' exists and is ready — reusing it`,
                );
                note(
                  "  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to force recreation.",
                );
              }
              await restoreReusedSandboxDashboard(!selectionDrift.unknown);
              return sandboxName;
            }
          } else {
            notReadyRecreateInProgress = true;
            const outcome = recreateProtection.resolveNotReadyOutcome();
            if (outcome.kind === "blocked") {
              for (const hint of outcome.hints) console.error(hint);
              process.exit(1);
            }
            pendingStateRestoreBackupPath = outcome.restoreBackupPath;
          }
        } else if (existingSandboxState === "ready") {
          if (actionableSelectionDrift) {
            const confirmed = await confirmRecreateForSelectionDrift(
              sandboxName,
              selectionDrift,
              provider,
              model,
            );
            if (!confirmed) {
              console.error("  Aborted. Existing sandbox left unchanged.");
              process.exit(1);
            }
          } else {
            console.log(`  Sandbox '${sandboxName}' already exists.`);
            console.log("  Choosing 'n' will delete the existing sandbox and create a new one.");
            if (await promptYesNoOrDefault("  Reuse existing sandbox?", null, true)) {
              revalidatePolicyAuthority(true, `reusing sandbox '${sandboxName}'`);
              policyPresetCarry.seedReusedSandboxPolicyPresets(sandboxName, isNonInteractive());
              upsertMessagingProviders(messagingTokenDefs, {
                revalidatePolicyRequirements: (operation) =>
                  revalidatePolicyAuthority(true, operation),
              });
              await restoreReusedSandboxDashboard(!selectionDrift.unknown);
              return sandboxName;
            }
          }
        } else {
          console.log(`  Sandbox '${sandboxName}' exists but is not ready.`);
          console.log("  Selecting 'n' will abort onboarding.");
          if (!(await promptYesNoOrDefault("  Delete it and create a new one?", null, true))) {
            console.log("  Aborting onboarding.");
            process.exit(1);
          }
        }
      }

      if (credentialRotation.changed && existingSandboxState === "ready") {
        const rotatedNames = credentialRotation.changedProviders.join(", ");
        console.log(`  Messaging credential(s) rotated: ${rotatedNames}`);
        console.log("  Rebuilding sandbox to propagate new credentials to the L7 proxy...");
        if (!shouldSkipPreRecreateBackup(process.env)) {
          const result = recreateProtection.backup();
          if (!result.ok) {
            console.error(
              "  Set NEMOCLAW_RECREATE_WITHOUT_BACKUP=1 to recreate without preserving state.",
            );
            process.exit(1);
          }
          pendingStateRestore = result.backup;
        }
      }
      reportSandboxRecreateReason(
        {
          sandboxName,
          recreateForAgentDrift,
          existingAgentName: agentDrift.existingAgentName,
          requestedAgentName: agentDrift.requestedAgentName,
          needsProviderMigration,
          actionableSelectionDrift,
          sandboxGpuDrift,
          hermesToolGatewayDrift,
          hermesDashboardDrift,
          observabilityDrift,
          dcodeAutoApprovalDrift: dcodeAutoApprovalPlan.hasDrift,
          toolDisclosureMigrationNote,
          credentialRotationChanged: credentialRotation.changed,
          existingSandboxState,
        },
        { formatSandboxAgentName, note },
      );
      const managedMcpRebuildHandoff = hasPreservedManagedMcpRebuildHandoff(
        preservedMcpState,
        createIntent,
      );
      if (shouldRefuseManagedMcpRecreate(preservedMcpState, managedMcpRebuildHandoff)) {
        for (const hint of recreateJournal.managedMcpRecreateRefusalHints({
          sandboxName,
          cliName: cliName(),
          toolDisclosure: effectiveToolDisclosure,
          rebuildFlag: dcodeAutoApprovalPlan.rebuildFlag,
          observabilityFlag: observabilityCommandFlag.explicitObservabilityFlag(
            createIntent?.observabilityEnabled === true,
            createIntent?.observabilityRequestedExplicitly === true,
          ),
        }))
          console.error(hint);
        process.exit(1);
      }
      // Resolve and validate immutable workload authority before opening a recreate journal or
      // mutating a live sandbox.
      preparedSandboxWorkload = await ensurePreparedSandboxWorkload();
      await hermesApiPortReservationScope.selectAndReserve(hermesApiPortReservationInput);
      if (!createIntent?.recreateTransaction) recreateRuntime = openRecreateJournal();
      if (recreateRuntime.acceptedTarget) {
        if ("complete" in recreateRuntime) recreateRuntime.complete();
        await restoreReusedSandboxDashboard(true);
        return sandboxName;
      }
      const previousEntry: SandboxEntry | null = registry.getSandbox(sandboxName);
      baseImageResolutionFlow.captureBaseResolution(
        baseImageResolutionContext,
        previousEntry?.imageTag,
      );
      applyManagedSandboxRebuildPolicyCarryForward(
        {
          sandboxName,
          policyAuthority: resolvedPolicyAuthority,
          nonInteractive: isNonInteractive(),
          note,
          rebuildPolicyPresets: createIntent?.rebuildPolicyPresets,
          revalidatePolicyAuthority: (operation) => revalidatePolicyAuthority(true, operation),
        },
        policyPresetCarry.applyRecreatePolicyCarryForward,
      );

      const noRestorePending =
        pendingStateRestore === null && pendingStateRestoreBackupPath === null;
      if (
        noRestorePending &&
        !notReadyRecreateInProgress &&
        !shouldSkipPreRecreateBackup(process.env)
      ) {
        note("  Backing up workspace state before recreating sandbox...");
        const result = recreateProtection.backup();
        if (!result.ok) {
          console.error(
            "  Set NEMOCLAW_RECREATE_WITHOUT_BACKUP=1 to recreate without preserving state.",
          );
          process.exit(1);
        }
        pendingStateRestore = result.backup;
      }

      hermesStateVolumeLifecycle = prepareHermesStateVolumeLifecycle(preparedSandboxWorkload);
      note(`  Deleting and recreating sandbox '${sandboxName}'...`);

      revalidatePolicyAuthority(true, `recreating sandbox '${sandboxName}'`);
      if (recreateRuntime.beginDelete() === "source") {
        runAuthorityBoundProviderCleanup({
          sandboxName,
          revalidateSandboxIdentity: (operation) => revalidatePolicyAuthority(true, operation),
          runProviderPreDeleteCleanup: runSandboxProviderPreDeleteCleanup,
          runOpenshell,
          redact,
        });
        revalidatePolicyAuthority(true, `deleting sandbox '${sandboxName}'`);
        runOpenshell(
          [
            "sandbox",
            "delete",
            "-g",
            recreateRuntime.journaledGatewayName ?? GATEWAY_NAME,
            sandboxName,
          ],
          { ignoreError: true },
        );
        if (
          !waitForSandboxRecreateDeleteAbsence(
            sandboxName,
            recreateRuntime.journaledGatewayName ?? GATEWAY_NAME,
            note,
          )
        )
          throw new Error(
            `Cannot continue sandbox '${sandboxName}' recreation: OpenShell did not confirm explicit source absence after delete.`,
          );
      }
      recreateRuntime.confirmDeleted();
      finalizeRecreatedSourceHermesVolume(true, previousEntry, hermesStateVolumeLifecycle !== null);
      await hermesApiPortReservationScope.rebindAfterOwnedForwardDelete(
        hermesApiPortReservationInput,
      );
    }
    if (resumingVerifiedCreate) {
      await hermesApiPortReservationScope.selectAndReserve(hermesApiPortReservationInput);
      preparedSandboxWorkload = await ensurePreparedSandboxWorkload();
      hermesStateVolumeLifecycle = prepareHermesStateVolumeLifecycle(preparedSandboxWorkload);
    } else if (!liveExists || agentCreateInput.hermesPortableLifecycle) {
      if (!agentCreateInput.hermesPortableLifecycle) {
        await hermesApiPortReservationScope.selectAndReserve(hermesApiPortReservationInput);
      }
      preparedSandboxWorkload = await ensurePreparedSandboxWorkload();
      hermesStateVolumeLifecycle = prepareHermesStateVolumeLifecycle(preparedSandboxWorkload);
      finalizeRecreatedSourceHermesVolume(
        !liveExists,
        existingEntry,
        hermesStateVolumeLifecycle !== null,
      );
    }
    runForNewSandboxCreate(resumingVerifiedCreate, () => {
      revalidatePolicyAuthority(false, `creating sandbox '${sandboxName}'`);
      sandboxCreatePlanMaterialization.applyOrdinaryExtraProviderReconciliation(
        agentCreateInput.hermesPortableLifecycle,
        () => {
          revalidatePolicyAuthority(false, `updating providers for sandbox '${sandboxName}'`);
          applyExtraProviderReconciliation({
            extraProviders: resolvedCreateIntent.extraProviders,
            staleExtraProviders: resolvedCreateIntent.staleExtraProviders ?? [],
          });
        },
      );
    });
    const preparedOnboardLaunch =
      await managedWorkloadOnboard.prepareSelectedOnboardSandboxWorkloadLaunch(
        agentCreateInput.hermesPortableLifecycle,
        () =>
          managedWorkloadOnboard.prepareHermesPortableOnboardSandboxLaunch({
            intent: resolvedCreateIntent,
            policyAuthority: resolvedPolicyAuthority,
            fromRef:
              preparedSandboxWorkload.source.kind === "legacy-dockerfile"
                ? preparedSandboxWorkload.source.dockerfilePath
                : "",
            launchInput: {
              agent,
              observabilityEnabled: false,
              chatUiUrl: "",
              sandboxName,
              env: process.env,
              extraPlaceholderKeys: resolvedCreateIntent.extraPlaceholderKeys,
              getDashboardForwardPort,
              hermesDashboardState: { enabled: false, config: null },
              hermesApiPort: null,
              manageDashboard: false,
              openshellShellCommand,
              openshellArgv,
            },
            gpuConfig: effectiveSandboxGpuConfig,
          }),
        () =>
          managedWorkloadOnboard.prepareOnboardSandboxWorkloadLaunch({
            runtime: managedWorkloadRuntime,
            workload: preparedSandboxWorkload,
            legacy: {
              preparedBuildContext,
              agent,
              fromDockerfile,
              createAgentSandbox: (selectedAgent) =>
                baseImageResolutionFlow.createAgentSandboxWithResolution(
                  baseImageResolutionContext,
                  selectedAgent,
                  agentOnboard.createAgentSandbox,
                ),
              resolvePatchInput: () => ({
                preparedBuildContext,
                agent,
                fromDockerfile,
                model,
                chatUiUrl,
                provider,
                endpointUrl: createIntent?.endpointUrl ?? null,
                compatibleEndpointReasoning: createIntent?.compatibleEndpointReasoning,
                preferredInferenceApi,
                webSearchConfig,
                toolDisclosure: effectiveToolDisclosure,
                rebuildPreservedEnv: createIntent?.rebuildPreservedEnv,
                ...(isManagedDcodeAgent
                  ? { dcodeAutoApprovalMode: dcodeAutoApprovalPlan.mode }
                  : {}),
                hermesToolGateways,
                sandboxGpuConfig: effectiveSandboxGpuConfig,
                ...baseImageResolutionFlow.getBaseImageResolutionPatchOptions(
                  baseImageResolutionContext,
                ),
                gatewayPort: GATEWAY_PORT,
              }),
            },
            plan: {
              intent: resolvedCreateIntent,
              policyAuthority: resolvedPolicyAuthority,
              deferSandboxEffectsUntilPolicyVerification:
                createIntent?.deferSandboxEffectsUntilPolicyVerification === true,
              rebindMessagingTokenDefs: async () => {
                revalidatePolicyAuthority(
                  false,
                  `registering credentials for sandbox '${sandboxName}'`,
                );
                return (
                  await sandboxCreateIntentResolver.rebind(
                    {
                      sandboxName,
                      enabledChannels,
                      webSearchConfig,
                      agent,
                      ...(createIntent?.reuseRegisteredCredentials
                        ? { reuseRegisteredCredentials: true }
                        : {}),
                    },
                    resolvedCreateIntent,
                  )
                ).messagingTokenDefs;
              },
              runProviderPreDeleteCleanup: (verifiedPolicyRevalidation) => {
                runAuthorityBoundProviderCleanup({
                  sandboxName,
                  runProviderPreDeleteCleanup: runSandboxProviderPreDeleteCleanup,
                  runOpenshell,
                  redact,
                  tolerateMissingSandbox: true,
                  ...(verifiedPolicyRevalidation
                    ? { revalidateSandboxIdentity: verifiedPolicyRevalidation }
                    : {
                        observeSandbox: () =>
                          getSandboxRecreateObservation(sandboxName, GATEWAY_NAME),
                        revalidatePolicyAuthority: (operation: string) =>
                          revalidatePolicyAuthority(false, operation),
                      }),
                });
              },
              upsertMessagingProviders: (tokenDefs, options) =>
                upsertMessagingProviders(tokenDefs, {
                  ...options,
                  revalidatePolicyRequirements: (operation) =>
                    (
                      options.revalidatePolicyRequirements ??
                      ((targetOperation) => revalidatePolicyAuthority(false, targetOperation))
                    )(operation),
                }),
              getHermesToolGatewayProviderName: (targetSandbox) =>
                getHermesToolGatewayBroker().getHermesToolGatewayProviderName(targetSandbox),
              discloseInitialSandboxPolicy,
            },
            launchInput: {
              agent,
              observabilityEnabled: createIntent?.observabilityEnabled === true,
              chatUiUrl,
              sandboxName,
              env: process.env,
              extraPlaceholderKeys: resolvedCreateIntent.extraPlaceholderKeys,
              getDashboardForwardPort,
              hermesDashboardState: agentCreateInput.hermesPortableLifecycle
                ? { enabled: false, config: null }
                : hermesDashboardState,
              hermesApiPort: hermesApiPortReservationScope.effectivePort,
              manageDashboard,
              openshellShellCommand,
              openshellArgv,
            },
            plannedMessagingPlan: plannedMessagingState?.plan ?? null,
            gpu: {
              provider,
              config: effectiveSandboxGpuConfig,
              dockerDriverGateway: agentCreateInput.dockerDriverGateway,
              gatewayPort: GATEWAY_PORT,
            },
            dependencies: {
              materializeSandboxCreatePlan: (input) =>
                hermesStateVolumeLifecycle
                  ? hermesStateVolumeLifecycle.materializeSandboxCreatePlan(
                      input,
                      sandboxCreatePlanMaterialization.materializeSandboxCreatePlan,
                    )
                  : sandboxCreatePlanMaterialization.materializeSandboxCreatePlan(input),
              prepareSandboxBuildPatchConfig:
                sandboxBuildPatchConfig.prepareSandboxBuildPatchConfig,
            },
          }),
      );
    const {
      initialSandboxPolicy,
      policyTier: resolvedCreatePolicyTier,
      messagingProviders,
      gpuRoutePlan,
      compatibilityPolicyPath,
      activateDeferredProviderEffects,
      initialGpuRoute,
      sandboxReadyTimeoutSecs,
      buildId,
      dashboardRemoteBindPrepared,
      legacyBuildContext,
      launch: {
        createArgv,
        effectiveDashboardPort,
        intendedSandboxStartupCommand,
        managedBootstrapIdentity,
        managedStartupRootApplyRequest,
        prebuild,
        sandboxEnv,
        sandboxStartupCommand,
      },
    } = preparedOnboardLaunch;
    const restoreBackupPath =
      pendingStateRestore?.manifest?.backupPath ?? pendingStateRestoreBackupPath;
    onboardSessionBootstrap.verifyReadOnlyHostMountSources(resolvedCreateIntent.hostMounts);
    runForNewSandboxCreate(agentCreateInput.hermesPortableLifecycle || resumingVerifiedCreate, () =>
      recreateRuntime.advance("creating"),
    );
    const managedBootstrap = managedWorkloadOnboard.resolveOnboardManagedBootstrapLaunch({
      runtime: managedWorkloadRuntime,
      workload: preparedSandboxWorkload,
      stateRoot: getDockerDriverGatewayStateDir(),
      bootstrapIdentity: managedBootstrapIdentity,
      request: managedStartupRootApplyRequest,
      intendedWorkloadArgv: intendedSandboxStartupCommand,
    });
    const recoveredHermesLifecycleGeneration = readHermesPortableLifecycleGeneration({
      enabled: agentCreateInput.hermesPortableLifecycle,
      sandboxName,
      gatewayName: GATEWAY_NAME,
      inspect: sandboxGpuCreateFlow.inspectPortableAgentReceiptDisposition,
    });
    const createdSandboxLifecycle = sandboxRecreateTransaction.createCreatedSandboxLifecycle(
      recreateRuntime,
      { sandboxName, gatewayName: GATEWAY_NAME },
      getSandboxRecreateObservation,
      recoveredHermesLifecycleGeneration,
    );
    const hermesPortableAuthority = agentCreateInput.hermesPortableLifecycle
      ? (() => {
          if (!agent || agent.name !== "hermes" || !portableRuntimeAuthority) {
            throw new Error(
              "Hermes portable onboarding is missing exact agent or runtime authority.",
            );
          }
          return { agent, runtimeAuthority: portableRuntimeAuthority };
        })()
      : null;
    const hermesGpuAuthority = hermesPortableAuthority
      ? sandboxGpuCreateFlow.createHermesPortableGpuProofAuthority({
          sandboxName,
          gatewayName: GATEWAY_NAME,
          sourceEnv: sandboxEnv,
          lifecycleGeneration: createdSandboxLifecycle.generation,
          runtimeAuthority: hermesPortableAuthority.runtimeAuthority,
          runOpenshell,
          compactText,
          redact,
        })
      : null;
    const createFlowEnvironment = hermesGpuAuthority?.env ?? sandboxEnv;
    const createGpuVerifier = hermesGpuAuthority?.verify ?? verifyDirectSandboxGpu;
    const policySourcePathForRoute = (
      route: import("../docker-gpu-route").SelectedDockerGpuRoute,
    ): string => {
      const policySourcePath =
        route === "compatibility" ? compatibilityPolicyPath : initialSandboxPolicy.policyPath;
      if (!policySourcePath) {
        throw new Error("Sandbox creation has no exact policy source for its selected route.");
      }
      return policySourcePath;
    };
    let managedBootstrapCreateFinished = false;
    const revalidateCreatedSandboxIdentity = (
      expectedIdentity: string,
      operation: string,
    ): void => {
      sandboxRecreateTransaction.revalidateCreatedSandboxLifecycleRegistration(
        { sandboxName, gatewayName: GATEWAY_NAME },
        {
          lifecycleGeneration: createdSandboxLifecycle.generation,
          lifecycleLiveIdentityFingerprint: expectedIdentity,
        },
        getSandboxRecreateObservation,
        { allowNotReadyWithMatchingIdentity: managedBootstrapCreateFinished },
      );
    };
    const requireVerifiedPolicyGate = (): NonNullable<typeof verifiedPolicyGate> => {
      if (!verifiedPolicyGate) {
        throw new Error("Sandbox creation has no verified post-create policy boundary.");
      }
      return verifiedPolicyGate;
    };
    const requirePendingPolicyVerification = (): PendingSandboxPolicyVerification => {
      if (!pendingPolicyVerification) {
        throw new Error("Sandbox creation has no durable verified policy checkpoint.");
      }
      return pendingPolicyVerification;
    };
    const requireCreateReservation = (): QualifiedPendingSandboxCreateReservation => {
      if (!admittedCreateReservation) {
        throw new Error("Sandbox creation has no exact inference route reservation.");
      }
      return admittedCreateReservation;
    };
    let durableCreatedSandboxIdentity:
      | import("../sandbox-recreate-transaction").CreatedSandboxLifecycleRegistration
      | null = null;
    const persistCreatedSandboxIdentity = (exactIdentity: string): void => {
      durableCreatedSandboxIdentity = agentCreateInput.hermesPortableLifecycle
        ? {
            lifecycleGeneration: createdSandboxLifecycle.generation,
            lifecycleLiveIdentityFingerprint: exactIdentity,
          }
        : createdSandboxLifecycle.recordExactIdentity(exactIdentity);
    };
    const requireDurableCreatedSandboxIdentity = (
      exactIdentity: string,
    ): import("../sandbox-recreate-transaction").CreatedSandboxLifecycleRegistration => {
      const expected = durableCreatedSandboxIdentity;
      if (
        !expected ||
        expected.lifecycleGeneration !== createdSandboxLifecycle.generation ||
        expected.lifecycleLiveIdentityFingerprint !== exactIdentity
      ) {
        throw new Error("Sandbox creation has no matching durable created identity journal.");
      }
      const stored = agentCreateInput.hermesPortableLifecycle
        ? expected
        : createdSandboxLifecycle.recordExactIdentity(exactIdentity);
      if (
        stored.lifecycleGeneration !== expected.lifecycleGeneration ||
        stored.lifecycleLiveIdentityFingerprint !== expected.lifecycleLiveIdentityFingerprint
      ) {
        throw new Error("Sandbox created identity journal changed before policy publication.");
      }
      return stored;
    };
    const admitCreateReservation = (): QualifiedPendingSandboxCreateReservation => {
      if (!inferenceRouteReservationAuthority?.sessionId) {
        throw new Error("Sandbox creation requires current inference route reservation authority.");
      }
      return registry.qualifyPendingSandboxCreateReservation(
        {
          sandboxName,
          gatewayName: GATEWAY_NAME,
          sessionId: inferenceRouteReservationAuthority.sessionId,
          selection: inferenceRouteReservationAuthority.selection,
        },
        registry.getSandbox(sandboxName),
      );
    };
    /** Rebind only the current reserved GPU create, then CAS-persist its exact live receipt. */
    const revalidateActiveVerifiedCreateBoundary = (
      boundary: EffectiveVerifiedSandboxPolicyBoundary,
      checkpoint: PendingSandboxPolicyVerification,
      operation: string,
    ): {
      readonly boundary: EffectiveVerifiedSandboxPolicyBoundary;
      readonly checkpoint: PendingSandboxPolicyVerification;
    } => {
      if (!isDeepStrictEqual(pendingSandboxPolicyVerificationForBoundary(boundary), checkpoint)) {
        throw new PolicyAuthorityRefusalError(
          `Refusing to ${operation}: the verified create policy boundary no longer matches its durable checkpoint.`,
          "owner-unknown",
        );
      }
      registry.requireCurrentPendingSandboxPolicyVerification(
        requireCreateReservation(),
        checkpoint,
      );
      revalidateCreatedSandboxIdentity(boundary.lifecycleLiveIdentityFingerprint, operation);
      const registration =
        boundary.route !== "none" && boundary.registration.policyAuthority === "nemoclaw-managed"
          ? verifyCreatedSandboxPolicyRegistration(
              {
                sandboxName,
                gatewayName: GATEWAY_NAME,
                gatewayPort: GATEWAY_PORT,
                lifecycleGeneration: createdSandboxLifecycle.generation,
                lifecycleLiveIdentityFingerprint: boundary.lifecycleLiveIdentityFingerprint,
                policySourcePath: boundary.policySourcePath,
                route: boundary.route,
                operation,
                plannedAuthority: "nemoclaw-managed",
              },
              { sleep: sleepSeconds },
            )
          : revalidateCreatedSandboxPolicyRegistration({
              sandboxName,
              gatewayName: GATEWAY_NAME,
              gatewayPort: GATEWAY_PORT,
              lifecycleGeneration: createdSandboxLifecycle.generation,
              lifecycleLiveIdentityFingerprint: boundary.lifecycleLiveIdentityFingerprint,
              policySourcePath: boundary.policySourcePath,
              route: boundary.route,
              operation,
              registration: boundary.registration,
            });
      revalidateCreatedSandboxIdentity(boundary.lifecycleLiveIdentityFingerprint, operation);
      if (isDeepStrictEqual(registration, boundary.registration)) {
        return { boundary, checkpoint };
      }
      const refreshedBoundary = { ...boundary, registration };
      const refreshedCheckpoint = pendingSandboxPolicyVerificationForBoundary(refreshedBoundary);
      registry.recordPendingSandboxPolicyVerification(
        requireCreateReservation(),
        refreshedCheckpoint,
        { expected: checkpoint },
      );
      revalidateCreatedSandboxIdentity(boundary.lifecycleLiveIdentityFingerprint, operation);
      registry.requireCurrentPendingSandboxPolicyVerification(
        requireCreateReservation(),
        refreshedCheckpoint,
      );
      return { boundary: refreshedBoundary, checkpoint: refreshedCheckpoint };
    };
    const resumeVerifiedCreateInput = (() => {
      const checkpoint = acceptedTargetPendingCheckpoint;
      if (!checkpoint) return null;
      if (agentCreateInput.hermesPortableLifecycle) {
        throw new Error("Hermes portable onboarding cannot resume an ordinary verified create.");
      }
      const policySourcePath = policySourcePathForRoute(checkpoint.route);
      const boundary = {
        ...verifiedSandboxPolicyBoundaryFromPendingCheckpoint(checkpoint),
        policySourcePath,
      };
      admittedCreateReservation = admitCreateReservation();
      registry.requireCurrentPendingSandboxPolicyVerification(
        admittedCreateReservation,
        checkpoint,
      );
      durableCreatedSandboxIdentity = createdSandboxLifecycle.recordExactIdentity(
        checkpoint.sandboxIdentityFingerprint,
      );
      revalidateCreatedSandboxIdentity(
        checkpoint.sandboxIdentityFingerprint,
        `resuming sandbox creation for '${sandboxName}'`,
      );
      const resumed = revalidateActiveVerifiedCreateBoundary(
        boundary,
        checkpoint,
        `resume sandbox creation for '${sandboxName}'`,
      );
      pendingPolicyVerification = resumed.checkpoint;
      verifiedPolicyGate = resumed.boundary;
      return {
        route: resumed.checkpoint.route,
        liveIdentityFingerprint: resumed.checkpoint.sandboxIdentityFingerprint,
        createAttemptNonce: resumed.checkpoint.createAttemptNonce,
      };
    })();
    const revalidateVerifiedPolicyRegistration = (
      boundary: EffectiveVerifiedSandboxPolicyBoundary,
      operation: string,
    ): SandboxEntry => {
      const activeBoundary = requireVerifiedPolicyGate();
      if (
        boundary.sandboxName !== activeBoundary.sandboxName ||
        boundary.gatewayName !== activeBoundary.gatewayName ||
        boundary.gatewayPort !== activeBoundary.gatewayPort ||
        boundary.lifecycleGeneration !== activeBoundary.lifecycleGeneration ||
        boundary.lifecycleLiveIdentityFingerprint !==
          activeBoundary.lifecycleLiveIdentityFingerprint ||
        boundary.route !== activeBoundary.route
      ) {
        throw new PolicyAuthorityRefusalError(
          `Refusing to ${operation}: the verified create policy boundary changed during onboarding.`,
          "owner-unknown",
        );
      }
      const refreshed = revalidateActiveVerifiedCreateBoundary(
        activeBoundary,
        requirePendingPolicyVerification(),
        operation,
      );
      pendingPolicyVerification = refreshed.checkpoint;
      verifiedPolicyGate = refreshed.boundary;
      return registry.requireCurrentPendingSandboxPolicyVerification(
        requireCreateReservation(),
        requirePendingPolicyVerification(),
      );
    };
    const retainedSandboxRecoveryContext = (
      boundary: VerifiedSandboxPolicyBoundary | null,
      createAttemptNonceOverride: string | null = null,
    ): RetainedSandboxRecoveryContext => {
      const checkpoint = boundary ? pendingSandboxPolicyVerificationForBoundary(boundary) : null;
      const createAttemptNonce = boundary?.createAttemptNonce ?? createAttemptNonceOverride;
      if (!createAttemptNonce) {
        throw new Error("Retained sandbox recovery requires exact create-attempt authority.");
      }
      return {
        gatewayName: GATEWAY_NAME,
        gatewayPort: GATEWAY_PORT,
        lifecycleGeneration: createdSandboxLifecycle.generation,
        verifiedEffectivePolicyIdentity: checkpoint
          ? { hash: checkpoint.policyHash, activeVersion: checkpoint.policyVersion }
          : null,
        createAttemptNonce,
        policyCreationReceipt:
          boundary?.registration.policyAuthority === "nemoclaw-managed"
            ? boundary.registration.policyCreationReceipt
            : null,
      };
    };
    const recordPostCreateRecovery = (
      stage: "registry publication" | "onboarding finalization",
    ): void => {
      const boundary = requireVerifiedPolicyGate();
      postCreateRecoveryRetryOwner.record(() =>
        persistPostCreateRecovery({
          stage,
          sandboxName,
          gatewayName: GATEWAY_NAME,
          lifecycleGeneration: createdSandboxLifecycle.generation,
          exactIdentity: boundary.lifecycleLiveIdentityFingerprint,
          recoveryContext: retainedSandboxRecoveryContext(boundary),
          markRetainedSandboxRecovery: onboardSession.markRetainedSandboxRecovery,
        }),
      );
    };
    const persistCreateFlowRecovery = (
      message: string,
      exactIdentity: string | null = null,
      createAttemptNonce: string | null = null,
    ): boolean =>
      persistRetainedSandboxRecoveryWithRetry(postCreateRecoveryRetryOwner, () =>
        persistRetainedSandboxRecoveryMessage(
          {
            sandboxName,
            message,
            ...(exactIdentity ? { sandboxIdentityFingerprint: exactIdentity } : {}),
            recoveryContext: retainedSandboxRecoveryContext(verifiedPolicyGate, createAttemptNonce),
          },
          onboardSession.markRetainedSandboxRecovery,
        ),
      );
    const runCreateFlow = async (
      attemptCreateArgv: string[],
      hermesPortableReadyCapture?: import("../sandbox-gpu-create-flow").HermesPortableReadyCapture,
      hermesPortableReadyRunner?: import("../sandbox-gpu-create-flow").HermesPortableReadyRunner,
      createWorkingDirectory?: string,
      effectivePolicySourcePath?: string,
      runDeferredProviderEffects?: (context: VerifiedSandboxCreateEffectsContext) => Promise<void>,
    ) => {
      assertCreateLifecycleJournal({
        portableLifecycle: agentCreateInput.hermesPortableLifecycle,
        runtimeGeneration: recreateRuntime.targetGeneration ?? null,
        createdGeneration: createdSandboxLifecycle.generation,
        sandboxName,
      });
      if (Boolean(effectivePolicySourcePath) !== Boolean(hermesPortableAuthority)) {
        throw new Error("Hermes portable create policy authority is incomplete.");
      }
      admittedCreateReservation = admitCreateReservation();
      return runSandboxCreateWithPolicyAuthorityChecks<
        import("../sandbox-gpu-create-flow").CreatedSandboxIdentity,
        EffectiveVerifiedSandboxPolicyBoundary,
        import("../sandbox-gpu-create-flow").SandboxGpuCreateFlowResult
      >({
        sandboxName,
        revalidate: (sandboxIsLive, operation) =>
          revalidatePolicyAuthority(resumeVerifiedCreateInput ? true : sandboxIsLive, operation),
        captureCreatedSandboxIdentity: (
          identity: import("../sandbox-gpu-create-flow").CreatedSandboxIdentity,
        ) => identity.liveIdentityFingerprint,
        captureCreatedSandboxCreateAttemptNonce: (
          identity: import("../sandbox-gpu-create-flow").CreatedSandboxIdentity,
        ) => identity.createAttemptNonce,
        persistCreatedSandboxIdentity: (_identity, exactIdentity) =>
          persistCreatedSandboxIdentity(exactIdentity),
        revalidateCreatedSandboxIdentity,
        verifyCreatedPolicy: (
          identity: import("../sandbox-gpu-create-flow").CreatedSandboxIdentity,
        ) => {
          if (effectivePolicySourcePath && identity.route === "compatibility") {
            throw new Error("Hermes portable create selected an unsupported GPU route.");
          }
          const policySourcePath =
            effectivePolicySourcePath ?? policySourcePathForRoute(identity.route);
          const registrationInput = {
            sandboxName,
            gatewayName: GATEWAY_NAME,
            gatewayPort: GATEWAY_PORT,
            lifecycleGeneration: createdSandboxLifecycle.generation,
            lifecycleLiveIdentityFingerprint: identity.liveIdentityFingerprint,
            policySourcePath,
            route: identity.route,
            operation: `verify effective policy for sandbox '${sandboxName}'`,
          };
          const registration = resumeVerifiedCreateInput
            ? revalidateCreatedSandboxPolicyRegistration({
                ...registrationInput,
                registration: requireVerifiedPolicyGate().registration,
              })
            : apfInterceptorRequested
              ? verifyCreatedApfInterceptorPolicyRegistration(registrationInput, {
                  sleep: sleepSeconds,
                })
              : verifyCreatedSandboxPolicyRegistration(
                  {
                    ...registrationInput,
                    plannedAuthority: resolvedPolicyAuthority,
                  },
                  { sleep: sleepSeconds },
                );
          return {
            registration,
            sandboxName,
            gatewayName: GATEWAY_NAME,
            gatewayPort: GATEWAY_PORT,
            lifecycleGeneration: createdSandboxLifecycle.generation,
            lifecycleLiveIdentityFingerprint: identity.liveIdentityFingerprint,
            createAttemptNonce: identity.createAttemptNonce,
            route: identity.route,
            policySourcePath,
          };
        },
        persistVerifiedPolicy: (_identity, _exactIdentity, boundary) => {
          requireDurableCreatedSandboxIdentity(boundary.lifecycleLiveIdentityFingerprint);
          const checkpoint = pendingSandboxPolicyVerificationForBoundary(boundary);
          registry.recordPendingSandboxPolicyVerification(requireCreateReservation(), checkpoint, {
            ...(pendingPolicyVerification ? { expected: pendingPolicyVerification } : {}),
          });
          pendingPolicyVerification = checkpoint;
          verifiedPolicyGate = boundary;
          if (apfInterceptorRequested) {
            onboardSession.updateSession((session) => {
              session.policyAuthority = "externally-managed";
              session.policyPresets = null;
            });
          }
        },
        revalidateVerifiedPolicy: (_identity, _exactIdentity, boundary, operation) => {
          revalidateVerifiedPolicyRegistration(boundary, operation);
        },
        persistRetainedSandboxRecovery: (message, exactIdentity, boundary, created) =>
          persistRetainedSandboxRecoveryMessage(
            {
              sandboxName,
              message,
              ...(exactIdentity ? { sandboxIdentityFingerprint: exactIdentity } : {}),
              recoveryContext: retainedSandboxRecoveryContext(
                boundary,
                created?.createAttemptNonce ?? null,
              ),
            },
            onboardSession.markRetainedSandboxRecovery,
          ),
        retainedSandboxRecoveryRetryOwner: postCreateRecoveryRetryOwner,
        cleanupTemporarySources: cleanupSandboxCreateSources,
        runVerifiedCreateEffects: runDeferredProviderEffects
          ? async (_identity, _exactIdentity, boundary) => {
              const context: VerifiedSandboxCreateEffectsContext = {
                ...boundary,
                revalidatePolicyRequirements: (operation) =>
                  revalidateVerifiedPolicyRegistration(boundary, operation),
              };
              await runDeferredProviderEffects(context);
            }
          : undefined,
        create: async (verifyCreatedSandbox) => {
          const created = await sandboxGpuCreateFlow.runSandboxGpuCreateFlow(
            {
              sandboxName,
              ...(resumeVerifiedCreateInput
                ? { resumeVerifiedCreate: resumeVerifiedCreateInput }
                : {}),
              ...(apfInterceptorRequested
                ? {
                    requirePolicylessCreate: true as const,
                  }
                : {}),
              persistRetainedSandboxRecovery: (
                message,
                sandboxIdentityFingerprint,
                createAttemptNonce,
              ) =>
                persistCreateFlowRecovery(
                  message,
                  sandboxIdentityFingerprint ?? null,
                  createAttemptNonce ?? null,
                ),
              provider,
              sandboxGpuConfig: effectiveSandboxGpuConfig,
              gpuRoutePlan,
              initialGpuRoute,
              compatibilityPolicyPath,
              gatewayName: GATEWAY_NAME,
              gatewayPort: GATEWAY_PORT,
              sandboxReadyTimeoutSecs,
              createArgv: attemptCreateArgv,
              ...(createWorkingDirectory ? { createWorkingDirectory } : {}),
              sandboxEnv: createFlowEnvironment,
              sandboxStartupCommand,
              lifecycleGeneration: createdSandboxLifecycle.generation,
              portableRuntimeAuthority,
              prebuild,
              restoreBackupPath,
              terminalAgent: agentDefs.isTerminalAgent(agent),
              managedBootstrap,
              verifyCreatedSandboxBeforeEffects: async (identity) => {
                managedBootstrapCreateFinished = managedBootstrap !== null;
                await verifyCreatedSandbox(identity);
              },
              revalidateVerifiedSandboxBeforeEffect: (operation) =>
                revalidateVerifiedPolicyRegistration(requireVerifiedPolicyGate(), operation),
              ...agentCreateInput,
            },
            {
              runOpenshell: hermesPortableReadyRunner ?? runOpenshell,
              runCaptureOpenshell: hermesPortableReadyCapture ?? runCaptureOpenshell,
              sleep: sleepSeconds,
              openshellArgv,
              verifyDirectSandboxGpu: createGpuVerifier,
            },
          );
          return created;
        },
      });
    };

    const cleanupBuildContext =
      sandboxGpuCreateFlow.createSandboxBuildContextCleanup(legacyBuildContext);
    const cleanupInitialCreateSource = sandboxGpuCreateFlow.createSandboxCreateSourceCleanup(
      initialSandboxPolicy,
      agentCreateInput.hermesPortableLifecycle,
    );
    const cleanupSandboxCreateSources = (): void => {
      const cleanupErrors: Error[] = [];
      try {
        if (!cleanupInitialCreateSource()) {
          cleanupErrors.push(
            new Error("The temporary sandbox create policy could not be removed."),
          );
        }
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
      try {
        if (!cleanupBuildContext()) {
          cleanupErrors.push(
            new Error("The temporary sandbox build context could not be removed."),
          );
        }
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Temporary sandbox create sources remain.");
      }
    };
    const sandboxRuntimeFields = agentCreateInput.hermesPortableLifecycle
      ? sandboxRegistryMetadata.getHermesPortableSandboxRuntimeRegistryFields(
          effectiveSandboxGpuConfig,
          HERMES_PORTABLE_OPENSHELL_VERSION,
        )
      : getSandboxRuntimeRegistryFields(effectiveSandboxGpuConfig);
    const createdSandboxCompletion = createOnboardCreatedSandboxCompletion(
      sandboxName,
      restoreBackupPath,
      pendingStateRestoreBackupPath,
      agent,
      fromDockerfile,
      { customOpenClawImage, isManagedDcodeAgent },
      { provider, model, preferredInferenceApi, endpointUrl: createIntent?.endpointUrl ?? null },
      { createIntent, resolvedCreateIntent },
      sandboxRuntimeFields,
      agentCreateInput.portableLifecycle,
      {
        toolDisclosure: effectiveToolDisclosure,
        dcodeAutoApprovalMode: dcodeAutoApprovalPlan.mode,
      },
      { webSearchConfig, hermesAuthMethod: normalizeHermesAuthMethod(hermesAuthMethod) },
      { plannedMessagingState, preservedMcpState, hermesToolGateways },
      hermesApiPortReservationScope.effectivePort,
      { gatewayName: GATEWAY_NAME, gatewayPort: GATEWAY_PORT },
      {
        initialSandboxPolicy,
        compatibilityPolicyPath,
        policyTier: resolvedCreatePolicyTier,
        policyAuthority: resolvedPolicyAuthority,
        getVerifiedPolicyBoundary: requireVerifiedPolicyGate,
        getVerifiedCreateRegistrationAuthority: () => ({
          reservation: requireCreateReservation(),
          checkpoint: requirePendingPolicyVerification(),
        }),
        revalidatePolicyAuthority: (operation) => {
          revalidateVerifiedPolicyRegistration(requireVerifiedPolicyGate(), operation);
        },
        dashboardRemoteBindPrepared,
      },
      prebuild.imageRef,
      buildId,
      effectiveSandboxGpuConfig,
      agentCreateInput.dockerDriverGateway,
      createGpuVerifier,
      runCaptureOpenshell,
      chatUiUrl,
      hermesDashboardState,
      dashboardPortReservationScope.release,
      ensureDashboardForward,
      getDashboardForwardPort,
      hermesDashboardForwarding.resolveStateForPort,
      hermesDashboardForwarding.ensureForState,
      managedWorkloadRuntime,
      preparedSandboxWorkload,
      note,
    );
    // Managed bootstrap can invalidate OpenShell's cached Ready state after it
    // replaces the container. Registry publication stays bound to the durable
    // sandbox identity recorded before that replacement.
    const completeCreatedSandboxRegistration =
      createOnboardCreatedSandboxRegistrationWithManagedLifecycle({
        sandboxName,
        managedBootstrap: managedBootstrap !== null,
        sandboxGpuEnabled: effectiveSandboxGpuConfig.sandboxGpuEnabled,
        createdLifecycle: createdSandboxLifecycle,
        getRecordedRegistration: () =>
          requireDurableCreatedSandboxIdentity(
            requireVerifiedPolicyGate().lifecycleLiveIdentityFingerprint,
          ),
        createRegistration: createOnboardCreatedSandboxRegistration,
        registration: {
          completion: createdSandboxCompletion,
          cleanupBuildContext,
          manageDashboard,
          sandboxGpuEnabled: effectiveSandboxGpuConfig.sandboxGpuEnabled,
        },
      });

    const providerPreparationInput = {
      openshellDriver: sandboxRuntimeFields.openshellDriver,
      inferenceProvider: resolvedCreateIntent.inferenceProvider,
      messagingProviders,
      messagingProviderRequests: resolvedCreateIntent.messagingProviderRequests,
      extraProviders: resolvedCreateIntent.extraProviders,
      gatewayName: GATEWAY_NAME,
    };
    const providerPreparationDeps = {
      providerExistsInGateway,
      runOpenshell,
      cleanupCreateSources: () => {
        cleanupInitialCreateSource();
        cleanupBuildContext();
      },
    };
    const providerEffectBoundary = createProviderEffectBoundary({
      deferred: createIntent?.deferSandboxEffectsUntilPolicyVerification === true,
      sandboxName,
      gatewayName: GATEWAY_NAME,
      preparationInput: providerPreparationInput,
      preparationDeps: providerPreparationDeps,
      runVerifiedSandboxCreateEffects,
      activateDeferredProviderEffects,
      revalidatePolicyAuthorityBeforeCreate: () =>
        revalidatePolicyAuthority(
          false,
          `publishing providers before creating sandbox gateway '${GATEWAY_NAME}'`,
        ),
    });
    providerEffectBoundary.validateBeforeCreate();

    if (hermesPortableAuthority) {
      if (!portableRuntimeContext?.environmentScope) {
        throw new Error("Hermes portable onboarding is missing runtime environment authority.");
      }
      if (managedBootstrap || !["none", "native-only"].includes(gpuRoutePlan)) {
        throw new Error(
          "Hermes portable onboarding cannot use managed bootstrap or Docker GPU compatibility.",
        );
      }
      if (!inferenceRouteReservationAuthority?.sessionId) {
        throw new Error(
          "Hermes portable onboarding is missing current inference route reservation authority.",
        );
      }
      const inferenceRouteReservation = {
        sessionId: inferenceRouteReservationAuthority.sessionId,
        selection: inferenceRouteReservationAuthority.selection,
      };
      await sandboxGpuCreateFlow.runHermesPortableOnboardingFromOnboard<
        import("../sandbox-gpu-create-flow").SandboxGpuCreateFlowResult
      >({
        sandboxName,
        gatewayName: GATEWAY_NAME,
        lifecycleGeneration: createdSandboxLifecycle.generation,
        portableRuntime: portableRuntimeContext,
        createArgv,
        createPolicyPath: initialSandboxPolicy.policyPath,
        startup: {
          agent: hermesPortableAuthority.agent,
          sandboxName,
          startupArgv: intendedSandboxStartupCommand,
        },
        inferenceRouteReservation,
        withLifecycleLock: sandboxMutationLock.withMcpLifecycleLock,
        childEnv: sandboxEnv,
        openshellArgv,
        createSandbox: (
          attemptArgv,
          readyCapture,
          readyRunner,
          buildContextPath,
          effectivePolicySourcePath,
        ) =>
          runCreateFlow(
            [...attemptArgv],
            readyCapture,
            readyRunner,
            buildContextPath,
            effectivePolicySourcePath,
          ),
        readRegistry: () => registry.getSandbox(sandboxName),
        revalidatePendingCreateRegistry: () =>
          revalidateVerifiedPolicyRegistration(
            requireVerifiedPolicyGate(),
            `requalify verified create checkpoint for sandbox '${sandboxName}'`,
          ),
        compareAndSetRegistryGatewayPort: registry.compareAndSetSandboxGatewayPort,
        registerSandbox: async (
          created,
          receipt,
          liveIdentityFingerprint,
          revalidate,
          routeReservation,
        ) =>
          completeHermesPortableSandboxRegistration({
            sandboxName,
            completeRegistration: () =>
              completeCreatedSandboxRegistration(
                created,
                receipt,
                liveIdentityFingerprint,
                revalidate,
                routeReservation,
              ),
            readRegistry: registry.getSandbox,
          }),
        sourceRoot: ROOT,
        buildContextSettings: {
          model,
          provider,
          preferredInferenceApi,
          toolDisclosure: effectiveToolDisclosure,
        },
        cleanupTemporaryPolicy: cleanupInitialCreateSource,
        createPolicySourceBytes: initialSandboxPolicy.sourceBytes,
      });
      cleanupBuildContext();
    } else {
      runForNewSandboxCreate(Boolean(resumeVerifiedCreateInput), () =>
        providerEffectBoundary.publishBeforeCreate(),
      );
      const created = await runCreateFlow(
        createArgv,
        undefined,
        undefined,
        undefined,
        undefined,
        providerEffectBoundary.runAfterVerifiedCreate,
      );
      try {
        await finalizeCreatedSandboxBeforeHermesCredentialReconciliation(
          async () => {
            const registration = await runAsyncWithPostCreateRecovery(
              () => completeCreatedSandboxRegistration(created, null),
              () => recordPostCreateRecovery("registry publication"),
            );
            verifiedPolicyRegistrationFinalized = true;
            return registration;
          },
          () =>
            reconcileCreatedHermesCredentialEnvironment(
              {
                sandboxName,
                plan: plannedMessagingState?.plan ?? null,
              },
              createHermesCredentialEnvReconciliationRuntime(
                (args, options) => runOpenshell([...args], options),
                (operation) => revalidatePolicyAuthority(true, operation),
              ),
              () => recordPostCreateRecovery("onboarding finalization"),
            ),
        );
      } finally {
        cleanupInitialCreateSource();
      }
    }
    return runWithPostCreateRecovery(
      () => {
        hermesStateVolumeLifecycle?.commit();
        if ("complete" in recreateRuntime) recreateRuntime.complete();
        if (agentCreateInput.hermesPortableLifecycle) return sandboxName;
        return completeOrdinaryOnboardSandboxCreation(
          {
            sandboxName,
            sandboxWasLiveDefault,
            gatewayPort: GATEWAY_PORT,
            runtimeFields: sandboxRuntimeFields,
            messagingProviders,
            liveExists,
            ...cancelRecoveryIdentity(liveExists, requireVerifiedPolicyGate),
          },
          {
            setDefault: registry.setDefault,
            runFile,
            scriptsDir: SCRIPTS,
            gatewayName: GATEWAY_NAME,
            providerExistsInGateway,
            armCancelRollback: (name, identity) =>
              sandboxCancelRollback.arm(
                name,
                identity,
                retainedSandboxRecoveryContext(requireVerifiedPolicyGate()),
              ),
            markCancellationRecovery: (name) =>
              onboardSession.markCancellationRecovery(
                name,
                undefined,
                retainedSandboxRecoveryContext(requireVerifiedPolicyGate()),
              ),
            dockerInfoFormat,
            runCapture,
            revalidatePolicyAuthority: (operation) => revalidatePolicyAuthority(true, operation),
          },
        );
      },
      () => recordPostCreateRecovery("onboarding finalization"),
    );
  };
}

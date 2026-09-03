// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { createHermesCredentialEnvReconciliationRuntime } from "../../actions/sandbox/runtime/hermes-lifecycle";
import type { SandboxCreateOrchestrationRuntime } from "../../onboard";
import { HERMES_PORTABLE_OPENSHELL_VERSION } from "../../adapters/openshell/resolve-shared";
import { createCliOpenShellSandboxObserverFromRunner } from "../../adapters/openshell/sandbox-observer-cli";
import { NEMOCLAW_CREATE_ATTEMPT_LABEL } from "../../adapters/openshell/sandbox-identity";
import type { AgentDefinition } from "../../agent/defs";
import type { WebSearchConfig } from "../../inference/web-search";
import {
  getMessagingPolicyKeysByChannel,
  listMessagingPolicyPresetMetadata,
} from "../../messaging/channels/metadata";
import { loadMessagingChannelPolicyPreset } from "../../messaging/channels/policy";
import { normalizeWechatIlinkBaseUrl } from "../../messaging/channels/wechat/ilink-base-url";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import type { MessagingChannelConfig } from "../../messaging-channel-config";
import {
  isDcodeAgent,
  OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
} from "../observability-policy-presets";
import { RESTRICTED_TIER_NAME } from "../policy-tier-suppression";
import type { BackupResult } from "../../state/sandbox";
import type { RetainedSandboxRecoveryContext, Session } from "../../state/onboard-session";
import type { SandboxEntry, SandboxMcpState } from "../../state/registry";
import type {
  PendingSandboxCreateIdentity,
  QualifiedPendingSandboxCreateReservation,
} from "../../state/registry";
import type { HermesAuthMethod } from "../hermes-auth";
import {
  getMessagingChannelConfigFromPlan,
  getStoredMessagingChannelConfig,
} from "../messaging-config";
import type { PreparedSandboxBuildContext } from "../build-context-stage";
import type { DcodeSelectionDriftReader } from "../dcode-selection-drift";
import {
  assertProviderlessInterceptorEnvironment,
  enforceRemovedImmutabilityMigrationBoundary,
} from "../entry-options";
import type {
  ManagedHermesStateVolumeCleanupResult,
  ManagedHermesStateVolumeContext,
} from "../managed-workload/hermes-state-volume";
import { removeManagedHermesStateVolume } from "../managed-workload/hermes-state-volume";
import {
  createOnboardRecreateGatewayAuthorityRevalidator,
  type OwnedSandboxRecreateRuntime,
} from "../onboard-recreate-journal";
import { managedImageRuntimeIdentity } from "../managed-image/agents";
import {
  managedStartupStateRoots,
  MANAGED_HERMES_STATE_ROOT,
} from "../managed-startup/state-roots";
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
  VerifiedSandboxCreateBoundary,
} from "../types";
import * as sandboxCreatePlanMaterialization from "../sandbox-create-plan-materialization";
import {
  pendingSandboxCreateIdentityForBoundary,
  sandboxCreateBoundaryFromPendingIdentity,
} from "./identity-boundary";
import {
  attachProvidersAfterSandboxCreation,
  publishAttachedProvidersBeforeDockerSandboxCreation,
  validateAttachedMessagingProvidersBeforeSandboxCreation,
} from "./provider-publication";
import { materializeRebuildPolicyHandoff } from "./rebuild-policy-handoff";

function cancelRecoveryIdentity(
  liveExists: boolean,
  requireVerifiedCreateBoundary: () => VerifiedSandboxCreateBoundary,
): { readonly lifecycleLiveIdentityFingerprint?: string } {
  if (liveExists) return {};
  return {
    lifecycleLiveIdentityFingerprint:
      requireVerifiedCreateBoundary().lifecycleLiveIdentityFingerprint,
  };
}

/** Finalize provider arguments from the exact policy that creation consumes. */
export function bindRebuildPolicyProvidersToCreateArgs(
  createArgs: readonly string[],
  policy: Pick<import("../initial-policy").InitialSandboxPolicy, "credentialBindingProviders">,
): string[] {
  const result = [...createArgs];
  const attached = new Set(
    result.flatMap((value, index) =>
      index > 0 && result[index - 1] === "--provider" ? [value] : [],
    ),
  );
  for (const provider of policy.credentialBindingProviders ?? []) {
    if (attached.has(provider)) continue;
    const startupCommandSeparator = result.indexOf("--");
    const insertionIndex = startupCommandSeparator < 0 ? result.length : startupCommandSeparator;
    result.splice(insertionIndex, 0, "--provider", provider);
    attached.add(provider);
  }
  return result;
}

/**
 * Admit credential providers only from replacement inputs that were validated
 * independently of the live policy document. The live policy remains the
 * policy source of truth; this list only proves that each provider attachment
 * it references already belongs to the exact create, messaging, or managed MCP
 * replacement transaction.
 */
export function resolveRebuildPolicyProviderAuthority(input: {
  readonly createArgs: readonly string[];
  readonly messagingPlan:
    | Pick<SandboxMessagingPlan, "credentialBindings" | "disabledChannels">
    | null
    | undefined;
  readonly preservedMcpState: SandboxMcpState | undefined;
  readonly managedMcpRebuildHandoff: boolean;
}): string[] {
  const providers = new Set(
    input.createArgs.flatMap((value, index, args) =>
      index > 0 && args[index - 1] === "--provider" ? [value] : [],
    ),
  );
  const disabledChannels = new Set(input.messagingPlan?.disabledChannels ?? []);
  for (const binding of input.messagingPlan?.credentialBindings ?? []) {
    if (disabledChannels.has(binding.channelId)) continue;
    providers.add(binding.providerName);
  }
  if (input.managedMcpRebuildHandoff) {
    for (const entry of Object.values(input.preservedMcpState?.bridges ?? {})) {
      if (entry.addState || !entry.providerName || !entry.providerId) continue;
      providers.add(entry.providerName);
    }
  }
  return [...providers];
}

function asMessagingAgentId(
  agent: string | null | undefined,
): SandboxMessagingPlan["agent"] | null {
  return agent === "openclaw" || agent === "hermes" ? agent : null;
}

export function resolveRebuildMessagingPolicyDeltas(
  plan:
    | Pick<SandboxMessagingPlan, "agent" | "disabledChannels" | "networkPolicy">
    | null
    | undefined,
  fallback?: {
    readonly agent?: SandboxMessagingPlan["agent"] | null;
    readonly messagingConfig?: MessagingChannelConfig | null;
  },
): {
  readonly requiredNetworkPolicyKeys: readonly string[];
  readonly requiredNetworkPolicyPresetNames: readonly string[];
  readonly removedNetworkPolicyKeys: readonly string[];
} {
  if (!plan) {
    const wechatIlinkOrigin = normalizeWechatIlinkBaseUrl(
      fallback?.messagingConfig?.WECHAT_BASE_URL,
    );
    if (!wechatIlinkOrigin) {
      return {
        requiredNetworkPolicyKeys: [],
        requiredNetworkPolicyPresetNames: [],
        removedNetworkPolicyKeys: [],
      };
    }
    const fallbackAgent = fallback?.agent;
    const wechatPolicy = fallbackAgent
      ? listMessagingPolicyPresetMetadata({ agent: fallbackAgent }).find(
          ({ channelId }) => channelId === "wechat",
        )
      : undefined;
    if (!fallbackAgent || !wechatPolicy) {
      throw new Error(
        "Cannot prepare a legacy WeChat rebuild policy without manifest metadata for the effective agent.",
      );
    }
    return {
      requiredNetworkPolicyKeys:
        wechatPolicy.agentPolicyKeys[fallbackAgent] ?? wechatPolicy.policyKeys,
      requiredNetworkPolicyPresetNames: [wechatPolicy.presetName],
      removedNetworkPolicyKeys: [],
    };
  }
  const disabledChannels = new Set(plan.disabledChannels);
  const policyKeysByChannel = getMessagingPolicyKeysByChannel({ agent: plan.agent });
  return {
    requiredNetworkPolicyKeys: [
      ...new Set(
        plan.networkPolicy.entries
          .filter((entry) => !disabledChannels.has(entry.channelId))
          .flatMap((entry) => entry.policyKeys),
      ),
    ],
    requiredNetworkPolicyPresetNames: [
      ...new Set(
        plan.networkPolicy.entries
          .filter((entry) => !disabledChannels.has(entry.channelId))
          .map((entry) => entry.presetName),
      ),
    ],
    removedNetworkPolicyKeys: [
      ...new Set(
        plan.disabledChannels.flatMap((channelId) => policyKeysByChannel[channelId] ?? []),
      ),
    ],
  };
}

export function resolveRebuildObservabilityPolicyDelta(input: {
  readonly agent: string | null | undefined;
  readonly enabled: boolean | null | undefined;
  readonly explicitlyRequested: boolean | null | undefined;
  readonly tierName: string | null | undefined;
}): {
  readonly requiredNetworkPolicyKeys: readonly string[];
  readonly removedNetworkPolicyKeys: readonly string[];
} {
  if (!isDcodeAgent(input.agent) || input.explicitlyRequested !== true) {
    return { requiredNetworkPolicyKeys: [], removedNetworkPolicyKeys: [] };
  }
  const required = input.enabled === true && input.tierName !== RESTRICTED_TIER_NAME;
  return required
    ? {
        requiredNetworkPolicyKeys: [OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET],
        removedNetworkPolicyKeys: [],
      }
    : {
        requiredNetworkPolicyKeys: [],
        removedNetworkPolicyKeys: [OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET],
      };
}

/** Preserve OpenShell's live policy plus bounded requirements for this explicit create. */
export function selectRebuildCreatePolicy(
  policySourcePath: string,
  generatedPolicy: import("../initial-policy").InitialSandboxPolicy,
  requiredNetworkPolicyKeys: readonly string[],
  removedNetworkPolicyKeys: readonly string[],
  requiredNetworkPolicyPresetNames: readonly string[],
  messagingAgent: string | null | undefined,
  messagingConfig: MessagingChannelConfig | null | undefined,
  sandboxName: string,
  authorizedCredentialBindingProviders: readonly string[],
): import("../initial-policy").InitialSandboxPolicy {
  const requiredNetworkPolicySources = requiredNetworkPolicyPresetNames.map((presetName) => {
    const source = loadMessagingChannelPolicyPreset(presetName, {
      agent: messagingAgent,
      sandboxName,
      messagingConfig,
    });
    if (!source) {
      throw new Error(
        `Cannot prepare rebuild policy handoff: required messaging policy preset '${presetName}' is unavailable.`,
      );
    }
    return source;
  });
  return materializeRebuildPolicyHandoff({
    sandboxName,
    livePolicyPath: policySourcePath,
    replacementPolicy: generatedPolicy,
    requiredNetworkPolicyKeys,
    removedNetworkPolicyKeys,
    requiredNetworkPolicySources,
    authorizedCredentialBindingProviders,
  });
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

/** Require the generic deferred-effect gate for explicit APF creation. */
export function assertApfCreateIntent(
  createIntent: Pick<
    SandboxCreateIntent,
    "apfInterceptorRequested" | "deferSandboxEffectsUntilIdentityVerification"
  > | null,
): void {
  if (
    createIntent?.apfInterceptorRequested === true &&
    createIntent.deferSandboxEffectsUntilIdentityVerification !== true
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
    revalidateSandboxIdentity: (operation: string) => void,
  ) => {
    readonly changed: boolean;
  };
  readonly restartGateway: (
    sandboxName: string,
    revalidateSandboxIdentity: (operation: string) => void,
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
    revalidateSandboxIdentity: (operation: string) => void,
  ) => boolean;
  readonly revalidateSandboxIdentity: (operation: string) => void;
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

    deps.revalidateSandboxIdentity(
      `reconciling Hermes messaging credentials for sandbox '${input.sandboxName}'`,
    );
    const reconciliation = deps.reconcileCredentialEnv(input.plan, deps.revalidateSandboxIdentity);
    deps.revalidateSandboxIdentity(
      `confirming Hermes messaging credential reconciliation for sandbox '${input.sandboxName}'`,
    );
    if (!reconciliation.changed) return;

    const restart = deps.restartGateway(input.sandboxName, deps.revalidateSandboxIdentity);
    if (!deps.parseRestartCompletion(restart)) {
      throw new Error(
        `Hermes messaging credential reconciliation changed the gateway environment for sandbox '${input.sandboxName}', but the managed gateway restart did not complete.`,
      );
    }
    if (!deps.waitForGateway(input.sandboxName, deps.revalidateSandboxIdentity)) {
      throw new Error(
        `Hermes messaging credential reconciliation restarted sandbox '${input.sandboxName}', but the managed gateway did not remain healthy.`,
      );
    }
    deps.revalidateSandboxIdentity(
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
 * Keep every effect after an unverified create behind one exact-identity gate.
 *
 * The create callback owns the create transaction. It must await the supplied gate
 * immediately after OpenShell returns the exact created identity and before provider,
 * credential, service, runtime, registry, or completion effects.
 */
export async function runSandboxCreateWithIdentityVerification<
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
  readonly captureVerifiedCreateBoundary: (created: Created, exactIdentity: string) => Evidence;
  readonly persistCreateIdentity: (
    created: Created,
    exactIdentity: string,
    evidence: Evidence,
  ) => void;
  readonly revalidateVerifiedCreateIdentity: (
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
  let verifiedCreateEvidence: Evidence | null = null;
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
            verifiedCreateEvidence,
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
      `Sandbox post-create verification or finalization failed; automatic sandbox cleanup was not safe. ${recoveryGuidance}`,
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
        `verifying created sandbox '${input.sandboxName}'`,
      );
      const evidence = input.captureVerifiedCreateBoundary(created, capturedIdentity);
      input.revalidateCreatedSandboxIdentity(
        capturedIdentity,
        `recording pending create identity for sandbox '${input.sandboxName}'`,
      );
      verifiedCreateEvidence = evidence;
      input.persistCreateIdentity(created, capturedIdentity, evidence);
      input.revalidateVerifiedCreateIdentity(
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

async function validatePortableManagedWorkloadSelection(input: {
  readonly portableLifecycle: boolean;
  readonly selectionNeedsValidation: boolean;
  readonly prepareWorkload: () => Promise<unknown>;
}): Promise<void> {
  if (!input.portableLifecycle || !input.selectionNeedsValidation) return;
  await input.prepareWorkload();
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
    | ((revalidateSandboxIdentity: (operation: string) => void) => readonly string[])
    | null;
  readonly revalidateSandboxIdentityBeforeCreate: () => void;
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
        input.revalidateSandboxIdentityBeforeCreate();
        publish();
      },
      runAfterVerifiedCreate: undefined,
    };
  }
  return {
    validateBeforeCreate: () => undefined,
    publishBeforeCreate: () => undefined,
    runAfterVerifiedCreate: async (context) => {
      context.revalidateSandboxIdentity(
        `starting deferred provider effects for sandbox '${input.sandboxName}'`,
      );
      await input.runVerifiedSandboxCreateEffects?.(context);
      context.revalidateSandboxIdentity(
        `activating deferred providers for sandbox '${input.sandboxName}'`,
      );
      const providerNames =
        input.activateDeferredProviderEffects?.(context.revalidateSandboxIdentity) ?? [];
      validate();
      context.revalidateSandboxIdentity(
        `publishing deferred providers for sandbox '${input.sandboxName}'`,
      );
      publish();
      context.revalidateSandboxIdentity(
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
      readonly revalidateSandboxIdentity: (operation: string) => void;
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
          input.revalidateSandboxIdentity(operation);
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
}): PendingSandboxCreateIdentity | null {
  const checkpoint = input.entry?.pendingCreateIdentity;
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
  readonly openingCheckpoint: PendingSandboxCreateIdentity | null;
  readonly sandboxName: string;
  readonly readEntry: () => SandboxEntry | null;
}): PendingSandboxCreateIdentity | null {
  const entry = input.acceptedTarget ? input.readEntry() : null;
  const checkpoint =
    entry?.pendingRouteReservation === true ? (entry.pendingCreateIdentity ?? null) : null;
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

function selectRecreateGatewayAuthority(
  requested: boolean,
  target: { sandboxName: string; gatewayName: string; gatewayPort: number },
) {
  return requested ? createOnboardRecreateGatewayAuthorityRevalidator(target) : undefined;
}

function deleteJournaledRecreateSource(input: {
  readonly runtime: Pick<
    import("../sandbox-recreate-transaction").SandboxRecreateRuntime,
    "beginDelete" | "journaledGatewayName"
  >;
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly runOpenshell: SandboxCreateOrchestrationRuntime["runOpenshell"];
}): void {
  if (input.runtime.beginDelete() !== "source") return;
  input.runOpenshell(
    [
      "sandbox",
      "delete",
      "-g",
      input.runtime.journaledGatewayName ?? input.gatewayName,
      input.sandboxName,
    ],
    { ignoreError: true },
  );
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
    allowRemovedImmutabilityStateRecord = false,
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
    enforceRemovedImmutabilityMigrationBoundary(sandboxName, {
      allowStateRecord: allowRemovedImmutabilityStateRecord,
    });
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
    const prepareManagedStateVolumeLifecycle = (
      workload: Awaited<ReturnType<typeof ensurePreparedSandboxWorkload>>,
    ) => {
      const managedStateRoots =
        workload.source.kind === "managed-image"
          ? managedStartupStateRoots({
              agent: workload.source.contract.agent,
              sandboxName,
              agentIdentity: managedImageRuntimeIdentity(workload.source.contract.agent),
            })
          : [];
      return managedWorkloadOnboard.createManagedStateVolumeOnboardLifecycle({
        roots: managedStateRoots,
        runtimeProvider: managedWorkloadRuntime.runtimeProvider,
      });
    };
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
          removeManagedHermesStateVolume: (context) =>
            removeManagedHermesStateVolume(context, {
              runtimeProvider: managedWorkloadRuntime.runtimeProvider ?? undefined,
            }),
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
    let verifiedCreateBoundary: VerifiedSandboxCreateBoundary | null = null;
    let pendingCreateIdentity: PendingSandboxCreateIdentity | null = null;
    let admittedCreateReservation: QualifiedPendingSandboxCreateReservation | null = null;
    let createEffectsFinalized = false;
    const createCheckpointSession = onboardSession.loadSession();
    const effectiveMessagingConfig =
      getMessagingChannelConfigFromPlan(plannedMessagingState?.plan) ??
      getStoredMessagingChannelConfig(sandboxName, createCheckpointSession);
    const effectiveMessagingAgent = plannedMessagingState?.plan?.agent ?? effectiveAgent.name;
    const openingPendingCreateIdentity = pendingVerifiedCreateCheckpointForSession({
      sandboxName,
      gatewayName: GATEWAY_NAME,
      liveExists,
      entry: existingEntry,
      session: createCheckpointSession,
      request: createIntent?.recreateTransaction,
    });
    const revalidateSandboxIdentity = (sandboxIsLive: boolean, operation: string): void => {
      if (sandboxIsLive && !createEffectsFinalized && verifiedCreateBoundary) {
        revalidateVerifiedCreateIdentity(requireVerifiedCreateBoundary(), operation);
      }
    };
    const recreateRegistryEntry = readSandboxRecreateRegistryEntry({
      sandboxName,
      recreateTransaction: Boolean(createIntent?.recreateTransaction),
      existingEntry,
      readRegistry: registry.getSandbox,
    });
    const recreateGatewayAuthority = selectRecreateGatewayAuthority(
      Boolean(createIntent?.recreateTransaction),
      { sandboxName, gatewayName: GATEWAY_NAME, gatewayPort: GATEWAY_PORT },
    );
    let recreateRuntime:
      | import("../sandbox-recreate-transaction").SandboxRecreateRuntime
      | OwnedSandboxRecreateRuntime = sandboxRecreateTransaction.createSandboxRecreateRuntime(
      onboardSession,
      createIntent?.recreateTransaction,
      sandboxName,
      GATEWAY_NAME,
      recreateRegistryEntry,
      getSandboxRecreateObservation,
      note,
      () => registry.getSandbox(sandboxName),
      recreateGatewayAuthority?.revalidate,
    );
    const acceptedTargetPendingIdentity = readAcceptedPendingVerifiedCreate({
      acceptedTarget: recreateRuntime.acceptedTarget,
      openingCheckpoint: openingPendingCreateIdentity,
      sandboxName,
      readEntry: () => registry.getSandbox(sandboxName),
    });
    const resumingVerifiedCreate = acceptedTargetPendingIdentity !== null;
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
        revalidateSandboxIdentity: (operation) => revalidateSandboxIdentity(true, operation),
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
        },
      });
    let pendingStateRestoreBackupPath: string | null = null,
      preparedSandboxWorkload!: Awaited<ReturnType<typeof ensurePreparedSandboxWorkload>>,
      managedStateVolumeLifecycle!: ReturnType<typeof prepareManagedStateVolumeLifecycle>;
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
              revalidateSandboxIdentity(true, `reusing sandbox '${sandboxName}'`);
              // Upsert messaging providers even on reuse so credential changes take
              // effect without requiring a full sandbox recreation.
              upsertMessagingProviders(messagingTokenDefs, {
                revalidateSandboxIdentity: (operation) =>
                  revalidateSandboxIdentity(true, operation),
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
              revalidateSandboxIdentity(true, `reusing sandbox '${sandboxName}'`);
              upsertMessagingProviders(messagingTokenDefs, {
                revalidateSandboxIdentity: (operation) =>
                  revalidateSandboxIdentity(true, operation),
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

      managedStateVolumeLifecycle = prepareManagedStateVolumeLifecycle(preparedSandboxWorkload);
      note(`  Deleting and recreating sandbox '${sandboxName}'...`);

      revalidateSandboxIdentity(true, `recreating sandbox '${sandboxName}'`);
      if (recreateRuntime.beginDelete() === "source") {
        runAuthorityBoundProviderCleanup({
          sandboxName,
          revalidateSandboxIdentity: (operation) => revalidateSandboxIdentity(true, operation),
          runProviderPreDeleteCleanup: runSandboxProviderPreDeleteCleanup,
          runOpenshell,
          redact,
        });
        revalidateSandboxIdentity(true, `deleting sandbox '${sandboxName}'`);
        deleteJournaledRecreateSource({
          runtime: recreateRuntime,
          sandboxName,
          gatewayName: GATEWAY_NAME,
          runOpenshell,
        });
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
      finalizeRecreatedSourceHermesVolume(
        true,
        previousEntry,
        managedStateVolumeLifecycle.roots.some(
          (root) => root.mountTarget === MANAGED_HERMES_STATE_ROOT,
        ),
      );
      await hermesApiPortReservationScope.rebindAfterOwnedForwardDelete(
        hermesApiPortReservationInput,
      );
    }
    if (resumingVerifiedCreate) {
      await hermesApiPortReservationScope.selectAndReserve(hermesApiPortReservationInput);
      preparedSandboxWorkload = await ensurePreparedSandboxWorkload();
      managedStateVolumeLifecycle = prepareManagedStateVolumeLifecycle(preparedSandboxWorkload);
    } else if (!liveExists || agentCreateInput.hermesPortableLifecycle) {
      if (!agentCreateInput.hermesPortableLifecycle) {
        await hermesApiPortReservationScope.selectAndReserve(hermesApiPortReservationInput);
      }
      preparedSandboxWorkload = await ensurePreparedSandboxWorkload();
      managedStateVolumeLifecycle = prepareManagedStateVolumeLifecycle(preparedSandboxWorkload);
      finalizeRecreatedSourceHermesVolume(
        !liveExists,
        existingEntry,
        managedStateVolumeLifecycle.roots.some(
          (root) => root.mountTarget === MANAGED_HERMES_STATE_ROOT,
        ),
      );
    }
    runForNewSandboxCreate(resumingVerifiedCreate, () => {
      revalidateSandboxIdentity(false, `creating sandbox '${sandboxName}'`);
      sandboxCreatePlanMaterialization.applyOrdinaryExtraProviderReconciliation(
        agentCreateInput.hermesPortableLifecycle,
        () => {
          revalidateSandboxIdentity(false, `updating providers for sandbox '${sandboxName}'`);
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
              policylessCreate: apfInterceptorRequested,
              deferSandboxEffectsUntilIdentityVerification:
                createIntent?.deferSandboxEffectsUntilIdentityVerification === true,
              rebindMessagingTokenDefs: async () => {
                revalidateSandboxIdentity(
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
              runProviderPreDeleteCleanup: (verifiedIdentityRevalidation) => {
                runAuthorityBoundProviderCleanup({
                  sandboxName,
                  runProviderPreDeleteCleanup: runSandboxProviderPreDeleteCleanup,
                  runOpenshell,
                  redact,
                  tolerateMissingSandbox: true,
                  ...(verifiedIdentityRevalidation
                    ? { revalidateSandboxIdentity: verifiedIdentityRevalidation }
                    : {
                        observeSandbox: () =>
                          getSandboxRecreateObservation(sandboxName, GATEWAY_NAME),
                        revalidateSandboxIdentity: (operation: string) =>
                          revalidateSandboxIdentity(false, operation),
                      }),
                });
              },
              upsertMessagingProviders: (tokenDefs, options) =>
                upsertMessagingProviders(tokenDefs, {
                  ...options,
                  revalidateSandboxIdentity: (operation) =>
                    (
                      options.revalidateSandboxIdentity ??
                      ((targetOperation) => revalidateSandboxIdentity(false, targetOperation))
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
            messagingConfig: effectiveMessagingConfig,
            gpu: {
              provider,
              config: effectiveSandboxGpuConfig,
              dockerDriverGateway: agentCreateInput.dockerDriverGateway,
              gatewayPort: GATEWAY_PORT,
            },
            dependencies: {
              materializeSandboxCreatePlan: (input) =>
                managedStateVolumeLifecycle.materializeSandboxCreatePlan(
                  input,
                  sandboxCreatePlanMaterialization.materializeSandboxCreatePlan,
                ),
              prepareSandboxBuildPatchConfig:
                sandboxBuildPatchConfig.prepareSandboxBuildPatchConfig,
            },
          }),
      );
    const {
      initialSandboxPolicy: materializedInitialSandboxPolicy,
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
        createArgv: materializedCreateArgv,
        intendedSandboxStartupCommand,
        managedBootstrapIdentity,
        managedStartupRootApplyRequest,
        prebuild,
        sandboxEnv,
        sandboxStartupCommand,
      },
    } = preparedOnboardLaunch;
    const rebuildMessagingPolicyDeltas = resolveRebuildMessagingPolicyDeltas(
      plannedMessagingState?.plan,
      {
        agent: asMessagingAgentId(effectiveMessagingAgent),
        messagingConfig: effectiveMessagingConfig,
      },
    );
    const rebuildObservabilityPolicyDelta = resolveRebuildObservabilityPolicyDelta({
      agent: agent?.name,
      enabled: createIntent?.observabilityEnabled,
      explicitlyRequested: createIntent?.observabilityRequestedExplicitly,
      tierName: createIntent?.policyTier,
    });
    const rebuildPolicyProviderAuthority = resolveRebuildPolicyProviderAuthority({
      createArgs: materializedCreateArgv,
      messagingPlan: plannedMessagingState?.plan,
      preservedMcpState,
      managedMcpRebuildHandoff: hasManagedMcpRebuildHandoff(createIntent),
    });
    const initialSandboxPolicy = createIntent?.rebuildPolicySourcePath
      ? selectRebuildCreatePolicy(
          createIntent.rebuildPolicySourcePath,
          materializedInitialSandboxPolicy,
          [
            ...rebuildMessagingPolicyDeltas.requiredNetworkPolicyKeys,
            ...rebuildObservabilityPolicyDelta.requiredNetworkPolicyKeys,
          ],
          [
            ...rebuildMessagingPolicyDeltas.removedNetworkPolicyKeys,
            ...rebuildObservabilityPolicyDelta.removedNetworkPolicyKeys,
          ],
          rebuildMessagingPolicyDeltas.requiredNetworkPolicyPresetNames,
          effectiveMessagingAgent,
          effectiveMessagingConfig,
          sandboxName,
          rebuildPolicyProviderAuthority,
        )
      : materializedInitialSandboxPolicy;
    const createArgv = createIntent?.rebuildPolicySourcePath
      ? bindRebuildPolicyProvidersToCreateArgs(
          materializedCreateArgv.map((value, index, argv) =>
            index > 0 && argv[index - 1] === "--policy" ? initialSandboxPolicy.policyPath : value,
          ),
          initialSandboxPolicy,
        )
      : materializedCreateArgv;
    const restoreBackupPath =
      pendingStateRestore?.manifest?.backupPath ?? pendingStateRestoreBackupPath;
    onboardSessionBootstrap.verifyReadOnlyHostMountSources(resolvedCreateIntent.hostMounts);
    runForNewSandboxCreate(agentCreateInput.hermesPortableLifecycle || resumingVerifiedCreate, () =>
      recreateRuntime.advance("creating"),
    );
    const managedBootstrap = managedWorkloadOnboard.resolveOnboardManagedBootstrapLaunch({
      runtime: managedWorkloadRuntime,
      workload: preparedSandboxWorkload,
      sandboxName,
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
    const requireVerifiedCreateBoundary = (): NonNullable<typeof verifiedCreateBoundary> => {
      if (!verifiedCreateBoundary) {
        throw new Error("Sandbox creation has no verified post-create requirements boundary.");
      }
      return verifiedCreateBoundary;
    };
    const requirePendingCreateIdentity = (): PendingSandboxCreateIdentity => {
      if (!pendingCreateIdentity) {
        throw new Error("Sandbox creation has no pending create identity.");
      }
      return pendingCreateIdentity;
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
        throw new Error("Sandbox created identity journal changed before registry publication.");
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
    const resumeVerifiedCreateInput = (() => {
      const checkpoint = acceptedTargetPendingIdentity;
      if (!checkpoint) return null;
      if (agentCreateInput.hermesPortableLifecycle) {
        throw new Error("Hermes portable onboarding cannot resume an ordinary verified create.");
      }
      const boundary = sandboxCreateBoundaryFromPendingIdentity(checkpoint);
      admittedCreateReservation = admitCreateReservation();
      registry.requireCurrentPendingSandboxCreateIdentity(admittedCreateReservation, checkpoint);
      durableCreatedSandboxIdentity = createdSandboxLifecycle.recordExactIdentity(
        checkpoint.sandboxIdentityFingerprint,
      );
      revalidateCreatedSandboxIdentity(
        checkpoint.sandboxIdentityFingerprint,
        `resuming sandbox creation for '${sandboxName}'`,
      );
      revalidateCreatedSandboxIdentity(
        checkpoint.sandboxIdentityFingerprint,
        `resuming sandbox creation for '${sandboxName}'`,
      );
      registry.requireCurrentPendingSandboxCreateIdentity(admittedCreateReservation, checkpoint);
      pendingCreateIdentity = checkpoint;
      verifiedCreateBoundary = boundary;
      return {
        route: checkpoint.route,
        liveIdentityFingerprint: checkpoint.sandboxIdentityFingerprint,
        ...(checkpoint.createAttemptNonce
          ? { createAttemptNonce: checkpoint.createAttemptNonce }
          : {}),
      };
    })();
    const revalidateVerifiedCreateIdentity = (
      boundary: VerifiedSandboxCreateBoundary,
      operation: string,
    ): SandboxEntry => {
      registry.requireCurrentPendingSandboxCreateIdentity(
        requireCreateReservation(),
        requirePendingCreateIdentity(),
      );
      revalidateCreatedSandboxIdentity(boundary.lifecycleLiveIdentityFingerprint, operation);
      return registry.requireCurrentPendingSandboxCreateIdentity(
        requireCreateReservation(),
        requirePendingCreateIdentity(),
      );
    };
    const retainedSandboxRecoveryContext = (
      boundary: VerifiedSandboxCreateBoundary | null,
      createAttemptNonceOverride: string | null = null,
    ): RetainedSandboxRecoveryContext => {
      const createAttemptNonce = boundary?.createAttemptNonce ?? createAttemptNonceOverride;
      if (!createAttemptNonce) {
        throw new Error("Retained sandbox recovery requires exact create-attempt authority.");
      }
      return {
        gatewayName: GATEWAY_NAME,
        gatewayPort: GATEWAY_PORT,
        lifecycleGeneration: createdSandboxLifecycle.generation,
        createAttemptNonce,
      };
    };
    const recordPostCreateRecovery = (
      stage: "registry publication" | "onboarding finalization",
    ): void => {
      const boundary = requireVerifiedCreateBoundary();
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
            recoveryContext: retainedSandboxRecoveryContext(
              verifiedCreateBoundary,
              createAttemptNonce,
            ),
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
        throw new Error("Hermes portable create policy source is incomplete.");
      }
      admittedCreateReservation = admitCreateReservation();
      return runSandboxCreateWithIdentityVerification<
        import("../sandbox-gpu-create-flow").CreatedSandboxIdentity,
        VerifiedSandboxCreateBoundary,
        import("../sandbox-gpu-create-flow").SandboxGpuCreateFlowResult
      >({
        sandboxName,
        revalidate: (sandboxIsLive, operation) =>
          revalidateSandboxIdentity(resumeVerifiedCreateInput ? true : sandboxIsLive, operation),
        captureCreatedSandboxIdentity: (
          identity: import("../sandbox-gpu-create-flow").CreatedSandboxIdentity,
        ) => identity.liveIdentityFingerprint,
        captureCreatedSandboxCreateAttemptNonce: (
          identity: import("../sandbox-gpu-create-flow").CreatedSandboxIdentity,
        ) => identity.createAttemptNonce,
        persistCreatedSandboxIdentity: (_identity, exactIdentity) =>
          persistCreatedSandboxIdentity(exactIdentity),
        revalidateCreatedSandboxIdentity,
        captureVerifiedCreateBoundary: (
          identity: import("../sandbox-gpu-create-flow").CreatedSandboxIdentity,
        ) => {
          if (effectivePolicySourcePath && identity.route === "compatibility") {
            throw new Error("Hermes portable create selected an unsupported GPU route.");
          }
          return {
            sandboxName,
            gatewayName: GATEWAY_NAME,
            gatewayPort: GATEWAY_PORT,
            lifecycleGeneration: createdSandboxLifecycle.generation,
            lifecycleLiveIdentityFingerprint: identity.liveIdentityFingerprint,
            createAttemptNonce: identity.createAttemptNonce,
            route: identity.route,
          };
        },
        persistCreateIdentity: (_identity, _exactIdentity, boundary) => {
          requireDurableCreatedSandboxIdentity(boundary.lifecycleLiveIdentityFingerprint);
          const checkpoint = pendingSandboxCreateIdentityForBoundary(boundary);
          registry.recordPendingSandboxCreateIdentity(requireCreateReservation(), checkpoint, {
            ...(pendingCreateIdentity ? { expected: pendingCreateIdentity } : {}),
          });
          pendingCreateIdentity = checkpoint;
          verifiedCreateBoundary = boundary;
        },
        revalidateVerifiedCreateIdentity: (_identity, _exactIdentity, boundary, operation) => {
          revalidateVerifiedCreateIdentity(boundary, operation);
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
                revalidateSandboxIdentity: (operation) =>
                  revalidateVerifiedCreateIdentity(boundary, operation),
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
                revalidateVerifiedCreateIdentity(requireVerifiedCreateBoundary(), operation),
              ...agentCreateInput,
            },
            {
              runOpenshell: hermesPortableReadyRunner ?? runOpenshell,
              runCaptureOpenshell: hermesPortableReadyCapture ?? runCaptureOpenshell,
              sandboxObserver: createCliOpenShellSandboxObserverFromRunner(
                hermesPortableReadyRunner ?? runOpenshell,
              ),
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
        getVerifiedCreateBoundary: requireVerifiedCreateBoundary,
        getVerifiedCreateRegistrationAuthority: () => ({
          reservation: requireCreateReservation(),
          checkpoint: requirePendingCreateIdentity(),
        }),
        revalidateSandboxIdentity: (operation) => {
          revalidateVerifiedCreateIdentity(requireVerifiedCreateBoundary(), operation);
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
      getDashboardForwardPort,
      hermesDashboardForwarding.resolveStateForPort,
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
            requireVerifiedCreateBoundary().lifecycleLiveIdentityFingerprint,
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
      deferred: createIntent?.deferSandboxEffectsUntilIdentityVerification === true,
      sandboxName,
      gatewayName: GATEWAY_NAME,
      preparationInput: providerPreparationInput,
      preparationDeps: providerPreparationDeps,
      runVerifiedSandboxCreateEffects,
      activateDeferredProviderEffects,
      revalidateSandboxIdentityBeforeCreate: () =>
        revalidateSandboxIdentity(
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
          revalidateVerifiedCreateIdentity(
            requireVerifiedCreateBoundary(),
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
            createEffectsFinalized = true;
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
                (operation) => revalidateSandboxIdentity(true, operation),
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
        managedStateVolumeLifecycle.commit();
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
            ...cancelRecoveryIdentity(liveExists, requireVerifiedCreateBoundary),
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
                retainedSandboxRecoveryContext(requireVerifiedCreateBoundary()),
              ),
            markCancellationRecovery: (name) =>
              onboardSession.markCancellationRecovery(
                name,
                undefined,
                retainedSandboxRecoveryContext(requireVerifiedCreateBoundary()),
              ),
            dockerInfoFormat,
            runCapture,
            revalidateSandboxIdentity: (operation) => revalidateSandboxIdentity(true, operation),
          },
        );
      },
      () => recordPostCreateRecovery("onboarding finalization"),
    );
  };
}

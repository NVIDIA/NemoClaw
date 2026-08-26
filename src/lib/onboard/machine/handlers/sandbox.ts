// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type CurrentGatewayRouteCompatibilityCheck,
  formatGatewayRouteConflict,
  type GatewayRouteCompatibilityResult,
  isAdvisoryGatewayRouteConflict,
} from "../../../inference/gateway-route-compatibility";
import type { InferenceEndpointSource } from "../../../inference/selection";
import {
  parseExplicitWebSearchProvider,
  type WebSearchConfig as SharedWebSearchConfig,
  WEB_SEARCH_PROVIDER_ENV,
  webSearchConfigsEqual,
  webSearchEnvFor,
  webSearchLabelFor,
  webSearchProviderForConfig,
} from "../../../inference/web-search";
import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import {
  decisionValue,
  isDecisionSelected,
  isDecisionUnset,
} from "../../../state/onboard-checkpoint-decision";
import type {
  CheckpointEffectGroupName,
  CheckpointProviderBinding,
  CheckpointResourceProfile,
  CheckpointSandboxIdentity,
  CheckpointSandboxRecreateTransaction,
  OnboardCheckpoint,
} from "../../../state/onboard-checkpoint-types";
import type {
  HermesAuthMethod,
  Session,
  SessionResourceProfile,
  SessionUpdates,
} from "../../../state/onboard-session";
import {
  type BaselineExclusionEntry,
  type SandboxEntry,
  type SandboxRemovalReceipt,
} from "../../../state/registry";
import { getSandboxEntryInference } from "../../../state/registry-entry-view";
import { toolDisclosureOrDefault } from "../../../tool-disclosure";
import {
  recordCheckpointEffectGroup,
  recordCheckpointMessaging,
  recordCheckpointProviderEffectGroup,
  recordCheckpointProviderEffectGroups,
  recordCheckpointResourceProfile,
  recordCheckpointSandboxIdentity,
  recordCheckpointWebSearch,
} from "../../checkpoint-record";
import {
  checkpointProvesSandboxStepComplete,
  observeProviderEffectFingerprint,
  planEffectGroupReplay,
  planSandboxCreateReplay,
  requiredMessagingProviderBindings,
  requiredWebSearchProviderType,
} from "../../checkpoint-replay";
import {
  bindingRevalidationGuidance,
  revalidateCheckpointBindings,
} from "../../checkpoint-revalidate";
import { withDashboardPortReservationLock as withHostDashboardPortReservationLock } from "../../dashboard-port";
import { type DashboardRuntimeAgent, shouldManageDashboardForAgent } from "../../dashboard-runtime";
import {
  type DcodeAutoApprovalMode,
  DEFAULT_DCODE_AUTO_APPROVAL_MODE,
} from "../../dcode-auto-approval";
import { resolveSandboxGatewayName } from "../../gateway-binding";
import {
  type ManagedSandboxFeatureIssue,
  managedSandboxFeatureNeedsSessionUpdate,
  resolveManagedSandboxFeature,
} from "../../managed-sandbox-feature";
import {
  DCODE_OBSERVABILITY_FEATURE,
  hasDcodeObservabilityDrift,
  isDcodeAgent,
} from "../../observability-policy-presets";
import type { SandboxCreateIntent as ResolvedSandboxCreateIntent } from "../../sandbox-create-intent-types";
import {
  advanceSandboxRecreateTransaction,
  beginSandboxRecreateTransaction,
  clearCompletedSandboxRecreateTransaction,
  fingerprintSandboxRecreateValue,
  type ReplacedSandboxSourceEntry,
  type ReplacedSandboxWorkloadCleanupResult,
  retireReplacedSandboxWorkload as retireReplacedSandboxWorkloadDefault,
  type SandboxRecreateObservation,
  sandboxRecreatePhaseReached,
  sandboxRecreateSourceWorkloadEntry,
  selectSandboxRecreateTargetIntentFingerprint,
  selectedGatewayForSandboxRecreate,
} from "../../sandbox-recreate-transaction";
import {
  assertBaselineExclusionsMatchCreateIntent,
  baselineExclusionsForCreate,
} from "../../sandbox-registration";

import { withSandboxPhaseTrace } from "../../tracing";
import type { InferenceRouteReservationAuthority, SandboxCreateIntent } from "../../types";
import { branchTo, type OnboardStateTransitionResult } from "../result";
import * as dcodeResume from "./sandbox-dcode-resume";
import {
  hasMessagingCredentialDrift,
  type RegistryMessagingAuthority,
  reconcileReusedSandboxMessaging,
  reconcileSandboxMessaging,
  resolveMessagingPlanAuthority,
  sameRegistryMessagingAuthority,
} from "./sandbox-messaging";
import {
  decideSandboxResume,
  hasCompatibleEndpointReasoningDrift,
  hasHermesCompatibleAnthropicInferenceRouteDrift,
  hasHostMountConfigDrift,
  mcpRegistryRemovalBlockReason,
  replacesSameNameSandbox,
  requiresSandboxRecreation,
  resolveToolDisclosureResumeSignals,
  type SandboxResumeDecision,
} from "./sandbox-resume";

type SandboxRecreateWorkloadSkipReason = Extract<
  ReplacedSandboxWorkloadCleanupResult,
  { readonly status: "skipped" }
>["reason"];

const SANDBOX_RECREATE_WORKLOAD_SKIP_DIAGNOSTIC = {
  "replacement-unproven": "  Obsolete sandbox image retirement skipped: replacement-unproven",
  "shared-image": "  Obsolete sandbox image retirement skipped: shared-image",
  "authority-unproven": "  Obsolete sandbox image retirement skipped: authority-unproven",
  "no-owned-image": "  Obsolete sandbox image retirement skipped: no-owned-image",
  "image-reused": "  Obsolete sandbox image retirement skipped: image-reused",
} as const satisfies Record<SandboxRecreateWorkloadSkipReason, string>;

function isAdvisoryPeerRouteDifference(
  result: Exclude<GatewayRouteCompatibilityResult, { ok: true }>,
  sandboxName: string,
): boolean {
  return (
    isAdvisoryGatewayRouteConflict(result) &&
    !result.conflicts.some((conflict) => conflict.sandboxName === sandboxName)
  );
}

function messagingCredentialBindingsChanged(
  baseline: SandboxMessagingPlan | null,
  reconciled: SandboxMessagingPlan | null,
): boolean {
  return (
    fingerprintSandboxRecreateValue(baseline?.credentialBindings ?? []) !==
    fingerprintSandboxRecreateValue(reconciled?.credentialBindings ?? [])
  );
}

function shouldForceMessagingProviderRegistration(
  credentialChanged: boolean,
  baseline: SandboxMessagingPlan | null,
  reconciled: SandboxMessagingPlan | null,
): boolean {
  return credentialChanged || messagingCredentialBindingsChanged(baseline, reconciled);
}

function shouldApplyCheckpointCrashRecovery(
  decision: SandboxResumeDecision,
  recreateRequested: boolean,
): boolean {
  return (
    !recreateRequested &&
    decision.kind === "create" &&
    decision.continueHermesPortableLifecycle !== true &&
    decision.validateMessagingCredentialsBeforeMutation !== true
  );
}

export interface SandboxStateOptions<
  Gpu,
  Agent,
  WebSearchConfig,
  MessagingChannelConfig,
  SandboxGpuConfig,
  ResourceProfile,
> {
  resume: boolean;
  fresh: boolean;
  /** Exact schema-5 lifecycle selection owned by the locked portable runtime. */
  hermesPortableLifecycle?: boolean;
  /** Internal rebuild mode: null web-search state is an authoritative disable, not a prompt. */
  authoritativeResumeConfig?: boolean;
  /** Internal rebuild tier that must govern create-time and resumed policy selection. */
  authoritativePolicyTier?: string | null;
  /** Endpoint source to preserve during an authoritative rebuild. */
  endpointSource?: InferenceEndpointSource | null;
  /** Internal rebuild target fingerprint recorded by the journal opened before deletion. */
  recreateJournalTargetIntentFingerprint?: string | null;
  resumeAgentChanged: boolean;
  requestedObservabilityEnabled?: boolean | null;
  requestedDcodeAutoApprovalMode?: DcodeAutoApprovalMode | null;
  rebuildPreservedEnv?: readonly import("../../../state/preserved-env").PreservedEnvFile[];
  rebuildPolicyPresets?: readonly string[];
  hostMounts?: readonly import("../../../state/registry/types").SandboxHostMount[];
  recreateSandbox: (requested?: boolean) => boolean;
  gatewayName: string;
  session: Session | null;
  sandboxName: string | null;
  model: string;
  provider: string;
  hostLocalInferenceRouteOnly?: boolean;
  endpointUrl: string | null;
  compatibleEndpointReasoning: string | null;
  credentialEnv: string | null;
  nimContainer: string | null;
  webSearchConfig: WebSearchConfig | null;
  selectedMessagingChannels: string[];
  fromDockerfile: string | null;
  agent: Agent;
  gpu: Gpu;
  preferredInferenceApi: string | null;
  sandboxGpuConfig: SandboxGpuConfig;
  hermesToolGateways: string[];
  hermesAuthMethod: HermesAuthMethod | null;
  controlUiPort: number | null;
  rootDir: string;
  env: NodeJS.ProcessEnv;
  deps: dcodeResume.Deps & {
    checkGatewayRouteCompatibility: CurrentGatewayRouteCompatibilityCheck;
    withGatewayRouteMutationLock<T>(
      gatewayName: string,
      operation: () => Promise<T> | T,
    ): Promise<T>;
    withDashboardPortReservationLock?<T>(operation: () => Promise<T> | T): Promise<T>;
    resolvePath(value: string): string;
    agentSupportsWebSearch(
      agent: Agent,
      dockerfilePathOverride: string | null,
      rootDir: string,
    ): boolean;
    agentSupportsWebSearchProvider?(
      agent: Agent,
      provider: "brave" | "tavily",
      dockerfilePathOverride: string | null,
      rootDir: string,
    ): boolean;
    note(message: string): void;
    cliName(): string;
    updateSession(mutator: (session: Session) => Session | void): Session;
    getStoredMessagingChannelConfig(
      sandboxName: string | null,
      session: Session | null,
    ): MessagingChannelConfig | null;
    hydrateMessagingChannelConfig(
      config: MessagingChannelConfig | null,
    ): MessagingChannelConfig | null;
    messagingChannelConfigsEqual(
      left: MessagingChannelConfig | null,
      right: MessagingChannelConfig | null,
    ): boolean;
    getSandboxReuseState(sandboxName: string | null): string;
    getSandboxRecreateObservation(sandboxName: string | null): SandboxRecreateObservation;
    hasSandboxGpuDrift(sandboxName: string, config: SandboxGpuConfig): boolean;
    getSandboxHermesToolGateways(sandboxName: string): unknown;
    getSandboxRegistryEntry(sandboxName: string): SandboxEntry | null;
    retireReplacedSandboxWorkload?(
      sandboxName: string,
      targetGeneration: string,
      targetLiveIdentityFingerprint: string | null,
      source: ReplacedSandboxSourceEntry,
      replacement: SandboxEntry | null,
    ): ReplacedSandboxWorkloadCleanupResult;
    normalizeHermesToolGatewaySelections(value: unknown): string[];
    stringSetsEqual(left: string[], right: string[]): boolean;
    removeSandboxFromRegistry(sandboxName: string): SandboxRemovalReceipt | null;
    restoreSandboxRegistryEntryIfMissing(receipt: SandboxRemovalReceipt): boolean;
    ensureValidatedWebSearchCredential(config: WebSearchConfig): Promise<unknown>;
    isBackToSelection(value: unknown): boolean;
    configureWebSearch(
      existingConfig: WebSearchConfig | null,
      agent: Agent,
      dockerfilePathOverride: string | null,
    ): Promise<WebSearchConfig | null>;
    startRecordedStep(
      stepName: string,
      updates: { sandboxName?: string | null; provider: string; model: string },
    ): Promise<void>;
    getRecordedMessagingChannelsForResume(
      resume: boolean,
      session: Session | null,
      sandboxName: string | null,
    ): string[] | null;
    showMessagingStage?(): void;
    setupMessagingChannels(
      agent: Agent,
      existingChannels: string[] | null,
      sandboxName: string,
      options?: { readonly selectionCompleted?: boolean },
    ): Promise<string[]>;
    readMessagingPlanFromEnv(): SandboxMessagingPlan | null;
    writePlanToEnv(plan: SandboxMessagingPlan): void;
    clearPlanEnv(): void;
    getRegistrySandboxMessagingAuthority(
      sandboxName: string,
    ): import("../../../messaging/plan-authority").RegistryMessagingAuthority;
    providerMatchesGatewayCredential(name: string, type: string, credentialEnv: string): boolean;
    preflightPolicyRequirements(input: {
      gatewayName: string;
      sandboxName: string | null;
      agent: Agent;
      selectedMessagingChannels: readonly string[];
      hermesToolGateways: readonly string[];
      gpuPassthrough: boolean;
      provider: string | null;
      hostLocalInferenceRouteOnly?: boolean;
      webSearchConfig: WebSearchConfig | null;
      observabilityEnabled: boolean;
      operation: string;
    }): void;
    stageSandboxCredentialProviders(input: {
      sandboxName: string;
      enabledChannels: readonly string[];
      webSearchConfig: WebSearchConfig | null;
      agent: Agent;
      requiredBindings: readonly CheckpointProviderBinding[];
      revalidatePolicyRequirements?(operation: string): void;
    }): Promise<readonly CheckpointProviderBinding[]>;
    promptValidatedSandboxName(agent: Agent): Promise<string>;
    selectResourceProfileForSandbox(): Promise<ResourceProfile | null>;
    stopStaleDashboardListenersForSandbox(sandboxes: unknown[], sandboxName: string): void;
    listRegistrySandboxes(): { sandboxes: unknown[] };
    planRegisteredExtraProviders(
      gatewayName: string,
    ): import("../../extra-provider-reconciliation").ExtraProviderReconciliationPlan;
    resolveSandboxCreateIntent(input: {
      sandboxName: string;
      inferenceProvider?: string | null;
      hostLocalInferenceRouteOnly?: boolean;
      enabledChannels: readonly string[];
      webSearchConfig: WebSearchConfig | null;
      agent: Agent;
      sandboxGpuConfig: SandboxGpuConfig;
      resourceProfile: ResourceProfile | null;
      hermesToolGateways: readonly string[];
      extraProviders: readonly string[];
      staleExtraProviders: readonly string[];
      policyTier?: string | null;
      baselineExclusions?: readonly BaselineExclusionEntry[];
      reuseRegisteredCredentials?: boolean;
      hostMounts?: readonly import("../../../state/registry/types").SandboxHostMount[];
    }): Promise<ResolvedSandboxCreateIntent>;
    createSandbox(
      gpu: Gpu,
      model: string,
      provider: string,
      preferredInferenceApi: string | null,
      sandboxName: string,
      webSearchConfig: WebSearchConfig | null,
      selectedMessagingChannels: string[],
      fromDockerfile: string | null,
      agent: Agent,
      controlUiPort: number | null,
      sandboxGpuConfig: SandboxGpuConfig,
      resourceProfile: ResourceProfile | null,
      hermesToolGateways: string[],
      hermesAuthMethod: HermesAuthMethod | null,
      inferenceRouteReservationAuthority: InferenceRouteReservationAuthority | null,
      createIntent: CompleteSandboxCreateIntent,
    ): Promise<string>;
    finalizeSandboxRouteReservation(sandboxName: string, sessionId: string): boolean;
    updateSandboxRegistry(sandboxName: string, updates: Record<string, unknown>): void;
    getSandboxAgentRegistryFields(
      agent: Agent,
      agentVersionKnown: boolean,
    ): Record<string, unknown>;
    recordStepComplete(stepName: string, updates: SessionUpdates): Promise<Session>;
    toSessionUpdates(updates: Record<string, unknown>): SessionUpdates;
    skippedStepMessage(stepName: string, detail?: string | null, reason?: "resume" | "reuse"): void;
    recordStateSkipped(
      state: "sandbox",
      metadata?: Record<string, unknown> | null,
    ): Promise<Session>;
    recordRepairEvent(
      type: "state.repair.started" | "state.repair.completed" | "state.repair.failed",
      options?: {
        state?: "sandbox";
        error?: string | null;
        metadata?: Record<string, unknown> | null;
      },
    ): Promise<Session>;
    withSandboxMutationLock?<T>(sandboxName: string, action: () => Promise<T>): Promise<T>;
  };
}

export interface SandboxStateResult<WebSearchConfig> {
  sandboxName: string;
  webSearchConfig: WebSearchConfig | null;
  webSearchConfigChanged: boolean;
  hermesToolGateways: string[];
  selectedMessagingChannels: string[];
  webSearchSupported: boolean;
  session: Session | null;
  stateResult: OnboardStateTransitionResult;
}

interface SandboxStepState<WebSearchConfig> {
  readonly session: Session | null;
  readonly sandboxName: string | null;
  readonly webSearchConfig: WebSearchConfig | null;
  readonly webSearchConfigChanged: boolean;
  readonly selectedMessagingChannels: string[];
  readonly webSearchSupported: boolean;
  readonly webSearchSupportDropped: boolean;
  readonly webSearchSupportProbePath: string | null;
}

function resolveRequestedWebSearchConfig<WebSearchConfig>(
  current: WebSearchConfig | null,
  env: NodeJS.ProcessEnv,
  authoritative: boolean,
): WebSearchConfig | null {
  if (authoritative) return current;
  const explicit = parseExplicitWebSearchProvider(env[WEB_SEARCH_PROVIDER_ENV]);
  if (!explicit.specified) return current;
  if (!explicit.provider) return null;
  return { fetchEnabled: true, provider: explicit.provider } as WebSearchConfig;
}

function missingWebSearchFidelity(
  existing: SandboxEntry | null,
  webSearchConfig: SharedWebSearchConfig | null,
): Partial<SandboxEntry> {
  const fidelity: Partial<SandboxEntry> = {};
  if (existing?.webSearchEnabled === undefined) {
    fidelity.webSearchEnabled = Boolean(webSearchConfig);
  }
  if (existing?.webSearchProvider === undefined) {
    fidelity.webSearchProvider = webSearchConfig
      ? webSearchProviderForConfig(webSearchConfig)
      : null;
  }
  return fidelity;
}

function knownAgentSupportsWebSearchProvider(
  agent: { name?: string } | null,
  provider: "brave" | "tavily",
): boolean {
  return agent?.name?.trim().toLowerCase() !== "hermes" || provider === "tavily";
}

function effectiveHermesToolGatewaysForWebSearch(
  agent: { name?: string } | null,
  webSearchConfig: SharedWebSearchConfig | null,
  gateways: string[],
): string[] {
  const isHermes = agent?.name?.trim().toLowerCase() === "hermes";
  const tavilySelected =
    webSearchConfig !== null && webSearchProviderForConfig(webSearchConfig) === "tavily";
  return isHermes && tavilySelected
    ? gateways.filter((gateway) => gateway !== "nous-web")
    : [...gateways];
}

function requiredWebSearchProviderBindings(
  sandboxName: string,
  webSearchConfig: SharedWebSearchConfig | null,
  agent: { name?: string } | null,
): CheckpointProviderBinding[] {
  if (webSearchConfig?.fetchEnabled !== true) return [];
  const provider = webSearchProviderForConfig(webSearchConfig);
  return [
    {
      name: `${sandboxName}-${provider}-search`,
      type: requiredWebSearchProviderType(provider, agent),
      credentialEnv: webSearchEnvFor(provider),
    },
  ];
}

function hasResourceProfileEnvOverride(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NEMOCLAW_RESOURCE_PROFILE || env.NEMOCLAW_CPU || env.NEMOCLAW_RAM);
}

function endpointSourceForCreateIntent(
  fresh: boolean,
  endpointSource: InferenceEndpointSource | null | undefined,
  preserveSelectedEndpointSource: boolean,
): InferenceEndpointSource | null {
  return fresh && !preserveSelectedEndpointSource ? "onboard" : (endpointSource ?? null);
}

function compatibleEndpointReasoningForCreateIntent(
  value: string | null,
): Pick<SandboxCreateIntent, "compatibleEndpointReasoning"> {
  return value === "true" || value === "false" ? { compatibleEndpointReasoning: value } : {};
}

function rebuildPolicyPresetsForCreateIntent(
  value: readonly string[] | undefined,
  session: Session | null,
  sandboxName: string,
): Pick<SandboxCreateIntent, "rebuildPolicyPresets"> {
  if (session?.policyAuthority === "externally-managed") return {};
  // A later `onboard --resume` no longer has the outer rebuild's in-memory
  // options. The matching recreate journal makes its filtered session value
  // the durable replacement target instead of the preserved source row.
  const journaledValue =
    session?.checkpoint?.sandboxRecreate?.sandboxName === sandboxName &&
    Array.isArray(session.policyPresets)
      ? session.policyPresets
      : undefined;
  const selectedValue = Array.isArray(value) ? value : journaledValue;
  return Array.isArray(selectedValue) ? { rebuildPolicyPresets: [...selectedValue] } : {};
}

function clearExternallyManagedPolicyPresets(
  session: Session | null,
  updateSession: (mutator: (current: Session) => Session | void) => Session,
): void {
  if (session?.policyAuthority !== "externally-managed" || session.policyPresets === null) return;
  updateSession((current) => {
    if (current.policyAuthority === "externally-managed") current.policyPresets = null;
    return current;
  });
  session.policyPresets = null;
}

/** Replace a resumed create-plan snapshot with the outer rebuild's normalized built-ins. */
function applyAuthoritativeRebuildPolicyPresets(
  intent: ResolvedSandboxCreateIntent,
  rebuildPolicyPresets: readonly string[] | undefined,
): ResolvedSandboxCreateIntent {
  if (!Array.isArray(rebuildPolicyPresets)) return intent;
  return {
    ...intent,
    policy: {
      ...intent.policy,
      options: {
        ...intent.policy.options,
        additionalPresets: [...rebuildPolicyPresets],
      },
    },
  };
}

type SandboxCreationDecision = Exclude<SandboxResumeDecision, { readonly kind: "reuse" }>;
type CompleteSandboxCreateIntent = SandboxCreateIntent & {
  readonly resolved: ResolvedSandboxCreateIntent;
};

type SandboxRecreateRepairMetadata = {
  readonly repair: "recorded-sandbox-cleanup";
  readonly sandboxName: string | null;
};
type SandboxRecreatePreparation = {
  readonly transaction: CheckpointSandboxRecreateTransaction | null;
  readonly sourceEntry: ReplacedSandboxSourceEntry | null;
  readonly effectiveCreateIntent: CompleteSandboxCreateIntent;
  readonly repairMetadata: SandboxRecreateRepairMetadata | null;
};

function observabilityRequestValidationError(
  issue: ManagedSandboxFeatureIssue | null,
): string | null {
  if (issue === "unsupported-request") {
    return "  --observability is supported only with --agent langchain-deepagents-code.";
  }
  if (issue === "recorded-state-on-unsupported-agent") {
    return "  Recorded observability belongs to the existing Deep Agents Code sandbox. Pass --no-observability explicitly when switching agents.";
  }
  return null;
}

function checkpointIdentityForResumeTarget(
  checkpoint: OnboardCheckpoint,
  sandboxName: string | null,
  agentName: string,
): CheckpointSandboxIdentity | null {
  if (!isDecisionSelected(checkpoint.sandboxIdentity)) return null;
  const identity = checkpoint.sandboxIdentity.value;
  return identity.name === sandboxName && identity.agent === agentName ? identity : null;
}

type ProviderEffectGroupName = Extract<
  CheckpointEffectGroupName,
  "web_search_provider" | "messaging_providers"
>;

function canonicalCheckpointProviderReceiptNames(checkpoint: OnboardCheckpoint): string[] | null {
  const fingerprints = (["web_search_provider", "messaging_providers"] as const)
    .map((group) => checkpoint.effectGroups[group]?.fingerprint)
    .filter((fingerprint): fingerprint is string => typeof fingerprint === "string");
  const receiptNamesByGroup = fingerprints.map((fingerprint) =>
    fingerprint.split(",").filter(Boolean),
  );
  const malformed = receiptNamesByGroup.some(
    (names, index) =>
      names.length === 0 ||
      names.some((name) => name.trim() !== name) ||
      names.join(",") !== fingerprints[index] ||
      new Set(names).size !== names.length,
  );
  if (malformed) return null;
  const receiptNames = receiptNamesByGroup.flat();
  return new Set(receiptNames).size === receiptNames.length ? receiptNames : null;
}

function checkpointProviderReceiptNames(
  checkpoint: OnboardCheckpoint,
  group: ProviderEffectGroupName,
): string[] {
  return checkpoint.effectGroups[group]?.fingerprint.split(",") ?? [];
}

function checkpointProviderBindingKey(binding: CheckpointProviderBinding): string {
  return JSON.stringify([binding.name, binding.type, binding.credentialEnv]);
}

function isCanonicalCheckpointProviderBinding(binding: CheckpointProviderBinding): boolean {
  return (
    Boolean(binding.name && binding.type && binding.credentialEnv) &&
    binding.name.trim() === binding.name &&
    binding.type.trim() === binding.type &&
    binding.credentialEnv.trim() === binding.credentialEnv
  );
}

class SandboxStateFlow<
  Gpu,
  Agent,
  WebSearchConfig,
  MessagingChannelConfig,
  SandboxGpuConfig,
  ResourceProfile,
> {
  private dcodeAutoApprovalMode: DcodeAutoApprovalMode = DEFAULT_DCODE_AUTO_APPROVAL_MODE;

  constructor(
    private readonly options: SandboxStateOptions<
      Gpu,
      Agent,
      WebSearchConfig,
      MessagingChannelConfig,
      SandboxGpuConfig,
      ResourceProfile
    >,
  ) {}

  private get deps(): SandboxStateOptions<
    Gpu,
    Agent,
    WebSearchConfig,
    MessagingChannelConfig,
    SandboxGpuConfig,
    ResourceProfile
  >["deps"] {
    return this.options.deps;
  }

  private get resumesSandboxPrompts(): boolean {
    const agentName = (this.options.agent as { name?: string } | null)?.name;
    return !agentName || agentName === "openclaw";
  }

  private prepareWebSearchSupport(): SandboxStepState<WebSearchConfig> {
    const probePath = this.options.fromDockerfile
      ? this.deps.resolvePath(this.options.fromDockerfile)
      : null;
    const supported = this.deps.agentSupportsWebSearch(
      this.options.agent,
      probePath,
      this.options.rootDir,
    );
    const requestedWebSearchConfig = resolveRequestedWebSearchConfig(
      this.options.webSearchConfig,
      this.options.env,
      this.options.authoritativeResumeConfig === true,
    );
    const webSearchConfigChanged = !webSearchConfigsEqual(
      this.options.session?.webSearchConfig,
      requestedWebSearchConfig as unknown as SharedWebSearchConfig | null,
    );
    const provider = requestedWebSearchConfig
      ? webSearchProviderForConfig(requestedWebSearchConfig as unknown as SharedWebSearchConfig)
      : null;
    const providerSupported = provider
      ? (this.deps.agentSupportsWebSearchProvider?.(
          this.options.agent,
          provider,
          probePath,
          this.options.rootDir,
        ) ??
        knownAgentSupportsWebSearchProvider(
          this.options.agent as { name?: string } | null,
          provider,
        ))
      : true;
    const dropped = Boolean(requestedWebSearchConfig) && (!supported || !providerSupported);
    if (!dropped) {
      return {
        session: this.options.session,
        sandboxName: this.options.sandboxName,
        webSearchConfig: requestedWebSearchConfig,
        webSearchConfigChanged,
        selectedMessagingChannels: this.options.selectedMessagingChannels,
        webSearchSupported: supported,
        webSearchSupportDropped: false,
        webSearchSupportProbePath: probePath,
      };
    }

    this.deps.note(
      `  ${provider ? webSearchLabelFor(provider) : "Web search"} is not yet supported by ${(this.options.agent as { displayName?: string } | null)?.displayName ?? "this sandbox image"}. Clearing stale config.`,
    );
    if (this.options.session) this.options.session.webSearchConfig = null;
    const session = this.deps.updateSession((current) => {
      current.webSearchConfig = null;
      return current;
    });
    return {
      session,
      sandboxName: this.options.sandboxName,
      webSearchConfig: null,
      webSearchConfigChanged,
      selectedMessagingChannels: this.options.selectedMessagingChannels,
      webSearchSupported: supported,
      webSearchSupportDropped: true,
      webSearchSupportProbePath: probePath,
    };
  }

  private checkpointChangedExplicitSandboxName(
    state: SandboxStepState<WebSearchConfig>,
  ): SandboxStepState<WebSearchConfig> {
    const explicitName = this.options.sandboxName;
    const recordedName = state.session?.sandboxName;
    if (!explicitName || !recordedName || recordedName === explicitName) return state;
    return this.checkpointSandboxName(state, explicitName);
  }

  private resolveResumeDecision(state: SandboxStepState<WebSearchConfig>): SandboxResumeDecision {
    const storedMessagingConfig = this.deps.getStoredMessagingChannelConfig(
      state.sandboxName,
      state.session,
    );
    const effectiveMessagingConfig = this.deps.hydrateMessagingChannelConfig(storedMessagingConfig);
    const recordedToolGateways = state.sandboxName
      ? this.deps.normalizeHermesToolGatewaySelections(
          this.deps.getSandboxHermesToolGateways(state.sandboxName),
        )
      : [];
    const effectiveToolGateways = effectiveHermesToolGatewaysForWebSearch(
      this.options.agent as { name?: string } | null,
      state.webSearchConfig as unknown as SharedWebSearchConfig | null,
      this.options.hermesToolGateways,
    );
    const registryEntry = state.sandboxName
      ? this.deps.getSandboxRegistryEntry(state.sandboxName)
      : null;
    const messagingAuthority = state.sandboxName
      ? this.resolveSandboxMessagingAuthority(state.sandboxName, state.session)
      : { source: "none" as const, plan: null };
    const toolDisclosureSignals = resolveToolDisclosureResumeSignals(registryEntry, state.session);
    const sandboxReuseState = this.deps.getSandboxReuseState(state.sandboxName);
    const dcodeResumeSignals = dcodeResume.resolveSignals(
      this.options,
      state,
      sandboxReuseState,
      registryEntry,
      this.dcodeAutoApprovalMode,
      this.deps,
    );
    const messagingCredentialChanged = hasMessagingCredentialDrift(
      messagingAuthority.plan,
      this.options.env,
    );
    const decision = decideSandboxResume({
      resume: this.options.resume,
      resumeAgentChanged: this.options.resumeAgentChanged,
      sandboxStepComplete: state.session?.checkpoint
        ? checkpointProvesSandboxStepComplete(state.session)
        : state.session?.steps?.sandbox?.status === "complete",
      sandboxReuseState,
      inferenceRouteConfigChanged: hasHermesCompatibleAnthropicInferenceRouteDrift({
        agentName: (this.options.agent as { name?: string } | null)?.name,
        provider: this.options.provider,
        model: this.options.model,
        preferredInferenceApi: this.options.preferredInferenceApi,
        registryEntry,
      }),
      compatibleEndpointReasoningChanged: hasCompatibleEndpointReasoningDrift({
        provider: this.options.provider,
        compatibleEndpointReasoning: this.options.compatibleEndpointReasoning,
        registryEntry,
      }),
      webSearchConfigChanged: state.webSearchSupportDropped || state.webSearchConfigChanged,
      sandboxGpuConfigChanged: state.sandboxName
        ? this.deps.hasSandboxGpuDrift(state.sandboxName, this.options.sandboxGpuConfig)
        : false,
      hostMountConfigChanged: hasHostMountConfigDrift(
        registryEntry?.hostMounts,
        this.options.hostMounts,
      ),
      recreateSandboxRequested: this.options.recreateSandbox(false),
      recreateJournalHandoff: Boolean(this.options.recreateJournalTargetIntentFingerprint),
      activeRecreateJournal: Boolean(
        state.session?.checkpoint?.sandboxRecreate &&
        this.options.recreateJournalTargetIntentFingerprint &&
        state.session.checkpoint.sandboxRecreate.sandboxName === state.sandboxName &&
        state.session.checkpoint.sandboxRecreate.targetIntentFingerprint ===
          this.options.recreateJournalTargetIntentFingerprint,
      ),
      hermesPortableLifecyclePending:
        this.options.hermesPortableLifecycle === true &&
        registryEntry?.pendingRouteReservation === true,
      messagingChannelConfigChanged: !this.deps.messagingChannelConfigsEqual(
        effectiveMessagingConfig,
        storedMessagingConfig,
      ),
      messagingCredentialChanged,
      hermesToolGatewayConfigChanged: !this.deps.stringSetsEqual(
        recordedToolGateways,
        effectiveToolGateways,
      ),
      observabilityChanged: hasDcodeObservabilityDrift({
        liveExists: sandboxReuseState === "ready",
        managedDcodeAgent: isDcodeAgent((this.options.agent as { name?: string } | null)?.name),
        hasRegistryEntry: registryEntry !== null,
        recordedObservabilityEnabled: registryEntry?.observabilityEnabled,
        requestedObservabilityEnabled: state.session?.observabilityEnabled,
      }),
      ...toolDisclosureSignals,
      ...dcodeResumeSignals,
    });
    const credentialValidatedDecision =
      decision.kind !== "reuse" && messagingCredentialChanged
        ? { ...decision, validateMessagingCredentialsBeforeMutation: true }
        : decision;
    const managedDcodeDecision = dcodeResume.preserveManagedDcodeRegistryEntry(
      this.options,
      credentialValidatedDecision,
    );
    return this.resolveCheckpointCrashRecovery(managedDcodeDecision, state, sandboxReuseState);
  }

  private resolveCheckpointCrashRecovery(
    decision: SandboxResumeDecision,
    state: SandboxStepState<WebSearchConfig>,
    sandboxReuseState: string,
  ): SandboxResumeDecision {
    if (this.options.recreateSandbox(false)) return decision;
    return this.applyCheckpointCrashRecovery(decision, state, sandboxReuseState);
  }

  // A "create" decision from decideSandboxResume means only that the sandbox
  // step was never marked complete; it does not check whether a previous run
  // already executed the destructive create effect before crashing. When a
  // durable checkpoint proves that (recorded identity + a sandbox_create
  // effect receipt), disambiguate using live state instead of blindly
  // recreating under the same name (#5961, #6228).
  private applyCheckpointCrashRecovery(
    decision: SandboxResumeDecision,
    state: SandboxStepState<WebSearchConfig>,
    sandboxReuseState: string,
  ): SandboxResumeDecision {
    if (!shouldApplyCheckpointCrashRecovery(decision, this.options.recreateSandbox(false))) {
      return decision;
    }
    const checkpoint = state.session?.checkpoint;
    const agentName = (this.options.agent as { name?: string } | null)?.name ?? "openclaw";
    const identity =
      checkpoint && checkpointIdentityForResumeTarget(checkpoint, state.sandboxName, agentName);
    if (!checkpoint || !identity) return decision;

    const recordedFingerprint = checkpoint.effectGroups.sandbox_create?.fingerprint;
    const currentLightFingerprint = this.currentSandboxCreateFingerprint(identity.name);
    if (
      recordedFingerprint &&
      recordedFingerprint !== currentLightFingerprint &&
      !recordedFingerprint.startsWith(`${currentLightFingerprint}|`)
    ) {
      return this.rejectDriftedCheckpointFingerprint(identity.name);
    }

    const bindingCheck = revalidateCheckpointBindings(
      checkpoint,
      this.checkpointBindingAvailabilityBeforeProviderReplay(checkpoint),
    );
    if (bindingCheck.status === "stale") return this.rejectStaleCheckpointBindings(bindingCheck);

    const replay = planSandboxCreateReplay(checkpoint, {
      liveSandboxExists: sandboxReuseState === "ready",
    });
    return replay.action === "reuse" && replay.identity.name === state.sandboxName
      ? { kind: "reuse" }
      : decision;
  }

  private currentSandboxCreateFingerprint(
    sandboxName: string,
    createIntent?: ResolvedSandboxCreateIntent,
  ): string {
    const { nemoclawVersion: builtFingerprint } = this.deps.getSandboxAgentRegistryFields(
      this.options.agent,
      !this.options.fromDockerfile,
    );
    const policyFingerprint = this.options.authoritativePolicyTier ?? "default";
    const lightFingerprint = [
      typeof builtFingerprint === "string" ? builtFingerprint : sandboxName,
      policyFingerprint,
      this.options.provider,
      this.options.model,
      this.options.preferredInferenceApi ?? "default",
      ...Object.values(
        compatibleEndpointReasoningForCreateIntent(this.options.compatibleEndpointReasoning),
      ),
      this.options.fromDockerfile ?? "",
      JSON.stringify(this.options.sandboxGpuConfig ?? null),
      [...this.options.hermesToolGateways].sort().join(","),
    ].join("|");
    if (!createIntent) return lightFingerprint;
    // Extra providers are live gateway attachments, not durable build intent.
    // Resume deliberately re-plans them so newly live providers are attached
    // and stale records are omitted. Binding those ambient lists into the
    // receipt would reject the established repair/resume reconciliation path.
    const {
      extraProviders: _extraProviders,
      staleExtraProviders: _staleExtraProviders,
      ...durableCreateIntent
    } = createIntent;
    return `${lightFingerprint}|${JSON.stringify(durableCreateIntent)}`;
  }

  private assertCheckpointCreateInputsStillMatch(
    state: SandboxStepState<WebSearchConfig>,
    sandboxName: string,
    createIntent: ResolvedSandboxCreateIntent,
  ): void {
    if (this.options.recreateSandbox(false)) return;
    const recordedFingerprint = state.session?.checkpoint?.effectGroups.sandbox_create?.fingerprint;
    if (!recordedFingerprint) return;
    // Older and reuse-backfilled receipts contain the stable create-input prefix.
    // Accept that reviewed compatibility form while requiring an exact match
    // when the receipt includes the complete durable create intent.
    if (recordedFingerprint === this.currentSandboxCreateFingerprint(sandboxName)) return;
    if (recordedFingerprint !== this.currentSandboxCreateFingerprint(sandboxName, createIntent)) {
      this.rejectDriftedCheckpointFingerprint(sandboxName);
    }
  }

  private rejectDriftedCheckpointFingerprint(sandboxName: string): never {
    this.deps.error(
      `  A previous onboarding attempt recorded sandbox '${sandboxName}' with different build or policy inputs than this run requests.`,
    );
    this.deps.error("  Pass --recreate-sandbox to rebuild it with the current settings.");
    return this.deps.exitProcess(1);
  }

  private checkpointBindingAvailability(
    checkpoint: OnboardCheckpoint,
    provisionallyAvailableBindings: readonly CheckpointProviderBinding[] = [],
  ): {
    availableCredentialEnvs: ReadonlySet<string>;
    liveRegisteredProviders: ReadonlySet<string>;
  } {
    const provisionallyAvailableBindingKeys = new Set(
      provisionallyAvailableBindings.map(checkpointProviderBindingKey),
    );
    const bindingNameCounts = new Map<string, number>();
    for (const binding of checkpoint.bindings.registeredProviders) {
      bindingNameCounts.set(binding.name, (bindingNameCounts.get(binding.name) ?? 0) + 1);
    }
    const liveRegisteredBindings = checkpoint.bindings.registeredProviders.filter(
      (binding) =>
        bindingNameCounts.get(binding.name) === 1 &&
        isCanonicalCheckpointProviderBinding(binding) &&
        (provisionallyAvailableBindingKeys.has(checkpointProviderBindingKey(binding)) ||
          this.deps.providerMatchesGatewayCredential(
            binding.name,
            binding.type,
            binding.credentialEnv,
          )),
    );
    return {
      availableCredentialEnvs: new Set(
        [
          ...Object.keys(this.options.env).filter((name) =>
            Boolean(this.options.env[name]?.trim()),
          ),
          // Provider setup deliberately scrubs raw credentials from process.env
          // after registration. The exact live provider name, provider type, and credential key
          // is sufficient evidence for that scrubbed credential key (#7022).
          ...liveRegisteredBindings.map((binding) => binding.credentialEnv),
        ].filter(Boolean),
      ),
      liveRegisteredProviders: new Set(liveRegisteredBindings.map((binding) => binding.name)),
    };
  }

  private checkpointBindingAvailabilityBeforeProviderReplay(checkpoint: OnboardCheckpoint): {
    availableCredentialEnvs: ReadonlySet<string>;
    liveRegisteredProviders: ReadonlySet<string>;
  } {
    const replayableBindings = this.replayableCheckpointProviderBindings(checkpoint);
    return this.checkpointBindingAvailability(checkpoint, replayableBindings);
  }

  private replayableCheckpointProviderBindings(
    checkpoint: OnboardCheckpoint,
  ): CheckpointProviderBinding[] {
    const registeredBindings = checkpoint.bindings.registeredProviders;
    const registeredByName = new Map(registeredBindings.map((binding) => [binding.name, binding]));
    if (
      registeredByName.size !== registeredBindings.length ||
      registeredBindings.some((binding) => !isCanonicalCheckpointProviderBinding(binding))
    ) {
      return this.rejectInvalidCheckpointProviderBindings();
    }

    // Only canonical provider-effect receipts may defer their exact bindings
    // to the reconciliation that runs before sandbox creation.
    const receiptNames = canonicalCheckpointProviderReceiptNames(checkpoint);
    if (!receiptNames) {
      return this.rejectInvalidCheckpointProviderBindings();
    }

    const replayableBindings = receiptNames.map((name) => registeredByName.get(name));
    if (
      replayableBindings.some(
        (binding) => !binding || !isCanonicalCheckpointProviderBinding(binding),
      )
    ) {
      return this.rejectInvalidCheckpointProviderBindings();
    }
    return replayableBindings as CheckpointProviderBinding[];
  }

  private rejectInvalidCheckpointProviderBindings(): never {
    this.deps.error("  A previous onboarding attempt recorded invalid provider bindings.");
    this.deps.error(
      `  Run ${this.deps.cliName()} onboard --fresh to discard the invalid checkpoint and start again.`,
    );
    return this.deps.exitProcess(1);
  }

  private rejectStaleCheckpointBindings(
    bindingCheck: Extract<ReturnType<typeof revalidateCheckpointBindings>, { status: "stale" }>,
  ): never {
    const guidance = bindingRevalidationGuidance(bindingCheck);
    if (guidance) this.deps.error(guidance);
    this.deps.error(
      "  A previous onboarding attempt was interrupted after starting sandbox creation.",
    );
    this.deps.error("  Re-run with the required credentials available to continue safely.");
    return this.deps.exitProcess(1);
  }

  private assertCheckpointBindingsStillLive(state: SandboxStepState<WebSearchConfig>): void {
    const checkpoint = state.session?.checkpoint;
    if (!checkpoint) return;
    const bindingCheck = revalidateCheckpointBindings(
      checkpoint,
      this.checkpointBindingAvailability(checkpoint),
    );
    if (bindingCheck.status === "stale") this.rejectStaleCheckpointBindings(bindingCheck);
  }

  private applyObservabilityRequest(
    state: SandboxStepState<WebSearchConfig>,
  ): SandboxStepState<WebSearchConfig> {
    const registryEntry = state.sandboxName
      ? this.deps.getSandboxRegistryEntry(state.sandboxName)
      : null;
    const selectedAgent = (this.options.agent as { name?: string } | null)?.name;
    const requested = this.options.requestedObservabilityEnabled;
    const resolution = resolveManagedSandboxFeature(DCODE_OBSERVABILITY_FEATURE, {
      agent: selectedAgent,
      requested,
      resume: this.options.resume,
      sessionValue: state.session?.observabilityEnabled,
      sessionRequestedExplicitly: state.session?.observabilityRequestedExplicitly,
      registryValue: registryEntry?.observabilityEnabled,
    });
    const validationError = observabilityRequestValidationError(resolution.issue);
    if (validationError) {
      this.deps.error(validationError);
      return this.deps.exitProcess(1);
    }
    if (
      !managedSandboxFeatureNeedsSessionUpdate(
        DCODE_OBSERVABILITY_FEATURE,
        state.session?.observabilityEnabled,
        state.session?.observabilityRequestedExplicitly,
        resolution,
      )
    ) {
      return state;
    }
    const session = this.deps.updateSession((current) => {
      current.observabilityEnabled = resolution.value;
      current.observabilityRequestedExplicitly =
        current.observabilityRequestedExplicitly || resolution.requestedExplicitly;
      return current;
    });
    return { ...state, session };
  }

  private assertGatewayRouteCompatible(sandboxName: string | null): void {
    const targetEntry = sandboxName ? this.deps.getSandboxRegistryEntry(sandboxName) : null;
    if (!sandboxName || !targetEntry) {
      this.failGatewayRouteCheck(
        `  Error: sandbox route reservation '${sandboxName ?? "unknown"}' disappeared while onboarding was in progress. Retry onboarding.`,
      );
    }
    if (getSandboxEntryInference(targetEntry).kind !== "configured") {
      this.failGatewayRouteCheck(
        `  Error: sandbox '${sandboxName}' has incomplete route metadata, so its shared-gateway compatibility cannot be proven. Remove and re-onboard that sandbox.`,
      );
    }
    if (resolveSandboxGatewayName(targetEntry) !== this.options.gatewayName) {
      this.failGatewayRouteCheck(
        `  Error: sandbox '${sandboxName}' changed OpenShell gateways while onboarding was in progress. Retry onboarding.`,
      );
    }
    const compatibility = this.deps.checkGatewayRouteCompatibility({
      gatewayName: this.options.gatewayName,
      sandboxName: null,
      route: {
        provider: this.options.provider,
        model: this.options.model,
        endpointUrl: this.options.endpointUrl,
        preferredInferenceApi: this.options.preferredInferenceApi,
        credentialEnv: this.options.credentialEnv,
      },
    });
    if (compatibility.ok || isAdvisoryPeerRouteDifference(compatibility, sandboxName)) return;
    // The target registry row is the route reservation this transaction owns.
    // A changed target is a lost-reservation race, not an advisory peer drift.
    this.failGatewayRouteCheck(`  Error: ${formatGatewayRouteConflict(compatibility)}`);
  }

  private failGatewayRouteCheck(message: string): never {
    this.deps.error(message);
    this.deps.exitProcess(1);
    throw new Error("exitProcess returned while aborting an incompatible gateway route");
  }

  private finalizeInferenceRouteReservation(
    state: SandboxStepState<WebSearchConfig>,
    sandboxName: string,
  ): void {
    const sessionId = state.session?.sessionId;
    if (sessionId && this.deps.finalizeSandboxRouteReservation(sandboxName, sessionId)) {
      return;
    }
    this.deps.error(
      `  Error: sandbox '${sandboxName}' inference route reservation changed while onboarding was in progress. Retry onboarding.`,
    );
    this.deps.exitProcess(1);
  }

  private assertRegistryMessagingPlanUnchanged(
    sandboxName: string,
    expectedAuthority: RegistryMessagingAuthority,
  ): void {
    const currentAuthority = this.deps.getRegistrySandboxMessagingAuthority(sandboxName);
    if (sameRegistryMessagingAuthority(currentAuthority, expectedAuthority)) return;
    this.deps.error(
      `  Messaging channel state for sandbox '${sandboxName}' changed while onboarding was in progress.`,
    );
    this.deps.error(
      `  Retry with the latest channel state: ${this.deps.cliName()} onboard --name ${sandboxName}`,
    );
    this.deps.exitProcess(1);
    throw new Error("exitProcess returned after messaging channel state changed");
  }

  private async reuseSandbox(
    state: SandboxStepState<WebSearchConfig>,
  ): Promise<SandboxStepState<WebSearchConfig>> {
    return this.deps.withGatewayRouteMutationLock(this.options.gatewayName, async () => {
      this.assertCheckpointBindingsStillLive(state);
      this.assertGatewayRouteCompatible(state.sandboxName);
      if (state.webSearchConfig) {
        const provider = webSearchProviderForConfig(
          state.webSearchConfig as unknown as SharedWebSearchConfig,
        );
        this.deps.note(
          `  [resume] Reusing ${webSearchLabelFor(provider)} configuration already baked into the sandbox.`,
        );
      }
      const messagingAuthority = this.resolveSandboxMessagingAuthority(
        state.sandboxName,
        state.session,
      );
      const messaging = reconcileReusedSandboxMessaging(
        messagingAuthority.plan,
        this.options.agent,
        this.deps,
        state.session?.messagingPlan ?? null,
      );
      if (state.sandboxName) {
        this.revalidatePolicyRequirements(
          state.sandboxName,
          messaging.selectedChannels,
          state.webSearchConfig,
          state.session,
          `record reused sandbox state for '${state.sandboxName}'`,
        );
      }
      if (messaging.changed) {
        this.deps.updateSession((current) => {
          current.messagingPlan = messaging.plan;
          recordCheckpointMessaging(current, messaging.plan);
          return current;
        });
      }
      this.backfillReusedSandboxFidelity(state);
      this.deps.skippedStepMessage("sandbox", state.sandboxName, "reuse");
      if (state.sandboxName) {
        this.revalidatePolicyRequirements(
          state.sandboxName,
          messaging.selectedChannels,
          state.webSearchConfig,
          state.session,
          `record reused sandbox completion for '${state.sandboxName}'`,
        );
      }
      const skippedSession = await this.deps.recordStateSkipped("sandbox", {
        reason: "resume",
        sandboxName: state.sandboxName,
      });
      if (state.sandboxName) {
        this.revalidatePolicyRequirements(
          state.sandboxName,
          messaging.selectedChannels,
          state.webSearchConfig,
          state.session,
          `record reused sandbox receipts for '${state.sandboxName}'`,
        );
      }
      const recordedSession = this.backfillReusedSandboxCheckpointReceipts(
        skippedSession,
        state.sandboxName,
      );
      if (state.sandboxName) this.finalizeInferenceRouteReservation(state, state.sandboxName);
      return {
        ...state,
        session: recordedSession,
        selectedMessagingChannels: messaging.selectedChannels,
      };
    });
  }

  private backfillReusedSandboxCheckpointReceipts(
    session: Session,
    sandboxName: string | null,
  ): Session {
    if (!sandboxName || !session.checkpoint) return session;
    const agentName = (this.options.agent as { name?: string } | null)?.name ?? "openclaw";
    if (!checkpointIdentityForResumeTarget(session.checkpoint, sandboxName, agentName)) {
      return session;
    }
    if (
      session.checkpoint.effectGroups.sandbox_create &&
      session.checkpoint.effectGroups.sandbox_register
    ) {
      return session;
    }
    return this.deps.updateSession((current) => {
      const checkpoint = current.checkpoint;
      if (!checkpoint || !checkpointIdentityForResumeTarget(checkpoint, sandboxName, agentName)) {
        return current;
      }
      if (!checkpoint.effectGroups.sandbox_create) {
        recordCheckpointEffectGroup(
          current,
          "sandbox_create",
          this.currentSandboxCreateFingerprint(sandboxName),
        );
      }
      if (!checkpoint.effectGroups.sandbox_register) {
        recordCheckpointEffectGroup(current, "sandbox_register", sandboxName);
      }
      return current;
    });
  }

  private backfillReusedSandboxFidelity(state: SandboxStepState<WebSearchConfig>): void {
    if (!state.sandboxName) return;
    const existing = this.deps.getSandboxRegistryEntry(state.sandboxName);
    const fidelity = missingWebSearchFidelity(
      existing,
      state.webSearchConfig as unknown as SharedWebSearchConfig | null,
    );
    if (
      existing?.fromDockerfile === undefined &&
      (this.options.fromDockerfile || existing?.nemoclawVersion)
    ) {
      fidelity.fromDockerfile = this.options.fromDockerfile;
    }
    if (existing?.hermesAuthMethod === undefined && this.options.hermesAuthMethod) {
      fidelity.hermesAuthMethod = this.options.hermesAuthMethod;
    }
    Object.assign(fidelity, dcodeResume.selectionFidelity(this.options, existing));
    if (Object.keys(fidelity).length > 0) {
      this.deps.updateSandboxRegistry(state.sandboxName, fidelity);
    }
  }

  /**
   * Durable-ownership evidence that lets recreate reuse the web-search
   * credential already registered with this sandbox's OpenShell gateway
   * provider instead of revalidating a host credential.
   *
   * A staged receipt proves this session registered the provider itself, which
   * is the evidence an interrupted onboard resumes against. `rebuild` can never
   * present one: it resets the session and derives a fresh checkpoint before it
   * calls `onboard --resume`, so `stagedCredentialProviders` is empty by the
   * time recreate resolves web search. The recreate journal it hands off carries
   * that ownership claim instead — the same claim the rebuild preflight
   * (`canReuseGatewayWebSearchCredential`) and `messaging-prep` already accept
   * for this binding (#7097).
   *
   * A journal merely resident in the session is not enough, because nothing
   * binds it to this run: one survives a failed attempt, and
   * `beginSandboxRecreateTransaction` opens one straight at `deleted` when the
   * sandbox is already missing. What is checked is therefore that the journal
   * was handed to this run by the driver that owns the replacement, names this
   * sandbox, and has passed the delete boundary — the state in which the source
   * is gone and no host key can be read. Both forms stay paired with the exact
   * live gateway binding check, so neither can reuse a provider bound to
   * anything but this sandbox (#8717).
   */
  private ownsGatewayWebSearchProvider(
    state: SandboxStepState<WebSearchConfig>,
    providerName: string,
  ): boolean {
    if (state.session?.stagedCredentialProviders.includes(providerName)) return true;
    const handoff = this.options.recreateJournalTargetIntentFingerprint;
    const recreate = state.session?.checkpoint?.sandboxRecreate;
    return Boolean(
      handoff &&
      recreate &&
      recreate.sandboxName === state.sandboxName &&
      recreate.targetIntentFingerprint === handoff &&
      sandboxRecreatePhaseReached(recreate.phase, "deleted"),
    );
  }

  private async resolveWebSearchForCreation(
    state: SandboxStepState<WebSearchConfig>,
  ): Promise<WebSearchConfig | null> {
    if (!state.webSearchConfig) return this.resolveAbsentWebSearchForCreation(state);
    const provider = webSearchProviderForConfig(
      state.webSearchConfig as unknown as SharedWebSearchConfig,
    );
    const label = webSearchLabelFor(provider);
    const credentialEnv = webSearchEnvFor(provider);
    const localCredential = this.options.env[credentialEnv]?.trim();
    if (
      this.resumesSandboxPrompts &&
      this.options.resume &&
      state.sandboxName &&
      !localCredential &&
      this.ownsGatewayWebSearchProvider(state, `${state.sandboxName}-${provider}-search`) &&
      this.deps.providerMatchesGatewayCredential(
        `${state.sandboxName}-${provider}-search`,
        provider,
        credentialEnv,
      )
    ) {
      this.deps.note(`  [resume] Reusing ${label} credential registered with OpenShell.`);
      return state.webSearchConfig;
    }
    this.deps.note(`  [resume] Revalidating ${label} configuration for sandbox recreation.`);
    const credential = await this.deps.ensureValidatedWebSearchCredential(state.webSearchConfig);
    if (this.deps.isBackToSelection(credential) || !credential) return null;
    this.deps.note(`  [resume] Reusing ${label} configuration.`);
    return state.webSearchConfig;
  }

  private resolveAbsentWebSearchForCreation(
    state: SandboxStepState<WebSearchConfig>,
  ): Promise<WebSearchConfig | null> | null {
    const explicitlyConfigured = parseExplicitWebSearchProvider(
      this.options.env[WEB_SEARCH_PROVIDER_ENV],
    ).specified;
    const checkpoint = state.session?.checkpoint;
    const completedSelection =
      this.resumesSandboxPrompts &&
      this.options.resume &&
      (checkpoint
        ? !isDecisionUnset(checkpoint.webSearch)
        : state.session?.sandboxPromptProgress?.webSearch === true);
    if (!this.options.authoritativeResumeConfig && !explicitlyConfigured && !completedSelection) {
      return this.deps.configureWebSearch(
        null,
        this.options.agent,
        state.webSearchSupportProbePath,
      );
    }
    const checkpointedValue = checkpoint
      ? (decisionValue(checkpoint.webSearch) as unknown as WebSearchConfig | null)
      : null;
    if (completedSelection && !explicitlyConfigured && !state.webSearchSupportDropped) {
      this.deps.note(
        checkpointedValue
          ? "  [resume] Reusing checkpointed web search selection."
          : "  [resume] Reusing web search selection: disabled.",
      );
    }
    return checkpointedValue ? Promise.resolve(checkpointedValue) : null;
  }

  private checkpointWebSearch(
    state: SandboxStepState<WebSearchConfig>,
    webSearchConfig: WebSearchConfig | null,
  ): SandboxStepState<WebSearchConfig> {
    if (!this.resumesSandboxPrompts) return { ...state, webSearchConfig };
    const session = this.deps.updateSession((current) => {
      current.webSearchConfig = webSearchConfig as unknown as Session["webSearchConfig"];
      current.sandboxPromptProgress.webSearch = true;
      recordCheckpointWebSearch(
        current,
        webSearchConfig as unknown as SharedWebSearchConfig | null,
      );
      return current;
    });
    return { ...state, session, webSearchConfig };
  }

  private checkpointSandboxName(
    state: SandboxStepState<WebSearchConfig>,
    sandboxName: string,
  ): SandboxStepState<WebSearchConfig> {
    if (!this.resumesSandboxPrompts) return { ...state, sandboxName };
    let messagingInvalidated = false;
    const session = this.deps.updateSession((current) => {
      const recordedNameChanged =
        current.sandboxName !== null && current.sandboxName !== sandboxName;
      const messagingPlanTargetsAnotherName =
        current.messagingPlan !== null && current.messagingPlan.sandboxName !== sandboxName;
      if (recordedNameChanged || messagingPlanTargetsAnotherName) {
        current.messagingPlan = null;
        current.sandboxPromptProgress.messaging = false;
        messagingInvalidated = true;
      }
      current.sandboxName = sandboxName;
      current.sandboxPromptProgress.sandboxName = true;
      recordCheckpointSandboxIdentity(
        current,
        sandboxName,
        current.agent ?? (this.options.agent as { name?: string } | null)?.name ?? "openclaw",
      );
      return current;
    });
    if (messagingInvalidated) this.deps.clearPlanEnv();
    return { ...state, session, sandboxName };
  }

  private recordSandboxIdentityForCreate(
    state: SandboxStepState<WebSearchConfig>,
    sandboxName: string,
  ): SandboxStepState<WebSearchConfig> {
    if (this.resumesSandboxPrompts) return state;
    const session = this.deps.updateSession((current) => {
      recordCheckpointSandboxIdentity(
        current,
        sandboxName,
        current.agent ?? (this.options.agent as { name?: string } | null)?.name ?? "openclaw",
      );
      return current;
    });
    return { ...state, session };
  }

  private checkpointMessaging(
    state: SandboxStepState<WebSearchConfig>,
    messaging: { plan: SandboxMessagingPlan | null; selectedChannels: string[] },
  ): SandboxStepState<WebSearchConfig> {
    if (!this.resumesSandboxPrompts) {
      return { ...state, selectedMessagingChannels: messaging.selectedChannels };
    }
    const session = this.deps.updateSession((current) => {
      current.messagingPlan = messaging.plan;
      current.sandboxPromptProgress.messaging = true;
      recordCheckpointMessaging(current, messaging.plan);
      return current;
    });
    return {
      ...state,
      session,
      selectedMessagingChannels: messaging.selectedChannels,
    };
  }

  private checkpointProviderEffectGroup(
    state: SandboxStepState<WebSearchConfig>,
    group: ProviderEffectGroupName,
    registeredProviders: readonly CheckpointProviderBinding[],
  ): SandboxStepState<WebSearchConfig> {
    if (!this.resumesSandboxPrompts) return state;
    const session = this.deps.updateSession((current) => {
      recordCheckpointProviderEffectGroup(current, group, registeredProviders);
      return current;
    });
    return { ...state, session };
  }

  private revalidatePolicyRequirements(
    sandboxName: string,
    selectedMessagingChannels: readonly string[],
    webSearchConfig: WebSearchConfig | null,
    session: Session | null,
    operation: string,
  ): void {
    this.deps.preflightPolicyRequirements({
      gatewayName: this.options.gatewayName,
      sandboxName,
      agent: this.options.agent,
      selectedMessagingChannels,
      hermesToolGateways: effectiveHermesToolGatewaysForWebSearch(
        this.options.agent as { name?: string } | null,
        webSearchConfig as unknown as SharedWebSearchConfig | null,
        this.options.hermesToolGateways,
      ),
      gpuPassthrough: session?.gpuPassthrough === true,
      provider: this.options.provider,
      hostLocalInferenceRouteOnly: this.options.hostLocalInferenceRouteOnly === true,
      webSearchConfig,
      observabilityEnabled: session?.observabilityEnabled === true,
      operation,
    });
  }

  private async registerCompletedCredentialProviders(
    sandboxName: string,
    enabledChannels: readonly string[],
    selectedMessagingChannels: readonly string[],
    webSearchConfig: WebSearchConfig | null,
    requiredBindings: readonly CheckpointProviderBinding[],
    group: ProviderEffectGroupName,
    checkpoint: OnboardCheckpoint | null,
    session: Session | null,
    force = false,
  ): Promise<void> {
    if (
      !this.resumesSandboxPrompts ||
      (!webSearchConfig && enabledChannels.length === 0 && requiredBindings.length === 0)
    ) {
      return;
    }
    const requiredBindingsByName = new Map(
      requiredBindings.map((binding) => [binding.name, binding]),
    );
    if (
      requiredBindingsByName.size !== requiredBindings.length ||
      requiredBindings.some((binding) => !binding.name || !binding.type || !binding.credentialEnv)
    ) {
      this.deps.error("  Provider setup produced conflicting credential bindings.");
      return this.deps.exitProcess(1);
    }
    if (
      !force &&
      checkpoint &&
      planEffectGroupReplay(
        checkpoint,
        group,
        observeProviderEffectFingerprint(checkpoint, group, requiredBindings, (binding) =>
          this.deps.providerMatchesGatewayCredential(
            binding.name,
            binding.type,
            binding.credentialEnv,
          ),
        ),
      ).action === "skip"
    ) {
      return;
    }
    const registeredProviders = await this.deps.withGatewayRouteMutationLock(
      this.options.gatewayName,
      async () => {
        const revalidatePolicyRequirements = (operation: string) =>
          this.revalidatePolicyRequirements(
            sandboxName,
            selectedMessagingChannels,
            webSearchConfig,
            session,
            operation,
          );
        revalidatePolicyRequirements(
          `register credential providers for sandbox ${JSON.stringify(sandboxName)}`,
        );
        const staged = await this.deps.stageSandboxCredentialProviders({
          sandboxName,
          enabledChannels,
          webSearchConfig,
          agent: this.options.agent,
          requiredBindings,
          revalidatePolicyRequirements,
        });
        const stagedProviderNames = new Set<string>();
        for (const binding of staged) {
          const required = requiredBindingsByName.get(binding.name);
          if (
            stagedProviderNames.has(binding.name) ||
            !required ||
            binding.type !== required.type ||
            binding.credentialEnv !== required.credentialEnv
          ) {
            this.deps.error("  Provider setup returned unexpected credential bindings.");
            return this.deps.exitProcess(1);
          }
          stagedProviderNames.add(binding.name);
        }
        const allRequiredBindingsLive = requiredBindings.every((binding) =>
          this.deps.providerMatchesGatewayCredential(
            binding.name,
            binding.type,
            binding.credentialEnv,
          ),
        );
        if (!allRequiredBindingsLive) {
          this.deps.error("  OpenShell did not retain the selected credential bindings.");
          this.deps.error("  Re-run onboarding with the required credentials available.");
          return this.deps.exitProcess(1);
        }
        return staged;
      },
    );
    if (registeredProviders.length > 0) {
      this.deps.note("  ✓ Registered selected credentials with OpenShell for resume.");
    }
  }

  private async stageMessagingProvidersForCreate(
    sandboxName: string,
    state: SandboxStepState<WebSearchConfig>,
    requiredBindings: readonly CheckpointProviderBinding[],
    registryAuthoritySnapshot: RegistryMessagingAuthority,
    force: boolean,
  ): Promise<void> {
    if (state.selectedMessagingChannels.length === 0) return;
    const stage = async () => {
      this.assertRegistryMessagingPlanUnchanged(sandboxName, registryAuthoritySnapshot);
      await this.registerCompletedCredentialProviders(
        sandboxName,
        state.selectedMessagingChannels,
        state.selectedMessagingChannels,
        null,
        requiredBindings,
        "messaging_providers",
        state.session?.checkpoint ?? null,
        state.session,
        force,
      );
    };
    if (this.deps.withSandboxMutationLock) {
      await this.deps.withSandboxMutationLock(sandboxName, stage);
    } else {
      await stage();
    }
  }

  private async resolveResourceProfile(state: SandboxStepState<WebSearchConfig>): Promise<{
    state: SandboxStepState<WebSearchConfig>;
    resourceProfile: ResourceProfile | null;
  }> {
    const checkpoint = state.session?.checkpoint;
    const completedSelection = checkpoint
      ? !isDecisionUnset(checkpoint.resourceProfile)
      : state.session?.sandboxPromptProgress?.resourceProfile === true;
    if (
      this.resumesSandboxPrompts &&
      this.options.resume &&
      completedSelection &&
      !hasResourceProfileEnvOverride(this.options.env)
    ) {
      const resourceProfile = (
        checkpoint ? decisionValue(checkpoint.resourceProfile) : state.session?.resourceProfile
      ) as ResourceProfile | null;
      this.deps.note(
        resourceProfile
          ? "  [resume] Reusing resource profile selection."
          : "  [resume] Reusing OpenShell default resources.",
      );
      return { state, resourceProfile };
    }

    const resourceProfile = await this.deps.selectResourceProfileForSandbox();
    if (!this.resumesSandboxPrompts) return { state, resourceProfile };
    const session = this.deps.updateSession((current) => {
      current.resourceProfile = resourceProfile as SessionResourceProfile | null;
      current.sandboxPromptProgress.resourceProfile = true;
      recordCheckpointResourceProfile(current, resourceProfile as CheckpointResourceProfile | null);
      return current;
    });
    return { state: { ...state, session }, resourceProfile };
  }

  private async buildSandboxCreateIntent(
    state: SandboxStepState<WebSearchConfig>,
    sandboxName: string,
    decision: SandboxCreationDecision,
    extraProviders: readonly string[],
    staleExtraProviders: readonly string[],
    resourceProfile: ResourceProfile | null,
    hermesToolGateways: readonly string[],
  ): Promise<CompleteSandboxCreateIntent> {
    clearExternallyManagedPolicyPresets(state.session, this.deps.updateSession);
    const reuseRegisteredCredentials = this.resumesSandboxPrompts && this.options.resume;
    const rebuildPolicyPresetSelection = rebuildPolicyPresetsForCreateIntent(
      this.options.rebuildPolicyPresets,
      state.session,
      sandboxName,
    );
    const resolved = applyAuthoritativeRebuildPolicyPresets(
      await this.deps.resolveSandboxCreateIntent({
        sandboxName,
        inferenceProvider: this.options.provider,
        hostLocalInferenceRouteOnly: this.options.hostLocalInferenceRouteOnly === true,
        enabledChannels: state.selectedMessagingChannels,
        webSearchConfig: state.webSearchConfig,
        agent: this.options.agent,
        sandboxGpuConfig: this.options.sandboxGpuConfig,
        resourceProfile,
        hermesToolGateways,
        extraProviders,
        staleExtraProviders,
        hostMounts: this.options.hostMounts,
        baselineExclusions: baselineExclusionsForCreate(sandboxName),
        ...(reuseRegisteredCredentials ? { reuseRegisteredCredentials: true } : {}),
        ...(this.options.authoritativePolicyTier !== undefined
          ? { policyTier: this.options.authoritativePolicyTier }
          : {}),
      }),
      rebuildPolicyPresetSelection.rebuildPolicyPresets,
    );
    return {
      resolved,
      recreate: requiresSandboxRecreation(decision, this.options.recreateSandbox(false)),
      toolDisclosure: toolDisclosureOrDefault(state.session?.toolDisclosure),
      observabilityEnabled: state.session?.observabilityEnabled === true,
      ...(reuseRegisteredCredentials ? { reuseRegisteredCredentials: true as const } : {}),
      ...(this.options.endpointUrl ? { endpointUrl: this.options.endpointUrl } : {}),
      ...compatibleEndpointReasoningForCreateIntent(this.options.compatibleEndpointReasoning),
      endpointSource: endpointSourceForCreateIntent(
        this.options.fresh,
        this.options.endpointSource,
        this.options.hostLocalInferenceRouteOnly === true ||
          this.options.hermesPortableLifecycle === true,
      ),
      ...(state.session?.observabilityRequestedExplicitly === true
        ? { observabilityRequestedExplicitly: true as const }
        : {}),
      ...(!this.options.fromDockerfile &&
      isDcodeAgent((this.options.agent as { name?: string } | null)?.name)
        ? { dcodeAutoApprovalMode: this.dcodeAutoApprovalMode }
        : {}),
      ...(this.options.authoritativePolicyTier !== undefined
        ? { policyTier: this.options.authoritativePolicyTier }
        : {}),
      ...(this.options.rebuildPreservedEnv
        ? { rebuildPreservedEnv: this.options.rebuildPreservedEnv }
        : {}),
      recreateJournalTargetIntentFingerprint:
        this.options.recreateJournalTargetIntentFingerprint ?? undefined,
      ...rebuildPolicyPresetSelection,
      extraProviders,
    };
  }

  private beginSandboxRecreateJournal(
    state: SandboxStepState<WebSearchConfig>,
    sandboxName: string,
    createIntent: CompleteSandboxCreateIntent,
    sourceEntry: SandboxEntry | null,
  ): CheckpointSandboxRecreateTransaction | null {
    const existing = state.session?.checkpoint?.sandboxRecreate ?? null;
    if (!this.options.resume && !existing && sourceEntry) return null;
    const gateway = selectedGatewayForSandboxRecreate(
      state.session?.checkpoint,
      this.options.gatewayName,
    );
    if (
      existing &&
      (!gateway ||
        existing.gatewayName !== gateway.gatewayName ||
        existing.gatewayPort !== gateway.gatewayPort)
    ) {
      throw new Error(
        `Cannot resume sandbox '${existing.sandboxName}' recreation: journaled gateway '${existing.gatewayName}:${String(existing.gatewayPort)}' does not match the selected gateway authority.`,
      );
    }
    if (!gateway) return null;
    const observation = this.deps.getSandboxRecreateObservation(sandboxName);
    const updated = this.deps.updateSession((current) => {
      beginSandboxRecreateTransaction(current, {
        sandboxName,
        gatewayName: gateway.gatewayName,
        gatewayPort: gateway.gatewayPort,
        sourceEntry,
        observation,
        targetIntentFingerprint: selectSandboxRecreateTargetIntentFingerprint(
          existing,
          this.sandboxRecreateTargetIntentFingerprint(sandboxName, createIntent),
          this.options.recreateJournalTargetIntentFingerprint,
        ),
      });
      return current;
    });
    return updated.checkpoint?.sandboxRecreate ?? null;
  }

  private sandboxRecreateTargetIntentFingerprint(
    sandboxName: string,
    createIntent: CompleteSandboxCreateIntent,
  ): string {
    const journaled = this.options.recreateJournalTargetIntentFingerprint;
    if (journaled) return journaled;
    return fingerprintSandboxRecreateValue(
      this.currentSandboxCreateFingerprint(sandboxName, createIntent.resolved),
    );
  }

  private recordSandboxRecreatePhase(
    transaction: CheckpointSandboxRecreateTransaction,
    phase: Parameters<typeof advanceSandboxRecreateTransaction>[2],
  ): void {
    this.deps.updateSession((current) => {
      advanceSandboxRecreateTransaction(current, transaction.id, phase);
      return current;
    });
  }

  private clearSandboxRecreateJournal(transaction: CheckpointSandboxRecreateTransaction): Session {
    return this.deps.updateSession((current) => {
      clearCompletedSandboxRecreateTransaction(current, transaction.id);
      return current;
    });
  }

  private async prepareSandboxRecreate(
    state: SandboxStepState<WebSearchConfig>,
    requestedSandboxName: string,
    createIntent: CompleteSandboxCreateIntent,
    decision: SandboxCreationDecision,
  ): Promise<SandboxRecreatePreparation> {
    const sourceEntry = this.deps.getSandboxRegistryEntry(requestedSandboxName);
    const continueHermesPortableLifecycle =
      decision.kind === "create" && decision.continueHermesPortableLifecycle === true;
    const transaction = continueHermesPortableLifecycle
      ? null
      : this.beginSandboxRecreateJournal(state, requestedSandboxName, createIntent, sourceEntry);
    const repairMetadata: SandboxRecreateRepairMetadata | null =
      decision.kind === "repair-and-recreate"
        ? { repair: "recorded-sandbox-cleanup", sandboxName: state.sandboxName }
        : null;
    if (!transaction) {
      if (replacesSameNameSandbox(decision)) {
        throw new Error(
          `Cannot replace same-name sandbox '${requestedSandboxName}': no recreate transaction proves ownership of the source sandbox and its registry row.`,
        );
      }
      if (decision.kind === "recreate") this.deps.note(decision.note);
      return {
        transaction,
        sourceEntry: null,
        effectiveCreateIntent: createIntent,
        repairMetadata,
      };
    }
    const effectiveCreateIntent: CompleteSandboxCreateIntent = {
      ...createIntent,
      recreate: true,
      recreateTransaction: {
        id: transaction.id,
        targetGeneration: transaction.targetGeneration,
        targetIntentFingerprint: transaction.targetIntentFingerprint,
      },
    };
    if (repairMetadata) {
      this.deps.note(
        `  [resume] Recorded sandbox '${state.sandboxName}' exists but is not ready; recreating it.`,
      );
      await this.deps.recordRepairEvent("state.repair.started", {
        state: "sandbox",
        metadata: repairMetadata,
      });
    } else if (decision.kind === "recreate") {
      this.deps.note(decision.note);
    }
    return {
      transaction,
      sourceEntry: sandboxRecreateSourceWorkloadEntry(transaction) ?? sourceEntry,
      effectiveCreateIntent,
      repairMetadata,
    };
  }

  private async recordSandboxRecreateRepairFailure(
    transaction: CheckpointSandboxRecreateTransaction | null,
    repairMetadata: SandboxRecreateRepairMetadata | null,
    error: unknown,
  ): Promise<void> {
    if (!repairMetadata || !transaction) return;
    await this.deps.recordRepairEvent("state.repair.failed", {
      state: "sandbox",
      error: error instanceof Error ? error.message : String(error),
      metadata: repairMetadata,
    });
  }

  private async recordSandboxRecreateRepairSuccess(
    transaction: CheckpointSandboxRecreateTransaction | null,
    repairMetadata: SandboxRecreateRepairMetadata | null,
  ): Promise<void> {
    if (!repairMetadata || !transaction) return;
    await this.deps.recordRepairEvent("state.repair.completed", {
      state: "sandbox",
      metadata: repairMetadata,
    });
  }

  private recordSandboxRecreateRegistryCommit(
    transaction: CheckpointSandboxRecreateTransaction | null,
  ): void {
    if (!transaction || transaction.phase === "completed") return;
    this.recordSandboxRecreatePhase(transaction, "registry_committing");
  }

  private reloadSandboxRecreateTransaction(
    transaction: CheckpointSandboxRecreateTransaction | null,
  ): CheckpointSandboxRecreateTransaction | null {
    if (!transaction) return null;
    const current = this.deps.updateSession((session) => session).checkpoint?.sandboxRecreate;
    if (!current || current.id !== transaction.id) {
      throw new Error("Sandbox recreate transaction ownership changed after replacement creation.");
    }
    return current;
  }

  private retireSandboxRecreateSourceWorkload(
    transaction: CheckpointSandboxRecreateTransaction | null,
    sourceEntry: ReplacedSandboxSourceEntry | null,
    sandboxName: string,
  ): void {
    if (!transaction || !sourceEntry) return;
    const retired = (
      this.deps.retireReplacedSandboxWorkload ?? retireReplacedSandboxWorkloadDefault
    )(
      sandboxName,
      transaction.targetGeneration,
      transaction.targetLiveIdentityFingerprint,
      sourceEntry,
      this.deps.getSandboxRegistryEntry(sandboxName),
    );
    if (retired.status === "removed") {
      this.deps.note(`  Removed obsolete ${retired.engineDisplayName} image ${retired.reference}`);
    } else if (retired.status === "failed") {
      this.deps.note(
        `  Warning: failed to remove obsolete ${retired.engineDisplayName} image ${retired.reference}; run '${this.deps.cliName()} gc' to clean up.`,
      );
    } else if (retired.status === "skipped") {
      this.deps.note(SANDBOX_RECREATE_WORKLOAD_SKIP_DIAGNOSTIC[retired.reason]);
    }
  }

  private recordSandboxCreateEffects(
    transaction: CheckpointSandboxRecreateTransaction | null,
    sandboxName: string,
    createIntent: CompleteSandboxCreateIntent,
  ): Session {
    const recordedSession = this.deps.updateSession((current) => {
      recordCheckpointEffectGroup(
        current,
        "sandbox_create",
        this.currentSandboxCreateFingerprint(sandboxName, createIntent.resolved),
      );
      recordCheckpointEffectGroup(current, "sandbox_register", sandboxName);
      if (transaction) {
        advanceSandboxRecreateTransaction(current, transaction.id, "completed");
      }
      return current;
    });
    return transaction ? this.clearSandboxRecreateJournal(transaction) : recordedSession;
  }

  private async createAndRecordSandbox(
    initialState: SandboxStepState<WebSearchConfig>,
    requestedSandboxName: string,
    messagingPlan: SandboxMessagingPlan | null,
    registryMessagingAuthoritySnapshot: RegistryMessagingAuthority,
    decision: SandboxCreationDecision,
  ): Promise<SandboxStepState<WebSearchConfig>> {
    const resourceSelection = await this.resolveResourceProfile(initialState);
    const state = resourceSelection.state;
    const resourceProfile = resourceSelection.resourceProfile;
    const effectiveHermesToolGateways = effectiveHermesToolGatewaysForWebSearch(
      this.options.agent as { name?: string } | null,
      state.webSearchConfig as unknown as SharedWebSearchConfig | null,
      this.options.hermesToolGateways,
    );
    const revalidatePolicyRequirements = (operation: string) =>
      this.revalidatePolicyRequirements(
        requestedSandboxName,
        state.selectedMessagingChannels,
        state.webSearchConfig,
        state.session,
        operation,
      );
    const extraProviderPlan = this.deps.planRegisteredExtraProviders(this.options.gatewayName);
    const createAndRecord = async (): Promise<SandboxStepState<WebSearchConfig>> => {
      this.assertRegistryMessagingPlanUnchanged(
        requestedSandboxName,
        registryMessagingAuthoritySnapshot,
      );
      // Build the complete create plan after acquiring the sandbox lock. A
      // baseline transaction may have started while onboarding waited, and a
      // pre-lock snapshot must never survive a destructive recreate.
      const createIntent = await this.buildSandboxCreateIntent(
        state,
        requestedSandboxName,
        decision,
        extraProviderPlan.extraProviders,
        extraProviderPlan.staleExtraProviders,
        resourceProfile,
        effectiveHermesToolGateways,
      );
      this.assertGatewayRouteCompatible(requestedSandboxName);
      this.assertCheckpointBindingsStillLive(state);
      this.assertCheckpointCreateInputsStillMatch(
        state,
        requestedSandboxName,
        createIntent.resolved,
      );
      await this.deps.startRecordedStep("sandbox", {
        sandboxName: requestedSandboxName,
        provider: this.options.provider,
        model: this.options.model,
      });
      this.deps.updateSession((current) => {
        current.messagingPlan = messagingPlan;
        return current;
      });
      // Re-read at the destructive edge. The lock prevents cooperating
      // writers from changing this state; the equality check also catches a
      // direct registry writer that bypassed the lock.
      assertBaselineExclusionsMatchCreateIntent(
        requestedSandboxName,
        createIntent.resolved.policy.options.baselineExclusions,
      );
      const { transaction, sourceEntry, effectiveCreateIntent, repairMetadata } =
        await this.prepareSandboxRecreate(state, requestedSandboxName, createIntent, decision);

      let sandboxName: string;
      try {
        revalidatePolicyRequirements(`create sandbox '${requestedSandboxName}'`);
        if (this.options.fresh) {
          this.deps.stopStaleDashboardListenersForSandbox(
            this.deps.listRegistrySandboxes().sandboxes,
            requestedSandboxName,
          );
        }
        sandboxName = await withSandboxPhaseTrace(
          requestedSandboxName,
          this.options.provider,
          this.options.model,
          (this.options.agent as { name?: string } | null)?.name,
          () =>
            this.deps.createSandbox(
              this.options.gpu,
              this.options.model,
              this.options.provider,
              this.options.preferredInferenceApi,
              requestedSandboxName,
              state.webSearchConfig,
              state.selectedMessagingChannels,
              this.options.fromDockerfile,
              this.options.agent,
              this.options.controlUiPort,
              this.options.sandboxGpuConfig,
              resourceProfile,
              effectiveHermesToolGateways,
              this.options.hermesAuthMethod,
              this.options.session ? { sessionId: this.options.session.sessionId } : null,
              effectiveCreateIntent,
            ),
        );
      } catch (error) {
        await this.recordSandboxRecreateRepairFailure(transaction, repairMetadata, error);
        throw error;
      }
      revalidatePolicyRequirements("complete the created sandbox");
      let recordedTransaction: CheckpointSandboxRecreateTransaction | null;
      try {
        recordedTransaction = this.reloadSandboxRecreateTransaction(transaction);
        this.retireSandboxRecreateSourceWorkload(recordedTransaction, sourceEntry, sandboxName);
        await this.recordSandboxRecreateRepairSuccess(recordedTransaction, repairMetadata);
      } catch (error) {
        await this.recordSandboxRecreateRepairFailure(transaction, repairMetadata, error);
        throw error;
      }
      revalidatePolicyRequirements("complete sandbox repair");
      this.recordSandboxRecreateRegistryCommit(recordedTransaction);
      // createSandbox() owns the build fingerprint. In particular, reusing an
      // image must not stamp it with the current version and hide build drift.
      const {
        nemoclawVersion: _builtFingerprint,
        agent: _registeredAgent,
        ...agentRegistryFields
      } = this.deps.getSandboxAgentRegistryFields(this.options.agent, !this.options.fromDockerfile);
      // Preserve the validated route and credential env-var name, never a credential value.
      revalidatePolicyRequirements("register the created sandbox");
      this.deps.updateSandboxRegistry(sandboxName, {
        model: this.options.model,
        provider: this.options.provider,
        endpointUrl: this.options.endpointUrl,
        endpointSource: createIntent.endpointSource ?? null,
        credentialEnv: this.options.credentialEnv,
        nimContainer: this.options.nimContainer,
        preferredInferenceApi: this.options.preferredInferenceApi,
        ...agentRegistryFields,
      });
      // Finalization marks the default so a cancelled onboarding cannot leave a
      // partially configured sandbox selected as the default.
      revalidatePolicyRequirements("complete the sandbox onboarding session");
      await this.deps.recordStepComplete(
        "sandbox",
        this.deps.toSessionUpdates({
          sandboxName,
          provider: this.options.provider,
          model: this.options.model,
          nimContainer: this.options.nimContainer,
          webSearchConfig: state.webSearchConfig,
          messagingPlan,
          hermesToolGateways: effectiveHermesToolGateways,
        }),
      );
      revalidatePolicyRequirements("record the final sandbox creation receipt");
      const recordedSession = this.recordSandboxCreateEffects(
        transaction,
        sandboxName,
        createIntent,
      );
      this.finalizeInferenceRouteReservation(state, sandboxName);
      return { ...state, sandboxName, session: recordedSession };
    };
    const withGatewayLock = () =>
      this.deps.withGatewayRouteMutationLock(this.options.gatewayName, createAndRecord);
    const withDashboardPortLock =
      this.deps.withDashboardPortReservationLock ?? withHostDashboardPortReservationLock;
    const withDashboardAndGatewayLocks = () =>
      shouldManageDashboardForAgent(this.options.agent as DashboardRuntimeAgent)
        ? withDashboardPortLock(withGatewayLock)
        : withGatewayLock();
    return this.deps.withSandboxMutationLock
      ? this.deps.withSandboxMutationLock(requestedSandboxName, withDashboardAndGatewayLocks)
      : withDashboardAndGatewayLocks();
  }

  private resolveSandboxMessagingAuthority(
    sandboxName: string | null,
    session: Session | null,
  ): ReturnType<typeof resolveMessagingPlanAuthority> {
    const registry = sandboxName
      ? this.deps.getRegistrySandboxMessagingAuthority(sandboxName)
      : { authoritative: false as const, plan: null };
    return resolveMessagingPlanAuthority({
      sandboxName: sandboxName ?? "",
      registry,
      stagedPlan: registry.authoritative ? null : this.deps.readMessagingPlanFromEnv(),
      sessionPlan: session?.messagingPlan ?? null,
    });
  }

  private assertMessagingPlanTargetsSandbox(sandboxName: string, session: Session | null): void {
    this.resolveSandboxMessagingAuthority(sandboxName, session);
  }

  private assertExistingMessagingPlanTargetsSandbox(
    state: SandboxStepState<WebSearchConfig>,
  ): void {
    const sandboxName = state.sandboxName;
    if (!sandboxName || state.session?.sandboxName !== sandboxName) return;
    this.assertMessagingPlanTargetsSandbox(sandboxName, state.session);
  }

  private validateProviderBindingsForRegistration(
    checkpoint: OnboardCheckpoint | null,
    webSearchBindings: readonly CheckpointProviderBinding[],
    messagingBindings: readonly CheckpointProviderBinding[],
  ): void {
    const bindings = [...webSearchBindings, ...messagingBindings];
    const providerNames = new Set(bindings.map((binding) => binding.name));
    if (
      providerNames.size !== bindings.length ||
      bindings.some((binding) => !isCanonicalCheckpointProviderBinding(binding))
    ) {
      this.deps.error("  Provider setup produced conflicting credential bindings.");
      return this.deps.exitProcess(1);
    }
    if (!checkpoint) return;
    const recordedWebSearchNames = new Set(
      checkpointProviderReceiptNames(checkpoint, "web_search_provider"),
    );
    const recordedMessagingNames = new Set(
      checkpointProviderReceiptNames(checkpoint, "messaging_providers"),
    );
    if (
      webSearchBindings.some((binding) => recordedMessagingNames.has(binding.name)) ||
      messagingBindings.some((binding) => recordedWebSearchNames.has(binding.name))
    ) {
      return this.rejectInvalidCheckpointProviderBindings();
    }
  }

  private async recreateSandbox(
    state: SandboxStepState<WebSearchConfig>,
    decision: SandboxCreationDecision,
  ): Promise<SandboxStepState<WebSearchConfig>> {
    const mcpBlockReason = mcpRegistryRemovalBlockReason(
      decision,
      state.sandboxName,
      state.webSearchConfig as unknown as SharedWebSearchConfig | null,
      this.deps.getSandboxRegistryEntry,
    );
    if (mcpBlockReason) {
      this.deps.error(mcpBlockReason);
      return this.deps.exitProcess(1);
    }
    this.assertExistingMessagingPlanTargetsSandbox(state);
    let nextState = state.sandboxName
      ? this.checkpointSandboxName(state, state.sandboxName)
      : state;
    const requestedSandboxName =
      nextState.sandboxName ?? (await this.deps.promptValidatedSandboxName(this.options.agent));
    if (!nextState.sandboxName) {
      nextState = this.checkpointSandboxName(nextState, requestedSandboxName);
    }
    nextState = this.recordSandboxIdentityForCreate(nextState, requestedSandboxName);
    const webSearchConfig = await this.resolveWebSearchForCreation(nextState);
    const webSearchConfigChanged =
      nextState.webSearchConfigChanged ||
      !webSearchConfigsEqual(
        nextState.webSearchConfig as unknown as SharedWebSearchConfig | null,
        webSearchConfig as unknown as SharedWebSearchConfig | null,
      );
    nextState = this.checkpointWebSearch(
      {
        ...nextState,
        webSearchConfig,
        webSearchConfigChanged,
      },
      webSearchConfig,
    );
    this.assertMessagingPlanTargetsSandbox(requestedSandboxName, nextState.session);
    const webSearchProviderBindings = requiredWebSearchProviderBindings(
      requestedSandboxName,
      nextState.webSearchConfig as unknown as SharedWebSearchConfig | null,
      this.options.agent as { name?: string } | null,
    );
    const registryMessagingAuthority =
      this.deps.getRegistrySandboxMessagingAuthority(requestedSandboxName);
    const registryMessagingPlan = registryMessagingAuthority.plan;
    const messagingCredentialBaseline =
      registryMessagingPlan ?? nextState.session?.messagingPlan ?? null;
    const messagingCredentialChanged = decision.validateMessagingCredentialsBeforeMutation === true;
    const messaging = await reconcileSandboxMessaging({
      resume: this.options.resume,
      session: nextState.session,
      sandboxName: requestedSandboxName,
      agent: this.options.agent,
      env: this.options.env,
      registryAuthoritySnapshot: registryMessagingAuthority,
      credentialValidationPlan: messagingCredentialChanged ? messagingCredentialBaseline : null,
      forceCredentialValidation: messagingCredentialChanged,
      deps: this.deps,
    });
    const messagingProviderBindings = requiredMessagingProviderBindings(
      requestedSandboxName,
      messaging.plan,
    );
    this.validateProviderBindingsForRegistration(
      nextState.session?.checkpoint ?? null,
      webSearchProviderBindings,
      messagingProviderBindings,
    );
    nextState = this.checkpointMessaging(nextState, messaging);
    await this.registerCompletedCredentialProviders(
      requestedSandboxName,
      [],
      nextState.selectedMessagingChannels,
      nextState.webSearchConfig,
      webSearchProviderBindings,
      "web_search_provider",
      nextState.session?.checkpoint ?? null,
      nextState.session,
    );
    nextState = this.checkpointProviderEffectGroup(
      nextState,
      "web_search_provider",
      webSearchProviderBindings,
    );
    await this.stageMessagingProvidersForCreate(
      requestedSandboxName,
      nextState,
      messagingProviderBindings,
      registryMessagingAuthority,
      shouldForceMessagingProviderRegistration(
        messagingCredentialChanged,
        messagingCredentialBaseline,
        messaging.plan,
      ),
    );
    nextState = this.checkpointProviderEffectGroup(
      nextState,
      "messaging_providers",
      messagingProviderBindings,
    );
    if (this.resumesSandboxPrompts) {
      const session = this.deps.updateSession((current) => {
        recordCheckpointProviderEffectGroups(current, {
          webSearch: webSearchProviderBindings,
          messaging: messagingProviderBindings,
        });
        return current;
      });
      nextState = { ...nextState, session };
    }
    return this.createAndRecordSandbox(
      nextState,
      requestedSandboxName,
      messaging.plan,
      registryMessagingAuthority,
      decision,
    );
  }

  private complete(state: SandboxStepState<WebSearchConfig>): SandboxStateResult<WebSearchConfig> {
    if (!state.sandboxName) {
      this.deps.error("  Onboarding state is incomplete after sandbox setup.");
      return this.deps.exitProcess(1);
    }
    const hermesToolGateways = effectiveHermesToolGatewaysForWebSearch(
      this.options.agent as { name?: string } | null,
      state.webSearchConfig as unknown as SharedWebSearchConfig | null,
      this.options.hermesToolGateways,
    );
    if (
      this.options.hermesToolGateways.includes("nous-web") &&
      !hermesToolGateways.includes("nous-web")
    ) {
      this.deps.note(
        "  Tavily Search replaces Hermes managed Web search/extract and removes the conflicting nous-web selection.",
      );
    }
    return {
      sandboxName: state.sandboxName,
      webSearchConfig: state.webSearchConfig,
      webSearchConfigChanged: state.webSearchConfigChanged,
      hermesToolGateways,
      selectedMessagingChannels: state.selectedMessagingChannels,
      webSearchSupported: state.webSearchSupported,
      session: state.session,
      stateResult: branchTo(this.options.agent ? "agent_setup" : "openclaw", {
        metadata: {
          state: "sandbox",
          sandboxName: state.sandboxName,
          agent: (this.options.agent as { name?: string } | null)?.name ?? "openclaw",
        },
      }),
    };
  }

  async run(): Promise<SandboxStateResult<WebSearchConfig>> {
    if (this.options.session?.checkpoint) {
      this.replayableCheckpointProviderBindings(this.options.session.checkpoint);
    }
    this.dcodeAutoApprovalMode = dcodeResume.resolveAutoApprovalMode(
      this.options,
      this.options.sandboxName,
      this.deps,
    );
    const initialState = this.checkpointChangedExplicitSandboxName(
      this.applyObservabilityRequest(this.prepareWebSearchSupport()),
    );
    const decision = this.resolveResumeDecision(initialState);
    const completedState =
      decision.kind === "reuse"
        ? await this.reuseSandbox(initialState)
        : await this.recreateSandbox(initialState, decision);
    return this.complete(completedState);
  }
}

export async function handleSandboxState<
  Gpu,
  Agent,
  WebSearchConfig,
  MessagingChannelConfig,
  SandboxGpuConfig,
  ResourceProfile,
>(
  options: SandboxStateOptions<
    Gpu,
    Agent,
    WebSearchConfig,
    MessagingChannelConfig,
    SandboxGpuConfig,
    ResourceProfile
  >,
): Promise<SandboxStateResult<WebSearchConfig>> {
  const run = () => new SandboxStateFlow(options).run();
  return options.sandboxName && options.deps.withSandboxMutationLock
    ? options.deps.withSandboxMutationLock(options.sandboxName, run)
    : run();
}

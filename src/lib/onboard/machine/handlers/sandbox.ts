// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type CurrentGatewayRouteCompatibilityCheck,
  formatGatewayRouteConflict,
  type GatewayRouteCompatibilityResult,
  isAdvisoryGatewayRouteConflict,
} from "../../../inference/gateway-route-compatibility";
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
  OnboardCheckpoint,
} from "../../../state/onboard-checkpoint-types";
import type {
  HermesAuthMethod,
  Session,
  SessionResourceProfile,
  SessionUpdates,
} from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { getSandboxEntryInference } from "../../../state/registry-entry-view";
import { toolDisclosureOrDefault } from "../../../tool-disclosure";
import {
  recordCheckpointBindings,
  recordCheckpointEffectGroup,
  recordCheckpointMessaging,
  recordCheckpointResourceProfile,
  recordCheckpointSandboxIdentity,
  recordCheckpointWebSearch,
} from "../../checkpoint-record";
import {
  checkpointProvesSandboxStepComplete,
  planEffectGroupReplay,
  planSandboxCreateReplay,
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
import { withSandboxPhaseTrace } from "../../tracing";
import type { SandboxCreateIntent } from "../../types";
import { branchTo, type OnboardStateTransitionResult } from "../result";
import * as dcodeResume from "./sandbox-dcode-resume";
import { reconcileReusedSandboxMessaging, reconcileSandboxMessaging } from "./sandbox-messaging";
import {
  applySandboxResumeDecision,
  decideSandboxResume,
  hasHermesCompatibleAnthropicInferenceRouteDrift,
  mcpRegistryRemovalBlockReason,
  resolveToolDisclosureResumeSignals,
  type SandboxResumeDecision,
} from "./sandbox-resume";

function isAdvisoryPeerRouteDifference(
  result: Exclude<GatewayRouteCompatibilityResult, { ok: true }>,
  sandboxName: string,
): boolean {
  return (
    isAdvisoryGatewayRouteConflict(result) &&
    !result.conflicts.some((conflict) => conflict.sandboxName === sandboxName)
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
  /** Internal rebuild mode: null web-search state is an authoritative disable, not a prompt. */
  authoritativeResumeConfig?: boolean;
  /** Internal rebuild tier that must govern create-time and resumed policy selection. */
  authoritativePolicyTier?: string | null;
  resumeAgentChanged: boolean;
  requestedObservabilityEnabled?: boolean | null;
  requestedDcodeAutoApprovalMode?: DcodeAutoApprovalMode | null;
  recreateSandbox: (requested?: boolean) => boolean;
  gatewayName: string;
  session: Session | null;
  sandboxName: string | null;
  model: string;
  provider: string;
  endpointUrl: string | null;
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
    hasSandboxGpuDrift(sandboxName: string, config: SandboxGpuConfig): boolean;
    getSandboxHermesToolGateways(sandboxName: string): unknown;
    getSandboxRegistryEntry(sandboxName: string): SandboxEntry | null;
    normalizeHermesToolGatewaySelections(value: unknown): string[];
    stringSetsEqual(left: string[], right: string[]): boolean;
    removeSandboxFromRegistry(sandboxName: string): void;
    repairRecordedSandbox(sandboxName: string | null): void;
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
    getRegistrySandboxMessagingPlan(sandboxName: string): SandboxMessagingPlan | null;
    providerMatchesGatewayCredential(name: string, type: string, credentialEnv: string): boolean;
    stageSandboxCredentialProviders(input: {
      sandboxName: string;
      enabledChannels: readonly string[];
      webSearchConfig: WebSearchConfig | null;
      agent: Agent;
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
      enabledChannels: readonly string[];
      webSearchConfig: WebSearchConfig | null;
      agent: Agent;
      sandboxGpuConfig: SandboxGpuConfig;
      resourceProfile: ResourceProfile | null;
      hermesToolGateways: readonly string[];
      extraProviders: readonly string[];
      staleExtraProviders: readonly string[];
      policyTier?: string | null;
      reuseRegisteredCredentials?: boolean;
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
      createIntent: CompleteSandboxCreateIntent,
    ): Promise<string>;
    updateSandboxRegistry(sandboxName: string, updates: Record<string, unknown>): void;
    getSandboxAgentRegistryFields(
      agent: Agent,
      agentVersionKnown: boolean,
    ): Record<string, unknown>;
    recordStepComplete(stepName: string, updates: SessionUpdates): Promise<Session>;
    toSessionUpdates(updates: Record<string, unknown>): SessionUpdates;
    skippedStepMessage(stepName: string, detail?: string | null): void;
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

function hasResourceProfileEnvOverride(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NEMOCLAW_RESOURCE_PROFILE || env.NEMOCLAW_CPU || env.NEMOCLAW_RAM);
}

type SandboxCreationDecision = Exclude<SandboxResumeDecision, { readonly kind: "reuse" }>;
type CompleteSandboxCreateIntent = SandboxCreateIntent & {
  readonly resolved: ResolvedSandboxCreateIntent;
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
      webSearchConfigChanged: state.webSearchSupportDropped || state.webSearchConfigChanged,
      sandboxGpuConfigChanged: state.sandboxName
        ? this.deps.hasSandboxGpuDrift(state.sandboxName, this.options.sandboxGpuConfig)
        : false,
      recreateSandboxRequested: this.options.recreateSandbox(false),
      messagingChannelConfigChanged: !this.deps.messagingChannelConfigsEqual(
        effectiveMessagingConfig,
        storedMessagingConfig,
      ),
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
    const managedDcodeDecision = dcodeResume.preserveManagedDcodeRegistryEntry(
      this.options,
      decision,
    );
    return this.applyCheckpointCrashRecovery(managedDcodeDecision, state, sandboxReuseState);
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
    if (decision.kind !== "create") return decision;
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
      this.checkpointBindingAvailability(checkpoint),
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
    const recordedFingerprint = state.session?.checkpoint?.effectGroups.sandbox_create?.fingerprint;
    if (!recordedFingerprint) return;
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

  private providerBindingsLive(checkpoint: OnboardCheckpoint): boolean {
    if (checkpoint.bindings.registeredProviders.length === 0) return false;
    return checkpoint.bindings.registeredProviders.every((binding) =>
      this.deps.providerMatchesGatewayCredential(binding.name, binding.type, binding.credentialEnv),
    );
  }

  private checkpointBindingAvailability(checkpoint: OnboardCheckpoint): {
    availableCredentialEnvs: ReadonlySet<string>;
    liveRegisteredProviders: ReadonlySet<string>;
  } {
    const liveRegisteredBindings = checkpoint.bindings.registeredProviders.filter((binding) =>
      this.deps.providerMatchesGatewayCredential(binding.name, binding.type, binding.credentialEnv),
    );
    return {
      availableCredentialEnvs: new Set(
        [
          ...Object.keys(this.options.env).filter((name) =>
            Boolean(this.options.env[name]?.trim()),
          ),
          // Provider setup deliberately scrubs raw credentials from process.env
          // after registration. The exact live name/type/credential-key binding
          // is sufficient evidence for that scrubbed credential key (#7022).
          ...liveRegisteredBindings.map((binding) => binding.credentialEnv),
        ].filter(Boolean),
      ),
      liveRegisteredProviders: new Set(liveRegisteredBindings.map((binding) => binding.name)),
    };
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

  private async reuseSandbox(
    state: SandboxStepState<WebSearchConfig>,
  ): Promise<SandboxStepState<WebSearchConfig>> {
    return this.deps.withGatewayRouteMutationLock(this.options.gatewayName, async () => {
      this.assertGatewayRouteCompatible(state.sandboxName);
      if (state.webSearchConfig) {
        const provider = webSearchProviderForConfig(
          state.webSearchConfig as unknown as SharedWebSearchConfig,
        );
        this.deps.note(
          `  [resume] Reusing ${webSearchLabelFor(provider)} configuration already baked into the sandbox.`,
        );
      }
      const messaging = reconcileReusedSandboxMessaging(
        state.session?.messagingPlan ?? null,
        this.options.agent,
        this.deps,
      );
      if (messaging.changed) {
        this.deps.updateSession((current) => {
          current.messagingPlan = messaging.plan;
          return current;
        });
      }
      this.backfillReusedSandboxFidelity(state);
      if (state.sandboxName) {
        this.deps.updateSandboxRegistry(state.sandboxName, {
          pendingRouteReservation: undefined,
        });
      }
      this.deps.skippedStepMessage("sandbox", state.sandboxName);
      const skippedSession = await this.deps.recordStateSkipped("sandbox", {
        reason: "resume",
        sandboxName: state.sandboxName,
      });
      const recordedSession = this.backfillReusedSandboxCheckpointReceipts(
        skippedSession,
        state.sandboxName,
      );
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
      state.session?.stagedCredentialProviders.includes(
        `${state.sandboxName}-${provider}-search`,
      ) &&
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

  private async registerCompletedCredentialProviders(
    sandboxName: string,
    enabledChannels: readonly string[],
    webSearchConfig: WebSearchConfig | null,
    group: CheckpointEffectGroupName,
    checkpoint: OnboardCheckpoint | null,
  ): Promise<void> {
    if (!this.resumesSandboxPrompts || (!webSearchConfig && enabledChannels.length === 0)) return;
    if (
      checkpoint &&
      planEffectGroupReplay(checkpoint, group, this.providerBindingsLive(checkpoint)).action ===
        "skip"
    ) {
      return;
    }
    const registeredProviders = await this.deps.withGatewayRouteMutationLock(
      this.options.gatewayName,
      () =>
        this.deps.stageSandboxCredentialProviders({
          sandboxName,
          enabledChannels,
          webSearchConfig,
          agent: this.options.agent,
        }),
    );
    if (registeredProviders.length > 0) {
      this.deps.note("  ✓ Registered selected credentials with OpenShell for resume.");
      this.deps.updateSession((current) => {
        recordCheckpointBindings(current, {
          registeredProviders,
        });
        recordCheckpointEffectGroup(
          current,
          group,
          registeredProviders.map((binding) => binding.name).join(","),
        );
        return current;
      });
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
    const reuseRegisteredCredentials = this.resumesSandboxPrompts && this.options.resume;
    const resolved = await this.deps.resolveSandboxCreateIntent({
      sandboxName,
      inferenceProvider: this.options.provider,
      enabledChannels: state.selectedMessagingChannels,
      webSearchConfig: state.webSearchConfig,
      agent: this.options.agent,
      sandboxGpuConfig: this.options.sandboxGpuConfig,
      resourceProfile,
      hermesToolGateways,
      extraProviders,
      staleExtraProviders,
      ...(reuseRegisteredCredentials ? { reuseRegisteredCredentials: true } : {}),
      ...(this.options.authoritativePolicyTier !== undefined
        ? { policyTier: this.options.authoritativePolicyTier }
        : {}),
    });
    return {
      resolved,
      recreate: decision.kind !== "create",
      toolDisclosure: toolDisclosureOrDefault(state.session?.toolDisclosure),
      observabilityEnabled: state.session?.observabilityEnabled === true,
      ...(reuseRegisteredCredentials ? { reuseRegisteredCredentials: true as const } : {}),
      ...(this.options.endpointUrl ? { endpointUrl: this.options.endpointUrl } : {}),
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
      extraProviders,
    };
  }

  private async createAndRecordSandbox(
    initialState: SandboxStepState<WebSearchConfig>,
    requestedSandboxName: string,
    messagingPlan: SandboxMessagingPlan | null,
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
    const extraProviderPlan = this.deps.planRegisteredExtraProviders(this.options.gatewayName);
    const createIntent = await this.buildSandboxCreateIntent(
      state,
      requestedSandboxName,
      decision,
      extraProviderPlan.extraProviders,
      extraProviderPlan.staleExtraProviders,
      resourceProfile,
      effectiveHermesToolGateways,
    );
    const createAndRecord = async (): Promise<SandboxStepState<WebSearchConfig>> => {
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
      await applySandboxResumeDecision(decision, state.sandboxName, this.deps);
      if (this.options.fresh) {
        this.deps.stopStaleDashboardListenersForSandbox(
          this.deps.listRegistrySandboxes().sandboxes,
          requestedSandboxName,
        );
      }
      const sandboxName = await withSandboxPhaseTrace(
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
            createIntent,
          ),
      );
      // createSandbox() owns the build fingerprint. In particular, reusing an
      // image must not stamp it with the current version and hide build drift.
      const { nemoclawVersion: _builtFingerprint, ...agentRegistryFields } =
        this.deps.getSandboxAgentRegistryFields(this.options.agent, !this.options.fromDockerfile);
      // Preserve the validated route and credential env-var name, never a credential value.
      this.deps.updateSandboxRegistry(sandboxName, {
        model: this.options.model,
        provider: this.options.provider,
        endpointUrl: this.options.endpointUrl,
        credentialEnv: this.options.credentialEnv,
        nimContainer: this.options.nimContainer,
        preferredInferenceApi: this.options.preferredInferenceApi,
        ...agentRegistryFields,
      });
      // Finalization marks the default so a cancelled onboarding cannot leave a
      // partially configured sandbox selected as the default.
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
      const recordedSession = this.deps.updateSession((current) => {
        recordCheckpointEffectGroup(
          current,
          "sandbox_create",
          this.currentSandboxCreateFingerprint(sandboxName, createIntent.resolved),
        );
        recordCheckpointEffectGroup(current, "sandbox_register", sandboxName);
        return current;
      });
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
    await this.registerCompletedCredentialProviders(
      requestedSandboxName,
      [],
      nextState.webSearchConfig,
      "web_search_provider",
      nextState.session?.checkpoint ?? null,
    );
    const messaging = await reconcileSandboxMessaging({
      resume: this.options.resume,
      session: nextState.session,
      sandboxName: requestedSandboxName,
      agent: this.options.agent,
      deps: this.deps,
    });
    nextState = this.checkpointMessaging(nextState, messaging);
    await this.registerCompletedCredentialProviders(
      requestedSandboxName,
      nextState.selectedMessagingChannels,
      null,
      "messaging_providers",
      nextState.session?.checkpoint ?? null,
    );
    return this.createAndRecordSandbox(nextState, requestedSandboxName, messaging.plan, decision);
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
    this.dcodeAutoApprovalMode = dcodeResume.resolveAutoApprovalMode(
      this.options,
      this.options.sandboxName,
      this.deps,
    );
    const initialState = this.applyObservabilityRequest(this.prepareWebSearchSupport());
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

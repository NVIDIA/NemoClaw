// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
import type { HermesAuthMethod, Session, SessionUpdates } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { toolDisclosureOrDefault } from "../../../tool-disclosure";
import { withSandboxPhaseTrace } from "../../tracing";
import type { SandboxCreateIntent } from "../../types";
import { branchTo, type OnboardStateTransitionResult } from "../result";
import { reconcileReusedSandboxMessaging, reconcileSandboxMessaging } from "./sandbox-messaging";
import {
  applySandboxResumeDecision,
  decideSandboxResume,
  hasHermesCompatibleAnthropicInferenceRouteDrift,
  resolveToolDisclosureResumeSignals,
  type SandboxResumeDecision,
} from "./sandbox-resume";

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
  resumeAgentChanged: boolean;
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
  deps: {
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
      updates: { provider: string; model: string },
    ): Promise<void>;
    getRecordedMessagingChannelsForResume(
      resume: boolean,
      session: Session | null,
      sandboxName: string | null,
    ): string[] | null;
    setupMessagingChannels(
      agent: Agent,
      existingChannels: string[] | null,
      sandboxName: string,
    ): Promise<string[]>;
    readMessagingPlanFromEnv(): SandboxMessagingPlan | null;
    writePlanToEnv(plan: SandboxMessagingPlan): void;
    clearPlanEnv(): void;
    getRegistrySandboxMessagingPlan(sandboxName: string): SandboxMessagingPlan | null;
    promptValidatedSandboxName(agent: Agent): Promise<string>;
    selectResourceProfileForSandbox(): Promise<ResourceProfile | null>;
    stopStaleDashboardListenersForSandbox(sandboxes: unknown[], sandboxName: string): void;
    listRegistrySandboxes(): { sandboxes: unknown[] };
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
      createIntent: SandboxCreateIntent,
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
    error(message?: string): void;
    exitProcess(code: number): never;
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

type SandboxCreationDecision = Exclude<SandboxResumeDecision, { readonly kind: "reuse" }>;

function mcpRegistryRemovalBlockReason(
  decision: SandboxCreationDecision,
  sandboxName: string | null,
  webSearchConfig: SharedWebSearchConfig | null,
  getSandboxRegistryEntry: (sandboxName: string) => SandboxEntry | null,
): string | null {
  if (decision.kind !== "recreate") return null;
  if (!decision.removeRegistryEntry) return null;
  if (!sandboxName) return null;
  const mcpState = getSandboxRegistryEntry(sandboxName)?.mcp;
  if (!mcpState) return null;

  const selectedProvider = webSearchConfig ? webSearchProviderForConfig(webSearchConfig) : null;
  if (selectedProvider) {
    const credentialEnv = webSearchEnvFor(selectedProvider);
    const collidingBridge = Object.values(mcpState.bridges).find((entry) =>
      entry.env.includes(credentialEnv),
    );
    if (collidingBridge) {
      return `  Cannot enable ${webSearchLabelFor(selectedProvider)}: MCP server '${collidingBridge.server}' already owns ${credentialEnv}. Use a distinct credential name.`;
    }
  }

  return `  Sandbox '${sandboxName}' has managed MCP state. Use the transactional rebuild command before changing settings that recreate the sandbox.`;
}

class SandboxStateFlow<
  Gpu,
  Agent,
  WebSearchConfig,
  MessagingChannelConfig,
  SandboxGpuConfig,
  ResourceProfile,
> {
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
    return decideSandboxResume({
      resume: this.options.resume,
      resumeAgentChanged: this.options.resumeAgentChanged,
      sandboxStepComplete: state.session?.steps?.sandbox?.status === "complete",
      sandboxReuseState: this.deps.getSandboxReuseState(state.sandboxName),
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
      messagingChannelConfigChanged: !this.deps.messagingChannelConfigsEqual(
        effectiveMessagingConfig,
        storedMessagingConfig,
      ),
      hermesToolGatewayConfigChanged: !this.deps.stringSetsEqual(
        recordedToolGateways,
        effectiveToolGateways,
      ),
      ...toolDisclosureSignals,
    });
  }

  private async reuseSandbox(
    state: SandboxStepState<WebSearchConfig>,
  ): Promise<SandboxStepState<WebSearchConfig>> {
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
    this.deps.skippedStepMessage("sandbox", state.sandboxName);
    const skippedSession = await this.deps.recordStateSkipped("sandbox", {
      reason: "resume",
      sandboxName: state.sandboxName,
    });
    return {
      ...state,
      session: skippedSession,
      selectedMessagingChannels: messaging.selectedChannels,
    };
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
    if (Object.keys(fidelity).length > 0) {
      this.deps.updateSandboxRegistry(state.sandboxName, fidelity);
    }
  }

  private async resolveWebSearchForCreation(
    state: SandboxStepState<WebSearchConfig>,
  ): Promise<WebSearchConfig | null> {
    if (!state.webSearchConfig) {
      if (this.options.authoritativeResumeConfig) return null;
      return this.deps.configureWebSearch(
        null,
        this.options.agent,
        state.webSearchSupportProbePath,
      );
    }
    const provider = webSearchProviderForConfig(
      state.webSearchConfig as unknown as SharedWebSearchConfig,
    );
    const label = webSearchLabelFor(provider);
    this.deps.note(`  [resume] Revalidating ${label} configuration for sandbox recreation.`);
    const credential = await this.deps.ensureValidatedWebSearchCredential(state.webSearchConfig);
    if (this.deps.isBackToSelection(credential) || !credential) return null;
    this.deps.note(`  [resume] Reusing ${label} configuration.`);
    return state.webSearchConfig;
  }

  private async createAndRecordSandbox(
    state: SandboxStepState<WebSearchConfig>,
    requestedSandboxName: string,
    messagingPlan: SandboxMessagingPlan | null,
    decision: SandboxCreationDecision,
  ): Promise<SandboxStepState<WebSearchConfig>> {
    const effectiveHermesToolGateways = effectiveHermesToolGatewaysForWebSearch(
      this.options.agent as { name?: string } | null,
      state.webSearchConfig as unknown as SharedWebSearchConfig | null,
      this.options.hermesToolGateways,
    );
    const resourceProfile = await this.deps.selectResourceProfileForSandbox();
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
          {
            recreate: decision.kind !== "create",
            toolDisclosure: toolDisclosureOrDefault(state.session?.toolDisclosure),
          },
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
    const completedSession = await this.deps.recordStepComplete(
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
    return { ...state, sandboxName, session: completedSession };
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
    const webSearchConfig = await this.resolveWebSearchForCreation(state);
    const webSearchConfigChanged =
      state.webSearchConfigChanged ||
      !webSearchConfigsEqual(
        state.webSearchConfig as unknown as SharedWebSearchConfig | null,
        webSearchConfig as unknown as SharedWebSearchConfig | null,
      );
    // Validate the replacement provider before any resume cleanup removes the
    // still-live sandbox from the registry. A bad or missing credential must
    // leave the existing sandbox recoverable.
    await applySandboxResumeDecision(decision, state.sandboxName, this.deps);
    await this.deps.startRecordedStep("sandbox", {
      provider: this.options.provider,
      model: this.options.model,
    });
    const requestedSandboxName =
      state.sandboxName ?? (await this.deps.promptValidatedSandboxName(this.options.agent));
    const messaging = await reconcileSandboxMessaging({
      resume: this.options.resume,
      session: state.session,
      sandboxName: requestedSandboxName,
      agent: this.options.agent,
      deps: this.deps,
    });
    const session = this.deps.updateSession((current) => {
      current.messagingPlan = messaging.plan;
      return current;
    });
    return this.createAndRecordSandbox(
      {
        ...state,
        session,
        sandboxName: requestedSandboxName,
        webSearchConfig,
        webSearchConfigChanged,
        selectedMessagingChannels: messaging.selectedChannels,
      },
      requestedSandboxName,
      messaging.plan,
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
    const initialState = this.prepareWebSearchSupport();
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

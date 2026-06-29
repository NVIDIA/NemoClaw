// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import type { Session, SessionUpdates } from "../../../state/onboard-session";
import { withSandboxPhaseTrace } from "../../tracing";
import { branchTo, type OnboardStateTransitionResult } from "../result";
import { reconcileReusedSandboxMessaging, reconcileSandboxMessaging } from "./sandbox-messaging";
import {
  applySandboxResumeDecision,
  decideSandboxResume,
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
  resumeAgentChanged: boolean;
  session: Session | null;
  sandboxName: string | null;
  model: string;
  provider: string;
  nimContainer: string | null;
  webSearchConfig: WebSearchConfig | null;
  selectedMessagingChannels: string[];
  fromDockerfile: string | null;
  agent: Agent;
  gpu: Gpu;
  preferredInferenceApi: string | null;
  sandboxGpuConfig: SandboxGpuConfig;
  hermesToolGateways: string[];
  controlUiPort: number | null;
  rootDir: string;
  deps: {
    resolvePath(value: string): string;
    agentSupportsWebSearch(
      agent: Agent,
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
    normalizeHermesToolGatewaySelections(value: unknown): string[];
    stringSetsEqual(left: string[], right: string[]): boolean;
    removeSandboxFromRegistry(sandboxName: string): void;
    repairRecordedSandbox(sandboxName: string | null): void;
    ensureValidatedBraveSearchCredential(): Promise<unknown>;
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
    error(message?: string): void;
    exitProcess(code: number): never;
  };
}

export interface SandboxStateResult<WebSearchConfig> {
  sandboxName: string;
  webSearchConfig: WebSearchConfig | null;
  selectedMessagingChannels: string[];
  webSearchSupported: boolean;
  session: Session | null;
  stateResult: OnboardStateTransitionResult;
}

interface SandboxStepState<WebSearchConfig> {
  readonly session: Session | null;
  readonly sandboxName: string | null;
  readonly webSearchConfig: WebSearchConfig | null;
  readonly selectedMessagingChannels: string[];
  readonly webSearchSupported: boolean;
  readonly webSearchSupportDropped: boolean;
  readonly webSearchSupportProbePath: string | null;
}

type SandboxCreationDecision = Exclude<SandboxResumeDecision, { readonly kind: "reuse" }>;

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
    const dropped = Boolean(this.options.webSearchConfig) && !supported;
    if (!dropped) {
      return {
        session: this.options.session,
        sandboxName: this.options.sandboxName,
        webSearchConfig: this.options.webSearchConfig,
        selectedMessagingChannels: this.options.selectedMessagingChannels,
        webSearchSupported: supported,
        webSearchSupportDropped: false,
        webSearchSupportProbePath: probePath,
      };
    }

    this.deps.note(
      `  Web search is not yet supported by ${(this.options.agent as { displayName?: string } | null)?.displayName ?? "this sandbox image"}. Clearing stale config.`,
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
    return decideSandboxResume({
      resume: this.options.resume,
      resumeAgentChanged: this.options.resumeAgentChanged,
      sandboxStepComplete: state.session?.steps?.sandbox?.status === "complete",
      sandboxReuseState: this.deps.getSandboxReuseState(state.sandboxName),
      webSearchConfigChanged:
        state.webSearchSupportDropped ||
        Boolean(state.session?.webSearchConfig) !== Boolean(state.webSearchConfig),
      sandboxGpuConfigChanged: state.sandboxName
        ? this.deps.hasSandboxGpuDrift(state.sandboxName, this.options.sandboxGpuConfig)
        : false,
      messagingChannelConfigChanged: !this.deps.messagingChannelConfigsEqual(
        effectiveMessagingConfig,
        storedMessagingConfig,
      ),
      hermesToolGatewayConfigChanged: !this.deps.stringSetsEqual(
        recordedToolGateways,
        this.options.hermesToolGateways,
      ),
    });
  }

  private async reuseSandbox(
    state: SandboxStepState<WebSearchConfig>,
  ): Promise<SandboxStepState<WebSearchConfig>> {
    if (state.webSearchConfig) {
      this.deps.note(
        "  [resume] Reusing Brave Search configuration already baked into the sandbox.",
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

  private async resolveWebSearchForCreation(
    state: SandboxStepState<WebSearchConfig>,
  ): Promise<WebSearchConfig | null> {
    if (!state.webSearchConfig) {
      return this.deps.configureWebSearch(
        null,
        this.options.agent,
        state.webSearchSupportProbePath,
      );
    }
    this.deps.note("  [resume] Revalidating Brave Search configuration for sandbox recreation.");
    const credential = await this.deps.ensureValidatedBraveSearchCredential();
    if (this.deps.isBackToSelection(credential) || !credential) return null;
    this.deps.note("  [resume] Reusing Brave Search configuration.");
    return state.webSearchConfig;
  }

  private async createAndRecordSandbox(
    state: SandboxStepState<WebSearchConfig>,
    requestedSandboxName: string,
    messagingPlan: SandboxMessagingPlan | null,
  ): Promise<SandboxStepState<WebSearchConfig>> {
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
          this.options.hermesToolGateways,
        ),
    );
    // createSandbox() owns the build fingerprint. In particular, reusing an
    // image must not stamp it with the current version and hide build drift.
    const { nemoclawVersion: _builtFingerprint, ...agentRegistryFields } =
      this.deps.getSandboxAgentRegistryFields(this.options.agent, !this.options.fromDockerfile);
    this.deps.updateSandboxRegistry(sandboxName, {
      model: this.options.model,
      provider: this.options.provider,
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
        hermesToolGateways: this.options.hermesToolGateways,
      }),
    );
    return { ...state, sandboxName, session: completedSession };
  }

  private async recreateSandbox(
    state: SandboxStepState<WebSearchConfig>,
    decision: SandboxCreationDecision,
  ): Promise<SandboxStepState<WebSearchConfig>> {
    await applySandboxResumeDecision(decision, state.sandboxName, this.deps);
    const webSearchConfig = await this.resolveWebSearchForCreation(state);
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
        selectedMessagingChannels: messaging.selectedChannels,
      },
      requestedSandboxName,
      messaging.plan,
    );
  }

  private complete(state: SandboxStepState<WebSearchConfig>): SandboxStateResult<WebSearchConfig> {
    if (!state.sandboxName) {
      this.deps.error("  Onboarding state is incomplete after sandbox setup.");
      return this.deps.exitProcess(1);
    }
    return {
      sandboxName: state.sandboxName,
      webSearchConfig: state.webSearchConfig,
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
  return new SandboxStateFlow(options).run();
}

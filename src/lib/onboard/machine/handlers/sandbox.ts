// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session, SessionUpdates } from "../../../state/onboard-session";

export interface SandboxStateOptions<Gpu, Agent, WebSearchConfig, MessagingChannelConfig, SandboxGpuConfig> {
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
    agentSupportsWebSearch(agent: Agent, dockerfilePathOverride: string | null, rootDir: string): boolean;
    note(message: string): void;
    updateSession(mutator: (session: Session) => Session | void): Session;
    getStoredMessagingChannelConfig(sandboxName: string | null, session: Session | null): MessagingChannelConfig | null;
    hydrateMessagingChannelConfig(config: MessagingChannelConfig | null): MessagingChannelConfig | null;
    messagingChannelConfigsEqual(left: MessagingChannelConfig | null, right: MessagingChannelConfig | null): boolean;
    persistMessagingChannelConfigToSession(config: MessagingChannelConfig | null): void;
    getSandboxReuseState(sandboxName: string | null): string;
    computeTelegramRequireMention(): boolean | null;
    hasSandboxGpuDrift(sandboxName: string, config: SandboxGpuConfig): boolean;
    hasWechatConfigDrift(session: Session | null): boolean;
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
    startRecordedStep(stepName: string, updates: { provider: string; model: string }): Promise<void>;
    getRecordedMessagingChannelsForResume(
      resume: boolean,
      session: Session | null,
      sandboxName: string | null,
    ): string[] | null;
    getSandboxMessagingChannels(sandboxName: string): string[] | null | undefined;
    setupMessagingChannels(agent: Agent, existingChannels: string[] | null): Promise<string[]>;
    readMessagingChannelConfigFromEnv(): MessagingChannelConfig | null;
    promptValidatedSandboxName(agent: Agent): Promise<string>;
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
      hermesToolGateways: string[],
    ): Promise<string>;
    updateSandboxRegistry(sandboxName: string, updates: Record<string, unknown>): void;
    setDefaultSandbox(sandboxName: string): void;
    getSandboxAgentRegistryFields(agent: Agent, agentVersionKnown: boolean): Record<string, unknown>;
    recordStepComplete(stepName: string, updates: SessionUpdates): Promise<Session>;
    toSessionUpdates(updates: Record<string, unknown>): SessionUpdates;
    skippedStepMessage(stepName: string, detail?: string | null): void;
    recordStateSkipped(state: "sandbox", metadata?: Record<string, unknown> | null): Promise<Session>;
    recordRepairEvent(
      type: "state.repair.started" | "state.repair.completed" | "state.repair.failed",
      options?: { state?: "sandbox"; error?: string | null; metadata?: Record<string, unknown> | null },
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
}

function sameEffectiveTelegramRequireMention(left: boolean | null, right: boolean | null): boolean {
  return (left ?? false) === (right ?? false);
}

export async function handleSandboxState<Gpu, Agent, WebSearchConfig, MessagingChannelConfig, SandboxGpuConfig>({
  resume,
  fresh,
  resumeAgentChanged,
  session,
  sandboxName,
  model,
  provider,
  nimContainer,
  webSearchConfig,
  selectedMessagingChannels,
  fromDockerfile,
  agent,
  gpu,
  preferredInferenceApi,
  sandboxGpuConfig,
  hermesToolGateways,
  controlUiPort,
  rootDir,
  deps,
}: SandboxStateOptions<
  Gpu,
  Agent,
  WebSearchConfig,
  MessagingChannelConfig,
  SandboxGpuConfig
>): Promise<SandboxStateResult<WebSearchConfig>> {
  const webSearchSupportProbePath = fromDockerfile ? deps.resolvePath(fromDockerfile) : null;
  const webSearchSupported = deps.agentSupportsWebSearch(agent, webSearchSupportProbePath, rootDir);
  const webSearchSupportDropped = Boolean(webSearchConfig) && !webSearchSupported;
  if (webSearchSupportDropped) {
    deps.note(
      `  Web search is not yet supported by ${(agent as { displayName?: string } | null)?.displayName ?? "this sandbox image"}. Clearing stale config.`,
    );
    webSearchConfig = null;
    if (session) session.webSearchConfig = null;
    session = deps.updateSession((current) => {
      current.webSearchConfig = null;
      return current;
    });
  }

  const storedMessagingChannelConfig = deps.getStoredMessagingChannelConfig(sandboxName, session);
  const effectiveMessagingChannelConfig = deps.hydrateMessagingChannelConfig(storedMessagingChannelConfig);
  const messagingChannelConfigChanged = !deps.messagingChannelConfigsEqual(
    effectiveMessagingChannelConfig,
    storedMessagingChannelConfig,
  );
  if (effectiveMessagingChannelConfig) {
    deps.persistMessagingChannelConfigToSession(effectiveMessagingChannelConfig);
    if (session) session.messagingChannelConfig = effectiveMessagingChannelConfig as Session["messagingChannelConfig"];
  }

  const sandboxReuseState = deps.getSandboxReuseState(sandboxName);
  const webSearchConfigChanged = webSearchSupportDropped || Boolean(session?.webSearchConfig) !== Boolean(webSearchConfig);
  const currentTelegramRequireMention = deps.computeTelegramRequireMention();
  const recordedTelegramRequireMention = session?.telegramConfig?.requireMention ?? null;
  // Telegram mention-mode is baked into openclaw.json at sandbox build time.
  // Compare effective modes because null and false both produce groupPolicy: open
  // during config generation. This preserves the original #1737/#2417 drift rule.
  const telegramConfigChanged = !sameEffectiveTelegramRequireMention(
    currentTelegramRequireMention,
    recordedTelegramRequireMention,
  );
  const sandboxGpuConfigChanged = sandboxName ? deps.hasSandboxGpuDrift(sandboxName, sandboxGpuConfig) : false;
  const wechatConfigChanged = deps.hasWechatConfigDrift(session);
  const recordedHermesToolGateways = sandboxName
    ? deps.normalizeHermesToolGatewaySelections(deps.getSandboxHermesToolGateways(sandboxName))
    : [];
  const hermesToolGatewayConfigChanged = !deps.stringSetsEqual(recordedHermesToolGateways, hermesToolGateways);
  const resumeSandbox =
    resume &&
    !resumeAgentChanged &&
    !webSearchConfigChanged &&
    !telegramConfigChanged &&
    !sandboxGpuConfigChanged &&
    !wechatConfigChanged &&
    !messagingChannelConfigChanged &&
    !hermesToolGatewayConfigChanged &&
    session?.steps?.sandbox?.status === "complete" &&
    sandboxReuseState === "ready";

  if (resumeSandbox) {
    if (webSearchConfig) deps.note("  [resume] Reusing Brave Search configuration already baked into the sandbox.");
    selectedMessagingChannels = session?.messagingChannels ?? [];
    deps.skippedStepMessage("sandbox", sandboxName);
    await deps.recordStateSkipped("sandbox", { reason: "resume", sandboxName });
  } else {
    if (resume && session?.steps?.sandbox?.status === "complete") {
      if (resumeAgentChanged) {
        deps.note("  [resume] Agent selection changed; revalidating sandbox compatibility.");
      } else if (webSearchConfigChanged) {
        deps.note("  [resume] Web Search configuration changed; recreating sandbox.");
        if (sandboxName) deps.removeSandboxFromRegistry(sandboxName);
      } else if (telegramConfigChanged) {
        deps.note("  [resume] TELEGRAM_REQUIRE_MENTION changed; recreating sandbox.");
        if (sandboxName) deps.removeSandboxFromRegistry(sandboxName);
      } else if (sandboxGpuConfigChanged) {
        deps.note("  [resume] Sandbox GPU settings changed; recreating sandbox.");
        if (sandboxName) deps.removeSandboxFromRegistry(sandboxName);
      } else if (wechatConfigChanged) {
        deps.note("  [resume] WeChat account metadata changed; recreating sandbox.");
        if (sandboxName) deps.removeSandboxFromRegistry(sandboxName);
      } else if (messagingChannelConfigChanged) {
        deps.note("  [resume] Messaging channel configuration changed; recreating sandbox.");
        if (sandboxName) deps.removeSandboxFromRegistry(sandboxName);
      } else if (hermesToolGatewayConfigChanged) {
        deps.note("  [resume] Hermes managed tool gateway selection changed; recreating sandbox.");
        if (sandboxName) deps.removeSandboxFromRegistry(sandboxName);
      } else if (sandboxReuseState === "not_ready") {
        deps.note(`  [resume] Recorded sandbox '${sandboxName}' exists but is not ready; recreating it.`);
        const repairMetadata = { repair: "recorded-sandbox-cleanup", sandboxName };
        await deps.recordRepairEvent("state.repair.started", {
          state: "sandbox",
          metadata: repairMetadata,
        });
        try {
          deps.repairRecordedSandbox(sandboxName);
        } catch (err) {
          await deps.recordRepairEvent("state.repair.failed", {
            state: "sandbox",
            error: err instanceof Error ? err.message : String(err),
            metadata: repairMetadata,
          });
          throw err;
        }
        await deps.recordRepairEvent("state.repair.completed", {
          state: "sandbox",
          metadata: repairMetadata,
        });
      } else {
        deps.note("  [resume] Recorded sandbox state is unavailable; recreating it.");
        if (sandboxName) deps.removeSandboxFromRegistry(sandboxName);
      }
    }

    let nextWebSearchConfig = webSearchConfig;
    if (nextWebSearchConfig) {
      deps.note("  [resume] Revalidating Brave Search configuration for sandbox recreation.");
      const braveApiKey = await deps.ensureValidatedBraveSearchCredential();
      if (deps.isBackToSelection(braveApiKey)) {
        nextWebSearchConfig = null;
      } else {
        nextWebSearchConfig = braveApiKey ? webSearchConfig : null;
      }
      if (nextWebSearchConfig) deps.note("  [resume] Reusing Brave Search configuration.");
    } else {
      nextWebSearchConfig = await deps.configureWebSearch(null, agent, webSearchSupportProbePath);
    }

    await deps.startRecordedStep("sandbox", { provider, model });
    const recordedMessagingChannels = deps.getRecordedMessagingChannelsForResume(resume, session, sandboxName);
    if (recordedMessagingChannels) {
      selectedMessagingChannels = recordedMessagingChannels;
      if (selectedMessagingChannels.length > 0) {
        deps.note(`  [non-interactive] Reusing messaging channel configuration: ${selectedMessagingChannels.join(", ")}`);
      }
    } else {
      const existing = sandboxName
        ? deps.getSandboxMessagingChannels(sandboxName) ?? session?.messagingChannels ?? null
        : session?.messagingChannels ?? null;
      selectedMessagingChannels = await deps.setupMessagingChannels(agent, existing);
    }
    const messagingChannelConfig = deps.readMessagingChannelConfigFromEnv();
    session = deps.updateSession((current) => {
      current.messagingChannels = selectedMessagingChannels;
      current.messagingChannelConfig = messagingChannelConfig as Session["messagingChannelConfig"];
      return current;
    });

    if (!sandboxName) sandboxName = await deps.promptValidatedSandboxName(agent);
    if (fresh) deps.stopStaleDashboardListenersForSandbox(deps.listRegistrySandboxes().sandboxes, sandboxName);
    sandboxName = await deps.createSandbox(
      gpu,
      model,
      provider,
      preferredInferenceApi,
      sandboxName,
      nextWebSearchConfig,
      selectedMessagingChannels,
      fromDockerfile,
      agent,
      controlUiPort,
      sandboxGpuConfig,
      hermesToolGateways,
    );
    webSearchConfig = nextWebSearchConfig;
    deps.updateSandboxRegistry(sandboxName, {
      model,
      provider,
      ...deps.getSandboxAgentRegistryFields(agent, !fromDockerfile),
    });
    deps.setDefaultSandbox(sandboxName);
    session = await deps.recordStepComplete(
      "sandbox",
      deps.toSessionUpdates({
        sandboxName,
        provider,
        model,
        nimContainer,
        webSearchConfig,
        messagingChannelConfig,
        hermesToolGateways,
      }),
    );
  }

  if (!sandboxName) {
    deps.error("  Onboarding state is incomplete after sandbox setup.");
    deps.exitProcess(1);
  }
  const completedSandboxName = sandboxName;
  if (!completedSandboxName) throw new Error("Sandbox name is required after sandbox setup");

  return {
    sandboxName: completedSandboxName,
    webSearchConfig,
    selectedMessagingChannels,
    webSearchSupported,
    session,
  };
}

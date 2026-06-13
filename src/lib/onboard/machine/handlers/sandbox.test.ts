// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import { hashCredential } from "../../../security/credential-hash";
import { createSession, type Session, type SessionUpdates } from "../../../state/onboard-session";
import { handleSandboxState, type SandboxStateOptions } from "./sandbox";

function makeMinimalPlan(
  sandboxName: string,
  agent = "openclaw",
  channelIds: readonly SandboxMessagingPlan["channels"][number]["channelId"][] = [],
  disabledChannels: readonly SandboxMessagingPlan["channels"][number]["channelId"][] = [],
): SandboxMessagingPlan {
  const disabled = new Set(disabledChannels);
  return {
    schemaVersion: 1,
    sandboxName,
    agent: agent as SandboxMessagingPlan["agent"],
    workflow: "onboard",
    channels: channelIds.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: "token-paste",
      active: !disabled.has(channelId),
      selected: true,
      configured: true,
      disabled: disabled.has(channelId),
      inputs: [],
      hooks: [],
    })),
    disabledChannels: [...disabled],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function withTelegramCredentialHash(
  plan: SandboxMessagingPlan,
  credentialHash: string | null,
): SandboxMessagingPlan {
  return {
    ...plan,
    credentialBindings: [
      {
        channelId: "telegram",
        credentialId: "bot-token",
        sourceInput: "botToken",
        providerName: `${plan.sandboxName}-telegram-bridge`,
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        credentialAvailable: true,
        ...(credentialHash ? { credentialHash } : {}),
      },
    ],
  };
}

async function withEnv<T>(key: string, value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

type Gpu = { type: string } | null;
type Agent = { displayName?: string } | null;
type WebSearchConfig = { fetchEnabled: true };
type MessagingChannelConfig = Record<string, string>;
type SandboxGpuConfig = { sandboxGpuEnabled: boolean; mode: string };
type ResourceProfile = { cpu: string; memory: string };

function createDeps(
  overrides: Partial<
    SandboxStateOptions<
      Gpu,
      Agent,
      WebSearchConfig,
      MessagingChannelConfig,
      SandboxGpuConfig,
      ResourceProfile
    >["deps"]
  > = {},
) {
  let session = createSession();
  const calls = {
    note: vi.fn(),
    updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
      session = mutator(session) ?? session;
      return session;
    }),
    persistMessaging: vi.fn(),
    removeSandbox: vi.fn(),
    repairSandbox: vi.fn(),
    validateBrave: vi.fn(async () => "brave-key"),
    isBackToSelection: vi.fn(() => false),
    configureWebSearch: vi.fn(async () => null as WebSearchConfig | null),
    startStep: vi.fn(async () => undefined),
    getRecordedChannels: vi.fn(() => null),
    setupMessaging: vi.fn(async () => [] as string[]),
    promptName: vi.fn(async () => "my-assistant"),
    selectResourceProfile: vi.fn(async () => null as ResourceProfile | null),
    stopStale: vi.fn(),
    createSandbox: vi.fn(async () => "my-assistant"),
    updateSandbox: vi.fn(),
    complete: vi.fn(async () => createSession()),
    skipped: vi.fn(),
    recordSkip: vi.fn(async () => createSession()),
    repairEvent: vi.fn(async () => createSession()),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };
  return {
    calls,
    deps: {
      resolvePath: (value: string) => `/abs/${value}`,
      agentSupportsWebSearch: () => true,
      note: calls.note,
      updateSession: calls.updateSession,
      getStoredMessagingChannelConfig: () => null,
      hydrateMessagingChannelConfig: (config: MessagingChannelConfig | null) => config,
      messagingChannelConfigsEqual: () => true,
      getSandboxReuseState: () => "missing",
      computeTelegramRequireMention: () => null,
      hasSandboxGpuDrift: () => false,
      hasWechatConfigDrift: () => false,
      getSandboxHermesToolGateways: () => [],
      normalizeHermesToolGatewaySelections: (value: unknown) =>
        Array.isArray(value) ? (value as string[]) : [],
      stringSetsEqual: (left: string[], right: string[]) =>
        left.length === right.length && left.every((value) => right.includes(value)),
      removeSandboxFromRegistry: calls.removeSandbox,
      repairRecordedSandbox: calls.repairSandbox,
      ensureValidatedBraveSearchCredential: calls.validateBrave,
      isBackToSelection: calls.isBackToSelection,
      configureWebSearch: calls.configureWebSearch,
      startRecordedStep: calls.startStep,
      getRecordedMessagingChannelsForResume: calls.getRecordedChannels,
      setupMessagingChannels: calls.setupMessaging,
      readMessagingPlanFromEnv: () => null,
      writePlanToEnv: () => undefined,
      getRegistrySandboxMessagingPlan: () => null,
      promptValidatedSandboxName: calls.promptName,
      selectResourceProfileForSandbox: calls.selectResourceProfile,
      stopStaleDashboardListenersForSandbox: calls.stopStale,
      listRegistrySandboxes: () => ({ sandboxes: [{ name: "old" }] }),
      createSandbox: calls.createSandbox,
      updateSandboxRegistry: calls.updateSandbox,
      getSandboxAgentRegistryFields: () => ({ agent: null }),
      recordStepComplete: calls.complete,
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      skippedStepMessage: calls.skipped,
      recordStateSkipped: calls.recordSkip,
      recordRepairEvent: calls.repairEvent,
      error: calls.error,
      exitProcess: calls.exit,
      ...overrides,
    },
    getSession: () => session,
  };
}

function baseOptions(
  deps: SandboxStateOptions<
    Gpu,
    Agent,
    WebSearchConfig,
    MessagingChannelConfig,
    SandboxGpuConfig,
    ResourceProfile
  >["deps"],
  session: Session | null = createSession(),
): SandboxStateOptions<
  Gpu,
  Agent,
  WebSearchConfig,
  MessagingChannelConfig,
  SandboxGpuConfig,
  ResourceProfile
> {
  return {
    resume: false,
    fresh: false,
    resumeAgentChanged: false,
    session,
    sandboxName: null,
    model: "model",
    provider: "provider",
    nimContainer: null,
    webSearchConfig: null,
    selectedMessagingChannels: [],
    fromDockerfile: null,
    agent: null,
    gpu: { type: "nvidia" },
    preferredInferenceApi: "openai-completions",
    sandboxGpuConfig: { sandboxGpuEnabled: false, mode: "0" },
    hermesToolGateways: [],
    controlUiPort: null,
    rootDir: "/repo",
    deps,
  };
}

describe("handleSandboxState", () => {
  it("creates a sandbox and records messaging/web search state", async () => {
    const { deps, calls } = createDeps({
      configureWebSearch: vi.fn(async () => ({ fetchEnabled: true as const })),
    });
    calls.setupMessaging.mockResolvedValue(["telegram"]);

    const result = await handleSandboxState(baseOptions(deps));

    expect(calls.startStep).toHaveBeenCalledWith("sandbox", {
      provider: "provider",
      model: "model",
    });
    expect(calls.setupMessaging).toHaveBeenCalledWith(null, null, "my-assistant");
    expect(calls.promptName).toHaveBeenCalledWith(null);
    expect(calls.createSandbox).toHaveBeenCalledWith(
      { type: "nvidia" },
      "model",
      "provider",
      "openai-completions",
      "my-assistant",
      { fetchEnabled: true },
      ["telegram"],
      null,
      null,
      null,
      { sandboxGpuEnabled: false, mode: "0" },
      null,
      [],
    );
    expect(calls.updateSandbox).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ model: "model", provider: "provider" }),
    );
    // Default-marking is deferred to finalization (#4614) — the sandbox step must not set it.
    expect(calls.complete).toHaveBeenCalledWith(
      "sandbox",
      expect.objectContaining({ sandboxName: "my-assistant" }),
    );
    expect(result).toMatchObject({
      sandboxName: "my-assistant",
      selectedMessagingChannels: ["telegram"],
      webSearchSupported: true,
    });
    expect(result.stateResult).toEqual({
      type: "transition",
      next: "openclaw",
      transitionKind: "branch",
      updates: undefined,
      metadata: { state: "sandbox", sandboxName: "my-assistant", agent: "openclaw" },
    });
  });

  it("reuses a completed ready sandbox on resume", async () => {
    const session = createSession({
      sandboxName: "saved",
      messagingPlan: makeMinimalPlan("saved", "openclaw", ["slack"]),
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "ready" });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.skipped).toHaveBeenCalledWith("sandbox", "saved");
    expect(calls.recordSkip).toHaveBeenCalledWith("sandbox", {
      reason: "resume",
      sandboxName: "saved",
    });
    expect(result.selectedMessagingChannels).toEqual(["slack"]);
  });

  it("removes registry state when Telegram mention-mode drift forces sandbox recreation", async () => {
    const session = createSession({ telegramConfig: { requireMention: true } });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      computeTelegramRequireMention: () => false,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] TELEGRAM_REQUIRE_MENTION changed; recreating sandbox.",
    );
    expect(calls.removeSandbox).toHaveBeenCalledWith("saved");
    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it("repairs not-ready resumed sandboxes before recreation", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "not_ready" });

    await handleSandboxState({ ...baseOptions(deps, session), resume: true, sandboxName: "saved" });

    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.started", {
      state: "sandbox",
      metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
    });
    expect(calls.repairSandbox).toHaveBeenCalledWith("saved");
    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.completed", {
      state: "sandbox",
      metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
    });
    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it("records failed sandbox repair events before propagating repair errors", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "not_ready",
      repairRecordedSandbox: vi.fn(() => {
        throw new Error("cleanup failed");
      }),
    });

    await expect(
      handleSandboxState({ ...baseOptions(deps, session), resume: true, sandboxName: "saved" }),
    ).rejects.toThrow("cleanup failed");

    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.started", {
      state: "sandbox",
      metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
    });
    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.failed", {
      state: "sandbox",
      error: "cleanup failed",
      metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
    });
    expect(calls.repairEvent).not.toHaveBeenCalledWith("state.repair.completed", expect.anything());
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("recreates when a saved web search sandbox is no longer supported", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      agentSupportsWebSearch: () => false,
      getSandboxReuseState: () => "ready",
      updateSession: vi.fn(
        (mutator: (value: Session) => Session | void) => mutator(session) ?? session,
      ),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
    });

    expect(calls.note).toHaveBeenCalledWith(
      "  Web search is not yet supported by this sandbox image. Clearing stale config.",
    );
    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Web Search configuration changed; recreating sandbox.",
    );
    expect(calls.removeSandbox).toHaveBeenCalledWith("saved");
    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it("drops saved web search config when credential revalidation returns to provider selection", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
    });
    session.steps.sandbox.status = "complete";
    const backToSelection = Object.freeze({ kind: "NEMOCLAW_BACK_TO_SELECTION" });
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "not_ready",
      ensureValidatedBraveSearchCredential: vi.fn(async () => backToSelection),
      isBackToSelection: vi.fn((value: unknown) => value === backToSelection),
    });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
    });

    expect(calls.configureWebSearch).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalledWith(
      { type: "nvidia" },
      "model",
      "provider",
      "openai-completions",
      "saved",
      null,
      [],
      null,
      null,
      null,
      { sandboxGpuEnabled: false, mode: "0" },
      null,
      [],
    );
    expect(result.webSearchConfig).toBeNull();
  });

  it("uses recorded messaging channels on non-interactive resume", async () => {
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["discord"]);
    const { deps, calls } = createDeps({ getRecordedMessagingChannelsForResume });

    const result = await handleSandboxState({ ...baseOptions(deps), resume: true });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(getRecordedMessagingChannelsForResume).toHaveBeenCalledWith(
      true,
      expect.any(Object),
      "my-assistant",
    );
    expect(calls.note).toHaveBeenCalledWith(
      "  [non-interactive] Reusing messaging channel configuration: discord",
    );
    expect(result.selectedMessagingChannels).toEqual(["discord"]);
  });

  it("persists plan from env into session after fresh messaging setup", async () => {
    const mockPlan = makeMinimalPlan("my-assistant");
    const { deps, getSession } = createDeps({
      readMessagingPlanFromEnv: () => mockPlan,
    });

    await handleSandboxState({ ...baseOptions(deps) });

    expect(getSession().messagingPlan).toEqual(mockPlan);
  });

  it("restores registry plan to env on non-interactive resume when env is empty", async () => {
    const registryPlan = makeMinimalPlan("my-assistant");
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: registryPlan });
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["telegram"]);
    const writePlanToEnv = vi.fn();
    const { deps } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => null,
      getRegistrySandboxMessagingPlan: () => registryPlan,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(writePlanToEnv).toHaveBeenCalledWith(registryPlan);
  });

  it("prefers env-staged plan over registry plan on non-interactive resume (rebuild path)", async () => {
    const registryPlan = makeMinimalPlan("my-assistant");
    const rebuiltPlan = makeMinimalPlan("my-assistant", "openclaw", ["telegram"], ["telegram"]);
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: registryPlan });
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["telegram"]);
    const writePlanToEnv = vi.fn();
    const { deps, getSession } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => rebuiltPlan,
      getRegistrySandboxMessagingPlan: () => registryPlan,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(writePlanToEnv).not.toHaveBeenCalled();
    expect(getSession().messagingPlan).toEqual(rebuiltPlan);
    expect(getSession().messagingPlan?.disabledChannels).toEqual(["telegram"]);
    expect(getSession().messagingPlan?.channels[0]).toMatchObject({
      channelId: "telegram",
      active: false,
      disabled: true,
    });
  });

  it("refreshes credential hashes when reusing an env-staged rebuild plan", async () => {
    const oldHash = hashCredential("telegram-token-a");
    const newHash = hashCredential("telegram-token-b");
    const rebuiltPlan = withTelegramCredentialHash(
      makeMinimalPlan("my-assistant", "openclaw", ["telegram"]),
      oldHash,
    );
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: rebuiltPlan });
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["telegram"]);
    const writePlanToEnv = vi.fn();
    const { deps, calls, getSession } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => rebuiltPlan,
      getRegistrySandboxMessagingPlan: () => null,
    });

    await withEnv("TELEGRAM_BOT_TOKEN", "telegram-token-b", async () => {
      await handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
      });
    });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(writePlanToEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialBindings: [
          expect.objectContaining({
            providerEnvKey: "TELEGRAM_BOT_TOKEN",
            credentialHash: newHash,
          }),
        ],
      }),
    );
    expect(getSession().messagingPlan?.credentialBindings[0]?.credentialHash).toBe(newHash);
  });

  it("preserves an empty env-staged rebuild plan instead of rediscovering token-backed channels", async () => {
    const emptyRebuildPlan = makeMinimalPlan("my-assistant");
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: emptyRebuildPlan });
    const getRecordedMessagingChannelsForResume = vi.fn(() => null);
    const writePlanToEnv = vi.fn();
    const { deps, calls, getSession } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => emptyRebuildPlan,
      getRegistrySandboxMessagingPlan: () => emptyRebuildPlan,
    });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(writePlanToEnv).not.toHaveBeenCalled();
    expect(result.selectedMessagingChannels).toEqual([]);
    const createSandboxCall = calls.createSandbox.mock.calls[0] as unknown[];
    expect(createSandboxCall[6]).toEqual([]);
    expect(getSession().messagingPlan).toEqual(emptyRebuildPlan);
  });

  it("does not restore plan to env when registry has no entry", async () => {
    const session = createSession({
      sandboxName: "my-assistant",
      messagingPlan: makeMinimalPlan("my-assistant"),
    });
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["telegram"]);
    const writePlanToEnv = vi.fn();
    const { deps } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => null,
      getRegistrySandboxMessagingPlan: () => null,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(writePlanToEnv).not.toHaveBeenCalled();
  });
});

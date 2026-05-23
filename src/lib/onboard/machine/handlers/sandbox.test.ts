// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session, type SessionUpdates } from "../../../state/onboard-session";
import { handleSandboxState, type SandboxStateOptions } from "./sandbox";

type Gpu = { type: string } | null;
type Agent = { displayName?: string } | null;
type WebSearchConfig = { fetchEnabled: true };
type MessagingChannelConfig = Record<string, string>;
type SandboxGpuConfig = { sandboxGpuEnabled: boolean; mode: string };

function createDeps(overrides: Partial<SandboxStateOptions<Gpu, Agent, WebSearchConfig, MessagingChannelConfig, SandboxGpuConfig>["deps"]> = {}) {
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
    stopStale: vi.fn(),
    createSandbox: vi.fn(async () => "my-assistant"),
    updateSandbox: vi.fn(),
    setDefault: vi.fn(),
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
      persistMessagingChannelConfigToSession: calls.persistMessaging,
      getSandboxReuseState: () => "missing",
      computeTelegramRequireMention: () => null,
      hasSandboxGpuDrift: () => false,
      hasWechatConfigDrift: () => false,
      getSandboxHermesToolGateways: () => [],
      normalizeHermesToolGatewaySelections: (value: unknown) => (Array.isArray(value) ? (value as string[]) : []),
      stringSetsEqual: (left: string[], right: string[]) => left.length === right.length && left.every((value) => right.includes(value)),
      removeSandboxFromRegistry: calls.removeSandbox,
      repairRecordedSandbox: calls.repairSandbox,
      ensureValidatedBraveSearchCredential: calls.validateBrave,
      isBackToSelection: calls.isBackToSelection,
      configureWebSearch: calls.configureWebSearch,
      startRecordedStep: calls.startStep,
      getRecordedMessagingChannelsForResume: calls.getRecordedChannels,
      getSandboxMessagingChannels: () => ["telegram"],
      setupMessagingChannels: calls.setupMessaging,
      readMessagingChannelConfigFromEnv: () => null,
      promptValidatedSandboxName: calls.promptName,
      stopStaleDashboardListenersForSandbox: calls.stopStale,
      listRegistrySandboxes: () => ({ sandboxes: [{ name: "old" }] }),
      createSandbox: calls.createSandbox,
      updateSandboxRegistry: calls.updateSandbox,
      setDefaultSandbox: calls.setDefault,
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
  deps: SandboxStateOptions<Gpu, Agent, WebSearchConfig, MessagingChannelConfig, SandboxGpuConfig>["deps"],
  session: Session | null = createSession(),
): SandboxStateOptions<Gpu, Agent, WebSearchConfig, MessagingChannelConfig, SandboxGpuConfig> {
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
      readMessagingChannelConfigFromEnv: () => ({ telegram: "polling" }),
    });
    calls.setupMessaging.mockResolvedValue(["telegram"]);

    const result = await handleSandboxState(baseOptions(deps));

    expect(calls.startStep).toHaveBeenCalledWith("sandbox", { provider: "provider", model: "model" });
    expect(calls.setupMessaging).toHaveBeenCalledWith(null, null);
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
      [],
    );
    expect(calls.updateSandbox).toHaveBeenCalledWith("my-assistant", expect.objectContaining({ model: "model", provider: "provider" }));
    expect(calls.setDefault).toHaveBeenCalledWith("my-assistant");
    expect(calls.complete).toHaveBeenCalledWith("sandbox", expect.objectContaining({ sandboxName: "my-assistant" }));
    expect(result).toMatchObject({ sandboxName: "my-assistant", selectedMessagingChannels: ["telegram"], webSearchSupported: true });
  });

  it("reuses a completed ready sandbox on resume", async () => {
    const session = createSession({ sandboxName: "saved", messagingChannels: ["slack"] });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "ready" });

    const result = await handleSandboxState({ ...baseOptions(deps, session), resume: true, sandboxName: "saved" });

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

    expect(calls.note).toHaveBeenCalledWith("  [resume] TELEGRAM_REQUIRE_MENTION changed; recreating sandbox.");
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
    const session = createSession({ sandboxName: "saved", webSearchConfig: { fetchEnabled: true } });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      agentSupportsWebSearch: () => false,
      getSandboxReuseState: () => "ready",
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => mutator(session) ?? session),
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
    expect(calls.note).toHaveBeenCalledWith("  [resume] Web Search configuration changed; recreating sandbox.");
    expect(calls.removeSandbox).toHaveBeenCalledWith("saved");
    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it("drops saved web search config when credential revalidation returns to provider selection", async () => {
    const session = createSession({ sandboxName: "saved", webSearchConfig: { fetchEnabled: true } });
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
      [],
    );
    expect(result.webSearchConfig).toBeNull();
  });

  it("uses recorded messaging channels on non-interactive resume", async () => {
    const { deps, calls } = createDeps({ getRecordedMessagingChannelsForResume: vi.fn(() => ["discord"]) });

    const result = await handleSandboxState({ ...baseOptions(deps), resume: true });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(calls.note).toHaveBeenCalledWith("  [non-interactive] Reusing messaging channel configuration: discord");
    expect(result.selectedMessagingChannels).toEqual(["discord"]);
  });
});

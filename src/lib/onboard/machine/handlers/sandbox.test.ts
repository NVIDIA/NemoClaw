// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashCredential } from "../../../security/credential-hash";
import { createSession, type Session } from "../../../state/onboard-session";
import { detectMessagingChannelsFromEnv } from "../../messaging-channel-setup";
import { handleSandboxState } from "./sandbox";
import {
  baseOptions,
  createDeps,
  makeMinimalPlan,
  withEnv,
  withTelegramCredentialHash,
} from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

const detectMessagingChannelsFromEnvMock = vi.mocked(detectMessagingChannelsFromEnv);

function dcodeRegistryEntry(name: string, observabilityEnabled?: boolean) {
  return {
    name,
    agent: "langchain-deepagents-code",
    provider: "provider",
    model: "model",
    endpointUrl: null,
    credentialEnv: null,
    preferredInferenceApi: "openai-completions",
    gatewayName: "nemoclaw",
    toolDisclosure: "progressive" as const,
    ...(typeof observabilityEnabled === "boolean" ? { observabilityEnabled } : {}),
  };
}

describe("handleSandboxState", () => {
  beforeEach(() => {
    detectMessagingChannelsFromEnvMock.mockReturnValue([]);
  });

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
      null,
      {
        recreate: false,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
      },
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
      webSearchConfigChanged: true,
      webSearchSupported: true,
    });
    expect(result.session?.sandboxName).toBe("my-assistant");
    expect(result.stateResult).toEqual({
      type: "transition",
      next: "openclaw",
      transitionKind: "branch",
      updates: undefined,
      metadata: { state: "sandbox", sandboxName: "my-assistant", agent: "openclaw" },
    });
  });

  it("does not auto-enable web search from ambient credentials during authoritative rebuild", async () => {
    const configureWebSearch = vi.fn(async () => ({ fetchEnabled: true as const }));
    const { deps, calls } = createDeps({ configureWebSearch });

    const result = await handleSandboxState({
      ...baseOptions(deps),
      authoritativeResumeConfig: true,
      env: { NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily" },
    });

    expect(configureWebSearch).not.toHaveBeenCalled();
    expect((calls.createSandbox.mock.calls[0] as unknown[] | undefined)?.[5]).toBeNull();
    expect(result.webSearchConfig).toBeNull();
  });

  it("carries an authoritative rebuild tier in the sandbox create intent", async () => {
    const { deps, calls } = createDeps();

    await handleSandboxState({
      ...baseOptions(deps),
      agent: { name: "langchain-deepagents-code" },
      authoritativeResumeConfig: true,
      authoritativePolicyTier: "restricted",
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toMatchObject({
      policyTier: "restricted",
    });
  });

  it("rejects observability for a selected non-DCode agent", async () => {
    const { deps, calls } = createDeps();

    await expect(
      handleSandboxState({
        ...baseOptions(deps),
        agent: { name: "hermes" },
        requestedObservabilityEnabled: true,
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.error).toHaveBeenCalledWith(
      "  --observability is supported only with --agent langchain-deepagents-code.",
    );
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("preserves recorded observability when a new onboard run omits the flag", async () => {
    const session = createSession({ observabilityEnabled: false });
    const { deps, calls } = createDeps({
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, true),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "langchain-deepagents-code" },
      sandboxName: "saved",
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toMatchObject({
      observabilityEnabled: true,
    });
    expect(session.observabilityEnabled).toBe(true);
    expect(session.observabilityRequestedExplicitly).toBe(false);
  });

  it.each([
    "openclaw",
    "hermes",
  ])("requires an explicit observability disable when switching DCode to %s", async (agentName) => {
    const session = createSession({
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
    });
    const { deps, calls } = createDeps({
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, true),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        agent: { name: agentName },
        sandboxName: "saved",
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.error).toHaveBeenCalledWith(expect.stringContaining("--no-observability"));
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(session.observabilityEnabled).toBe(true);
  });

  it("requires an explicit disable when resumed session state has observability enabled", async () => {
    const session = createSession({
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      observabilityRequestedExplicitly: true,
    });
    const { deps, calls } = createDeps({
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, false),
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        agent: { name: "hermes" },
        resume: true,
        sandboxName: "saved",
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.error).toHaveBeenCalledWith(expect.stringContaining("--no-observability"));
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("clears DCode observability during an explicitly acknowledged agent switch", async () => {
    const session = createSession({
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
    });
    const { deps, calls } = createDeps({
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, true),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "hermes" },
      sandboxName: "saved",
      requestedObservabilityEnabled: false,
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toMatchObject({
      observabilityEnabled: false,
      observabilityRequestedExplicitly: true,
    });
    expect(session.observabilityEnabled).toBe(false);
    expect(session.observabilityRequestedExplicitly).toBe(true);
  });

  it("records an explicit request even when its enabled value already matches", async () => {
    const session = createSession({ observabilityEnabled: true });
    const updateSession = vi.fn((mutator: (value: Session) => Session | void) => {
      return mutator(session) ?? session;
    });
    const { deps } = createDeps({
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, true),
      updateSession,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "langchain-deepagents-code" },
      sandboxName: "saved",
      requestedObservabilityEnabled: true,
    });

    expect(session.observabilityEnabled).toBe(true);
    expect(session.observabilityRequestedExplicitly).toBe(true);
    expect(updateSession).toHaveBeenCalled();
  });

  it.each([
    { recorded: true, requested: false },
    { recorded: false, requested: true },
  ])("gives current explicit observability=$requested precedence on resume", async ({
    recorded,
    requested,
  }) => {
    const session = createSession({
      sandboxName: "saved",
      observabilityEnabled: recorded,
      observabilityRequestedExplicitly: true,
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, recorded),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "langchain-deepagents-code" },
      resume: true,
      sandboxName: "saved",
      requestedObservabilityEnabled: requested,
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toMatchObject({
      recreate: true,
      observabilityEnabled: requested,
    });
    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Observability configuration changed; recreating sandbox.",
    );
    expect(session.observabilityEnabled).toBe(requested);
    expect(session.observabilityRequestedExplicitly).toBe(true);
  });

  it.each([
    { recorded: false, requested: true },
    { recorded: true, requested: false },
  ])("preserves interrupted explicit observability=$requested over registry=$recorded", async ({
    recorded,
    requested,
  }) => {
    const session = createSession({
      sandboxName: "saved",
      observabilityEnabled: requested,
      observabilityRequestedExplicitly: true,
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, recorded),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "langchain-deepagents-code" },
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toMatchObject({
      recreate: true,
      observabilityEnabled: requested,
    });
    expect(session.observabilityEnabled).toBe(requested);
    expect(session.observabilityRequestedExplicitly).toBe(true);
  });

  it("does not treat an interrupted omitted request as an explicit disable", async () => {
    const session = createSession({
      sandboxName: "saved",
      observabilityEnabled: false,
      observabilityRequestedExplicitly: false,
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name, true),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "langchain-deepagents-code" },
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(session.observabilityEnabled).toBe(true);
    expect(session.observabilityRequestedExplicitly).toBe(false);
  });

  it("recreates a ready DCode sandbox before opting out from unknown legacy state", async () => {
    const session = createSession({
      sandboxName: "saved",
      observabilityEnabled: false,
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name: string) => dcodeRegistryEntry(name),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "langchain-deepagents-code" },
      resume: true,
      sandboxName: "saved",
      requestedObservabilityEnabled: false,
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toMatchObject({
      recreate: true,
      observabilityEnabled: false,
    });
    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Observability configuration changed; recreating sandbox.",
    );
  });

  it("removes the conflicting Hermes nous-web gateway when Tavily is selected", async () => {
    const { deps, calls } = createDeps();

    const result = await handleSandboxState({
      ...baseOptions(deps),
      agent: { name: "hermes", displayName: "Hermes" },
      webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      hermesToolGateways: ["nous-web", "nous-audio"],
    });

    expect(calls.createSandbox).toHaveBeenCalledWith(
      expect.anything(),
      "model",
      "provider",
      "openai-completions",
      "my-assistant",
      { fetchEnabled: true, provider: "tavily" },
      [],
      null,
      { name: "hermes", displayName: "Hermes" },
      null,
      expect.anything(),
      null,
      ["nous-audio"],
      null,
      {
        recreate: false,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
      },
    );
    expect(result.hermesToolGateways).toEqual(["nous-audio"]);
    expect(calls.note).toHaveBeenCalledWith(
      "  Tavily Search replaces Hermes managed Web search/extract and removes the conflicting nous-web selection.",
    );
    expect(calls.complete).toHaveBeenCalledWith(
      "sandbox",
      expect.objectContaining({ hermesToolGateways: ["nous-audio"] }),
    );
  });

  it("reuses a completed ready sandbox on resume", async () => {
    const session = createSession({
      sandboxName: "saved",
      messagingPlan: makeMinimalPlan("saved", "openclaw", ["slack"]),
    });
    session.steps.sandbox.status = "complete";
    const skippedSession = createSession({ sandboxName: "saved-after-skip" });
    const recordStateSkipped = vi.fn(async () => skippedSession);
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: () => ({
        name: "saved",
        pendingRouteReservation: true,
        provider: "provider",
        model: "model",
        endpointUrl: null,
        preferredInferenceApi: "openai-completions",
        toolDisclosure: "progressive",
        fromDockerfile: null,
        hermesAuthMethod: null,
      }),
      recordStateSkipped,
    });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.updateSandbox).toHaveBeenCalledWith("saved", {
      pendingRouteReservation: undefined,
    });
    expect(calls.skipped).toHaveBeenCalledWith("sandbox", "saved");
    expect(recordStateSkipped).toHaveBeenCalledWith("sandbox", {
      reason: "resume",
      sandboxName: "saved",
    });
    expect(result.selectedMessagingChannels).toEqual(["slack"]);
    expect(result.webSearchConfigChanged).toBe(false);
    expect(result.session).toBe(skippedSession);
  });

  it("recreates a resumed Hermes sandbox when its compatible Anthropic frontend is stale", async () => {
    const session = createSession({
      agent: "hermes",
      sandboxName: "saved",
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
      preferredInferenceApi: "anthropic-messages",
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name) => ({
        name,
        agent: "hermes",
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        toolDisclosure: "progressive",
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      agent: { name: "hermes", displayName: "Hermes" },
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
      preferredInferenceApi: "openai-completions",
    });

    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Hermes inference route configuration changed; recreating sandbox.",
    );
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalledWith(
      expect.anything(),
      "claude-sonnet-proxy",
      "compatible-anthropic-endpoint",
      "openai-completions",
      "saved",
      null,
      [],
      null,
      { name: "hermes", displayName: "Hermes" },
      null,
      expect.anything(),
      null,
      [],
      null,
      {
        recreate: true,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
      },
    );
  });

  it("backfills absent rebuild fidelity after validated sandbox reuse", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
      hermesAuthMethod: "api_key",
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name) => ({
        name,
        provider: "provider",
        model: "model",
        endpointUrl: null,
        preferredInferenceApi: "openai-completions",
        nemoclawVersion: "0.1.0",
        toolDisclosure: "progressive",
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
      hermesAuthMethod: "api_key",
    });

    expect(calls.updateSandbox).toHaveBeenCalledWith("saved", {
      webSearchEnabled: true,
      webSearchProvider: "brave",
      fromDockerfile: null,
      hermesAuthMethod: "api_key",
    });
  });

  it("marks web search changed when recreate implicitly enables Tavily", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const { deps } = createDeps({
      getSandboxReuseState: () => "not_ready",
      configureWebSearch: vi.fn(async () => ({
        fetchEnabled: true as const,
        provider: "tavily" as const,
      })),
    });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(result.webSearchConfig).toEqual({ fetchEnabled: true, provider: "tavily" });
    expect(result.webSearchConfigChanged).toBe(true);
  });

  it("removes registry state when messaging config drift forces sandbox recreation", async () => {
    const session = createSession();
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getStoredMessagingChannelConfig: () => ({ TELEGRAM_REQUIRE_MENTION: "1" }),
      hydrateMessagingChannelConfig: () => ({ TELEGRAM_REQUIRE_MENTION: "0" }),
      messagingChannelConfigsEqual: () => false,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Messaging channel configuration changed; recreating sandbox.",
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
      "  Brave Search is not yet supported by this sandbox image. Clearing stale config.",
    );
    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Web Search configuration changed; recreating sandbox.",
    );
    expect(calls.removeSandbox).toHaveBeenCalledWith("saved");
    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it("recreates when an explicit web-search provider differs from saved state", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      agentSupportsWebSearchProvider: () => true,
    });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
      env: { NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily" },
    });

    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Web Search configuration changed; recreating sandbox.",
    );
    expect(calls.removeSandbox).toHaveBeenCalledWith("saved");
    expect(calls.validateBrave).toHaveBeenCalledWith({
      fetchEnabled: true,
      provider: "tavily",
    });
    expect(calls.createSandbox).toHaveBeenCalledWith(
      { type: "nvidia" },
      "model",
      "provider",
      "openai-completions",
      "saved",
      { fetchEnabled: true, provider: "tavily" },
      [],
      null,
      null,
      null,
      { sandboxGpuEnabled: false, mode: "0" },
      null,
      [],
      null,
      {
        recreate: true,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
      },
    );
    expect(result.webSearchConfigChanged).toBe(true);
  });

  it("keeps registry state intact when replacement provider validation fails", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      agentSupportsWebSearchProvider: () => true,
      ensureValidatedWebSearchCredential: vi.fn(async () => {
        throw new Error("Tavily credential rejected");
      }),
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
        webSearchConfig: { fetchEnabled: true, provider: "brave" },
        env: { NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily" },
      }),
    ).rejects.toThrow("Tavily credential rejected");

    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.repairSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("fails before credential or registry mutation when Tavily collides with managed MCP", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      agentSupportsWebSearchProvider: () => true,
      getSandboxRegistryEntry: (name: string) => ({
        name,
        mcp: {
          bridges: {
            search: {
              server: "search",
              agent: "openclaw",
              url: "https://mcp.example.com/mcp",
              env: ["TAVILY_API_KEY"],
              policyName: "saved-mcp-search",
              addedAt: "2026-07-03T00:00:00.000Z",
            },
          },
        },
      }),
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
        webSearchConfig: { fetchEnabled: true, provider: "brave" },
        env: { NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily" },
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.error).toHaveBeenCalledWith(
      expect.stringContaining("already owns TAVILY_API_KEY"),
    );
    expect(calls.validateBrave).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
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
      ensureValidatedWebSearchCredential: vi.fn(async () => backToSelection),
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
      null,
      {
        recreate: true,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
      },
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

  it("refreshes credential hashes when restoring a registry plan for rebuild resume", async () => {
    const oldHash = hashCredential("telegram-token-a");
    const newHash = hashCredential("telegram-token-b");
    const registryPlan = withTelegramCredentialHash(
      makeMinimalPlan("my-assistant", "openclaw", ["telegram"]),
      oldHash,
    );
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: registryPlan });
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["telegram"]);
    const writePlanToEnv = vi.fn();
    const { deps, calls, getSession } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => null,
      getRegistrySandboxMessagingPlan: () => registryPlan,
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

  it("clears env-staged messaging plans when the current agent has no channel manifest support", async () => {
    const stalePlan = makeMinimalPlan("my-assistant", "openclaw", ["telegram"]);
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: stalePlan });
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["telegram"]);
    const writePlanToEnv = vi.fn();
    const { deps, calls, getSession } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => stalePlan,
    });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      agent: { name: "langchain-deepagents-code" },
    });

    expect(calls.clearPlanEnv).toHaveBeenCalledTimes(1);
    expect(writePlanToEnv).not.toHaveBeenCalled();
    expect(result.selectedMessagingChannels).toEqual([]);
    expect((calls.createSandbox.mock.calls[0] as unknown[])[6]).toEqual([]);
    expect(getSession().messagingPlan).toBeNull();
  });

  it("clears registry messaging plans when the current agent is unknown", async () => {
    const registryPlan = makeMinimalPlan("my-assistant", "openclaw", ["discord"]);
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: registryPlan });
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["discord"]);
    const writePlanToEnv = vi.fn();
    const { deps, calls, getSession } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => null,
      getRegistrySandboxMessagingPlan: () => registryPlan,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      agent: { name: "custom-agent" },
    });

    expect(calls.clearPlanEnv).toHaveBeenCalledTimes(1);
    expect(writePlanToEnv).not.toHaveBeenCalled();
    expect((calls.createSandbox.mock.calls[0] as unknown[])[6]).toEqual([]);
    expect(getSession().messagingPlan).toBeNull();
  });

  it("refreshes a reused empty registry messaging plan when env supplies new channel inputs", async () => {
    // Reporter scenario (#5680): a fresh non-interactive onboard targets an
    // existing sandbox whose registry messaging plan has no active channels, but
    // the process now exports TELEGRAM_BOT_TOKEN. The empty plan must not be
    // accepted as authoritative; messaging setup must run so the Telegram
    // reachability check executes instead of being silently bypassed.
    detectMessagingChannelsFromEnvMock.mockReturnValue(["telegram"]);
    // Reused registry plan has no ACTIVE channels but records a previously
    // configured in-sandbox-QR channel (whatsapp, disabled) with no host token.
    // The rebuild must seed `existing` from this authoritative registry plan,
    // not from the session plan, so whatsapp is preserved across the refresh.
    const registryPlan = makeMinimalPlan("my-assistant", "openclaw", ["whatsapp"], ["whatsapp"]);
    const refreshedPlan = makeMinimalPlan("my-assistant", "openclaw", ["telegram"], ["telegram"]);
    const session = createSession({
      sandboxName: "my-assistant",
      // A divergent/stale session plan that must NOT be used as the seed source.
      messagingPlan: makeMinimalPlan("my-assistant", "openclaw", ["slack"]),
    });
    const writePlanToEnv = vi.fn();
    const readMessagingPlanFromEnv = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValue(refreshedPlan);
    const { deps, calls, getSession } = createDeps({
      getRecordedMessagingChannelsForResume: vi.fn(() => null),
      writePlanToEnv,
      readMessagingPlanFromEnv,
      getRegistrySandboxMessagingPlan: () => registryPlan,
    });
    // Fake-token rejection disables Telegram, so no channel survives setup.
    calls.setupMessaging.mockResolvedValue([]);

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      sandboxName: "my-assistant",
    });

    expect(calls.setupMessaging).toHaveBeenCalledWith(null, ["whatsapp"], "my-assistant");
    expect(writePlanToEnv).not.toHaveBeenCalled();
    expect(calls.note).toHaveBeenCalledWith(
      "  [non-interactive] Detected messaging channel inputs for telegram; refreshing reused sandbox messaging plan.",
    );
    expect(result.selectedMessagingChannels).toEqual([]);
    expect(getSession().messagingPlan).toEqual(refreshedPlan);
  });

  it("preserves an active registry channel without refresh when env adds a different channel", async () => {
    // Regression guard: a reused plan with an active channel (slack) must not be
    // rebuilt just because a new token (telegram) now appears in env. Rebuilding
    // non-interactively would re-derive the plan from env and drop slack when
    // its token is absent from this run, so active plans are preserved as-is.
    detectMessagingChannelsFromEnvMock.mockReturnValue(["telegram"]);
    const registryPlan = makeMinimalPlan("my-assistant", "openclaw", ["slack"]);
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: registryPlan });
    const writePlanToEnv = vi.fn();
    const { deps, calls } = createDeps({
      getRecordedMessagingChannelsForResume: vi.fn(() => null),
      writePlanToEnv,
      readMessagingPlanFromEnv: () => null,
      getRegistrySandboxMessagingPlan: () => registryPlan,
    });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      sandboxName: "my-assistant",
    });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(writePlanToEnv).toHaveBeenCalledWith(registryPlan);
    expect(result.selectedMessagingChannels).toEqual(["slack"]);
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

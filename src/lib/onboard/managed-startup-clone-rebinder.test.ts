// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../messaging/manifest";
import { PEM } from "./__test-helpers__/corporate-ca-fixtures";
import {
  type ManagedStartupCloneCurrentState,
  ManagedStartupCloneRebindError,
  managedStartupCloneRebinderDependencies,
  rebindManagedStartupProfileForClone,
} from "./managed-startup/clone-rebinder";
import {
  buildManagedStartupProfile,
  type ManagedStartupProfileBuilderInput,
} from "./managed-startup/profile-builder";
import { encodeManagedStartupProfile } from "./managed-startup/profile";

function messagingPlan(agent: "openclaw" | "hermes", sandboxName = "source"): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent,
    workflow: "onboard",
    channels: [
      {
        channelId: "telegram",
        displayName: "Telegram",
        authMode: "token-paste",
        configured: true,
        active: true,
        selected: true,
        disabled: false,
        inputs: [
          {
            channelId: "telegram",
            inputId: "botToken",
            kind: "secret",
            required: true,
            sourceEnv: "TELEGRAM_BOT_TOKEN",
            credentialAvailable: true,
          },
          {
            channelId: "telegram",
            inputId: "allowedIds",
            kind: "config",
            required: false,
            statePath: "allowedIds.telegram",
            value: ["123456"],
          },
        ],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] },
    stateUpdates: [],
    healthChecks: [],
  };
}

function openClawInput(): ManagedStartupProfileBuilderInput {
  return {
    agent: "openclaw",
    inference: {
      routeProvider: "inference",
      upstreamProvider: "openai-api",
      model: "gpt-5.4",
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl: null,
      api: "openai-responses",
      primaryModelRef: "inference/gpt-5.4",
      compatibility: {},
    },
    dashboard: {
      agent: "openclaw",
      mode: "loopback",
      url: "http://127.0.0.1:18789",
      port: 18_789,
      bindAddress: "127.0.0.1",
      wslExposure: false,
    },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: messagingPlan("openclaw"),
    dcodeAutoApprovalMode: null,
    observabilityEnabled: null,
    environment: {},
    corporateCa: null,
  };
}

function hermesInput(): ManagedStartupProfileBuilderInput {
  return {
    agent: "hermes",
    inference: {
      routeProvider: "inference",
      upstreamProvider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-4-6",
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl: null,
      api: "openai-completions",
      primaryModelRef: null,
      compatibility: null,
    },
    dashboard: {
      agent: "hermes",
      mode: "loopback-forwarded",
      url: "http://127.0.0.1:19189",
      browserUrl: "https://secure-link.example/",
      publicPort: 19_189,
      internalPort: 29_189,
      tuiEnabled: true,
    },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: messagingPlan("hermes"),
    dcodeAutoApprovalMode: null,
    observabilityEnabled: null,
    environment: {},
    corporateCa: null,
  };
}

function dcodeInput(): ManagedStartupProfileBuilderInput {
  return {
    agent: "langchain-deepagents-code",
    inference: {
      routeProvider: "inference",
      upstreamProvider: "openrouter",
      model: "openai/gpt-5.4",
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl: "https://openrouter.ai/api/v1",
      api: "openai-completions",
      primaryModelRef: null,
      compatibility: null,
    },
    dashboard: { agent: "langchain-deepagents-code", mode: "disabled" },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: "disabled",
    observabilityEnabled: false,
    environment: {},
    corporateCa: null,
  };
}

function rebind(
  built: ReturnType<typeof buildManagedStartupProfile>,
  expectedAgent: ManagedStartupProfileBuilderInput["agent"],
  destinationDashboardPort: number | null,
  currentOverrides: Partial<ManagedStartupCloneCurrentState> = {},
  names: {
    readonly sourceSandboxName?: string;
    readonly destinationSandboxName?: string;
  } = {},
) {
  const profile = built.profile;
  const webSearch =
    profile.agentConfig.agent === "openclaw" || profile.agentConfig.agent === "hermes"
      ? profile.agentConfig.webSearch
      : null;
  const hermesDashboard = profile.dashboard.agent === "hermes" ? profile.dashboard : null;
  const dcodeConfig =
    profile.agentConfig.agent === "langchain-deepagents-code" ? profile.agentConfig : null;
  return rebindManagedStartupProfileForClone({
    sourceSandboxName: names.sourceSandboxName ?? "source",
    destinationSandboxName: names.destinationSandboxName ?? "destination",
    expectedAgent,
    destinationDashboardPort,
    ...(expectedAgent === "hermes" && profile.tools.enabledGateways.length > 0
      ? { destinationHermesInferenceProvider: "destination-hermes-inference" }
      : {}),
    encodedProfile: built.encodedProfile,
    startupProfileSha256: built.startupProfileSha256,
    ...(built.corporateCaB64 === undefined ? {} : { corporateCaB64: built.corporateCaB64 }),
    currentSource: {
      provider: profile.inference.upstreamProvider,
      model: profile.inference.model,
      endpointUrl: profile.inference.upstreamEndpointUrl,
      preferredInferenceApi: profile.inference.api,
      compatibleEndpointReasoning:
        profile.agent === "openclaw" && profile.inference.upstreamProvider === "compatible-endpoint"
          ? profile.tuning.reasoning
            ? "true"
            : "false"
          : null,
      compatibleEndpointReasoningEffort:
        profile.agent === "openclaw" &&
        profile.inference.upstreamProvider === "compatible-endpoint" &&
        profile.tuning.reasoningEffort !== "default"
          ? profile.tuning.reasoningEffort
          : null,
      toolDisclosure: profile.tools.disclosure,
      webSearchEnabled: webSearch?.enabled,
      webSearchProvider: webSearch?.provider,
      messaging:
        profile.messaging.plan === null
          ? undefined
          : { schemaVersion: 1, plan: profile.messaging.plan },
      hermesToolGateways: profile.tools.enabledGateways,
      hermesDashboardEnabled: hermesDashboard?.mode === "loopback-forwarded",
      hermesDashboardPort:
        hermesDashboard?.mode === "loopback-forwarded" ? hermesDashboard.publicPort : undefined,
      hermesDashboardInternalPort:
        hermesDashboard?.mode === "loopback-forwarded" ? hermesDashboard.internalPort : undefined,
      hermesDashboardTui:
        hermesDashboard?.mode === "loopback-forwarded" ? hermesDashboard.tuiEnabled : undefined,
      dashboardPort:
        profile.dashboard.agent === "openclaw"
          ? profile.dashboard.port
          : hermesDashboard?.mode === "loopback-forwarded"
            ? hermesDashboard.publicPort
            : undefined,
      dashboardRemoteBindPrepared:
        profile.dashboard.agent === "openclaw"
          ? profile.dashboard.bindAddress === "0.0.0.0"
          : undefined,
      dcodeAutoApprovalMode: dcodeConfig?.autoApprovalMode,
      observabilityEnabled: dcodeConfig?.observabilityEnabled,
      ...currentOverrides,
    },
  });
}

describe("rebindManagedStartupProfileForClone", () => {
  it("rebinds OpenClaw dashboard and manifest-derived provider identity without ambient tokens", () => {
    const built = buildManagedStartupProfile(openClawInput());
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "ambient-token-must-not-be-read");
    const rebound = rebind(built, "openclaw", 20_789);
    expect(rebound.profile.dashboard).toMatchObject({
      agent: "openclaw",
      url: "http://127.0.0.1:20789",
      port: 20_789,
    });
    expect(rebound.profile.messaging.plan).toMatchObject({
      sandboxName: "destination",
      credentialBindings: [
        {
          providerName: "destination-telegram-bridge",
          credentialAvailable: true,
        },
      ],
    });
    expect(JSON.stringify(rebound.profile.messaging.plan)).not.toContain(
      "ambient-token-must-not-be-read",
    );
    expect(
      (rebound.profile.messaging.plan as unknown as SandboxMessagingPlan).credentialBindings[0],
    ).not.toHaveProperty("credentialHash");
    expect(rebound.startupProfileSha256).not.toBe(built.startupProfileSha256);
    expect(Object.isFrozen(rebound)).toBe(true);
    expect(Object.isFrozen(rebound.profile)).toBe(true);
    expect(Object.isFrozen(rebound.profile.messaging.plan)).toBe(true);
    expect(Object.isFrozen(rebound.profile.tools.enabledGateways)).toBe(true);
  });

  it("rebinds the current compatible-endpoint reasoning effort instead of stale receipt tuning", () => {
    const built = buildManagedStartupProfile({
      ...openClawInput(),
      inference: {
        ...openClawInput().inference,
        upstreamProvider: "compatible-endpoint",
        api: "openai-completions",
      },
      environment: {
        NEMOCLAW_REASONING: "true",
        NEMOCLAW_REASONING_EFFORT: "low",
      },
    });

    const rebound = rebind(built, "openclaw", 20_789, {
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: "high",
    });

    expect(built.profile.tuning.reasoningEffort).toBe("low");
    expect(rebound.profile.tuning).toMatchObject({
      reasoning: true,
      reasoningEffort: "high",
    });
  });

  it("resolves the current Ollama context window when the source provider changed", () => {
    const built = buildManagedStartupProfile(openClawInput());
    const resolveContextWindowForModel = vi
      .spyOn(managedStartupCloneRebinderDependencies, "resolveContextWindowForModel")
      .mockReturnValue(131_072);

    const rebound = rebind(built, "openclaw", 20_789, {
      provider: "ollama-local",
      model: "qwen3.5:9b",
    });

    expect(resolveContextWindowForModel).toHaveBeenCalledWith("ollama-local", "qwen3.5:9b");
    expect(rebound.profile.tuning.contextWindow).toBe(131_072);
  });

  it("resolves the current Ollama context window when only the source model changed", () => {
    const input = openClawInput();
    const ollamaSource = buildManagedStartupProfile({
      ...input,
      inference: {
        ...input.inference,
        upstreamProvider: "ollama-local",
        model: "qwen3:8b",
        api: "openai-completions",
        primaryModelRef: "inference/qwen3:8b",
        compatibility: { supportsUsageInStreaming: true },
      },
      environment: { NEMOCLAW_CONTEXT_WINDOW: "65536" },
    });
    const resolveContextWindowForModel = vi
      .spyOn(managedStartupCloneRebinderDependencies, "resolveContextWindowForModel")
      .mockReturnValue(131_072);

    const rebound = rebind(ollamaSource, "openclaw", 20_789, {
      provider: "ollama-local",
      model: "qwen3.5:9b",
    });

    expect(resolveContextWindowForModel).toHaveBeenCalledWith("ollama-local", "qwen3.5:9b");
    expect(rebound.profile.tuning.contextWindow).toBe(131_072);
  });

  it("rebinds Hermes public dashboard and provider identity while retaining its internal port", () => {
    const rebound = rebind(buildManagedStartupProfile(hermesInput()), "hermes", 21_189);

    expect(rebound.profile.dashboard).toEqual({
      agent: "hermes",
      mode: "loopback-forwarded",
      url: "http://127.0.0.1:21189",
      browserUrl: "https://secure-link.example",
      publicPort: 21_189,
      internalPort: 29_189,
      tuiEnabled: true,
    });
    expect(rebound.profile.messaging.plan).toMatchObject({
      sandboxName: "destination",
      credentialBindings: [{ providerName: "destination-telegram-bridge" }],
    });
  });

  it("rebinds a Hermes browser URL across the IPv4 loopback range", () => {
    const input = hermesInput();
    const dashboard = input.dashboard as Extract<
      typeof input.dashboard,
      { readonly agent: "hermes" }
    >;
    const rebound = rebind(
      buildManagedStartupProfile({
        ...input,
        dashboard: {
          ...dashboard,
          browserUrl: "http://127.0.0.2:19189",
        },
      }),
      "hermes",
      21_189,
    );

    expect(rebound.profile.dashboard).toMatchObject({
      url: "http://127.0.0.1:21189",
      browserUrl: "http://127.0.0.2:21189",
      publicPort: 21_189,
      internalPort: 29_189,
    });
  });

  it("refuses to clone an enabled Hermes dashboard without a recorded browser URL", () => {
    const input = hermesInput();
    const built = buildManagedStartupProfile(input);
    const dashboard = built.profile.dashboard as Extract<
      typeof built.profile.dashboard,
      { readonly agent: "hermes" }
    >;
    expect(dashboard.agent).toBe("hermes");
    const { browserUrl: _browserUrl, ...legacyDashboard } = dashboard;
    const legacyProfile = { ...built.profile, dashboard: legacyDashboard };
    const encodedProfile = encodeManagedStartupProfile(legacyProfile);
    const legacyBuilt = {
      ...built,
      profile: legacyProfile,
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    } as ReturnType<typeof buildManagedStartupProfile>;

    expect(() => rebind(legacyBuilt, "hermes", 21_189)).toThrow(
      "Cannot prepare managed snapshot clone: current source Hermes dashboard has no recorded browser URL; rerun onboarding before cloning the sandbox",
    );
  });

  it("rebinds managed-tool Hermes inference to the destination provider identity", () => {
    const built = buildManagedStartupProfile({
      ...hermesInput(),
      hermesToolGateways: ["nous-web"],
    });

    const rebound = rebind(built, "hermes", 21_189);

    expect(rebound.profile.inference).toMatchObject({
      routeProvider: "inference",
      upstreamProvider: "destination-hermes-inference",
    });
    expect(rebound.profile.tools.enabledGateways).toEqual(["nous-web"]);
  });

  it("rebinds DCode without inventing dashboard or messaging state", () => {
    const rebound = rebind(
      buildManagedStartupProfile(dcodeInput()),
      "langchain-deepagents-code",
      null,
    );

    expect(rebound.profile.dashboard).toEqual({
      agent: "langchain-deepagents-code",
      mode: "disabled",
    });
    expect(rebound.profile.messaging).toEqual({ plan: null });
    expect(rebound.encodedProfile).toBe(buildManagedStartupProfile(dcodeInput()).encodedProfile);
  });

  it("retains and revalidates the exact public corporate CA transport", () => {
    const built = buildManagedStartupProfile({
      ...openClawInput(),
      corporateCa: {
        pem: PEM,
        sourcePath: "/public/corporate-ca.pem",
        sourceEnv: "NEMOCLAW_CORPORATE_CA_BUNDLE",
      },
    });

    const rebound = rebind(built, "openclaw", 20_789);

    expect(rebound.corporateCaB64).toBe(built.corporateCaB64);
    expect(rebound.profile.corporateCa).toEqual(built.profile.corporateCa);
  });

  it("fails closed on receipt hash, source messaging identity, and unexpected CA transport", () => {
    const built = buildManagedStartupProfile(openClawInput());
    expect(() =>
      rebindManagedStartupProfileForClone({
        sourceSandboxName: "source",
        destinationSandboxName: "destination",
        expectedAgent: "openclaw",
        destinationDashboardPort: 20_789,
        encodedProfile: built.encodedProfile,
        startupProfileSha256: "0".repeat(64),
        currentSource: {
          provider: built.profile.inference.upstreamProvider,
          model: built.profile.inference.model,
        },
      }),
    ).toThrow(ManagedStartupCloneRebindError);

    const wrongIdentity = buildManagedStartupProfile({
      ...openClawInput(),
      messagingPlan: messagingPlan("openclaw", "other-source"),
    });
    expect(() => rebind(wrongIdentity, "openclaw", 20_789)).toThrow(/source plan is invalid/u);

    expect(() =>
      rebindManagedStartupProfileForClone({
        sourceSandboxName: "source",
        destinationSandboxName: "destination",
        expectedAgent: "openclaw",
        destinationDashboardPort: 20_789,
        encodedProfile: built.encodedProfile,
        startupProfileSha256: built.startupProfileSha256,
        corporateCaB64: "eA==",
        currentSource: {
          provider: built.profile.inference.upstreamProvider,
          model: built.profile.inference.model,
        },
      }),
    ).toThrow(/corporate CA transport/u);
  });

  it("uses the canonical sandbox grammar and rejects an identity-preserving clone", () => {
    const built = buildManagedStartupProfile(dcodeInput());

    expect(() =>
      rebind(
        built,
        "langchain-deepagents-code",
        null,
        {},
        {
          sourceSandboxName: "1source",
        },
      ),
    ).toThrow(/source sandbox name is invalid/u);
    expect(() =>
      rebind(
        built,
        "langchain-deepagents-code",
        null,
        {},
        {
          destinationSandboxName: "1destination",
        },
      ),
    ).toThrow(/destination sandbox name is invalid/u);
    expect(() =>
      rebind(
        built,
        "langchain-deepagents-code",
        null,
        {},
        {
          destinationSandboxName: "source",
        },
      ),
    ).toThrow(/source and destination sandbox names must differ/u);
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildManagedStartupOnboardProfile,
  ManagedStartupOnboardProfileError,
  type ManagedStartupOnboardProfileInput,
} from "./managed-startup/onboard-profile";
import { decodeManagedStartupProfile } from "./managed-startup/profile";

const EMPTY_ENVIRONMENT: NodeJS.ProcessEnv = {};

function messagingPlan(agent: "openclaw" | "hermes") {
  return {
    schemaVersion: 1,
    sandboxName: "adapter-test",
    agent,
    workflow: "onboard",
    channels: [],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  } as const;
}

function openClawInput(
  overrides: Partial<ManagedStartupOnboardProfileInput> = {},
): ManagedStartupOnboardProfileInput {
  return {
    agentName: "openclaw",
    inference: {
      routeProvider: "openai",
      upstreamProvider: "openai-api",
      model: "gpt-5.4",
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl: null,
      api: "openai-responses",
      primaryModelRef: "openai/gpt-5.4",
      compatibility: {},
    },
    chatUiUrl: "http://127.0.0.1:18789",
    effectiveDashboardPort: 18_789,
    manageDashboard: true,
    dashboardBindAddress: undefined,
    wslExposure: false,
    hermesDashboardState: { config: null, enabled: false },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: "disabled",
    observabilityEnabled: false,
    environment: EMPTY_ENVIRONMENT,
    corporateCa: null,
    ...overrides,
  };
}

function hermesInput(
  overrides: Partial<ManagedStartupOnboardProfileInput> = {},
): ManagedStartupOnboardProfileInput {
  return {
    agentName: "hermes",
    inference: {
      routeProvider: "inference",
      upstreamProvider: "hermes-provider",
      model: "moonshotai/kimi-k2.6",
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl: null,
      api: "openai-completions",
      primaryModelRef: null,
      compatibility: null,
    },
    chatUiUrl: "http://127.0.0.1:18789",
    effectiveDashboardPort: 18_789,
    manageDashboard: true,
    dashboardBindAddress: undefined,
    wslExposure: false,
    hermesDashboardState: {
      config: {
        enabled: false,
        port: 9119,
        internalPort: 19_119,
        tuiEnabled: false,
      },
      enabled: false,
    },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: "disabled",
    observabilityEnabled: false,
    environment: EMPTY_ENVIRONMENT,
    corporateCa: null,
    ...overrides,
  };
}

function dcodeInput(
  overrides: Partial<ManagedStartupOnboardProfileInput> = {},
): ManagedStartupOnboardProfileInput {
  return {
    agentName: "langchain-deepagents-code",
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
    chatUiUrl: "",
    effectiveDashboardPort: 0,
    manageDashboard: false,
    dashboardBindAddress: undefined,
    wslExposure: false,
    hermesDashboardState: { config: null, enabled: false },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: "disabled",
    observabilityEnabled: false,
    environment: EMPTY_ENVIRONMENT,
    corporateCa: null,
    ...overrides,
  };
}

function piInput(
  overrides: Partial<ManagedStartupOnboardProfileInput> = {},
): ManagedStartupOnboardProfileInput {
  return {
    agentName: "pi",
    inference: {
      routeProvider: "inference",
      upstreamProvider: "nvidia",
      model: "nvidia/nemotron-3-super-120b-a12b",
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl: null,
      api: "openai-completions",
      primaryModelRef: null,
      compatibility: null,
    },
    chatUiUrl: "",
    effectiveDashboardPort: 0,
    manageDashboard: false,
    dashboardBindAddress: undefined,
    wslExposure: false,
    hermesDashboardState: { config: null, enabled: false },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: "disabled",
    observabilityEnabled: false,
    environment: EMPTY_ENVIRONMENT,
    corporateCa: null,
    ...overrides,
  };
}

describe("buildManagedStartupOnboardProfile", () => {
  it("builds Pi without requiring state another agent owns (#7930)", () => {
    const built = buildManagedStartupOnboardProfile(
      piInput({
        environment: {
          NEMOCLAW_CONTEXT_WINDOW: "262144",
          NEMOCLAW_MAX_TOKENS: "32000",
          NEMOCLAW_REASONING: "true",
        },
      }),
    );

    expect(built.profile).toMatchObject({
      agent: "pi",
      agentConfig: { agent: "pi" },
      dashboard: { agent: "pi", mode: "disabled" },
      messaging: { plan: null },
      tuning: {
        contextWindow: 262_144,
        maxTokens: 32_000,
        reasoning: true,
        reasoningEffort: null,
      },
    });
  });

  it("rejects Pi web-search intent instead of carrying it into the profile (#7930)", () => {
    expect(
      buildManagedStartupOnboardProfile(
        piInput({ webSearch: { fetchEnabled: true, provider: "tavily" } }),
      ).profile.agentConfig,
    ).toEqual({ agent: "pi" });
  });

  it("rejects Pi messaging intent instead of silently discarding it (#7930)", () => {
    expect(() =>
      buildManagedStartupOnboardProfile(piInput({ messagingPlan: messagingPlan("openclaw") })),
    ).toThrow(/pi does not support messaging/);
  });

  it("rejects a Pi dashboard request (#7930)", () => {
    expect(() =>
      buildManagedStartupOnboardProfile(piInput({ manageDashboard: true })),
    ).toThrow(/Pi must not enable a dashboard/);
  });

  it("maps a remote OpenClaw dashboard and its complete agent-owned state", () => {
    const plan = messagingPlan("openclaw");
    const built = buildManagedStartupOnboardProfile(
      openClawInput({
        chatUiUrl: "https://dashboard.example.test:19443",
        effectiveDashboardPort: 19_443,
        dashboardBindAddress: "0.0.0.0",
        wslExposure: true,
        webSearch: { fetchEnabled: true, provider: "tavily" },
        toolDisclosure: "direct",
        messagingPlan: plan,
      }),
    );

    expect(built.profile).toMatchObject({
      agent: "openclaw",
      dashboard: {
        agent: "openclaw",
        mode: "remote",
        url: "https://dashboard.example.test:19443",
        port: 19_443,
        bindAddress: "0.0.0.0",
        wslExposure: true,
      },
      agentConfig: {
        agent: "openclaw",
        webSearch: { enabled: true, provider: "tavily" },
        deviceAuth: { disabled: true, optOutSource: "managed-onboard" },
      },
      tools: { disclosure: "direct", enabledGateways: [] },
    });
    expect(built.profile.messaging.plan).not.toBeNull();
    expect(built.profile.inference.upstreamEndpointUrl).toBeNull();
  });

  it("keeps bracketed IPv6 loopback OpenClaw dashboards in loopback mode", () => {
    const built = buildManagedStartupOnboardProfile(
      openClawInput({
        chatUiUrl: "http://[::1]:18789",
      }),
    );

    expect(built.profile.dashboard).toEqual({
      agent: "openclaw",
      mode: "loopback",
      url: "http://[::1]:18789",
      port: 18_789,
      bindAddress: "127.0.0.1",
      wslExposure: false,
    });
  });

  it("rejects an OpenClaw bind value that would otherwise be silently downgraded", () => {
    expect(() =>
      buildManagedStartupOnboardProfile(
        openClawInput({
          dashboardBindAddress: "127.0.0.1",
        }),
      ),
    ).toThrow(/dashboard bind address must be empty or 0\.0\.0\.0/);
  });

  it("normalizes a malformed dashboard URL without echoing its input", () => {
    const canary = "dashboard-url-secret-canary";
    const invoke = () =>
      buildManagedStartupOnboardProfile(openClawInput({ chatUiUrl: `http://[${canary}` }));

    expect(invoke).toThrow(ManagedStartupOnboardProfileError);
    expect(invoke).toThrow(/chatUiUrl must be a valid HTTP\(S\) URL/u);
    try {
      invoke();
    } catch (error) {
      expect(String(error)).not.toContain(canary);
    }
  });

  it("maps Hermes with its dashboard disabled and Tavily retained", () => {
    const built = buildManagedStartupOnboardProfile(hermesInput());

    expect(built.profile).toMatchObject({
      agent: "hermes",
      dashboard: {
        agent: "hermes",
        mode: "disabled",
        url: "http://127.0.0.1:18789",
        publicPort: null,
        internalPort: null,
        tuiEnabled: false,
      },
      agentConfig: {
        agent: "hermes",
        webSearch: { enabled: false, provider: "tavily" },
      },
      inference: {
        upstreamEndpointUrl: null,
        primaryModelRef: null,
        compatibility: null,
        inputModalities: null,
      },
    });
  });

  it("maps Hermes forwarding, tool gateways, messaging, and context independently", () => {
    const plan = messagingPlan("hermes");
    const built = buildManagedStartupOnboardProfile(
      hermesInput({
        chatUiUrl: "https://hermes.example.test:19189",
        effectiveDashboardPort: 19_189,
        hermesDashboardState: {
          config: {
            enabled: true,
            port: 19_189,
            internalPort: 29_189,
            tuiEnabled: true,
          },
          enabled: true,
        },
        webSearch: { fetchEnabled: true, provider: "tavily" },
        hermesToolGateways: ["nous-web", "nous-image"],
        messagingPlan: plan,
        environment: {
          ...EMPTY_ENVIRONMENT,
          NEMOCLAW_CONTEXT_WINDOW: "65536",
        },
      }),
    );

    expect(built.profile.dashboard).toEqual({
      agent: "hermes",
      mode: "loopback-forwarded",
      url: "http://127.0.0.1:19189",
      browserUrl: "https://hermes.example.test:19189",
      publicPort: 19_189,
      internalPort: 29_189,
      tuiEnabled: true,
    });
    expect(built.profile.tools.enabledGateways).toEqual(["nous-image", "nous-web"]);
    expect(built.profile.messaging.plan).not.toBeNull();
    expect(built.profile.tuning).toEqual({
      contextWindow: 65_536,
      maxTokens: null,
      reasoning: null,
      reasoningEffort: null,
    });
  });

  it("maps DCode without dashboard, messaging, web-search, gateway, or tuning state", () => {
    const built = buildManagedStartupOnboardProfile(
      dcodeInput({
        dcodeAutoApprovalMode: "thread-opt-in",
        observabilityEnabled: true,
      }),
    );

    expect(built.profile).toMatchObject({
      agent: "langchain-deepagents-code",
      agentConfig: {
        agent: "langchain-deepagents-code",
        autoApprovalMode: "thread-opt-in",
        observabilityEnabled: true,
      },
      dashboard: { agent: "langchain-deepagents-code", mode: "disabled" },
      inference: {
        upstreamEndpointUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        primaryModelRef: null,
        compatibility: null,
        inputModalities: null,
      },
      tools: { disclosure: "progressive", enabledGateways: [] },
      messaging: { plan: null },
      tuning: {
        contextWindow: null,
        maxTokens: null,
        reasoning: null,
        reasoningEffort: "default",
      },
    });
  });

  it.each([
    ["hermes", hermesInput, "text,image"],
    ["langchain-deepagents-code", dcodeInput, "text"],
  ] as const)("rejects OpenClaw input modalities for %s before filtering ambient input", (agent, input, modalities) => {
    expect(() =>
      buildManagedStartupOnboardProfile(
        input({ environment: { NEMOCLAW_INFERENCE_INPUTS: modalities } }),
      ),
    ).toThrow(new RegExp(`NEMOCLAW_INFERENCE_INPUTS is not supported by ${agent}`, "u"));
  });

  it("rejects DCode messaging intent instead of silently discarding it", () => {
    expect(() =>
      buildManagedStartupOnboardProfile(dcodeInput({ messagingPlan: messagingPlan("openclaw") })),
    ).toThrow(/langchain-deepagents-code does not support messaging/u);
  });

  it("does not inspect host CA settings during profile construction", () => {
    const built = buildManagedStartupOnboardProfile(
      openClawInput({
        environment: {
          NEMOCLAW_CORPORATE_CA_BUNDLE: "/host/path/that-does-not-exist.pem",
          NEMOCLAW_CORPORATE_CA_IMPORT: "1",
        },
        corporateCa: null,
      }),
    );

    expect(built.profile.corporateCa.bundleSha256).toBeNull();
    expect(built.corporateCaB64).toBeUndefined();
  });

  it("rejects a DCode dashboard while retaining credential-free host-proxy intent", () => {
    expect(() => buildManagedStartupOnboardProfile(dcodeInput({ manageDashboard: true }))).toThrow(
      /DCode must not enable a dashboard/,
    );

    const built = buildManagedStartupOnboardProfile(
      dcodeInput({
        environment: {
          ...EMPTY_ENVIRONMENT,
          HTTP_PROXY: "http://proxy.example.test:8080",
        },
      }),
    );
    expect(built.profile.proxy.hostHttpUrl).toBe("http://proxy.example.test:8080");
    expect(built.profile.proxy.hostNoProxy).toContain("inference.local");
  });

  it("preserves an explicitly resolved routed base URL for every agent", () => {
    const route = "https://portable-route.example.test/v1";

    expect(
      buildManagedStartupOnboardProfile(
        openClawInput({
          inference: { ...openClawInput().inference, routedBaseUrl: route },
        }),
      ).profile.inference.routedBaseUrl,
    ).toBe(route);
    expect(
      buildManagedStartupOnboardProfile(
        hermesInput({
          inference: { ...hermesInput().inference, routedBaseUrl: route },
        }),
      ).profile.inference.routedBaseUrl,
    ).toBe(route);
    expect(
      buildManagedStartupOnboardProfile(
        dcodeInput({
          inference: { ...dcodeInput().inference, routedBaseUrl: route },
        }),
      ).profile.inference.routedBaseUrl,
    ).toBe(route);
  });

  it.each([
    ["openclaw", openClawInput],
    ["hermes", hermesInput],
    ["langchain-deepagents-code", dcodeInput],
  ] as const)("keeps credential-bearing proxy aliases out of the %s profile", (agent, input) => {
    const built = buildManagedStartupOnboardProfile(
      input({
        environment: {
          ...EMPTY_ENVIRONMENT,
          HTTP_PROXY: "http://upper:upper-secret@upper.example.test:8080",
          HTTPS_PROXY: "http://upper-tls:upper-secret@upper-tls.example.test:8443",
          NO_PROXY: "upper.internal",
          http_proxy: "http://lower:lower-secret@lower.example.test:8081",
          https_proxy: "http://lower-tls:lower-secret@lower-tls.example.test:8444",
          no_proxy: "lower.internal",
        },
      }),
    );

    expect(built.profile.proxy).toMatchObject({
      hostHttpUrl: null,
      hostHttpsUrl: null,
      hostNoProxy: [],
    });
    expect(built.credentialProxyReplayRequired).toBe(agent !== "langchain-deepagents-code");
    const decoded = decodeManagedStartupProfile(built.encodedProfile);
    const serialized = JSON.stringify(decoded);
    expect(decoded).toEqual(built.profile);
    expect(serialized).not.toContain("upper-secret");
    expect(serialized).not.toContain("lower-secret");
    expect(serialized).not.toContain("upper.internal");
    expect(serialized).not.toContain("lower.internal");
  });

  it("filters stale semantic env while preserving environment-owned tuning and proxy knobs", () => {
    const built = buildManagedStartupOnboardProfile(
      openClawInput({
        toolDisclosure: "direct",
        webSearch: { fetchEnabled: true, provider: "tavily" },
        environment: {
          ...EMPTY_ENVIRONMENT,
          NEMOCLAW_MODEL: "stale-model",
          NEMOCLAW_INFERENCE_API: "anthropic-messages",
          NEMOCLAW_TOOL_DISCLOSURE: "progressive",
          NEMOCLAW_WEB_SEARCH_ENABLED: "0",
          NEMOCLAW_WEB_SEARCH_PROVIDER: "brave",
          CHAT_UI_URL: "https://stale.example.test:19999",
          NEMOCLAW_CONTEXT_WINDOW: "262144",
          NEMOCLAW_MAX_TOKENS: "8192",
          NEMOCLAW_PROXY_HOST: "host.containers.internal",
          NEMOCLAW_PROXY_PORT: "3129",
          HTTP_PROXY: "http://proxy.example.test:8080",
        },
      }),
    );

    expect(built.profile.inference).toMatchObject({
      model: "gpt-5.4",
      api: "openai-responses",
    });
    expect(decodeManagedStartupProfile(built.encodedProfile).inference.model).toBe("gpt-5.4");
    expect(built.profile.tools.disclosure).toBe("direct");
    expect(built.profile.agentConfig).toMatchObject({
      agent: "openclaw",
      webSearch: { enabled: true, provider: "tavily" },
    });
    expect(built.profile.dashboard).toMatchObject({
      url: "http://127.0.0.1:18789",
    });
    expect(built.profile.tuning).toEqual({
      contextWindow: 262_144,
      maxTokens: 8192,
      reasoning: false,
      reasoningEffort: "default",
    });
    expect(built.profile.proxy).toMatchObject({
      managedHost: "host.containers.internal",
      managedPort: 3129,
      hostHttpUrl: "http://proxy.example.test:8080",
    });
  });
});

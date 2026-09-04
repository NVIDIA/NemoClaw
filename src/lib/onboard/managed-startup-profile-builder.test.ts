// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PEM } from "./__test-helpers__/corporate-ca-fixtures";
import { decodeManagedStartupProfile } from "./managed-startup/profile";
import {
  assertManagedStartupProfileBuilderInventoryCoverage,
  buildManagedStartupProfile,
  ManagedStartupProfileBuilderError,
  type ManagedStartupProfileBuilderInput,
  type ValidatedManagedStartupProfileTransport,
} from "./managed-startup/profile-builder";

function messagingPlan(agent: "openclaw" | "hermes") {
  return {
    schemaVersion: 1,
    sandboxName: "portable-agent",
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

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function openClawInput(
  overrides: Partial<ManagedStartupProfileBuilderInput> = {},
): ManagedStartupProfileBuilderInput {
  return {
    agent: "openclaw",
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
    messagingPlan: null,
    dcodeAutoApprovalMode: null,
    observabilityEnabled: null,
    environment: {},
    corporateCa: null,
    ...overrides,
  };
}

function hermesInput(
  overrides: Partial<ManagedStartupProfileBuilderInput> = {},
): ManagedStartupProfileBuilderInput {
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
      mode: "disabled",
      url: "http://127.0.0.1:18789",
      browserUrl: "http://127.0.0.1:18789",
      publicPort: null,
      internalPort: null,
      tuiEnabled: false,
    },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: null,
    observabilityEnabled: null,
    environment: {},
    corporateCa: null,
    ...overrides,
  };
}

function hermesInputWithBrowserUrl(browserUrl: string): ManagedStartupProfileBuilderInput {
  return hermesInput({
    dashboard: {
      agent: "hermes",
      mode: "disabled",
      url: "http://127.0.0.1:18789",
      browserUrl,
      publicPort: null,
      internalPort: null,
      tuiEnabled: false,
    },
  });
}

function dcodeInput(
  overrides: Partial<ManagedStartupProfileBuilderInput> = {},
): ManagedStartupProfileBuilderInput {
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
    dashboard: {
      agent: "langchain-deepagents-code",
      mode: "disabled",
    },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: "disabled",
    observabilityEnabled: false,
    environment: {},
    corporateCa: null,
    ...overrides,
  };
}

function piInput(
  overrides: Partial<ManagedStartupProfileBuilderInput> = {},
): ManagedStartupProfileBuilderInput {
  return {
    agent: "pi",
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
    dashboard: { agent: "pi", mode: "disabled" },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: null,
    observabilityEnabled: null,
    environment: {},
    corporateCa: null,
    ...overrides,
  };
}

describe("buildManagedStartupProfile", () => {
  it("builds Pi model tuning from the environment and leaves the effort scale unset (#7930)", () => {
    const built = buildManagedStartupProfile(
      piInput({
        environment: {
          NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
          NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
          NEMOCLAW_UPSTREAM_PROVIDER: "nvidia",
          NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
          NEMOCLAW_INFERENCE_API: "openai-completions",
          NEMOCLAW_TOOL_DISCLOSURE: "progressive",
          NEMOCLAW_CONTEXT_WINDOW: "262144",
          NEMOCLAW_MAX_TOKENS: "32000",
          NEMOCLAW_REASONING: "true",
          NEMOCLAW_PROXY_HOST: "10.200.0.1",
          NEMOCLAW_PROXY_PORT: "3128",
        },
      }),
    );

    expect(built.profile.tuning).toEqual({
      contextWindow: 262_144,
      maxTokens: 32_000,
      reasoning: true,
      reasoningEffort: null,
    });
    expect(decodeManagedStartupProfile(built.encodedProfile)).toEqual(built.profile);
  });

  it("leaves every Pi model tuning field unset when the environment supplies none (#7930)", () => {
    expect(buildManagedStartupProfile(piInput()).profile.tuning).toEqual({
      contextWindow: null,
      maxTokens: null,
      reasoning: null,
      reasoningEffort: null,
    });
  });

  it("refuses a Pi reasoning flag that is neither true nor false (#7930)", () => {
    expect(() =>
      buildManagedStartupProfile(piInput({ environment: { NEMOCLAW_REASONING: "yes" } })),
    ).toThrow(/NEMOCLAW_REASONING must be "true" or "false"/);
  });

  it("parses and hydrates messaging before exposing the validated transport handoff", () => {
    const compactPlan = {
      schemaVersion: 1,
      sandboxName: "portable-agent",
      agent: "openclaw",
      workflow: "onboard",
      channels: [],
      disabledChannels: [],
    } as const;

    const built = buildManagedStartupProfile(
      openClawInput({
        messagingPlan: compactPlan,
      }),
    );
    const acceptsOnlyValidatedTransport = (
      transport: ValidatedManagedStartupProfileTransport,
    ): string => transport;

    expect(acceptsOnlyValidatedTransport(built.encodedProfile)).toBe(built.encodedProfile);
    expect(built.profile.messaging.plan).toMatchObject({
      schemaVersion: 1,
      agent: "openclaw",
      credentialBindings: [],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [],
      buildSteps: [],
      runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] },
      stateUpdates: [],
      healthChecks: [],
    });
  });

  it("omits a derived package pin from the managed startup profile (#9399)", () => {
    const built = buildManagedStartupProfile(
      openClawInput({
        messagingPlan: {
          ...messagingPlan("openclaw"),
          channels: [
            {
              channelId: "discord",
              displayName: "Discord",
              authMode: "token-paste",
              active: true,
              selected: true,
              configured: true,
              disabled: false,
              inputs: [],
              hooks: [],
            },
          ],
          buildSteps: [
            {
              channelId: "discord",
              kind: "package-install",
              outputId: "openclawPluginPackage",
              required: true,
              value: {
                manager: "openclaw-plugin",
                spec: "npm:@openclaw/discord@2026.7.1",
                pin: true,
              },
            },
          ],
        },
      }),
    );

    const plan = built.profile.messaging.plan as {
      buildSteps: Array<{ value?: Record<string, unknown> }>;
    };
    expect(plan.buildSteps[0]?.value).toEqual({
      manager: "openclaw-plugin",
      spec: "npm:@openclaw/discord@2026.7.1",
    });
    expect(JSON.stringify(decodeManagedStartupProfile(built.encodedProfile))).not.toContain(
      '"pin"',
    );
  });

  it("does not project a malformed package pin past profile validation (#9399)", () => {
    expect(() =>
      buildManagedStartupProfile(
        openClawInput({
          messagingPlan: {
            ...messagingPlan("openclaw"),
            channels: [
              {
                channelId: "discord",
                displayName: "Discord",
                authMode: "token-paste",
                active: true,
                selected: true,
                configured: true,
                disabled: false,
                inputs: [],
                hooks: [],
              },
            ],
            buildSteps: [
              {
                channelId: "discord",
                kind: "package-install",
                outputId: "openclawPluginPackage",
                required: true,
                value: {
                  manager: "openclaw-plugin",
                  spec: "npm:@openclaw/discord@2026.7.1",
                  pin: "true",
                },
              },
            ],
          },
        }),
      ),
    ).toThrow(/buildSteps\[0\]\.value\.pin has a credential-shaped field name/u);
  });

  it.each([
    ["wrong-agent discriminator", { ...messagingPlan("hermes"), sandboxName: "portable-agent" }],
    [
      "malformed nested channel",
      {
        ...messagingPlan("openclaw"),
        channels: [{ channelId: "discord", inputs: { invalid: true } }],
      },
    ],
  ])("rejects %s before encoding a profile transport", (_name, plan) => {
    expect(() => buildManagedStartupProfile(openClawInput({ messagingPlan: plan }))).toThrow(
      /valid openclaw SandboxMessagingPlan/,
    );
  });

  it("builds OpenClaw with every stock behavior knob and canonical transport", () => {
    const plan = messagingPlan("openclaw");
    const extraAgents = {
      agents: [{ id: "reviewer", workspace: "/sandbox/reviewer" }],
      defaults: { subagents: { maxSpawnDepth: 2 } },
      main: { tools: { profile: "coding" } },
    };
    const input = openClawInput({
      dashboard: {
        agent: "openclaw",
        mode: "remote",
        url: "https://dashboard.example.test:19443",
        port: 19_443,
        bindAddress: "0.0.0.0",
        wslExposure: true,
      },
      webSearch: { fetchEnabled: true, provider: "tavily" },
      toolDisclosure: "direct",
      messagingPlan: plan,
      environment: {
        NEMOCLAW_MODEL: "gpt-5.4",
        NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
        NEMOCLAW_UPSTREAM_PROVIDER: "openai-api",
        NEMOCLAW_PRIMARY_MODEL_REF: "openai/gpt-5.4",
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_INFERENCE_API: "openai-responses",
        NEMOCLAW_INFERENCE_COMPAT_B64: encodeJson({}),
        NEMOCLAW_INFERENCE_INPUTS: "text,image",
        NEMOCLAW_CONTEXT_WINDOW: "262144",
        NEMOCLAW_MAX_TOKENS: "8192",
        NEMOCLAW_REASONING: "true",
        NEMOCLAW_REASONING_EFFORT: " HIGH ",
        NEMOCLAW_TOOL_DISCLOSURE: "direct",
        NEMOCLAW_AGENT_TIMEOUT: "900",
        NEMOCLAW_AGENT_HEARTBEAT_EVERY: "30m",
        NEMOCLAW_EXTRA_AGENTS_JSON: JSON.stringify(extraAgents),
        NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
        NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE: "managed-onboard",
        NEMOCLAW_WEB_SEARCH_ENABLED: "1",
        NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
        NEMOCLAW_OPENCLAW_OTEL: "yes",
        NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "https://otel.example.test:4318",
        NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME: "nemoclaw-openclaw",
        NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE: "0.25",
        CHAT_UI_URL: "https://dashboard.example.test:19443",
        NEMOCLAW_DASHBOARD_BIND: "0.0.0.0",
        NEMOCLAW_WSL_DASHBOARD_EXPOSURE: "1",
        NEMOCLAW_DASHBOARD_PORT: "19443",
        NEMOCLAW_PROXY_HOST: "host.containers.internal",
        NEMOCLAW_PROXY_PORT: "3129",
        NEMOCLAW_MESSAGING_PLAN_B64: encodeJson(plan),
        NEMOCLAW_MINIMAL_BOOTSTRAP: "1",
        HTTP_PROXY: "http://proxy.example.test:8080",
        http_proxy: "http://proxy.example.test:8080",
        HTTPS_PROXY: "https://connect.example.test:8443",
        https_proxy: "https://connect.example.test:8443",
        NO_PROXY: "metadata.example.test",
        no_proxy: "metadata.example.test",
      },
    });

    const built = buildManagedStartupProfile(input);

    expect(built.profile.agent).toBe("openclaw");
    expect(built.profile.inference).toMatchObject({
      routeProvider: "openai",
      upstreamProvider: "openai-api",
      model: "gpt-5.4",
      api: "openai-responses",
      primaryModelRef: "openai/gpt-5.4",
      compatibility: {},
      inputModalities: ["image", "text"],
    });
    expect(built.profile.agentConfig).toMatchObject({
      agent: "openclaw",
      webSearch: { enabled: true, provider: "tavily" },
      otel: {
        enabled: true,
        endpointUrl: "https://otel.example.test:4318",
        serviceName: "nemoclaw-openclaw",
        sampleRate: 0.25,
      },
      agentTimeoutSeconds: 900,
      heartbeatEvery: "30m",
      extraAgents,
      deviceAuth: { disabled: true, optOutSource: "managed-onboard" },
      minimalBootstrap: true,
    });
    expect(built.profile.proxy).toMatchObject({
      managedHost: "host.containers.internal",
      managedPort: 3129,
      hostHttpUrl: "http://proxy.example.test:8080",
      hostHttpsUrl: "https://connect.example.test:8443",
    });
    expect(built.profile.proxy.hostNoProxy).toEqual(
      expect.arrayContaining([
        "metadata.example.test",
        "localhost",
        "host.docker.internal",
        "host.containers.internal",
        "inference.local",
      ]),
    );
    expect(built.profile.messaging.plan).not.toBeNull();
    expect(built.profile.tuning).toEqual({
      contextWindow: 262_144,
      maxTokens: 8192,
      reasoning: true,
      reasoningEffort: "high",
    });
    expect(built.corporateCaB64).toBeUndefined();
    expect(decodeManagedStartupProfile(built.encodedProfile)).toEqual(built.profile);
    expect(built.startupProfileSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("builds Hermes with Tavily, gateway presets, messaging, context, and forwarding", () => {
    const plan = messagingPlan("hermes");
    const gateways = ["nous-web", "nous-image"] as const;
    const built = buildManagedStartupProfile(
      hermesInput({
        dashboard: {
          agent: "hermes",
          mode: "loopback-forwarded",
          url: "http://127.0.0.1:19189",
          browserUrl: "https://hermes.example.test:19189",
          publicPort: 19_189,
          internalPort: 29_189,
          tuiEnabled: true,
        },
        webSearch: { fetchEnabled: true, provider: "tavily" },
        toolDisclosure: "direct",
        hermesToolGateways: gateways,
        messagingPlan: plan,
        environment: {
          NEMOCLAW_MODEL: "claude-sonnet-4-6",
          NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
          NEMOCLAW_UPSTREAM_PROVIDER: "compatible-anthropic-endpoint",
          NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
          NEMOCLAW_INFERENCE_API: "openai-completions",
          NEMOCLAW_CONTEXT_WINDOW: "65536",
          NEMOCLAW_TOOL_DISCLOSURE: "direct",
          NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER: "1",
          NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64: encodeJson(gateways),
          NEMOCLAW_WEB_SEARCH_ENABLED: "1",
          NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
          NEMOCLAW_MESSAGING_PLAN_B64: encodeJson(plan),
          CHAT_UI_URL: "https://hermes.example.test:19189",
          NEMOCLAW_DASHBOARD_PORT: "19189",
          NEMOCLAW_HERMES_DASHBOARD: "true",
          NEMOCLAW_HERMES_DASHBOARD_PORT: "19189",
          NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: "29189",
          NEMOCLAW_HERMES_DASHBOARD_TUI: "yes",
          NEMOCLAW_PROXY_HOST: "10.200.0.1",
          NEMOCLAW_PROXY_PORT: "3128",
          HTTP_PROXY: "http://proxy.example.test:8080",
          NO_PROXY: "internal.example.test",
        },
      }),
    );

    expect(built.profile.agentConfig).toEqual({
      agent: "hermes",
      webSearch: { enabled: true, provider: "tavily" },
    });
    expect(built.profile.inference).toMatchObject({
      routeProvider: "inference",
      upstreamProvider: "compatible-anthropic-endpoint",
      api: "openai-completions",
      primaryModelRef: null,
      compatibility: null,
      inputModalities: null,
    });
    expect(built.profile.dashboard).toEqual({
      agent: "hermes",
      mode: "loopback-forwarded",
      url: "http://127.0.0.1:19189",
      browserUrl: "https://hermes.example.test:19189",
      publicPort: 19_189,
      internalPort: 29_189,
      tuiEnabled: true,
    });
    expect(built.profile.tools).toEqual({
      disclosure: "direct",
      enabledGateways: ["nous-image", "nous-web"],
    });
    expect(built.profile.tuning).toEqual({
      contextWindow: 65_536,
      maxTokens: null,
      reasoning: null,
      reasoningEffort: null,
    });
    expect(decodeManagedStartupProfile(built.encodedProfile)).toEqual(built.profile);
  });

  it("rejects an external HTTP Hermes browser URL before persisting the profile", () => {
    expect(() =>
      buildManagedStartupProfile(hermesInputWithBrowserUrl("http://hermes.example.test:18789")),
    ).toThrow(/must use HTTPS unless it is loopback/);
  });

  it.each([
    ["https://hermes.example.test:18789", "https://hermes.example.test:18789"],
    ["https://secure-link.example/", "https://secure-link.example"],
    ["http://127.0.0.1:18789", "http://127.0.0.1:18789"],
    ["http://127.0.0.2:18789", "http://127.0.0.2:18789"],
  ])(
    "accepts the Hermes browser URL %s at the durable profile boundary",
    (browserUrl, expectedBrowserUrl) => {
      expect(
        buildManagedStartupProfile(hermesInputWithBrowserUrl(browserUrl)).profile.dashboard,
      ).toMatchObject({ agent: "hermes", browserUrl: expectedBrowserUrl });
    },
  );

  it("builds DCode with its direct upstream, approval, and observability contract", () => {
    const built = buildManagedStartupProfile(
      dcodeInput({
        dcodeAutoApprovalMode: "thread-opt-in",
        observabilityEnabled: true,
        toolDisclosure: "direct",
        environment: {
          NEMOCLAW_MODEL: "openai/gpt-5.4",
          NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
          NEMOCLAW_UPSTREAM_PROVIDER: "openrouter",
          NEMOCLAW_UPSTREAM_ENDPOINT_URL: "https://openrouter.ai/api/v1",
          NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
          NEMOCLAW_INFERENCE_API: "openai-completions",
          NEMOCLAW_TOOL_DISCLOSURE: "direct",
          NEMOCLAW_DCODE_AUTO_APPROVAL: "thread-opt-in",
          NEMOCLAW_PROXY_HOST: "10.200.0.1",
          NEMOCLAW_PROXY_PORT: "3128",
          NEMOCLAW_OBSERVABILITY: "1",
          NEMOCLAW_REASONING_EFFORT: "high",
        },
      }),
    );

    expect(built.profile).toMatchObject({
      agent: "langchain-deepagents-code",
      agentConfig: {
        agent: "langchain-deepagents-code",
        autoApprovalMode: "thread-opt-in",
        observabilityEnabled: true,
      },
      inference: {
        routeProvider: "inference",
        upstreamProvider: "openrouter",
        upstreamEndpointUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        primaryModelRef: null,
        compatibility: null,
        inputModalities: null,
      },
      proxy: {
        managedHost: "10.200.0.1",
        managedPort: 3128,
        hostHttpUrl: null,
        hostHttpsUrl: null,
        hostNoProxy: [],
      },
      dashboard: {
        agent: "langchain-deepagents-code",
        mode: "disabled",
      },
      messaging: { plan: null },
      tuning: {
        contextWindow: null,
        maxTokens: null,
        reasoning: null,
        reasoningEffort: "high",
      },
    });
    expect(decodeManagedStartupProfile(built.encodedProfile)).toEqual(built.profile);
  });

  it("keeps validated corporate CA bytes out of the profile and returns a digest-bound transport", () => {
    const built = buildManagedStartupProfile(
      openClawInput({
        corporateCa: {
          pem: PEM,
          sourcePath: "/public/corporate-ca.pem",
          sourceEnv: "NEMOCLAW_CORPORATE_CA_BUNDLE",
        },
      }),
    );

    const normalizedPem = `${PEM.trimEnd()}\n`;
    expect(built.corporateCaB64).toBe(Buffer.from(normalizedPem, "utf8").toString("base64"));
    expect(built.profile.corporateCa.bundleSha256).toBe(
      createHash("sha256").update(normalizedPem, "utf8").digest("hex"),
    );
    const decodedProfile = Buffer.from(built.encodedProfile, "base64url").toString("utf8");
    expect(decodedProfile).not.toContain("BEGIN CERTIFICATE");
    expect(decodedProfile).not.toContain("/public/corporate-ca.pem");
  });

  it("uses managed OpenClaw defaults without relying on Dockerfile defaults", () => {
    const built = buildManagedStartupProfile(openClawInput());

    expect(built.profile.agentConfig).toMatchObject({
      agent: "openclaw",
      webSearch: { enabled: false, provider: "brave" },
      otel: {
        enabled: false,
        endpointUrl: "http://host.openshell.internal:4318",
        serviceName: "openclaw-gateway",
        sampleRate: 1,
      },
      agentTimeoutSeconds: 600,
      heartbeatEvery: null,
      extraAgents: {
        agents: [],
        defaults: { subagents: {} },
        main: {},
      },
      deviceAuth: { disabled: true, optOutSource: "managed-onboard" },
      minimalBootstrap: false,
    });
    expect(built.profile.tuning).toEqual({
      contextWindow: 131_072,
      maxTokens: 4096,
      reasoning: false,
      reasoningEffort: "default",
    });
  });

  it("retains Hermes Tavily selection while web search is disabled", () => {
    const built = buildManagedStartupProfile(hermesInput());
    expect(built.profile.agentConfig).toEqual({
      agent: "hermes",
      webSearch: { enabled: false, provider: "tavily" },
    });
  });

  it.each([
    ["DCode messaging", dcodeInput({ messagingPlan: messagingPlan("openclaw") }), /messagingPlan/],
    [
      "DCode web search",
      dcodeInput({ webSearch: { fetchEnabled: false, provider: "brave" } }),
      /web-search/,
    ],
    [
      "OpenClaw Hermes gateways",
      openClawInput({ hermesToolGateways: ["nous-web"] }),
      /another agent/,
    ],
    [
      "Hermes Brave",
      hermesInput({ webSearch: { fetchEnabled: true, provider: "brave" } }),
      /only the Tavily/,
    ],
    [
      "Hermes OpenClaw OTEL knob",
      hermesInput({ environment: { NEMOCLAW_OPENCLAW_OTEL: "1" } }),
      /not supported by hermes/,
    ],
    [
      "Hermes inference compatibility",
      hermesInput({
        inference: { ...hermesInput().inference, compatibility: { strict: true } },
      }),
      /does not support inference compatibility/,
    ],
    [
      "DCode inference compatibility",
      dcodeInput({
        inference: { ...dcodeInput().inference, compatibility: { strict: true } },
      }),
      /does not support inference compatibility/,
    ],
    [
      "Hermes input modalities",
      hermesInput({ environment: { NEMOCLAW_INFERENCE_INPUTS: "text,image" } }),
      /NEMOCLAW_INFERENCE_INPUTS is not supported by hermes/,
    ],
    [
      "DCode input modalities",
      dcodeInput({ environment: { NEMOCLAW_INFERENCE_INPUTS: "text" } }),
      /NEMOCLAW_INFERENCE_INPUTS is not supported by langchain-deepagents-code/,
    ],
  ])("rejects unsupported cross-agent intent: %s", (_label, input, message) => {
    expect(() => buildManagedStartupProfile(input)).toThrow(message);
  });

  it.each([
    [
      "oversized context",
      openClawInput({ environment: { NEMOCLAW_CONTEXT_WINDOW: "9999999999" } }),
      /NEMOCLAW_CONTEXT_WINDOW/,
    ],
    [
      "malformed reasoning",
      openClawInput({ environment: { NEMOCLAW_REASONING: "sometimes" } }),
      /NEMOCLAW_REASONING/,
    ],
    [
      "malformed reasoning effort",
      openClawInput({ environment: { NEMOCLAW_REASONING_EFFORT: "maximum" } }),
      /NEMOCLAW_REASONING_EFFORT/,
    ],
    [
      "conflicting proxy aliases",
      openClawInput({
        environment: {
          HTTP_PROXY: "http://one.example.test:8080",
          http_proxy: "http://two.example.test:8080",
        },
      }),
      /conflicting values/,
    ],
    [
      "bare no-proxy intent",
      openClawInput({ environment: { NO_PROXY: "localhost" } }),
      /requires an HTTP_PROXY or HTTPS_PROXY/,
    ],
    [
      "raw CA transport",
      openClawInput({ environment: { NEMOCLAW_CORPORATE_CA_B64: "ZmFrZQ==" } }),
      /separate corporateCa input/,
    ],
    [
      "conflicting semantic model",
      openClawInput({ environment: { NEMOCLAW_MODEL: "another-model" } }),
      /conflicts with the resolved semantic/,
    ],
  ])("fails closed for malformed or conflicting stock input: %s", (_label, input, message) => {
    expect(() => buildManagedStartupProfile(input)).toThrow(message);
  });

  it.each([
    [
      "credential-bearing proxy URL",
      openClawInput({
        environment: { HTTP_PROXY: "http://operator:password@proxy.example.test:8080" },
      }),
      "proxy.hostHttpUrl",
      "password",
    ],
    [
      "secret-shaped model",
      openClawInput({
        inference: {
          ...openClawInput().inference,
          model: "sk-proj-secret-material-1234567890",
        },
      }),
      "inference.model",
      "sk-proj-secret-material-1234567890",
    ],
    [
      "credential-shaped extra-agent field",
      openClawInput({
        environment: {
          NEMOCLAW_EXTRA_AGENTS_JSON: JSON.stringify({
            agents: [
              {
                id: "reviewer",
                api_key: ["sk", "secret", "material", "1234567890"].join("-"),
              },
            ],
          }),
        },
      }),
      "agentConfig.extraAgents.agents[0].api_key",
      "sk-secret-material-1234567890",
    ],
  ] as const)(
    "rejects %s with a precise non-secret-bearing domain error",
    (_label, input, field, secret) => {
      let thrown: unknown;
      try {
        buildManagedStartupProfile(input);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ManagedStartupProfileBuilderError);
      expect(thrown).toHaveProperty("message", expect.stringContaining(field));
      expect(thrown).toHaveProperty("message", expect.not.stringContaining(secret));
    },
  );

  it.each([
    ["null", "[null]", /NEMOCLAW_EXTRA_AGENTS_JSON\[0\] must be an object/u],
    ["unknown primitive", '["unknown"]', /NEMOCLAW_EXTRA_AGENTS_JSON\[0\] must be an object/u],
    [
      "unsafe prototype field",
      '[{"id":"reviewer","__proto__":{"polluted":true}}]',
      /NEMOCLAW_EXTRA_AGENTS_JSON\[0\] contains an unsafe prototype field/u,
    ],
  ] as const)("rejects a %s top-level extra-agent entry", (_label, value, message) => {
    expect(() =>
      buildManagedStartupProfile(
        openClawInput({
          environment: {
            NEMOCLAW_EXTRA_AGENTS_JSON: value,
          },
        }),
      ),
    ).toThrow(message);
  });

  it("rejects malformed or non-CA certificate material", () => {
    expect(() =>
      buildManagedStartupProfile(
        openClawInput({
          corporateCa: {
            pem: "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n",
            sourcePath: "/public/bad.pem",
            sourceEnv: "test",
          },
        }),
      ),
    ).toThrow(/invalid X.509/);
  });

  it("audits the exact all-agent affordance inventory", () => {
    expect(() => assertManagedStartupProfileBuilderInventoryCoverage()).not.toThrow();
  });
});

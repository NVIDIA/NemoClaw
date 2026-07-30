// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  decodeManagedStartupProfile,
  encodeManagedStartupProfile,
  fingerprintManagedStartupProfile,
  MANAGED_STARTUP_AGENTS,
  MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY,
  MANAGED_STARTUP_PROFILE_CAPABILITIES,
  MANAGED_STARTUP_PROFILE_EXCLUDED_DOCKER_INPUTS,
  MANAGED_STARTUP_PROFILE_MAX_BYTES,
  MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
  type ManagedStartupAgent,
  type ManagedStartupProfile,
  serializeManagedStartupProfile,
  validateManagedStartupProfile,
} from "./managed-startup/profile";

const CA_SHA256 = "a".repeat(64);

const MESSAGING_PLAN = {
  schemaVersion: 1,
  sandboxName: "demo",
  agent: "portable",
  workflow: "onboard",
  channels: [],
  disabledChannels: [],
  credentialBindings: [
    {
      credentialId: "slackBotToken",
      providerEnvKey: "SLACK_BOT_TOKEN",
      placeholder: "openshell:resolve:env:SLACK_BOT_TOKEN",
      credentialAvailable: true,
    },
  ],
  networkPolicy: { presets: [], entries: [] },
  agentRender: [],
  buildSteps: [],
  stateUpdates: [],
  healthChecks: [],
} as const;

const OPENCLAW_PROFILE = {
  schemaVersion: MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
  agent: "openclaw",
  agentConfig: {
    agent: "openclaw",
    webSearch: { enabled: true, provider: "brave" },
    otel: {
      enabled: true,
      endpointUrl: "http://host.openshell.internal:4318",
      serviceName: "openclaw-gateway",
      sampleRate: 0.75,
    },
    agentTimeoutSeconds: 900,
    heartbeatEvery: "30m",
    extraAgents: {
      agents: [
        {
          id: "reviewer",
          workspace: "/sandbox/reviewer",
          model: "inference/nvidia/nemotron-3-ultra-550b-a55b",
        },
      ],
      defaults: { subagents: { maxSpawnDepth: 3 } },
      main: { tools: { profile: "coding" } },
    },
    deviceAuth: { disabled: true, optOutSource: "managed-onboard" },
    minimalBootstrap: true,
  },
  inference: {
    routeProvider: "inference",
    upstreamProvider: "nvidia-prod",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    routedBaseUrl: "https://inference.local/v1",
    upstreamEndpointUrl: null,
    api: "openai-responses",
    primaryModelRef: "inference/nvidia/nemotron-3-ultra-550b-a55b",
    compatibility: { supportsDeveloperRole: true, maxRetries: 2 },
    inputModalities: ["text", "image"],
  },
  proxy: {
    managedHost: "10.200.0.1",
    managedPort: 3128,
    hostHttpUrl: "http://proxy.example.test:8080",
    hostHttpsUrl: "http://connect-proxy.example.test:3128",
    hostNoProxy: ["inference.local", "127.0.0.1", "localhost"],
  },
  dashboard: {
    agent: "openclaw",
    mode: "remote",
    url: "https://dashboard.example.test:18789",
    port: 18_789,
    bindAddress: "0.0.0.0",
    wslExposure: true,
  },
  tools: {
    disclosure: "progressive",
    enabledGateways: [],
  },
  messaging: { plan: MESSAGING_PLAN },
  tuning: {
    contextWindow: 131_072,
    maxTokens: 8192,
    reasoning: true,
    reasoningEffort: "high",
  },
  corporateCa: { bundleSha256: CA_SHA256 },
} as const satisfies ManagedStartupProfile;

const HERMES_PROFILE = {
  schemaVersion: MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
  agent: "hermes",
  agentConfig: {
    agent: "hermes",
    webSearch: { enabled: true, provider: "tavily" },
  },
  inference: {
    routeProvider: "custom",
    upstreamProvider: "anthropic-prod",
    model: "claude-sonnet-4-5",
    routedBaseUrl: "https://inference.local/v1",
    upstreamEndpointUrl: null,
    api: "anthropic-messages",
    primaryModelRef: null,
    compatibility: null,
    inputModalities: null,
  },
  proxy: {
    managedHost: "10.200.0.1",
    managedPort: 3128,
    hostHttpUrl: "http://proxy.example.test:8080",
    hostHttpsUrl: "https://proxy.example.test:8443",
    hostNoProxy: ["localhost", "127.0.0.1"],
  },
  dashboard: {
    agent: "hermes",
    mode: "loopback-forwarded",
    url: "http://127.0.0.1:19189",
    publicPort: 19_189,
    internalPort: 29_189,
    tuiEnabled: true,
  },
  tools: {
    disclosure: "direct",
    enabledGateways: ["nous-web", "nous-image", "nous-audio", "nous-browser", "nous-code"],
  },
  messaging: { plan: MESSAGING_PLAN },
  tuning: {
    contextWindow: 65_536,
    maxTokens: null,
    reasoning: null,
    reasoningEffort: null,
  },
  corporateCa: { bundleSha256: CA_SHA256 },
} as const satisfies ManagedStartupProfile;

const DCODE_PROFILE = {
  schemaVersion: MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
  agent: "langchain-deepagents-code",
  agentConfig: {
    agent: "langchain-deepagents-code",
    autoApprovalMode: "thread-opt-in",
    observabilityEnabled: true,
  },
  inference: {
    routeProvider: "inference",
    upstreamProvider: "openrouter",
    model: "openai/gpt-5.4",
    routedBaseUrl: "https://inference.local/v1",
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
  tools: {
    disclosure: "progressive",
    enabledGateways: [],
  },
  messaging: { plan: null },
  tuning: {
    contextWindow: null,
    maxTokens: null,
    reasoning: null,
    reasoningEffort: null,
  },
  corporateCa: { bundleSha256: CA_SHA256 },
} as const satisfies ManagedStartupProfile;

const VALID_PROFILES = [OPENCLAW_PROFILE, HERMES_PROFILE, DCODE_PROFILE] as const;

function encodeUnknown(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function dockerArgs(relativePath: string): Set<string> {
  const source = readFileSync(relativePath, "utf8");
  return new Set(
    [...source.matchAll(/^ARG\s+([A-Z][A-Z0-9_]*)/gmu)].map((match) => match[1] as string),
  );
}

describe("managed startup profile", () => {
  it.each(
    VALID_PROFILES,
  )("round-trips every $agent affordance without secret material", (profile) => {
    const validated = validateManagedStartupProfile(profile);
    const encoded = encodeManagedStartupProfile(profile);

    expect(decodeManagedStartupProfile(encoded)).toEqual(validated);
    expect(encoded).not.toContain(profile.inference.model);
    expect(fingerprintManagedStartupProfile(profile)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("round-trips every OpenClaw-only startup knob", () => {
    const profile = decodeManagedStartupProfile(encodeManagedStartupProfile(OPENCLAW_PROFILE));
    expect(profile).toMatchObject({
      agentConfig: {
        webSearch: { enabled: true, provider: "brave" },
        otel: {
          enabled: true,
          endpointUrl: "http://host.openshell.internal:4318",
          serviceName: "openclaw-gateway",
          sampleRate: 0.75,
        },
        agentTimeoutSeconds: 900,
        heartbeatEvery: "30m",
        minimalBootstrap: true,
        deviceAuth: { disabled: true, optOutSource: "managed-onboard" },
      },
      inference: {
        api: "openai-responses",
        primaryModelRef: "inference/nvidia/nemotron-3-ultra-550b-a55b",
        compatibility: { supportsDeveloperRole: true, maxRetries: 2 },
        inputModalities: ["image", "text"],
      },
      dashboard: {
        mode: "remote",
        bindAddress: "0.0.0.0",
        wslExposure: true,
      },
      tuning: {
        contextWindow: 131_072,
        maxTokens: 8192,
        reasoning: true,
        reasoningEffort: "high",
      },
    });
    expect(profile.agentConfig.agent === "openclaw" && profile.agentConfig.extraAgents).toEqual(
      OPENCLAW_PROFILE.agentConfig.extraAgents,
    );
  });

  it("round-trips Hermes forwarding, reviewed gateways, messaging, and context tuning", () => {
    const profile = decodeManagedStartupProfile(encodeManagedStartupProfile(HERMES_PROFILE));
    expect(profile).toMatchObject({
      dashboard: {
        mode: "loopback-forwarded",
        publicPort: 19_189,
        internalPort: 29_189,
        tuiEnabled: true,
      },
      agentConfig: { webSearch: { enabled: true, provider: "tavily" } },
      tuning: {
        contextWindow: 65_536,
        maxTokens: null,
        reasoning: null,
        reasoningEffort: null,
      },
    });
    expect(profile.tools.enabledGateways).toEqual([
      "nous-audio",
      "nous-browser",
      "nous-code",
      "nous-image",
      "nous-web",
    ]);
    expect(profile.messaging.plan).not.toBeNull();
  });

  it("round-trips DCode upstream metadata, trusted proxy, approval, and observability", () => {
    const profile = decodeManagedStartupProfile(encodeManagedStartupProfile(DCODE_PROFILE));
    expect(profile).toMatchObject({
      inference: {
        routeProvider: "inference",
        upstreamProvider: "openrouter",
        upstreamEndpointUrl: "https://openrouter.ai/api/v1",
        routedBaseUrl: "https://inference.local/v1",
        api: "openai-completions",
      },
      proxy: {
        managedHost: "10.200.0.1",
        managedPort: 3128,
        hostHttpUrl: null,
        hostHttpsUrl: null,
        hostNoProxy: [],
      },
      agentConfig: {
        autoApprovalMode: "thread-opt-in",
        observabilityEnabled: true,
      },
      dashboard: { mode: "disabled" },
    });
  });

  it("canonicalizes object keys and set-like lists before fingerprinting", () => {
    const reordered = {
      ...HERMES_PROFILE,
      proxy: {
        ...HERMES_PROFILE.proxy,
        hostNoProxy: [...HERMES_PROFILE.proxy.hostNoProxy].reverse(),
      },
      tools: {
        ...HERMES_PROFILE.tools,
        enabledGateways: [...HERMES_PROFILE.tools.enabledGateways].reverse(),
      },
    };
    const serialized = serializeManagedStartupProfile(HERMES_PROFILE);

    expect(serializeManagedStartupProfile(reordered)).toBe(serialized);
    expect(fingerprintManagedStartupProfile(reordered)).toBe(
      createHash("sha256").update(serialized, "utf8").digest("hex"),
    );
  });

  it("exports complete, fail-closed capabilities for every supported agent", () => {
    expect(Object.keys(MANAGED_STARTUP_PROFILE_CAPABILITIES).sort()).toEqual(
      [...MANAGED_STARTUP_AGENTS].sort(),
    );
    expect(MANAGED_STARTUP_PROFILE_CAPABILITIES.openclaw.dashboardModes).toEqual([
      "loopback",
      "remote",
    ]);
    expect(MANAGED_STARTUP_PROFILE_CAPABILITIES.hermes.dashboardModes).toEqual([
      "disabled",
      "loopback-forwarded",
    ]);
    expect(MANAGED_STARTUP_PROFILE_CAPABILITIES.hermes.inputModalities).toEqual([]);
    expect(MANAGED_STARTUP_PROFILE_CAPABILITIES["langchain-deepagents-code"].inferenceApis).toEqual(
      ["openai-completions"],
    );
    expect(
      MANAGED_STARTUP_PROFILE_CAPABILITIES["langchain-deepagents-code"].inputModalities,
    ).toEqual([]);
  });

  it.each([
    ["openclaw", "Dockerfile"],
    ["hermes", "agents/hermes/Dockerfile"],
    ["langchain-deepagents-code", "agents/langchain-deepagents-code/Dockerfile"],
  ] as const)("classifies every stock %s Docker ARG as startup-affordance or deliberate exclusion", (agent, dockerfile) => {
    const classified = new Set([
      ...MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY[agent].map(({ input }) => input),
      ...MANAGED_STARTUP_PROFILE_EXCLUDED_DOCKER_INPUTS[agent].map(({ input }) => input),
    ]);
    expect([...dockerArgs(dockerfile)].filter((input) => !classified.has(input))).toEqual([]);
  });

  it.each(MANAGED_STARTUP_AGENTS)("keeps the %s affordance inventory unambiguous", (agent) => {
    const inventory = MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY[agent];
    const uniqueMappings = new Set(
      inventory.map(({ input, profilePath, source }) => `${source}:${input}:${profilePath}`),
    );
    expect(uniqueMappings.size).toBe(inventory.length);
    expect(inventory.every(({ profilePath }) => !profilePath.startsWith("env."))).toBe(true);
  });

  it.each(
    VALID_PROFILES,
  )("maps every $agent inventory entry to an explicit profile field", (profile) => {
    for (const { profilePath } of MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY[profile.agent]) {
      let current: unknown = profile;
      for (const segment of profilePath.split(".")) {
        expect(current).not.toBeNull();
        expect(typeof current).toBe("object");
        expect(Object.hasOwn(current as object, segment)).toBe(true);
        current = (current as Record<string, unknown>)[segment];
      }
    }
  });

  it("rejects non-canonical transports instead of accepting ambiguous fingerprints", () => {
    const raw = JSON.stringify(OPENCLAW_PROFILE);
    expect(() => decodeManagedStartupProfile(Buffer.from(raw).toString("base64url"))).toThrow(
      /canonical form/,
    );
  });

  it.each([
    {
      label: "top level",
      mutate: (profile: ManagedStartupProfile) => ({ ...profile, extension: true }),
    },
    {
      label: "inference",
      mutate: (profile: ManagedStartupProfile) => ({
        ...profile,
        inference: { ...profile.inference, extension: true },
      }),
    },
    {
      label: "proxy",
      mutate: (profile: ManagedStartupProfile) => ({
        ...profile,
        proxy: { ...profile.proxy, extension: true },
      }),
    },
    {
      label: "dashboard",
      mutate: (profile: ManagedStartupProfile) => ({
        ...profile,
        dashboard: { ...profile.dashboard, extension: true },
      }),
    },
    {
      label: "messaging wrapper",
      mutate: (profile: ManagedStartupProfile) => ({
        ...profile,
        messaging: { ...profile.messaging, extension: true },
      }),
    },
    {
      label: "agent config",
      mutate: (profile: ManagedStartupProfile) => ({
        ...profile,
        agentConfig: { ...profile.agentConfig, extension: true },
      }),
    },
    {
      label: "CA digest",
      mutate: (profile: ManagedStartupProfile) => ({
        ...profile,
        corporateCa: { ...profile.corporateCa, extension: true },
      }),
    },
  ])("rejects recursively unknown keys at $label", ({ mutate }) => {
    expect(() => validateManagedStartupProfile(mutate(OPENCLAW_PROFILE))).toThrow(
      /unsupported fields/,
    );
  });

  it.each([
    ["agentConfig", { ...OPENCLAW_PROFILE, agentConfig: HERMES_PROFILE.agentConfig }],
    ["dashboard", { ...OPENCLAW_PROFILE, dashboard: HERMES_PROFILE.dashboard }],
  ])("rejects a mismatched %s agent discriminator", (_label, profile) => {
    expect(() => validateManagedStartupProfile(profile)).toThrow(/must match agent/);
  });

  it.each([
    ["credential-named compatibility field", { accessToken: "not-even-a-real-token" }],
    [
      "credential-named field hidden under a non-messaging plan",
      { plan: { accessToken: "not-even-a-real-token" } },
    ],
    ["provider token", { note: `nvapi-${"a".repeat(32)}` }],
    ["bearer value", { note: `Bearer ${"a".repeat(32)}` }],
    [
      "private key",
      {
        note: `-----BEGIN ${"PRIVATE"} KEY-----\nabc\n-----END ${"PRIVATE"} KEY-----`,
      },
    ],
  ])("rejects %s anywhere in the profile", (_label, compatibility) => {
    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        inference: { ...OPENCLAW_PROFILE.inference, compatibility },
      }),
    ).toThrow(/credential-shaped/);
  });

  it("rejects raw credentials nested inside an otherwise opaque messaging plan", () => {
    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        messaging: {
          plan: {
            ...OPENCLAW_PROFILE.messaging.plan,
            credentialBindings: [
              {
                providerEnvKey: "SLACK_BOT_TOKEN",
                value: `xoxb-${"a".repeat(32)}`,
              },
            ],
          },
        },
      }),
    ).toThrow(/credential-shaped string data/);
  });

  it.each([
    ["routed inference", "inference", "routedBaseUrl"],
    ["upstream inference", "inference", "upstreamEndpointUrl"],
    ["OTEL", "otel", "endpointUrl"],
    ["dashboard", "dashboard", "url"],
  ] as const)("rejects credentials embedded in the %s URL", (_label, scope, field) => {
    const profile =
      scope === "inference"
        ? {
            ...DCODE_PROFILE,
            inference: {
              ...DCODE_PROFILE.inference,
              [field]: "https://user:password@example.test/v1",
            },
          }
        : scope === "otel"
          ? {
              ...OPENCLAW_PROFILE,
              agentConfig: {
                ...OPENCLAW_PROFILE.agentConfig,
                otel: {
                  ...OPENCLAW_PROFILE.agentConfig.otel,
                  [field]: "https://user:password@example.test/v1",
                },
              },
            }
          : {
              ...OPENCLAW_PROFILE,
              dashboard: {
                ...OPENCLAW_PROFILE.dashboard,
                [field]: "https://user:password@example.test/v1",
              },
            };
    expect(() => validateManagedStartupProfile(profile)).toThrow(
      /embedded credentials|credential-free/,
    );
  });

  it("accepts an HTTP CONNECT origin for host HTTPS proxy intent", () => {
    expect(validateManagedStartupProfile(OPENCLAW_PROFILE).proxy.hostHttpsUrl).toBe(
      "http://connect-proxy.example.test:3128",
    );
  });

  it("keeps DCode messaging, dashboards, and tuning fail-closed while retaining host proxy intent", () => {
    expect(() =>
      validateManagedStartupProfile({
        ...DCODE_PROFILE,
        messaging: { plan: { schemaVersion: 1 } },
      }),
    ).toThrow(/messaging\.plan must be null/);
    expect(
      validateManagedStartupProfile({
        ...DCODE_PROFILE,
        proxy: { ...DCODE_PROFILE.proxy, hostHttpUrl: "http://proxy.example.test:8080" },
      }).proxy.hostHttpUrl,
    ).toBe("http://proxy.example.test:8080");
    expect(() =>
      validateManagedStartupProfile({
        ...DCODE_PROFILE,
        tuning: { ...DCODE_PROFILE.tuning, contextWindow: 65_536 },
      }),
    ).toThrow(/does not support startup tuning/);
    expect(() =>
      validateManagedStartupProfile({
        ...DCODE_PROFILE,
        dashboard: { agent: "langchain-deepagents-code", mode: "remote" },
      }),
    ).toThrow(/dashboard\.mode must be disabled/);
  });

  it("rejects unsupported DCode inference APIs and OpenClaw-only inference fields", () => {
    expect(() =>
      validateManagedStartupProfile({
        ...DCODE_PROFILE,
        inference: { ...DCODE_PROFILE.inference, api: "openai-responses" },
      }),
    ).toThrow(/not supported/);
    expect(() =>
      validateManagedStartupProfile({
        ...HERMES_PROFILE,
        inference: {
          ...HERMES_PROFILE.inference,
          compatibility: { supportsDeveloperRole: true },
        },
      }),
    ).toThrow(/does not support/);
  });

  it("accepts only reviewed Hermes gateway IDs and rejects gateways for other agents", () => {
    expect(validateManagedStartupProfile(HERMES_PROFILE).tools.enabledGateways).toHaveLength(5);
    expect(() =>
      validateManagedStartupProfile({
        ...HERMES_PROFILE,
        tools: { ...HERMES_PROFILE.tools, enabledGateways: ["filesystem"] },
      }),
    ).toThrow(/unsupported value/);
    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        tools: { ...OPENCLAW_PROFILE.tools, enabledGateways: ["nous-web"] },
      }),
    ).toThrow(/supported only by hermes/);
  });

  it("enforces adapter-specific web-search providers", () => {
    expect(() =>
      validateManagedStartupProfile({
        ...HERMES_PROFILE,
        agentConfig: {
          ...HERMES_PROFILE.agentConfig,
          webSearch: { enabled: true, provider: "brave" },
        },
      }),
    ).toThrow(/not supported/);
  });

  it("enforces resolved OpenClaw dashboard exposure and device-auth semantics", () => {
    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        dashboard: { ...OPENCLAW_PROFILE.dashboard, mode: "loopback" },
      }),
    ).toThrow(/must reflect/);
    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        agentConfig: {
          ...OPENCLAW_PROFILE.agentConfig,
          deviceAuth: { disabled: false, optOutSource: "operator" },
        },
      }),
    ).toThrow(/requires device auth to be disabled/);
    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        dashboard: { ...OPENCLAW_PROFILE.dashboard, port: 18_790 },
      }),
    ).toThrow(/must match dashboard\.url/);
  });

  it("supports disabled or loopback-forwarded Hermes dashboards only", () => {
    const disabled = validateManagedStartupProfile({
      ...HERMES_PROFILE,
      dashboard: {
        agent: "hermes",
        mode: "disabled",
        url: "http://127.0.0.1:18789",
        publicPort: null,
        internalPort: null,
        tuiEnabled: false,
      },
    });
    expect(disabled.dashboard.mode).toBe("disabled");
    expect(() =>
      validateManagedStartupProfile({
        ...HERMES_PROFILE,
        dashboard: { ...HERMES_PROFILE.dashboard, url: "https://dashboard.example.test" },
      }),
    ).toThrow(/must remain loopback/);
    expect(() =>
      validateManagedStartupProfile({
        ...HERMES_PROFILE,
        dashboard: { ...HERMES_PROFILE.dashboard, publicPort: 8642 },
      }),
    ).toThrow(/reserved API port/);
    expect(() =>
      validateManagedStartupProfile({
        ...HERMES_PROFILE,
        dashboard: { ...HERMES_PROFILE.dashboard, publicPort: 19_190 },
      }),
    ).toThrow(/must match dashboard\.url/);
  });

  it.each([
    "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
    `MII${"A".repeat(300)}`,
  ])("rejects raw CA material while accepting only its digest", (rawCa) => {
    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        inference: { ...OPENCLAW_PROFILE.inference, model: rawCa },
      }),
    ).toThrow(/raw certificate data/);
  });

  it.each([
    ["bad schema", { ...OPENCLAW_PROFILE, schemaVersion: 2 }],
    [
      "bad DCode mode",
      {
        ...DCODE_PROFILE,
        agentConfig: {
          ...DCODE_PROFILE.agentConfig,
          autoApprovalMode: "always",
        },
      },
    ],
    [
      "bad heartbeat",
      {
        ...OPENCLAW_PROFILE,
        agentConfig: { ...OPENCLAW_PROFILE.agentConfig, heartbeatEvery: "every hour" },
      },
    ],
    [
      "invalid CA digest",
      {
        ...OPENCLAW_PROFILE,
        corporateCa: { bundleSha256: "not-a-digest" },
      },
    ],
  ])("rejects malformed profile: %s", (_label, profile) => {
    expect(() => validateManagedStartupProfile(profile)).toThrow(/Invalid managed startup profile/);
  });

  it.each([
    ["empty", ""],
    ["not base64url", "%%%"],
    ["invalid base64url quantum", "a"],
    ["invalid JSON", Buffer.from("{", "utf8").toString("base64url")],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28]).toString("base64url")],
  ])("rejects malformed encoded payload: %s", (_label, encoded) => {
    expect(() => decodeManagedStartupProfile(encoded)).toThrow(/Invalid managed startup profile/);
  });

  it("rejects decoded payloads over the bounded profile size", () => {
    const encoded = Buffer.alloc(MANAGED_STARTUP_PROFILE_MAX_BYTES + 1, 0x61).toString("base64url");
    expect(() => decodeManagedStartupProfile(encoded)).toThrow(/size limit/);
  });

  it("rejects structurally deep payloads within the byte cap", () => {
    const deep = JSON.parse(`${'{"nested":'.repeat(40)}null${"}".repeat(40)}`) as Record<
      string,
      unknown
    >;
    expect(() => validateManagedStartupProfile(deep)).toThrow(/complexity limit/);
  });

  it("rejects a noncanonical payload even when its profile values are otherwise valid", () => {
    const encoded = encodeUnknown({
      ...HERMES_PROFILE,
      tools: {
        ...HERMES_PROFILE.tools,
        enabledGateways: [...HERMES_PROFILE.tools.enabledGateways].reverse(),
      },
    });
    expect(() => decodeManagedStartupProfile(encoded)).toThrow(/canonical form/);
  });
});

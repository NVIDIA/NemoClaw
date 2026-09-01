// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { HERMES_API_PORT_RANGE_END, HERMES_API_PORT_RANGE_START } from "../core/ports";
import { listMessagingCredentialEnvAssignments } from "../messaging/channels/metadata.ts";
import {
  decodeManagedStartupProfile,
  encodeManagedStartupProfile,
  fingerprintManagedStartupProfile,
  MANAGED_STARTUP_AGENTS,
  MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY,
  MANAGED_STARTUP_PROFILE_CAPABILITIES,
  MANAGED_STARTUP_PROFILE_DEFERRED_RUNTIME_INPUTS,
  MANAGED_STARTUP_PROFILE_EXCLUDED_DOCKER_INPUTS,
  MANAGED_STARTUP_PROFILE_MAX_BYTES,
  MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
  MANAGED_STARTUP_RUNTIME_CLEANUP_OBLIGATIONS,
  type ManagedStartupAgent,
  type ManagedStartupProfile,
  serializeManagedStartupProfile,
  validateManagedStartupProfile,
} from "./managed-startup/profile";

const CA_SHA256 = "a".repeat(64);
const HERMES_RESERVED_API_PORTS = [
  8_642, 8_643, 8_644, 8_645, 8_646, 8_647, 8_648, 8_649, 8_650, 8_651, 8_652, 18_642,
];

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
  agentRender: [
    {
      channelId: "discord",
      agent: "openclaw",
      target: "openclaw.json",
      kind: "json-fragment",
      path: "channels.discord",
      value: { token: "openshell:resolve:env:DISCORD_BOT_TOKEN" },
      templateRefs: ["credential.discordBotToken.placeholder"],
    },
    {
      channelId: "slack",
      agent: "openclaw",
      target: "openclaw.json",
      kind: "json-fragment",
      path: "channels.slack",
      value: { token: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN" },
      templateRefs: ["credential.slackBotToken.placeholder"],
    },
  ],
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
  messaging: { plan: { ...MESSAGING_PLAN, agent: "openclaw" } },
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
    browserUrl: "https://hermes.example.test:19189",
    publicPort: 19_189,
    internalPort: 29_189,
    tuiEnabled: true,
  },
  tools: {
    disclosure: "direct",
    enabledGateways: ["nous-web", "nous-image", "nous-audio", "nous-browser", "nous-code"],
  },
  messaging: { plan: { ...MESSAGING_PLAN, agent: "hermes" } },
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

const PI_PROFILE = {
  schemaVersion: MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
  agent: "pi",
  agentConfig: { agent: "pi" },
  inference: {
    routeProvider: "inference",
    upstreamProvider: "nvidia",
    model: "nvidia/nemotron-3-super-120b-a12b",
    routedBaseUrl: "https://inference.local/v1",
    upstreamEndpointUrl: null,
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
    agent: "pi",
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

const VALID_PROFILES = [OPENCLAW_PROFILE, HERMES_PROFILE, DCODE_PROFILE, PI_PROFILE] as const;

function encodeUnknown(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function dockerArgs(relativePath: string): Set<string> {
  const source = readFileSync(relativePath, "utf8");
  return new Set(
    [...source.matchAll(/^ARG\s+([A-Z][A-Z0-9_]*)/gmu)].map((match) => match[1] as string),
  );
}

const STOCK_DOCKER_ARGS = {
  openclaw: dockerArgs(path.join(process.cwd(), "Dockerfile")),
  hermes: dockerArgs(path.join(process.cwd(), "agents/hermes/Dockerfile")),
  "langchain-deepagents-code": dockerArgs(
    path.join(process.cwd(), "agents/langchain-deepagents-code/Dockerfile"),
  ),
  pi: dockerArgs(path.join(process.cwd(), "agents/pi/Dockerfile")),
} satisfies Record<ManagedStartupAgent, Set<string>>;

const RUNTIME_INPUT_SOURCE_FILES = [
  "src/lib/onboard/sandbox-create-launch.ts",
  "src/lib/onboard/openclaw-runtime-env.ts",
  "src/lib/onboard/extra-placeholder-keys.ts",
  "src/lib/onboard/host-proxy-env.ts",
  "src/lib/onboard/hermes-dashboard.ts",
  "src/lib/hermes-dashboard.ts",
] as const;
const QUOTED_RUNTIME_INPUT_RE =
  /["']((?:(?:NEMOCLAW|OPENCLAW)_[A-Z0-9_]+)|CHAT_UI_URL|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)["']/gu;
const STOCK_RUNTIME_INPUTS = new Set(
  RUNTIME_INPUT_SOURCE_FILES.flatMap((relativePath) => [
    ...readFileSync(path.join(process.cwd(), relativePath), "utf8").matchAll(
      QUOTED_RUNTIME_INPUT_RE,
    ),
  ]).map((match) => match[1] as string),
);
const OPENCLAW_AUTO_PAIR_CONSUMER_INPUTS = new Set(
  readFileSync(path.join(process.cwd(), "scripts/nemoclaw-start.sh"), "utf8").match(
    /\bNEMOCLAW_AUTO_PAIR_[A-Z0-9_]+\b/gu,
  ) ?? [],
);
const STOCK_RUNTIME_INPUT_AGENTS = {
  CHAT_UI_URL: ["openclaw", "hermes"],
  HTTPS_PROXY: MANAGED_STARTUP_AGENTS,
  HTTP_PROXY: MANAGED_STARTUP_AGENTS,
  NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: ["openclaw"],
  NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: ["openclaw"],
  NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: ["openclaw"],
  NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: ["openclaw"],
  NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: ["openclaw"],
  NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: ["openclaw"],
  NEMOCLAW_DASHBOARD_BIND: ["openclaw"],
  NEMOCLAW_DASHBOARD_PORT: ["openclaw", "hermes"],
  NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: MANAGED_STARTUP_AGENTS,
  NEMOCLAW_HERMES_DASHBOARD: ["hermes"],
  NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: ["hermes"],
  NEMOCLAW_HERMES_DASHBOARD_PORT: ["hermes"],
  NEMOCLAW_HERMES_DASHBOARD_TUI: ["hermes"],
  NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: ["openclaw"],
  NEMOCLAW_MINIMAL_BOOTSTRAP: ["openclaw"],
  NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS: ["openclaw"],
  NEMOCLAW_OBSERVABILITY: ["langchain-deepagents-code"],
  NEMOCLAW_PROXY_HOST: MANAGED_STARTUP_AGENTS,
  NEMOCLAW_PROXY_PORT: MANAGED_STARTUP_AGENTS,
  NEMOCLAW_SANDBOX_NAME: ["langchain-deepagents-code"],
  NO_PROXY: MANAGED_STARTUP_AGENTS,
  OPENCLAW_HOME: ["openclaw"],
  OPENCLAW_STATE_DIR: ["openclaw"],
  OPENCLAW_WORKSPACE_DIR: ["openclaw"],
  http_proxy: MANAGED_STARTUP_AGENTS,
  https_proxy: MANAGED_STARTUP_AGENTS,
  no_proxy: MANAGED_STARTUP_AGENTS,
} as const satisfies Record<string, readonly ManagedStartupAgent[]>;

describe("managed startup profile", () => {
  it.each(VALID_PROFILES)(
    "round-trips each $agent profile through canonical encoding",
    (profile) => {
      const validated = validateManagedStartupProfile(profile);
      const encoded = encodeManagedStartupProfile(profile);

      const decoded = decodeManagedStartupProfile(encoded);
      expect(decoded).toEqual(validated);
      expect(decoded.inference.model).toBe(profile.inference.model);
      expect(fingerprintManagedStartupProfile(profile)).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it("round-trips all OpenClaw-only startup settings", () => {
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

  it("round-trips Hermes forwarding, declared gateways, messaging, and context tuning", () => {
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

  it("round-trips langchain-deepagents-code upstream metadata, managed proxy, approval, and observability", () => {
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

  it("keeps exported capabilities deeply frozen and validation authority private", () => {
    const capabilities = MANAGED_STARTUP_PROFILE_CAPABILITIES["langchain-deepagents-code"];
    expect(Object.isFrozen(MANAGED_STARTUP_PROFILE_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities.inferenceApis)).toBe(true);
    expect(() =>
      (capabilities.inferenceApis as unknown as string[]).push("openai-responses"),
    ).toThrow(TypeError);
    expect(() =>
      validateManagedStartupProfile({
        ...DCODE_PROFILE,
        inference: { ...DCODE_PROFILE.inference, api: "openai-responses" },
      }),
    ).toThrow(/not supported/);
  });

  it.each(Array.from(MANAGED_STARTUP_RUNTIME_CLEANUP_OBLIGATIONS, (value) => [value]))(
    "records $input cross-agent emissions as cleanup obligations, not supported semantics",
    (obligation) => {
      expect(MANAGED_STARTUP_RUNTIME_CLEANUP_OBLIGATIONS).toHaveLength(2);

      const supportedAgents =
        STOCK_RUNTIME_INPUT_AGENTS[obligation.input as keyof typeof STOCK_RUNTIME_INPUT_AGENTS];
      expect(obligation.owner).toBe("application-environment");
      obligation.emittedFor.forEach((agent) => {
        expect(supportedAgents).not.toContain(agent);
        expect(
          MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY[agent].map(({ input }) => input),
        ).not.toContain(obligation.input);
      });
      expect(obligation.supportedFor.every((agent) =>
          supportedAgents.some((supportedAgent) => supportedAgent === agent))).toBe(true);
    },
  );

  it.each(MANAGED_STARTUP_AGENTS)(
    "keeps deferred %s runtime inputs separate from typed profile intent",
    (agent) => {
      const deferredInputs = MANAGED_STARTUP_PROFILE_DEFERRED_RUNTIME_INPUTS[agent];
      const profileInputs = new Set(
        MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY[agent].map(({ input }) => input),
      );
      expect(deferredInputs.filter(({ input }) => profileInputs.has(input))).toEqual([]);
      expect(new Set(deferredInputs.map(({ input }) => input)).size).toBe(deferredInputs.length);
    },
  );

  it.each(MANAGED_STARTUP_AGENTS)("keeps the %s affordance inventory unambiguous", (agent) => {
    const inventory = MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY[agent];
    expect(new Set(inventory.map(({ input }) => input)).size).toBe(inventory.length);
    expect(inventory.every(({ profilePath }) => !profilePath.startsWith("env."))).toBe(true);
  });

  it("classifies the shared Hermes dashboard port as runtime startup intent", () => {
    expect(MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY.hermes).toContainEqual({
      input: "NEMOCLAW_DASHBOARD_PORT",
      profilePath: "dashboard.publicPort",
      source: "runtime-env",
      representation: "value",
    });
  });

  it.each(VALID_PROFILES)(
    "maps every $agent inventory entry to an explicit profile field",
    (profile) => {
      MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY[profile.agent].forEach(({ profilePath }) => {
        let current: unknown = profile;
      profilePath.split(".").forEach((segment) => {
        expect(current).not.toBeNull();
        expect(typeof current).toBe("object");
        expect(Object.hasOwn(current as object, segment)).toBe(true);
        current = (current as Record<string, unknown>)[segment];
      });
      });
    },
  );

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
    ["schema version", { ...OPENCLAW_PROFILE.messaging.plan, schemaVersion: 2 }],
    ["agent", { ...OPENCLAW_PROFILE.messaging.plan, agent: "hermes" }],
  ])("rejects a messaging plan with a mismatched %s", (_label, plan) => {
    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        messaging: { plan },
      }),
    ).toThrow(/version 1 plan for the selected agent/);
  });

  it.each([
    ["credential-named compatibility field", { accessToken: "not-even-a-real-token" }],
    ["token-shaped compatibility field name", { [`nvapi-${"a".repeat(32)}`]: true }],
    ["credential-prefixed public key field", { secret_public_key: "opaque-secret" }],
    ["provider-prefixed token field", { slackBotToken: "opaque-secret" }],
    ["provider-prefixed API key field", { customApiKey: "opaque-secret" }],
    ["camel-case secret public key field", { secretPublicKey: "opaque-secret" }],
    ["generic provider token field", { githubToken: "opaque-secret" }],
    ["generic provider key field", { openaiKey: "opaque-secret" }],
    ["generic provider secret field", { matrixSecret: "opaque-secret" }],
    ["generic provider PAT field", { githubPat: "opaque-secret" }],
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

  it.each(["publicKey", "public_key", "public-key"])(
    "does not classify exact %s metadata as credential material",
    (field) => {
      expect(
        validateManagedStartupProfile({
          ...OPENCLAW_PROFILE,
          inference: {
            ...OPENCLAW_PROFILE.inference,
            compatibility: { [field]: "non-secret metadata" },
          },
        }).inference.compatibility,
      ).toEqual({ [field]: "non-secret metadata" });
    },
  );

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

  it("rejects credential fields in a messaging plan unless they contain provider placeholders", () => {
    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        messaging: {
          plan: {
            ...OPENCLAW_PROFILE.messaging.plan,
            password: "hunter2",
          },
        },
      }),
    ).toThrow(/credential-shaped field name/);
  });

  it("accepts schema-owned messaging pins, placeholders, and credential environment aliases (#9355)", () => {
    expect(() =>
      validateManagedStartupProfile({
        ...HERMES_PROFILE,
        messaging: {
          plan: {
            ...HERMES_PROFILE.messaging.plan,
            buildSteps: [
              {
                channelId: "slack",
                kind: "package-install",
                outputId: "slack-openclaw-plugin",
                required: true,
                value: {
                  manager: "npm",
                  spec: "@slack/web-api@7.9.3",
                  pin: true,
                },
              },
            ],
            agentRender: [
              {
                channelId: "slack",
                agent: "hermes",
                target: "~/.hermes/.env",
                kind: "env-lines",
                lines: [
                  "SLACK_BOT_TOKEN=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
                  "DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN",
                  "TELEGRAM_BOT_TOKEN=openshell:resolve:env:v1_TELEGRAM_BOT_TOKEN",
                  ...listMessagingCredentialEnvAssignments({ agent: "hermes" })
                    .filter(({ sourceEnvKey, targetEnvKey }) => sourceEnvKey !== targetEnvKey)
                    .map(({ targetEnvKey, placeholder }) => `${targetEnvKey}=${placeholder}`),
                ],
                templateRefs: ["credential.slackBotToken.placeholder"],
              },
            ],
          },
        },
      }),
    ).not.toThrow();
  });

  it.each([
    ...listMessagingCredentialEnvAssignments({ agent: "hermes" })
      .filter(({ sourceEnvKey, targetEnvKey }) => sourceEnvKey !== targetEnvKey)
      .map(({ targetEnvKey, placeholder }) => [
        "a cross-agent credential environment alias",
        `${targetEnvKey}=${placeholder}`,
      ] as const),
    ["a raw credential", `SLACK_BOT_TOKEN=xoxb-${"a".repeat(32)}`],
    ["a malformed assignment", "SLACK_BOT_TOKEN =openshell:resolve:env:SLACK_BOT_TOKEN"],
    ["more than one assignment", "SLACK_BOT_TOKEN=openshell:resolve:env:SLACK_BOT_TOKEN=FORGED"],
    [
      "a placeholder assigned to a non-credential environment key",
      "CHANNEL_NAME=openshell:resolve:env:SLACK_BOT_TOKEN",
    ],
    [
      "a placeholder with a noncanonical provider environment key",
      "SLACK_BOT_TOKEN=openshell:resolve:env:slack_bot_token",
    ],
    [
      "a placeholder assigned to an unapproved credential environment key",
      "AWS_SECRET_ACCESS_KEY=openshell:resolve:env:MSTEAMS_APP_PASSWORD",
    ],
  ] as const)("rejects %s in messaging environment lines (#9355)", (_label, line) => {
    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        messaging: {
          plan: {
            ...OPENCLAW_PROFILE.messaging.plan,
            agentRender: [
              {
                channelId: "slack",
                agent: "openclaw",
                target: "~/.hermes/.env",
                kind: "env-lines",
                lines: [line],
                templateRefs: ["credential.slackBotToken.placeholder"],
              },
            ],
          },
        },
      }),
    ).toThrow(/credential-shaped string data/);
  });

  it.each([
    [
      "a package pin outside buildSteps[*].value",
      {
        ...OPENCLAW_PROFILE.messaging.plan,
        buildSteps: [{ pin: true }],
      },
    ],
    [
      "a non-boolean package pin",
      {
        ...OPENCLAW_PROFILE.messaging.plan,
        buildSteps: [{ value: { pin: "true" } }],
      },
    ],
    [
      "a credential placeholder assignment outside agentRender[*].lines[*]",
      {
        ...OPENCLAW_PROFILE.messaging.plan,
        note: "SLACK_BOT_TOKEN=openshell:resolve:env:SLACK_BOT_TOKEN",
      },
    ],
    [
      "a direct credential placeholder outside schema-owned fields",
      {
        ...OPENCLAW_PROFILE.messaging.plan,
        note: "openshell:resolve:env:SLACK_BOT_TOKEN",
      },
    ],
  ])("rejects %s (#9355)", (_label, plan) => {
    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        messaging: { plan },
      }),
    ).toThrow(/credential-shaped/);
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

  it.each(["token", "api_key"])(
    "rejects credential-shaped query parameter %s in an opaque URL",
    (credentialField) => {
      expect(() =>
        validateManagedStartupProfile({
          ...OPENCLAW_PROFILE,
          inference: {
            ...OPENCLAW_PROFILE.inference,
            compatibility: {
              note: `https://example.test/hook?${credentialField}=opaque-secret`,
            },
          },
        }),
      ).toThrow(/URL with embedded credentials/);
    },
  );

  it.each(["#access_token=opaque-secret", "#token=opaque-secret", "#/route?api_key=opaque-secret"])(
    "rejects credential-shaped parameters in an opaque URL fragment",
    (fragment) => {
      expect(() =>
        validateManagedStartupProfile({
          ...OPENCLAW_PROFILE,
          inference: {
            ...OPENCLAW_PROFILE.inference,
            compatibility: {
              note: `https://example.test/callback${fragment}`,
            },
          },
        }),
      ).toThrow(/URL with embedded credentials/);
    },
  );

  it("accepts an HTTP CONNECT origin for host HTTPS proxy intent", () => {
    expect(validateManagedStartupProfile(OPENCLAW_PROFILE).proxy.hostHttpsUrl).toBe(
      "http://connect-proxy.example.test:3128",
    );
  });

  it("keeps langchain-deepagents-code messaging, dashboards, and tuning fail-closed while retaining host proxy intent", () => {
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

  it("carries the Pi model tuning fields and rejects the effort scale Pi has no surface for (#7930)", () => {
    expect(
      validateManagedStartupProfile({
        ...PI_PROFILE,
        tuning: {
          ...PI_PROFILE.tuning,
          contextWindow: 65_536,
          maxTokens: 8192,
          reasoning: true,
        },
      }).tuning,
    ).toEqual({
      contextWindow: 65_536,
      maxTokens: 8192,
      reasoning: true,
      reasoningEffort: null,
    });
    expect(() =>
      validateManagedStartupProfile({
        ...PI_PROFILE,
        tuning: { ...PI_PROFILE.tuning, reasoningEffort: "high" },
      }),
    ).toThrow(/pi does not support startup tuning fields: reasoningEffort/);
  });

  it("keeps Pi messaging, dashboards, and inference APIs fail-closed while retaining host proxy intent", () => {
    expect(() =>
      validateManagedStartupProfile({
        ...PI_PROFILE,
        messaging: { plan: { schemaVersion: 1 } },
      }),
    ).toThrow(/messaging\.plan must be null/);
    expect(
      validateManagedStartupProfile({
        ...PI_PROFILE,
        proxy: { ...PI_PROFILE.proxy, hostHttpUrl: "http://proxy.example.test:8080" },
      }).proxy.hostHttpUrl,
    ).toBe("http://proxy.example.test:8080");
    expect(() =>
      validateManagedStartupProfile({
        ...PI_PROFILE,
        inference: { ...PI_PROFILE.inference, api: "openai-responses" },
      }),
    ).toThrow(/not supported/);
    expect(() =>
      validateManagedStartupProfile({
        ...PI_PROFILE,
        dashboard: { agent: "pi", mode: "loopback-forwarded" },
      }),
    ).toThrow(/dashboard\.mode must be disabled/);
    expect(() =>
      validateManagedStartupProfile({
        ...PI_PROFILE,
        inference: { ...PI_PROFILE.inference, upstreamEndpointUrl: "https://openrouter.ai/api/v1" },
      }),
    ).toThrow(/inference\.upstreamEndpointUrl must be null for pi/);
  });

  it("rejects unsupported langchain-deepagents-code inference APIs and OpenClaw-only inference fields", () => {
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

  it("rejects an OpenClaw primary model reference that disagrees with its provider and model", () => {
    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        inference: {
          ...OPENCLAW_PROFILE.inference,
          primaryModelRef: "different-provider/different-model",
        },
      }),
    ).toThrow(/primaryModelRef must match routeProvider and model/);
  });

  it("accepts only declared Hermes gateway IDs and rejects gateways for other agents", () => {
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
    ).toThrow(/unsupported value/);
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
        dashboard: { ...HERMES_PROFILE.dashboard, publicPort: 19_190 },
      }),
    ).toThrow(/must match dashboard\.url/);
  });

  it("rejects an explicit Hermes context window below the image contract minimum", () => {
    expect(() =>
      validateManagedStartupProfile({
        ...HERMES_PROFILE,
        tuning: { ...HERMES_PROFILE.tuning, contextWindow: 63_999 },
      }),
    ).toThrow(/contextWindow must be at least 64000 tokens/);
  });

  it.each([
    ["publicPort", 8642],
    ["publicPort", 8652],
    ["publicPort", 18_642],
    ["internalPort", 8642],
    ["internalPort", 8652],
    ["internalPort", 18_642],
  ] as const)("rejects Hermes dashboard %s collisions with reserved API port %i", (field, port) => {
    expect(() =>
      validateManagedStartupProfile({
        ...HERMES_PROFILE,
        dashboard: { ...HERMES_PROFILE.dashboard, [field]: port },
      }),
    ).toThrow(/reserved API ports 8642-8652 or 18642/);
  });

  it.each(HERMES_RESERVED_API_PORTS)("rejects reserved Hermes API port %s", (port) => {
      expect(() =>
        validateManagedStartupProfile({
          ...HERMES_PROFILE,
          dashboard: { ...HERMES_PROFILE.dashboard, publicPort: port },
        }),
      ).toThrow(/reserved API ports/);
  });

  it.each([HERMES_API_PORT_RANGE_START - 1, HERMES_API_PORT_RANGE_END + 1])(
    "accepts dashboard port %s outside the reserved Hermes API port range",
    (port) => {
    expect(() =>
      validateManagedStartupProfile({
        ...HERMES_PROFILE,
        dashboard: {
          ...HERMES_PROFILE.dashboard,
          url: `http://127.0.0.1:${port}`,
          browserUrl: `https://hermes.example.test:${port}`,
          publicPort: port,
        },
      }),
    ).not.toThrow();
    },
  );

  it.each([
    "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
    Buffer.from(
      `-----BEGIN CERTIFICATE-----\n${"A".repeat(300)}\n-----END CERTIFICATE-----`,
      "utf8",
    ).toString("base64"),
    `MII${"A".repeat(300)}`,
    `data:application/x-x509-ca-cert;base64,MII${"A".repeat(300)}`,
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
      "invalid langchain-deepagents-code approval mode",
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

  it("checks direct payload complexity before reading excess properties", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => [`field-${String(index)}`, null]),
    );
    let excessPropertyRead = false;
    Object.defineProperty(wide, "excess", {
      enumerable: true,
      get() {
        excessPropertyRead = true;
        throw new Error("excess property was read");
      },
    });

    expect(() => validateManagedStartupProfile(wide)).toThrow(/complexity limit/);
    expect(excessPropertyRead).toBe(false);
  });

  it("rejects a custom JSON serializer before invoking it", () => {
    const inputModalities = [...OPENCLAW_PROFILE.inference.inputModalities];
    let serializerInvoked = false;
    Object.defineProperty(inputModalities, "toJSON", {
      value() {
        serializerInvoked = true;
        return ["text"];
      },
    });

    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        inference: { ...OPENCLAW_PROFILE.inference, inputModalities },
      }),
    ).toThrow(/custom JSON serializer/);
    expect(serializerInvoked).toBe(false);
  });

  it("rejects an inherited array serializer before invoking it", () => {
    const enabledGateways: string[] = [];
    let serializerInvoked = false;
    const prototype = Object.create(Array.prototype) as Record<string, unknown>;
    Object.defineProperty(prototype, "toJSON", {
      value() {
        serializerInvoked = true;
        return [`nvapi-${"a".repeat(32)}`];
      },
    });
    Object.setPrototypeOf(enabledGateways, prototype);

    expect(() =>
      validateManagedStartupProfile({
        ...DCODE_PROFILE,
        tools: { ...DCODE_PROFILE.tools, enabledGateways },
      }),
    ).toThrow(/standard JSON prototype/);
    expect(serializerInvoked).toBe(false);
  });

  it("rejects an array map override before invoking it", () => {
    const enabledGateways: string[] = [];
    let mapInvoked = false;
    Object.defineProperty(enabledGateways, "map", {
      value() {
        mapInvoked = true;
        return [`nvapi-${"a".repeat(32)}`];
      },
    });

    expect(() =>
      validateManagedStartupProfile({
        ...DCODE_PROFILE,
        tools: { ...DCODE_PROFILE.tools, enabledGateways },
      }),
    ).toThrow(/only indexed JSON values/);
    expect(mapInvoked).toBe(false);
  });

  it("rejects a polluted Object prototype serializer before invoking it", () => {
    let serializerInvoked = false;
    let caught: unknown;
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() {
        serializerInvoked = true;
        return { note: `nvapi-${"a".repeat(32)}` };
      },
    });
    try {
      validateManagedStartupProfile(OPENCLAW_PROFILE);
    } catch (error) {
      caught = error;
    } finally {
      Reflect.deleteProperty(Object.prototype, "toJSON");
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/custom JSON serializer/);
    expect(serializerInvoked).toBe(false);
  });

  it("does not invoke an inherited getter to supply a missing schema field", () => {
    const corporateCa: Record<string, unknown> = {};
    let getterInvoked = false;
    Object.defineProperty(Object.prototype, "bundleSha256", {
      configurable: true,
      get() {
        getterInvoked = true;
        return null;
      },
    });

    let caught: unknown;
    try {
      validateManagedStartupProfile({ ...DCODE_PROFILE, corporateCa });
    } catch (error) {
      caught = error;
    } finally {
      Reflect.deleteProperty(Object.prototype, "bundleSha256");
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/bundleSha256/);
    expect(getterInvoked).toBe(false);
  });

  it("requires own messaging discriminators without invoking inherited getters", () => {
    let getterInvoked = false;
    Object.defineProperties(Object.prototype, {
      schemaVersion: {
        configurable: true,
        get() {
          getterInvoked = true;
          return 1;
        },
      },
      agent: {
        configurable: true,
        get() {
          getterInvoked = true;
          return "openclaw";
        },
      },
    });

    try {
      expect(() =>
        validateManagedStartupProfile({
          ...OPENCLAW_PROFILE,
          messaging: { plan: {} },
        }),
      ).toThrow(/version 1 plan for the selected agent/);
    } finally {
      Reflect.deleteProperty(Object.prototype, "schemaVersion");
      Reflect.deleteProperty(Object.prototype, "agent");
    }

    expect(getterInvoked).toBe(false);
  });

  it("returns opaque JSON objects without inherited prototype data", () => {
    const profile = validateManagedStartupProfile(OPENCLAW_PROFILE);
    expect(Object.getPrototypeOf(profile.inference.compatibility as object)).toBeNull();
    expect(Object.getPrototypeOf(profile.messaging.plan as object)).toBeNull();
    expect(
      Object.getPrototypeOf(
        (profile.messaging.plan as Record<string, Record<string, unknown>>).networkPolicy,
      ),
    ).toBeNull();
  });

  it("rejects non-enumerable unknown fields instead of silently stripping them", () => {
    const inference = { ...OPENCLAW_PROFILE.inference };
    Object.defineProperty(inference, "hiddenExtension", {
      value: "safe",
      enumerable: false,
    });

    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        inference,
      }),
    ).toThrow(/unsupported fields/);
  });

  it("does not invoke polluted Array prototype mapping or sorting methods", () => {
    const mapDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "map");
    const sortDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "sort");
    let prototypeMethodInvoked = false;
    let serialized: string | undefined;
    const poison = {
      configurable: true,
      value() {
        prototypeMethodInvoked = true;
        return [`nvapi-${"a".repeat(32)}`];
      },
      writable: true,
    };
    Object.defineProperty(Array.prototype, "map", poison);
    Object.defineProperty(Array.prototype, "sort", poison);
    try {
      serialized = serializeManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        messaging: {
          plan: {
            ...OPENCLAW_PROFILE.messaging.plan,
            payload: ["safe"],
          },
        },
      });
    } finally {
      Object.defineProperty(Array.prototype, "map", mapDescriptor as PropertyDescriptor);
      Object.defineProperty(Array.prototype, "sort", sortDescriptor as PropertyDescriptor);
    }

    expect(prototypeMethodInvoked).toBe(false);
    expect(serialized).toContain('"payload":["safe"]');
    expect(serialized).not.toContain("nvapi-");
  });

  it("screens non-enumerable profile fields before rebuilding them", () => {
    const inference = { ...OPENCLAW_PROFILE.inference };
    Object.defineProperty(inference, "model", {
      value: `nvapi-${"a".repeat(32)}`,
      enumerable: false,
    });

    expect(() =>
      validateManagedStartupProfile({
        ...OPENCLAW_PROFILE,
        inference,
      }),
    ).toThrow(/credential-shaped string data/);
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

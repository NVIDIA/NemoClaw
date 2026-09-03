// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { readHermesBuildSettings } from "../../../agents/hermes/config/build-env";
import { buildConfig as buildOpenClawConfig } from "../../../scripts/generate-openclaw-config.mts";
import {
  type ManagedStartupAgentEnvironment,
  mapManagedStartupProfileToAgentEnvironment,
} from "./managed-startup/agent-environment";
import {
  MANAGED_STARTUP_AGENTS,
  MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY,
  MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
  MANAGED_STARTUP_RUNTIME_CLEANUP_OBLIGATIONS,
  type ManagedStartupAgent,
  type ManagedStartupJsonObject,
  type ManagedStartupProfile,
} from "./managed-startup/profile";

const CA_SHA256 = "a".repeat(64);
const OPENCLAW_APPLICATION_RUNTIME_NAMES = [
  "NEMOCLAW_AUTO_PAIR_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS",
  "NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS",
  "NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS",
] as const;
const UNSUPPORTED_AGENT_RUNTIME_UNSETS = [
  ...OPENCLAW_APPLICATION_RUNTIME_NAMES,
  "NEMOCLAW_DASHBOARD_BIND",
  "NEMOCLAW_MINIMAL_BOOTSTRAP",
] as const;
const HERMES_FIXED_RUNTIME_NAMES = [
  "HERMES_BUNDLED_PLUGINS",
  "HERMES_HOME",
  "HERMES_LAZY_INSTALL_TARGET",
] as const;

function messagingPlan(agent: "openclaw" | "hermes"): ManagedStartupJsonObject {
  return {
    schemaVersion: 1,
    sandboxName: `${agent}-sandbox`,
    agent,
    workflow: "onboard",
    channels: [],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    runtimeSetup: {
      nodePreloads: [],
      envAliases: [],
      secretScans: [],
    },
    stateUpdates: [],
    healthChecks: [],
  };
}

function openClawProfile(): ManagedStartupProfile {
  return {
    schemaVersion: MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
    agent: "openclaw",
    agentConfig: {
      agent: "openclaw",
      webSearch: { enabled: true, provider: "brave" },
      otel: {
        enabled: true,
        endpointUrl: "http://host.openshell.internal:4318",
        serviceName: "openclaw-gateway",
        sampleRate: 0.5,
      },
      agentTimeoutSeconds: 900,
      heartbeatEvery: "30m",
      extraAgents: {
        agents: [
          {
            id: "reviewer",
            workspace: "/sandbox/.openclaw/workspace-reviewer",
            agentDir: "/sandbox/.openclaw/agents/reviewer",
            tools: { profile: "minimal", allow: ["read"], deny: ["exec"] },
          },
        ],
        defaults: { subagents: { maxSpawnDepth: 3 } },
        main: { tools: { profile: "minimal", allow: ["read"], deny: ["exec"] } },
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
      compatibility: { maxRetries: 2, supportsDeveloperRole: true },
      inputModalities: ["text", "image"],
    },
    proxy: {
      managedHost: "10.200.0.1",
      managedPort: 3128,
      hostHttpUrl: "http://proxy.example.test:8080",
      hostHttpsUrl: "https://connect-proxy.example.test:8443",
      hostNoProxy: ["localhost", "inference.local", "127.0.0.1"],
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
    messaging: { plan: messagingPlan("openclaw") },
    tuning: {
      contextWindow: 131_072,
      maxTokens: 8192,
      reasoning: true,
      reasoningEffort: "high",
    },
    corporateCa: { bundleSha256: CA_SHA256 },
  };
}

function hermesProfile(): ManagedStartupProfile {
  return {
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
      managedHost: "proxy_name",
      managedPort: 43128,
      hostHttpUrl: "http://proxy.example.test:8080",
      hostHttpsUrl: "http://proxy.example.test:3128",
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
    messaging: { plan: messagingPlan("hermes") },
    tuning: {
      contextWindow: 65_536,
      maxTokens: null,
      reasoning: null,
      reasoningEffort: null,
    },
    corporateCa: { bundleSha256: CA_SHA256 },
  };
}

function dcodeProfile(): ManagedStartupProfile {
  return {
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
      reasoningEffort: "high",
    },
    corporateCa: { bundleSha256: CA_SHA256 },
  };
}

function piProfile(): ManagedStartupProfile {
  return {
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
  };
}

function decodeBase64Json(encoded: string): unknown {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
}

function representedLegacyInputs(result: ManagedStartupAgentEnvironment): string[] {
  return [
    ...new Set([
      ...Object.keys(result.configurationEnvironment),
      ...Object.keys(result.runtimeEnvironment),
      ...result.materials.map((material) => material.legacyInput),
    ]),
  ].sort();
}

const PROFILES: Readonly<Record<ManagedStartupAgent, () => ManagedStartupProfile>> = {
  openclaw: openClawProfile,
  hermes: hermesProfile,
  "langchain-deepagents-code": dcodeProfile,
  pi: piProfile,
};

describe("managed startup agent environment", () => {
  it("maps every OpenClaw profile field to the existing generator and entrypoint contracts", () => {
    const result = mapManagedStartupProfileToAgentEnvironment(openClawProfile(), {
      NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: " 30 ",
      NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "3e0",
      NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "0.25",
      NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "03",
      NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "10.0",
      NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "6e2",
    });

    expect(result.schemaVersion).toBe(1);
    expect(result.agent).toBe("openclaw");
    expect(result.configurationEnvironment).toEqual({
      CHAT_UI_URL: "https://dashboard.example.test:18789",
      NEMOCLAW_AGENT_HEARTBEAT_EVERY: "30m",
      NEMOCLAW_AGENT_TIMEOUT: "900",
      NEMOCLAW_CONTEXT_WINDOW: "131072",
      NEMOCLAW_DASHBOARD_BIND: "0.0.0.0",
      NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
      NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE: "managed-onboard",
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: expect.any(String),
      NEMOCLAW_INFERENCE_API: "openai-responses",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_COMPAT_B64: expect.any(String),
      NEMOCLAW_INFERENCE_INPUTS: "image,text",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
      NEMOCLAW_MAX_TOKENS: "8192",
      NEMOCLAW_MESSAGING_PLAN_B64: expect.any(String),
      NEMOCLAW_MODEL: "nvidia/nemotron-3-ultra-550b-a55b",
      NEMOCLAW_OPENCLAW_OTEL: "1",
      NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "http://host.openshell.internal:4318",
      NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE: "0.5",
      NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME: "openclaw-gateway",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/nvidia/nemotron-3-ultra-550b-a55b",
      NEMOCLAW_PROXY_HOST: "10.200.0.1",
      NEMOCLAW_PROXY_PORT: "3128",
      NEMOCLAW_REASONING: "true",
      NEMOCLAW_REASONING_EFFORT: "high",
      NEMOCLAW_TOOL_DISCLOSURE: "progressive",
      NEMOCLAW_UPSTREAM_PROVIDER: "nvidia-prod",
      NEMOCLAW_WEB_SEARCH_ENABLED: "1",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "brave",
      NEMOCLAW_WSL_DASHBOARD_EXPOSURE: "1",
    });
    const expectedOpenClawRuntime = { ...result.configurationEnvironment };
    delete expectedOpenClawRuntime.NEMOCLAW_MESSAGING_PLAN_B64;
    expect(result.runtimeEnvironment).toEqual({
      ...expectedOpenClawRuntime,
      HTTP_PROXY: "http://proxy.example.test:8080",
      HTTPS_PROXY: "https://connect-proxy.example.test:8443",
      NO_PROXY: "127.0.0.1,inference.local,localhost",
      NEMOCLAW_DASHBOARD_PORT: "18789",
      NEMOCLAW_MINIMAL_BOOTSTRAP: "1",
      http_proxy: "http://proxy.example.test:8080",
      https_proxy: "https://connect-proxy.example.test:8443",
      no_proxy: "127.0.0.1,inference.local,localhost",
    });
    expect(Object.hasOwn(result.runtimeEnvironment, "NEMOCLAW_MESSAGING_PLAN_B64")).toBe(false);
    expect(result.applicationRuntime).toEqual({
      exportEnvironment: {
        NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "30",
        NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "3",
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "0.25",
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "3",
        NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "10",
        NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "600",
      },
      unsetEnvironment: [],
    });
    expect(Object.isFrozen(result.applicationRuntime)).toBe(true);
    expect(Object.isFrozen(result.applicationRuntime.exportEnvironment)).toBe(true);
    expect(Object.isFrozen(result.applicationRuntime.unsetEnvironment)).toBe(true);

    expect(
      decodeBase64Json(result.configurationEnvironment.NEMOCLAW_INFERENCE_COMPAT_B64 ?? ""),
    ).toEqual({
      maxRetries: 2,
      supportsDeveloperRole: true,
    });
    expect(
      decodeBase64Json(result.configurationEnvironment.NEMOCLAW_EXTRA_AGENTS_JSON_B64 ?? ""),
    ).toEqual({
      agents: [
        {
          agentDir: "/sandbox/.openclaw/agents/reviewer",
          id: "reviewer",
          tools: { allow: ["read"], deny: ["exec"], profile: "minimal" },
          workspace: "/sandbox/.openclaw/workspace-reviewer",
        },
      ],
      defaults: { subagents: { maxSpawnDepth: 3 } },
      main: { tools: { allow: ["read"], deny: ["exec"], profile: "minimal" } },
    });
    const encodedPlan = result.configurationEnvironment.NEMOCLAW_MESSAGING_PLAN_B64 ?? "";
    expect(encodedPlan).toMatch(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
    expect(decodeBase64Json(encodedPlan)).toMatchObject({
      schemaVersion: 1,
      sandboxName: "openclaw-sandbox",
      agent: "openclaw",
    });
    expect(decodeBase64Json(encodedPlan)).not.toHaveProperty("workflow");

    expect(result.materials).toEqual([
      {
        kind: "corporate-ca-handoff",
        legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
        expectedSha256: CA_SHA256,
      },
    ]);
    expect(result.actions).toEqual([
      {
        kind: "apply-messaging-plan",
        agent: "openclaw",
        mode: "apply",
        phase: "runtime-setup",
        runAs: "root",
      },
      { kind: "generate-agent-config", agent: "openclaw", runAs: "sandbox" },
      {
        kind: "apply-messaging-plan",
        agent: "openclaw",
        mode: "apply",
        phase: "post-agent-install",
        runAs: "sandbox",
      },
      {
        kind: "configure-dashboard",
        dashboard: openClawProfile().dashboard,
      },
    ]);
  });

  it.each([
    ["NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS", "0", /positive safe integer/u],
    ["NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS", "1.5", /positive safe integer/u],
    [
      "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS",
      String(Number.MAX_SAFE_INTEGER + 1),
      /positive safe integer/u,
    ],
    ["NEMOCLAW_AUTO_PAIR_DEADLINE_SECS", "Infinity", /finite positive seconds/u],
    ["NEMOCLAW_AUTO_PAIR_DEADLINE_SECS", "NaN", /finite positive seconds/u],
    ["NEMOCLAW_AUTO_PAIR_DEADLINE_SECS", "not-a-number", /finite positive seconds/u],
    ["NEMOCLAW_AUTO_PAIR_DEADLINE_SECS", "1\n", /single-line text/u],
    ["NEMOCLAW_AUTO_PAIR_DEADLINE_SECS", "\r1", /single-line text/u],
    ["NEMOCLAW_AUTO_PAIR_DEADLINE_SECS", "1\0", /single-line text/u],
    ["NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS", "-0.1", /finite positive seconds/u],
    ["NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS", " ", /finite positive seconds/u],
  ] as const)("rejects invalid application runtime input %s=%s", (name, value, message) => {
    expect(() =>
      mapManagedStartupProfileToAgentEnvironment(openClawProfile(), { [name]: value }),
    ).toThrow(message);
  });

  it.each(MANAGED_STARTUP_AGENTS)(
    "derives every unsupported $0 runtime unset from the closed contract",
    (agent) => {
      const result = mapManagedStartupProfileToAgentEnvironment(PROFILES[agent](), {
        NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "30",
        NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "3",
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "0.25",
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "3",
        NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "10",
        NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "600",
      });
      const unsets = new Set(result.applicationRuntime.unsetEnvironment);
      expect(MANAGED_STARTUP_RUNTIME_CLEANUP_OBLIGATIONS.every((obligation) =>
          Object.is(unsets.has(obligation.input), !obligation.supportedFor.includes(agent)))).toBe(true);
      expect(OPENCLAW_APPLICATION_RUNTIME_NAMES.every((name) =>
          Object.is(unsets.has(name), agent !== "openclaw"))).toBe(true);
    },
  );

  it("keeps the profile mapper independent from mutable process-global runtime input", () => {
    const name = "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS";
    const previous = process.env[name];
    process.env[name] = "not-a-number";
    try {
      expect(
        mapManagedStartupProfileToAgentEnvironment(openClawProfile()).applicationRuntime,
      ).toEqual({
        exportEnvironment: {},
        unsetEnvironment: [],
      });
    } finally {
      delete process.env[name];
      Object.assign(process.env, previous === undefined ? {} : { [name]: previous });
    }
  });

  it("maps every Hermes profile field, including gateway presets and dashboard forwarding", () => {
    const result = mapManagedStartupProfileToAgentEnvironment(hermesProfile(), {
      NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "not-a-number",
    });

    expect(result.configurationEnvironment).toEqual({
      CHAT_UI_URL: "https://hermes.example.test:19189",
      NEMOCLAW_CONTEXT_WINDOW: "65536",
      NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER: "1",
      NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64: expect.any(String),
      NEMOCLAW_INFERENCE_API: "anthropic-messages",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "custom",
      NEMOCLAW_MESSAGING_PLAN_B64: expect.any(String),
      NEMOCLAW_MODEL: "claude-sonnet-4-5",
      NEMOCLAW_TOOL_DISCLOSURE: "direct",
      NEMOCLAW_UPSTREAM_PROVIDER: "anthropic-prod",
      NEMOCLAW_WEB_SEARCH_ENABLED: "1",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
    });
    expect(
      decodeBase64Json(
        result.configurationEnvironment.NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64 ?? "",
      ),
    ).toEqual(["nous-audio", "nous-browser", "nous-code", "nous-image", "nous-web"]);
    expect(result.runtimeEnvironment).toEqual({
      CHAT_UI_URL: "https://hermes.example.test:19189",
      HTTP_PROXY: "http://proxy.example.test:8080",
      HTTPS_PROXY: "http://proxy.example.test:3128",
      NO_PROXY: "127.0.0.1,localhost",
      NEMOCLAW_CONTEXT_WINDOW: "65536",
      NEMOCLAW_DASHBOARD_PORT: "19189",
      NEMOCLAW_HERMES_DASHBOARD: "1",
      NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: "29189",
      NEMOCLAW_HERMES_DASHBOARD_PORT: "19189",
      NEMOCLAW_HERMES_DASHBOARD_TUI: "1",
      NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER: "1",
      NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64:
        result.configurationEnvironment.NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64,
      NEMOCLAW_INFERENCE_API: "anthropic-messages",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "custom",
      NEMOCLAW_MODEL: "claude-sonnet-4-5",
      HERMES_BUNDLED_PLUGINS: "/opt/hermes/plugins",
      HERMES_HOME: "/sandbox/.hermes",
      HERMES_LAZY_INSTALL_TARGET: "/sandbox/.hermes/lazy-packages",
      NEMOCLAW_PROXY_HOST: "proxy_name",
      NEMOCLAW_PROXY_PORT: "43128",
      NEMOCLAW_TOOL_DISCLOSURE: "direct",
      NEMOCLAW_UPSTREAM_PROVIDER: "anthropic-prod",
      NEMOCLAW_WEB_SEARCH_ENABLED: "1",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
      http_proxy: "http://proxy.example.test:8080",
      https_proxy: "http://proxy.example.test:3128",
      no_proxy: "127.0.0.1,localhost",
    });
    expect(result.applicationRuntime).toEqual({
      exportEnvironment: {},
      unsetEnvironment: UNSUPPORTED_AGENT_RUNTIME_UNSETS,
    });
    expect(result.actions).toContainEqual({
      kind: "apply-messaging-plan",
      agent: "hermes",
      mode: "apply",
      phase: "runtime-setup",
      runAs: "root",
    });
    expect(result.actions).toContainEqual({
      kind: "apply-messaging-plan",
      agent: "hermes",
      mode: "apply",
      phase: "post-agent-install",
      runAs: "sandbox",
    });
    expect(result.actions).toContainEqual({
      kind: "configure-dashboard",
      dashboard: hermesProfile().dashboard,
    });
  });

  it("refuses to start a legacy Hermes dashboard without its browser URL (#10651)", () => {
    const profile = hermesProfile();
    assert.equal(profile.dashboard.agent, "hermes");
    const { browserUrl: _browserUrl, ...legacyDashboard } = profile.dashboard;

    expect(() =>
      mapManagedStartupProfileToAgentEnvironment({
        ...profile,
        dashboard: legacyDashboard,
      }),
    ).toThrow(
      "Cannot start the Hermes dashboard because its managed startup profile has no recorded browser URL. Rerun onboarding before starting the sandbox.",
    );
  });

  it("keeps DCode routing, provider identity, and auto-approval in root-owned files", () => {
    const result = mapManagedStartupProfileToAgentEnvironment(dcodeProfile(), {
      NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "not-a-number",
    });

    expect(result.configurationEnvironment).toEqual({
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
      NEMOCLAW_MODEL: "openai/gpt-5.4",
      NEMOCLAW_REASONING_EFFORT: "high",
      NEMOCLAW_TOOL_DISCLOSURE: "progressive",
      NEMOCLAW_UPSTREAM_ENDPOINT_URL: "https://openrouter.ai/api/v1",
      NEMOCLAW_UPSTREAM_PROVIDER: "openrouter",
      NO_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      no_proxy: "",
    });
    const expectedDcodeRuntime = { ...result.configurationEnvironment };
    delete expectedDcodeRuntime.NEMOCLAW_INFERENCE_BASE_URL;
    delete expectedDcodeRuntime.NEMOCLAW_REASONING_EFFORT;
    delete expectedDcodeRuntime.NEMOCLAW_UPSTREAM_PROVIDER;
    [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ].forEach((name) => {
      delete expectedDcodeRuntime[name];
    });
    expect(result.runtimeEnvironment).toEqual({
      ...expectedDcodeRuntime,
      NEMOCLAW_OBSERVABILITY: "1",
    });
    expect(result.applicationRuntime).toEqual({
      exportEnvironment: {},
      unsetEnvironment: UNSUPPORTED_AGENT_RUNTIME_UNSETS,
    });
    [result.configurationEnvironment, result.runtimeEnvironment].forEach((environment) => {
      expect(environment).not.toHaveProperty("NEMOCLAW_DCODE_AUTO_APPROVAL");
      expect(environment).not.toHaveProperty("NEMOCLAW_MESSAGING_PLAN_B64");
      expect(environment).not.toHaveProperty("NEMOCLAW_PROXY_HOST");
      expect(environment).not.toHaveProperty("NEMOCLAW_PROXY_PORT");
    });
    expect(result.runtimeEnvironment).not.toHaveProperty("HTTP_PROXY");
    expect(result.runtimeEnvironment).not.toHaveProperty("HTTPS_PROXY");
    expect(result.runtimeEnvironment).not.toHaveProperty("NEMOCLAW_INFERENCE_BASE_URL");
    expect(result.runtimeEnvironment).not.toHaveProperty("NEMOCLAW_REASONING_EFFORT");
    expect(result.runtimeEnvironment).not.toHaveProperty("NEMOCLAW_UPSTREAM_PROVIDER");

    expect(result.materials).toEqual([
      {
        kind: "corporate-ca-handoff",
        legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
        expectedSha256: CA_SHA256,
      },
      {
        kind: "root-owned-file",
        legacyInput: "NEMOCLAW_DCODE_AUTO_APPROVAL",
        path: "/usr/local/share/nemoclaw/dcode-auto-approval",
        contents: "thread-opt-in\n",
        owner: "root",
        group: "root",
        mode: 0o444,
      },
      {
        kind: "root-owned-file",
        legacyInput: "NEMOCLAW_INFERENCE_BASE_URL",
        path: "/usr/local/share/nemoclaw/dcode-inference-base-url",
        contents: "https://inference.local/v1\n",
        owner: "root",
        group: "root",
        mode: 0o444,
      },
      {
        kind: "root-owned-file",
        legacyInput: "NEMOCLAW_UPSTREAM_PROVIDER",
        path: "/usr/local/share/nemoclaw/dcode-upstream-provider",
        contents: "openrouter\n",
        owner: "root",
        group: "root",
        mode: 0o444,
      },
      {
        kind: "root-owned-file",
        legacyInput: "NEMOCLAW_PROXY_HOST",
        path: "/usr/local/share/nemoclaw/dcode-proxy-host",
        contents: "10.200.0.1\n",
        owner: "root",
        group: "root",
        mode: 0o444,
      },
      {
        kind: "root-owned-file",
        legacyInput: "NEMOCLAW_PROXY_PORT",
        path: "/usr/local/share/nemoclaw/dcode-proxy-port",
        contents: "3128\n",
        owner: "root",
        group: "root",
        mode: 0o444,
      },
      {
        kind: "root-owned-file",
        legacyInput: "NEMOCLAW_REASONING_EFFORT",
        path: "/usr/local/share/nemoclaw/dcode-reasoning-effort",
        contents: "high\n",
        owner: "root",
        group: "root",
        mode: 0o444,
      },
    ]);
    expect(result.actions).toEqual([
      {
        kind: "generate-agent-config",
        agent: "langchain-deepagents-code",
        runAs: "sandbox",
      },
      {
        kind: "configure-dashboard",
        dashboard: { agent: "langchain-deepagents-code", mode: "disabled" },
      },
    ]);
  });

  it("keeps the Pi managed route credential-free and confined to root-owned proxy files (#7930)", () => {
    const result = mapManagedStartupProfileToAgentEnvironment(piProfile());

    expect(result.configurationEnvironment).toEqual({
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NEMOCLAW_CONTEXT_WINDOW: "",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
      NEMOCLAW_MAX_TOKENS: "",
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_REASONING: "",
      NEMOCLAW_TOOL_DISCLOSURE: "progressive",
      NEMOCLAW_UPSTREAM_PROVIDER: "nvidia",
      NO_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      no_proxy: "",
    });
    expect(result.runtimeEnvironment).toEqual({
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_TOOL_DISCLOSURE: "progressive",
      NEMOCLAW_UPSTREAM_PROVIDER: "nvidia",
    });
    expect(result.materials).toEqual([
      {
        kind: "corporate-ca-handoff",
        legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
        expectedSha256: CA_SHA256,
      },
      {
        kind: "root-owned-file",
        legacyInput: "NEMOCLAW_PROXY_HOST",
        path: "/usr/local/share/nemoclaw/pi-proxy-host",
        contents: "10.200.0.1\n",
        owner: "root",
        group: "root",
        mode: 0o444,
      },
      {
        kind: "root-owned-file",
        legacyInput: "NEMOCLAW_PROXY_PORT",
        path: "/usr/local/share/nemoclaw/pi-proxy-port",
        contents: "3128\n",
        owner: "root",
        group: "root",
        mode: 0o444,
      },
    ]);
    expect(result.actions).toEqual([
      { kind: "generate-agent-config", agent: "pi", runAs: "sandbox" },
      { kind: "configure-dashboard", dashboard: { agent: "pi", mode: "disabled" } },
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("nvapi-");
    expect(serialized).not.toContain("NVIDIA_API_KEY");
    expect(serialized).not.toContain("BEGIN CERTIFICATE");
    expect(serialized).toContain(CA_SHA256);
  });

  it("hands Pi model tuning to its config generator and keeps it out of the long-running runtime (#7930)", () => {
    const base = piProfile();
    const result = mapManagedStartupProfileToAgentEnvironment({
      ...base,
      tuning: { contextWindow: 262_144, maxTokens: 32_000, reasoning: true, reasoningEffort: null },
    });

    expect(result.configurationEnvironment).toMatchObject({
      NEMOCLAW_CONTEXT_WINDOW: "262144",
      NEMOCLAW_MAX_TOKENS: "32000",
      NEMOCLAW_REASONING: "true",
    });
    expect(result.runtimeEnvironment).not.toHaveProperty("NEMOCLAW_CONTEXT_WINDOW");
    expect(result.runtimeEnvironment).not.toHaveProperty("NEMOCLAW_MAX_TOKENS");
    expect(result.runtimeEnvironment).not.toHaveProperty("NEMOCLAW_REASONING");
    expect(
      mapManagedStartupProfileToAgentEnvironment({
        ...base,
        tuning: { ...base.tuning, reasoning: false },
      }).configurationEnvironment.NEMOCLAW_REASONING,
    ).toBe("false");
  });

  it("rebuilds the Pi generator inputs from the current route without retaining the previous one (#7930)", () => {
    const base = piProfile();
    const before = mapManagedStartupProfileToAgentEnvironment(base);
    const after = mapManagedStartupProfileToAgentEnvironment({
      ...base,
      inference: {
        ...base.inference,
        routeProvider: "rebuilt-inference",
        upstreamProvider: "openrouter",
        model: "openai/gpt-5.4",
        routedBaseUrl: "https://rebuilt.inference.local/v1",
      },
      proxy: { ...base.proxy, managedHost: "10.200.0.9", managedPort: 3129 },
    });

    expect(after.configurationEnvironment).toMatchObject({
      NEMOCLAW_INFERENCE_BASE_URL: "https://rebuilt.inference.local/v1",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "rebuilt-inference",
      NEMOCLAW_MODEL: "openai/gpt-5.4",
      NEMOCLAW_UPSTREAM_PROVIDER: "openrouter",
    });
    expect(after.materials).toEqual([
      before.materials[0],
      { ...before.materials[1], contents: "10.200.0.9\n" },
      { ...before.materials[2], contents: "3129\n" },
    ]);
    const serialized = JSON.stringify(after);
    expect(serialized).not.toContain("https://inference.local/v1");
    expect(serialized).not.toContain("nvidia/nemotron-3-super-120b-a12b");
    expect(serialized).not.toContain("10.200.0.1");
    expect(serialized).not.toContain("3128");
    expect(after.actions).toEqual(before.actions);
  });

  it("feeds the existing OpenClaw and Hermes config consumers without translation", () => {
    const openclaw = mapManagedStartupProfileToAgentEnvironment(openClawProfile());
    const openclawConfig = buildOpenClawConfig({
      ...openclaw.configurationEnvironment,
      ...openclaw.runtimeEnvironment,
    });
    expect(openclawConfig).toMatchObject({
      agents: {
        defaults: {
          heartbeat: { every: "30m" },
          subagents: { maxSpawnDepth: 3 },
          timeoutSeconds: 900,
        },
        list: [{ default: true, id: "main" }, { id: "reviewer" }],
      },
      models: {
        providers: {
          inference: {
            api: "openai-responses",
            baseUrl: "https://inference.local/v1",
          },
        },
      },
    });

    const hermes = mapManagedStartupProfileToAgentEnvironment(hermesProfile());
    const hermesSettings = readHermesBuildSettings({
      ...hermes.configurationEnvironment,
      ...hermes.runtimeEnvironment,
    });
    expect(hermesSettings).toMatchObject({
      model: "claude-sonnet-4-5",
      baseUrl: "https://inference.local/v1",
      providerKey: "custom",
      upstreamProvider: "anthropic-prod",
      inferenceApi: "anthropic-messages",
      contextWindow: 65_536,
      toolDisclosure: "direct",
      webSearchProvider: "tavily",
      managedToolGateways: {
        brokerEnabled: true,
        presets: ["nous-audio", "nous-browser", "nous-code", "nous-image", "nous-web"],
      },
    });
  });

  it("materializes the longest DCode upstream provider accepted by its runtime (#7112)", () => {
    const profile = dcodeProfile();
    const upstreamProvider = "a".repeat(64);
    const result = mapManagedStartupProfileToAgentEnvironment({
      ...profile,
      inference: { ...profile.inference, upstreamProvider },
    });

    expect(
      result.materials.find((material) => material.legacyInput === "NEMOCLAW_UPSTREAM_PROVIDER"),
    ).toMatchObject({ contents: `${upstreamProvider}\n` });
  });

  it.each(MANAGED_STARTUP_AGENTS)(
    "represents the complete $0 Docker/start affordance inventory",
    (agent) => {
      const result = mapManagedStartupProfileToAgentEnvironment(PROFILES[agent]());
      expect(representedLegacyInputs(result)).toEqual(
        [
          ...MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY[agent].map(
            (affordance) => affordance.input,
          ),
          ...(agent === "hermes" ? HERMES_FIXED_RUNTIME_NAMES : []),
        ].sort(),
      );
      const messagingActions = result.actions.filter(
        (action) => action.kind === "apply-messaging-plan",
      );
      expect(messagingActions.map(({ phase, runAs }) => [phase, runAs])).toEqual(
        agent === "langchain-deepagents-code" || agent === "pi"
          ? []
          : [
              ["runtime-setup", "root"],
              ["post-agent-install", "sandbox"],
            ],
      );
      expect(messagingActions.map((action) => String(action.phase))).not.toContain("agent-install");
    },
  );

  it.each(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"])(
    "uses explicit clear states without erasing launch-only ambient proxy credentials [case %#]",
    (name) => {
      const openclawBase = openClawProfile();
      assert(openclawBase.agentConfig.agent === "openclaw", "fixture mismatch");
      const openclaw: ManagedStartupProfile = {
        ...openclawBase,
        agentConfig: {
          ...openclawBase.agentConfig,
          heartbeatEvery: null,
          minimalBootstrap: false,
        },
        proxy: {
          ...openclawBase.proxy,
          hostHttpUrl: null,
          hostHttpsUrl: null,
          hostNoProxy: [],
        },
        dashboard: {
          agent: "openclaw",
          mode: "loopback",
          url: "http://127.0.0.1:18789",
          port: 18_789,
          bindAddress: "127.0.0.1",
          wslExposure: false,
        },
        messaging: { plan: null },
        corporateCa: { bundleSha256: null },
      };

      const openclawResult = mapManagedStartupProfileToAgentEnvironment(openclaw);
      expect(openclawResult.configurationEnvironment.NEMOCLAW_AGENT_HEARTBEAT_EVERY).toBe("");
      expect(openclawResult.configurationEnvironment.NEMOCLAW_DASHBOARD_BIND).toBe("");
      expect(openclawResult.runtimeEnvironment.NEMOCLAW_MINIMAL_BOOTSTRAP).toBe("0");
      [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
      ].forEach((name) => {
        expect(openclawResult.runtimeEnvironment).not.toHaveProperty(name);
      });
      expect(openclawResult.configurationEnvironment).not.toHaveProperty(
        "NEMOCLAW_MESSAGING_PLAN_B64",
      );
      expect(openclawResult.actions).toContainEqual({
        kind: "apply-messaging-plan",
        agent: "openclaw",
        mode: "clear",
        phase: "runtime-setup",
        runAs: "root",
      });
      expect(openclawResult.actions).toContainEqual({
        kind: "apply-messaging-plan",
        agent: "openclaw",
        mode: "clear",
        phase: "post-agent-install",
        runAs: "sandbox",
      });
      expect(openclawResult.materials[0]).toMatchObject({ expectedSha256: null });

      const hermes: ManagedStartupProfile = {
        ...hermesProfile(),
        proxy: {
          ...hermesProfile().proxy,
          hostHttpUrl: null,
          hostHttpsUrl: null,
          hostNoProxy: [],
        },
        dashboard: {
          agent: "hermes",
          mode: "disabled",
          url: "http://127.0.0.1:18789",
          publicPort: null,
          internalPort: null,
          tuiEnabled: false,
        },
        tuning: {
          contextWindow: null,
          maxTokens: null,
          reasoning: null,
          reasoningEffort: null,
        },
      };
      const hermesResult = mapManagedStartupProfileToAgentEnvironment(hermes);
      expect(hermesResult.configurationEnvironment.NEMOCLAW_CONTEXT_WINDOW).toBe("");
      expect(hermesResult.runtimeEnvironment).toMatchObject({
        NEMOCLAW_DASHBOARD_PORT: "",
        NEMOCLAW_HERMES_DASHBOARD: "0",
        NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: "",
        NEMOCLAW_HERMES_DASHBOARD_PORT: "",
        NEMOCLAW_HERMES_DASHBOARD_TUI: "0",
      });
      [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
      ].forEach((name) => {
        expect(hermesResult.runtimeEnvironment).not.toHaveProperty(name);
      });

      const dcodeBase = dcodeProfile();
      const dcode: ManagedStartupProfile = {
        ...dcodeBase,
        inference: { ...dcodeBase.inference, upstreamEndpointUrl: null },
      };
      const dcodeResult = mapManagedStartupProfileToAgentEnvironment(dcode);
      expect(dcodeResult.configurationEnvironment.NEMOCLAW_UPSTREAM_ENDPOINT_URL).toBe("");

      expect(dcodeResult.configurationEnvironment).toHaveProperty(name, "");
      expect(dcodeResult.runtimeEnvironment).not.toHaveProperty(name);
    },
  );

  it("is deterministic across profile key order and never emits certificate or credential bytes", () => {
    const profile = openClawProfile();
    const cloned = JSON.parse(JSON.stringify(profile)) as ManagedStartupProfile;
    const reordered: ManagedStartupProfile = {
      ...cloned,
      inference: {
        api: profile.inference.api,
        upstreamEndpointUrl: profile.inference.upstreamEndpointUrl,
        compatibility: profile.inference.compatibility,
        inputModalities: profile.inference.inputModalities,
        routeProvider: profile.inference.routeProvider,
        upstreamProvider: profile.inference.upstreamProvider,
        primaryModelRef: profile.inference.primaryModelRef,
        routedBaseUrl: profile.inference.routedBaseUrl,
        model: profile.inference.model,
      },
    };
    const first = mapManagedStartupProfileToAgentEnvironment(profile);
    const second = mapManagedStartupProfileToAgentEnvironment(reordered);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("BEGIN CERTIFICATE");
    expect(serialized).not.toContain("nvapi-");
    expect(serialized).not.toContain("NVIDIA_API_KEY");
    expect(serialized).toContain(CA_SHA256);
  });

  it("revalidates mismatched or unsupported messaging profiles", () => {
    const profile: ManagedStartupProfile = {
      ...openClawProfile(),
      messaging: { plan: messagingPlan("hermes") },
    };
    expect(() => mapManagedStartupProfileToAgentEnvironment(profile)).toThrow(
      /messaging.plan must be a version 1 plan for the selected agent/,
    );

    const dcode: ManagedStartupProfile = {
      ...dcodeProfile(),
      messaging: { plan: messagingPlan("openclaw") },
    };
    expect(() => mapManagedStartupProfileToAgentEnvironment(dcode)).toThrow(
      /messaging.plan must be null for langchain-deepagents-code/,
    );
  });

  it.each(["provider-π", `p${"x".repeat(64)}`, "-ollama-local"])(
    "rejects unsupported DCode provider identifier %s before materialization (#7112)",
    (upstreamProvider) => {
      const base = dcodeProfile();
      const profile: ManagedStartupProfile = {
        ...base,
        inference: { ...base.inference, upstreamProvider },
      };

      expect(() => mapManagedStartupProfileToAgentEnvironment(profile)).toThrow(
        /must start with an ASCII letter or digit and contain 1-64 ASCII letters, digits, dots, underscores, or hyphens for DCode/u,
      );
    },
  );

  it("revalidates typed input while keeping DCode host proxy intent outside its pinned runtime", () => {
    const dcodeBase = dcodeProfile();
    const profile: ManagedStartupProfile = {
      ...dcodeBase,
      proxy: {
        ...dcodeBase.proxy,
        hostHttpUrl: "http://proxy.example.test:8080",
      },
    };
    const mappedDcode = mapManagedStartupProfileToAgentEnvironment(profile);
    expect(mappedDcode.runtimeEnvironment.HTTP_PROXY).toBeUndefined();

    const openclawBase = openClawProfile();
    const credentialBearing: ManagedStartupProfile = {
      ...openclawBase,
      inference: {
        ...openclawBase.inference,
        routedBaseUrl: "https://user:password@inference.local/v1",
      },
    };
    expect(() => mapManagedStartupProfileToAgentEnvironment(credentialBearing)).toThrow(
      /credential/,
    );
  });
});

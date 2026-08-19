// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
  validateManagedStartupProfile,
} from "./managed-startup/profile";

const TEAMS_OPENCLAW_RENDER = {
  channelId: "teams",
  renderId: "teams-openclaw-channel",
  hookId: "teams-openclaw-channel",
  handler: "common.staticOutputs",
  kind: "json-fragment",
  agent: "openclaw",
  target: "openclaw.json",
  path: "channels.msteams",
  value: {
    enabled: true,
    appId: "00000000-0000-0000-0000-000000000001",
    appPassword: "openshell:resolve:env:MSTEAMS_APP_PASSWORD",
    tenantId: "00000000-0000-0000-0000-000000000002",
    webhook: { port: 3978, path: "/api/messages" },
    healthMonitor: { enabled: false },
    streaming: { mode: "off" },
    dmPolicy: "allowlist",
    allowFrom: ["00000000-0000-0000-0000-000000000003"],
    groupPolicy: "open",
    requireMention: true,
  },
  templateRefs: ["credential.teamsClientSecret.placeholder"],
} as const;

const BASE_OPENCLAW_PROFILE = {
  schemaVersion: MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
  agent: "openclaw",
  agentConfig: {
    agent: "openclaw",
    webSearch: { enabled: false, provider: "brave" },
    otel: {
      enabled: true,
      endpointUrl: "http://host.openshell.internal:4318",
      serviceName: "openclaw-gateway",
      sampleRate: 0.75,
    },
    agentTimeoutSeconds: 900,
    heartbeatEvery: "30m",
    extraAgents: { agents: [], defaults: {}, main: {} },
    deviceAuth: { disabled: true, optOutSource: "managed-onboard" },
    minimalBootstrap: true,
  },
  inference: {
    routeProvider: "inference",
    upstreamProvider: "nvidia",
    model: "nvidia/nemotron-3-super-120b-a12b",
    routedBaseUrl: "https://inference.local/v1",
    upstreamEndpointUrl: null,
    api: "openai-responses",
    primaryModelRef: "inference/nvidia/nemotron-3-super-120b-a12b",
    compatibility: null,
    inputModalities: ["text"],
  },
  proxy: {
    managedHost: "10.200.0.1",
    managedPort: 3128,
    hostHttpUrl: null,
    hostHttpsUrl: null,
    hostNoProxy: ["inference.local", "localhost"],
  },
  dashboard: {
    agent: "openclaw",
    mode: "loopback",
    url: "http://127.0.0.1:18789",
    port: 18_789,
    bindAddress: "127.0.0.1",
    wslExposure: false,
  },
  tools: { disclosure: "progressive", enabledGateways: [] },
  messaging: {
    plan: { schemaVersion: 1, agent: "openclaw", agentRender: [] },
  },
  tuning: {
    contextWindow: 131_072,
    maxTokens: 8192,
    reasoning: true,
    reasoningEffort: "high",
  },
  corporateCa: { bundleSha256: null },
} as const;

function profileWithRender(render: Record<string, unknown>): unknown {
  return {
    ...BASE_OPENCLAW_PROFILE,
    messaging: {
      plan: {
        ...BASE_OPENCLAW_PROFILE.messaging.plan,
        agentRender: [render],
      },
    },
  };
}

describe("managed startup profile Microsoft Teams webhook", () => {
  it.each([1, 3978, 65_535])(
    "accepts a stock Microsoft Teams OpenClaw webhook on port %i (#9610)",
    (port) => {
      expect(() =>
        validateManagedStartupProfile(
          profileWithRender({
            ...TEAMS_OPENCLAW_RENDER,
            value: {
              ...TEAMS_OPENCLAW_RENDER.value,
              webhook: { port, path: "/api/messages" },
            },
          }),
        ),
      ).not.toThrow();
    },
  );

  it.each([
    ["a zero port", { port: 0, path: "/api/messages" }],
    ["a port above 65535", { port: 65_536, path: "/api/messages" }],
    ["a fractional port", { port: 3978.5, path: "/api/messages" }],
    ["a string port", { port: "3978", path: "/api/messages" }],
    ["a missing port", { path: "/api/messages" }],
    ["a missing path", { port: 3978 }],
    ["another path", { port: 3978, path: "/messages" }],
    ["a string value", "http://127.0.0.1:3978/api/messages"],
    ["a null value", null],
    ["an array value", [3978, "/api/messages"]],
    ["an extra field", { port: 3978, path: "/api/messages", enabled: true }],
    ["credential material", { port: 3978, path: "/api/messages", token: `ghp_${"a".repeat(32)}` }],
  ])("rejects a Microsoft Teams OpenClaw webhook with %s (#9610)", (_label, webhook) => {
    expect(() =>
      validateManagedStartupProfile(
        profileWithRender({
          ...TEAMS_OPENCLAW_RENDER,
          value: { ...TEAMS_OPENCLAW_RENDER.value, webhook },
        }),
      ),
    ).toThrow(/credential-shaped/);
  });

  it.each([
    ["channel", { channelId: "slack" }],
    ["render", { renderId: "other-render" }],
    ["hook", { hookId: "other-hook" }],
    ["handler", { handler: "other.handler" }],
    ["agent", { agent: "hermes" }],
    ["target", { target: "~/.openclaw/openclaw.json" }],
    ["render kind", { kind: "env-lines" }],
    ["configuration path", { path: "channels.other" }],
  ])(
    "rejects a webhook when its Microsoft Teams OpenClaw %s differs (#9610)",
    (_label, override) => {
      expect(() =>
        validateManagedStartupProfile(profileWithRender({ ...TEAMS_OPENCLAW_RENDER, ...override })),
      ).toThrow(/credential-shaped/);
    },
  );

  it("rejects the stock webhook object outside its owned render value (#9610)", () => {
    expect(() =>
      validateManagedStartupProfile({
        ...BASE_OPENCLAW_PROFILE,
        inference: {
          ...BASE_OPENCLAW_PROFILE.inference,
          compatibility: { webhook: TEAMS_OPENCLAW_RENDER.value.webhook },
        },
      }),
    ).toThrow(/credential-shaped/);
  });
});

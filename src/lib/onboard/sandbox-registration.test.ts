// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const onboardSession = requireDist("../state/onboard-session.js");
const { buildCreatedSandboxRegistryEntry, registerCreatedSandbox, selection } = requireDist(
  "./sandbox-registration.ts",
) as typeof import("./sandbox-registration");

const runtimeFields = {
  gpuEnabled: true,
  hostGpuDetected: true,
  sandboxGpuEnabled: true,
  sandboxGpuMode: "auto",
  sandboxGpuDevice: null,
  openshellDriver: "docker",
  openshellVersion: "0.1.2",
};

describe("buildCreatedSandboxRegistryEntry", () => {
  it("records the final created sandbox metadata with configured messaging channels", () => {
    const plannedMessagingState = {
      schemaVersion: 1 as const,
      plan: { sandboxName: "demo" },
    };

    const entry = buildCreatedSandboxRegistryEntry({
      sandboxName: "demo",
      inferenceSelection: {
        model: "llama",
        provider: "openai-compatible",
        endpointUrl: "https://example.test/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
        compatibleEndpointReasoning: null,
        nimContainer: null,
      },
      runtimeFields,
      agent: null,
      agentVersionKnown: true,
      imageTag: "nemoclaw-demo:123",
      appliedPolicies: ["discord", "slack"],
      webSearchEnabled: true,
      fromDockerfile: "/tmp/Dockerfile.custom",
      hermesAuthMethod: "api_key",
      plannedMessagingState: plannedMessagingState as any,
      hermesToolGateways: ["filesystem"],
      hermesDashboardState: {
        enabled: true,
        config: { enabled: true, port: 18790, internalPort: 19123, tuiEnabled: true },
      },
      dashboardPort: 18789,
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
    });

    expect(entry).toMatchObject({
      name: "demo",
      model: "llama",
      provider: "openai-compatible",
      endpointUrl: "https://example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      imageTag: "nemoclaw-demo:123",
      policies: ["discord", "slack"],
      webSearchEnabled: true,
      fromDockerfile: "/tmp/Dockerfile.custom",
      hermesAuthMethod: "api_key",
      hermesToolGateways: ["filesystem"],
      hermesDashboardEnabled: true,
      hermesDashboardPort: 18790,
      hermesDashboardInternalPort: 19123,
      hermesDashboardTui: true,
      dashboardPort: 18789,
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
      gpuEnabled: true,
      openshellDriver: "docker",
      openshellVersion: "0.1.2",
    });
    expect(entry.agent).toBeNull();
    expect(entry.agentVersion).toBeTruthy();
    expect(entry.nemoclawVersion).toBeTruthy();
    expect(entry.messaging).toBe(plannedMessagingState);
    const rawEntry = entry as unknown as Record<string, unknown>;
    expect(rawEntry.messagingChannels).toBeUndefined();
    expect(rawEntry.messagingChannelConfig).toBeUndefined();
    expect(rawEntry.disabledChannels).toBeUndefined();
  });

  it("skips stale messaging plans without writing legacy messaging fields", () => {
    const entry = buildCreatedSandboxRegistryEntry({
      sandboxName: "demo",
      inferenceSelection: {
        model: "",
        provider: "",
        endpointUrl: "",
        credentialEnv: "",
        preferredInferenceApi: "",
        compatibleEndpointReasoning: null,
        nimContainer: "",
      },
      runtimeFields,
      agent: null,
      agentVersionKnown: false,
      imageTag: null,
      appliedPolicies: [],
      plannedMessagingState: {
        schemaVersion: 1 as const,
        plan: { sandboxName: "other" },
      } as any,
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false, config: null },
      dashboardPort: 18789,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });

    expect(entry.model).toBeNull();
    expect(entry.provider).toBeNull();
    expect(entry.endpointUrl).toBeNull();
    expect(entry.credentialEnv).toBeNull();
    expect(entry.preferredInferenceApi).toBeNull();
    expect(entry.nimContainer).toBeNull();
    expect(entry.agentVersion).toBeNull();
    expect(entry.nemoclawVersion).toBeNull();
    const rawEntry = entry as unknown as Record<string, unknown>;
    expect(rawEntry.messagingChannels).toBeUndefined();
    expect(rawEntry.messagingChannelConfig).toBeUndefined();
    expect(entry.messaging).toBeUndefined();
    expect(rawEntry.disabledChannels).toBeUndefined();
    expect(entry.hermesToolGateways).toBeUndefined();
    expect(entry.hermesDashboardEnabled).toBeUndefined();
    expect(entry.hermesDashboardPort).toBeUndefined();
    expect(entry.hermesDashboardInternalPort).toBeUndefined();
    expect(entry.hermesDashboardTui).toBeUndefined();
    expect(entry.webSearchEnabled).toBe(false);
    expect(entry.fromDockerfile).toBeNull();
    expect(entry.hermesAuthMethod).toBeNull();
  });

  it("carries a durable MCP rebuild manifest into the replacement registry entry", () => {
    const preservedMcpState = {
      bridges: {
        github: {
          server: "github",
          agent: "openclaw",
          adapter: "mcporter",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "demo-mcp-github",
          policyName: "mcp-bridge-github",
          addedAt: "2026-06-27T00:00:00.000Z",
        },
      },
    };
    const entry = buildCreatedSandboxRegistryEntry({
      sandboxName: "demo",
      inferenceSelection: {
        model: "llama",
        provider: "compatible-endpoint",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        compatibleEndpointReasoning: "true",
        nimContainer: null,
      },
      runtimeFields,
      agent: null,
      agentVersionKnown: true,
      imageTag: "nemoclaw-demo:replacement",
      appliedPolicies: [],
      plannedMessagingState: undefined,
      preservedMcpState,
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false, config: null },
      dashboardPort: 18789,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });

    expect(entry.mcp).toBe(preservedMcpState);
    expect(entry.mcp?.bridges.github?.providerName).toBe("demo-mcp-github");
    expect(entry.compatibleEndpointReasoning).toBe("true");
  });

  it("normalizes invalid preferred inference API values", () => {
    const entry = buildCreatedSandboxRegistryEntry({
      sandboxName: "demo",
      inferenceSelection: {
        model: "llama",
        provider: "compatible-endpoint",
        endpointUrl: "https://example.test/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "chat",
        compatibleEndpointReasoning: null,
        nimContainer: null,
      },
      runtimeFields,
      agent: null,
      agentVersionKnown: true,
      imageTag: null,
      appliedPolicies: [],
      plannedMessagingState: undefined,
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false, config: null },
      dashboardPort: 18789,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });

    expect(entry.preferredInferenceApi).toBeNull();
  });
});

describe("selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not borrow endpoint credential or NIM metadata from an unrelated session", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "other",
      provider: "compatible-endpoint",
      model: "llama",
      endpointUrl: "https://wrong.test/v1",
      credentialEnv: "WRONG_KEY",
      compatibleEndpointReasoning: "true",
      nimContainer: "wrong",
    });

    expect(selection("demo", "compatible-endpoint", "llama", "openai-completions")).toEqual({
      provider: "compatible-endpoint",
      model: "llama",
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: null,
      nimContainer: null,
    });
  });

  it("borrows session-scoped metadata only when sandbox provider and model match", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "demo",
      provider: "compatible-endpoint",
      model: "llama",
      endpointUrl: "https://right.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      compatibleEndpointReasoning: "true",
      nimContainer: "nim-right",
    });

    expect(selection("demo", "compatible-endpoint", "llama", "openai-completions")).toEqual({
      provider: "compatible-endpoint",
      model: "llama",
      endpointUrl: "https://right.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: "true",
      nimContainer: "nim-right",
    });
  });
});

describe("registerCreatedSandbox", () => {
  it("passes the built entry to the supplied registry writer", () => {
    const registerSandbox = vi.fn();

    const entry = registerCreatedSandbox({
      sandboxName: "demo",
      inferenceSelection: {
        model: "llama",
        provider: "openai-compatible",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        compatibleEndpointReasoning: null,
        nimContainer: null,
      },
      runtimeFields,
      agent: null,
      agentVersionKnown: true,
      imageTag: null,
      appliedPolicies: [],
      plannedMessagingState: undefined,
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false, config: null },
      dashboardPort: 18789,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      registerSandbox,
    });

    expect(registerSandbox).toHaveBeenCalledWith(entry);
    expect(entry.name).toBe("demo");
  });
});

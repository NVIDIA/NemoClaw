// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  nativeLocalIdentity,
  type NativeLocalProviderAttachment,
} from "../../inference/native-local/contract";
import { getSandboxInferenceConfig, resolveAgentInferenceApi } from "../../inference/config";
import { createManagedWorkloadOnboardRuntime } from "./onboard-orchestration";

const nativeBinding = {
  provider: "compatible-endpoint",
  endpointUrl: "http://host.openshell.internal:8000/v1",
  credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  authMode: "authenticated",
  gatewayName: "nemoclaw",
  sandboxName: "alpha",
} as const;
const nativeAttachment = {
  ...nativeBinding,
  ...nativeLocalIdentity(nativeBinding),
  schemaVersion: 1 as const,
  providerId: "fixture-provider",
};
const routes = [
  {
    name: "resolved native attachment",
    endpointUrl: null,
    attachment: nativeAttachment,
    expected: nativeBinding.endpointUrl,
  },
  {
    name: "legacy ephemeral endpoint",
    endpointUrl: "http://host.openshell.internal:42103/v1",
    expected: "https://inference.local/v1",
  },
] as const;

type AgentName = "openclaw" | "hermes" | "langchain-deepagents-code" | "pi";

function prepareProfile(
  agentName: AgentName,
  route: {
    endpointUrl: string | null;
    attachment?: NativeLocalProviderAttachment;
    provider?: string;
    localNimSelected?: boolean;
    nativeProvider?: boolean;
  },
) {
  const runtime = createManagedWorkloadOnboardRuntime(
    {
      computePlan: { driverName: "docker", gatewayLauncher: "nemoclaw" },
      managedWorkloadRebuild: null,
      tempManagedRuntime: false,
      stockManagedRuntime: true,
      tempManagedRuntimeCatalog: null,
      agentName,
      legacyDockerfilePath: "Dockerfile",
      customDockerfilePath: null,
      rootDir: process.cwd(),
      model: "fixture-model",
      provider: route.provider ?? "compatible-endpoint",
      preferredInferenceApi: "openai-completions",
      endpointUrl: route.endpointUrl,
      localNimSelected: route.localNimSelected,
      nativeProvider: route.nativeProvider ?? Boolean(route.attachment),
      ...("attachment" in route ? { nativeLocalProviderAttachment: route.attachment } : {}),
      startupProfile: {
        chatUiUrl: "http://localhost:18789",
        effectiveDashboardPort: 18789,
        dashboardBindAddress: undefined,
        manageDashboard: agentName !== "langchain-deepagents-code" && agentName !== "pi",
        wslExposure: false,
        hermesDashboardState: {
          config: { enabled: false, port: 19189, internalPort: 29189, tuiEnabled: false },
          enabled: false,
        },
        webSearch: null,
        toolDisclosure: "progressive",
        hermesToolGateways: [],
        messagingPlan: null,
        dcodeAutoApprovalMode: "disabled",
        observabilityEnabled: false,
        environment: {},
      },
      note: vi.fn(),
      fallbackBuildEstimate: () => null,
    },
    { getSandboxInferenceConfig, resolveAgentInferenceApi },
  );
  return runtime.ensurePreparedProfile({ source: { kind: "managed-image" } } as never);
}

describe.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
  "%s managed startup inference",
  (agentName) => {
    it.each(routes)("keeps $name on its selected transport (#12558)", (route) => {
      const expected =
        agentName === "langchain-deepagents-code" ? route.expected : "https://inference.local/v1";
      const prepared = prepareProfile(agentName, route);
      expect(prepared?.profile.inference).toMatchObject({
        model: "fixture-model",
        upstreamProvider: "compatible-endpoint",
        routedBaseUrl: expected,
      });
    });
  },
);

it.each(["openclaw", "hermes"] as const)(
  "%s keeps an unattached native endpoint as its legacy route (#12558)",
  (agentName) => {
    const prepared = prepareProfile(agentName, {
      endpointUrl: nativeBinding.endpointUrl,
    });
    expect(prepared?.profile.inference?.routedBaseUrl).toBe("https://inference.local/v1");
  },
);

it("rejects unattached Deep Agents Code native inference (#13197)", () => {
  expect(() =>
    prepareProfile("langchain-deepagents-code", { endpointUrl: nativeBinding.endpointUrl }),
  ).toThrow("requires its native provider attachment");
});

it("keeps owned Local NIM on the Deep Agents Code shared route without an attachment (#13116)", () => {
  const prepared = prepareProfile("langchain-deepagents-code", {
    provider: "vllm-local",
    endpointUrl: "http://127.0.0.1:8000/v1",
    localNimSelected: true,
    nativeProvider: false,
  });
  expect(prepared?.profile.inference).toMatchObject({
    upstreamProvider: "vllm-local",
    routedBaseUrl: "https://inference.local/v1",
  });
});

it("routes new OpenClaw Ollama through its sandbox attachment", () => {
  const localBinding = {
    ...nativeBinding,
    provider: "ollama-local" as const,
    agent: "openclaw" as const,
  };
  const attachment = {
    ...localBinding,
    ...nativeLocalIdentity(localBinding),
    schemaVersion: 1 as const,
    providerId: "local-fixture",
  };
  const prepared = prepareProfile("openclaw", {
    provider: "ollama-local",
    endpointUrl: localBinding.endpointUrl,
    attachment,
  });
  expect(prepared?.profile.inference).toMatchObject({
    upstreamProvider: "ollama-local",
    routedBaseUrl: localBinding.endpointUrl,
    upstreamEndpointUrl: null,
  });
});

const piBinding = { ...nativeBinding, agent: "pi" as const };
const piAttachment = { ...nativeAttachment, ...piBinding, ...nativeLocalIdentity(piBinding) };
it.each([
  {
    name: "attached local",
    endpointUrl: nativeBinding.endpointUrl,
    attachment: piAttachment,
    expected: nativeBinding.endpointUrl,
  },
  {
    name: "unattached local",
    endpointUrl: nativeBinding.endpointUrl,
    expected: "https://inference.local/v1",
  },
  {
    name: "hosted with stale local attachment",
    endpointUrl: "https://example.com/v1",
    attachment: piAttachment,
    expected: "https://inference.local/v1",
  },
  {
    name: "another agent attachment",
    endpointUrl: nativeBinding.endpointUrl,
    attachment: nativeAttachment,
    expected: "https://inference.local/v1",
  },
])("keeps Pi $name on its selected transport", ({ expected, ...route }) => {
  const prepared = prepareProfile("pi", route);
  expect(prepared?.profile.inference).toMatchObject({
    model: "fixture-model",
    upstreamProvider: "compatible-endpoint",
    routedBaseUrl: expected,
  });
});

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
    api?: string;
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
      preferredInferenceApi: route.api ?? "openai-completions",
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

describe.each(["openclaw", "langchain-deepagents-code"] as const)(
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

it.each([
  { agentName: "openclaw" as const, endpointUrl: nativeBinding.endpointUrl },
  { agentName: "hermes" as const, endpointUrl: nativeBinding.endpointUrl },
  { agentName: "openclaw" as const, endpointUrl: "http://host.openshell.internal:42103/v1" },
  { agentName: "hermes" as const, endpointUrl: "http://host.openshell.internal:42103/v1" },
])(
  "$agentName keeps unattached $endpointUrl as its legacy route (#12558)",
  ({ agentName, endpointUrl }) => {
    const prepared = prepareProfile(agentName, { endpointUrl });
    expect(prepared?.profile.inference?.routedBaseUrl).toBe("https://inference.local/v1");
  },
);

it.each([nativeBinding.endpointUrl, "http://host.openshell.internal:42103/v1"])(
  "rejects unattached Deep Agents Code native inference at %s (#13197)",
  (endpointUrl) => {
    expect(() => prepareProfile("langchain-deepagents-code", { endpointUrl })).toThrow(
      "requires its native provider attachment",
    );
  },
);

it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
  "%s refuses to start NIM without its native attachment",
  (agentName) => {
    expect(() =>
      prepareProfile(agentName, {
        provider: "vllm-local",
        endpointUrl: nativeBinding.endpointUrl,
        localNimSelected: true,
      }),
    ).toThrow("Local NIM inference requires its native provider attachment");
  },
);

it("preserves the published Pi NIM shared startup path on OpenShell 0.0.x", () => {
  const prepared = prepareProfile("pi", {
    provider: "vllm-local",
    endpointUrl: nativeBinding.endpointUrl,
    localNimSelected: true,
  });
  expect(prepared?.profile.inference?.routedBaseUrl).toBe("https://inference.local/v1");
});

it.each(["openclaw", "hermes", "pi", "langchain-deepagents-code"] as const)(
  "uses the %s Local NIM native attachment",
  (agentName) => {
    const nimBinding = {
      ...nativeBinding,
      provider: "vllm-local" as const,
      authMode: "sentinel" as const,
      ...(agentName === "langchain-deepagents-code" ? {} : { agent: agentName }),
    };
    const nimAttachment = {
      ...nimBinding,
      ...nativeLocalIdentity(nimBinding),
      schemaVersion: 1 as const,
      providerId: "nim-provider",
    };
    const prepared = prepareProfile(agentName, {
      provider: "vllm-local",
      endpointUrl: nativeBinding.endpointUrl,
      localNimSelected: true,
      attachment: nimAttachment,
    });
    expect(prepared?.profile.inference).toMatchObject({
      upstreamProvider: "vllm-local",
      routedBaseUrl: nativeBinding.endpointUrl,
    });
  },
);

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

it("projects the Hermes-scoped native attachment into managed startup", () => {
  const binding = { ...nativeBinding, agent: "hermes" as const };
  const attachment = { ...nativeAttachment, ...binding, ...nativeLocalIdentity(binding) };
  const prepared = prepareProfile("hermes", { endpointUrl: null, attachment });
  expect(prepared?.profile.inference).toMatchObject({
    model: "fixture-model",
    upstreamProvider: "compatible-endpoint",
    routedBaseUrl: nativeBinding.endpointUrl,
  });
});

const piBinding = { ...nativeBinding, agent: "pi" as const };
const piCustomBinding = { ...piBinding, endpointUrl: "http://host.openshell.internal:12345/v1" };
const piCustomAttachment = {
  ...nativeAttachment,
  ...piCustomBinding,
  ...nativeLocalIdentity(piCustomBinding),
};
const piAttachment = { ...nativeAttachment, ...piBinding, ...nativeLocalIdentity(piBinding) };
it.each([
  {
    name: "attached compatible endpoint on a nonstandard port",
    endpointUrl: piCustomBinding.endpointUrl,
    attachment: piCustomAttachment,
    expected: piCustomBinding.endpointUrl,
  },
  {
    name: "unattached compatible endpoint on a nonstandard port",
    endpointUrl: piCustomBinding.endpointUrl,
    expected: "https://inference.local/v1",
  },
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

it.each([
  { agent: "openclaw" as const, api: "openai-completions" as const },
  { agent: "openclaw" as const, api: "openai-responses" as const },
  { agent: "hermes" as const, api: "openai-completions" as const },
  { agent: "hermes" as const, api: "openai-responses" as const },
])("rebuilds compatible $agent with its recorded native $api API", ({ agent, api }) => {
  const binding = {
    ...nativeBinding,
    agent,
    ...(api === "openai-responses" ? { api } : {}),
  };
  const attachment = { ...nativeAttachment, ...binding, ...nativeLocalIdentity(binding) };
  const prepared = prepareProfile(agent, {
    endpointUrl: binding.endpointUrl,
    attachment,
    api,
  });
  expect(prepared?.profile.inference).toMatchObject({
    api,
    upstreamProvider: "compatible-endpoint",
    routedBaseUrl: binding.endpointUrl,
    model: "fixture-model",
  });
});

it.each(["openclaw", "hermes"] as const)(
  "rejects a rebuilt compatible %s API that differs from its native provider",
  (agent) => {
    const binding = {
      ...nativeBinding,
      agent,
      api: "openai-responses" as const,
    };
    const attachment = { ...nativeAttachment, ...binding, ...nativeLocalIdentity(binding) };
    expect(() =>
      prepareProfile(agent, {
        endpointUrl: binding.endpointUrl,
        attachment,
        api: "openai-completions",
      }),
    ).toThrow(/API does not match/);
  },
);

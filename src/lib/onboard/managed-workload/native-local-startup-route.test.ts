// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { nativeLocalIdentity } from "../../inference/native-local/contract";
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
  {
    name: "unattached native endpoint",
    endpointUrl: "http://host.openshell.internal:8000/v1",
    expected: "https://inference.local/v1",
  },
] as const;

describe.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
  "%s managed startup inference",
  (agentName) => {
    it.each(routes)("keeps $name on its selected transport (#12558)", (route) => {
      const { endpointUrl } = route;
      const expected = agentName === "hermes" ? "https://inference.local/v1" : route.expected;
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
          provider: "compatible-endpoint",
          preferredInferenceApi: "openai-completions",
          endpointUrl,
          ...("attachment" in route ? { nativeLocalProviderAttachment: route.attachment } : {}),
          startupProfile: {
            chatUiUrl: "http://localhost:18789",
            effectiveDashboardPort: 18789,
            dashboardBindAddress: undefined,
            manageDashboard: agentName !== "langchain-deepagents-code",
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
      const prepared = runtime.ensurePreparedProfile({
        source: { kind: "managed-image" },
      } as never);
      expect(prepared?.profile.inference).toMatchObject({
        model: "fixture-model",
        upstreamProvider: "compatible-endpoint",
        routedBaseUrl: expected,
      });
    });
  },
);

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { registeredInferenceFixture } from "../../../../test/helpers/registered-inference";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { mapManagedStartupProfileToAgentEnvironment } from "../../onboard/managed-startup/agent-environment";
import * as managedWorkload from "../../onboard/workload/rebuild";
import * as registry from "../../state/registry";
import type { SandboxEntry } from "../../state/registry/types";
import {
  managedRebuildProfileDependencies,
  prepareManagedRebuildProfileHandoff,
} from "./agents/managed-workload-rebuild-profile";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { revalidateManagedWorkloadRebuildBeforeDelete } from "./rebuild-preflight-guards";
import type { RebuildTargetConfig } from "./rebuild-target-preflight";

const entry = {
  name: "alpha",
  openshellDriver: "docker",
} as SandboxEntry;
const handoff = {
  providerId: "docker",
} as managedWorkload.ManagedWorkloadRebuildHandoff;

describe("managed workload rebuild mutation guard", () => {
  it("blocks deletion when durable workload authority changes", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(entry);

    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", handoff)).toEqual({
      ok: false,
      message: "Managed workload authority changed before sandbox deletion.",
    });
  });

  it("blocks deletion when the sandbox entry disappeared", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(null);

    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", handoff)).toEqual({
      ok: false,
      message: "Managed workload authority changed before sandbox deletion.",
    });
  });

  it("blocks deletion when the recorded runtime provider is unknown", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      ...entry,
      openshellDriver: "not-a-provider",
    } as SandboxEntry);

    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", handoff)).toEqual({
      ok: false,
      message: "Managed workload authority changed before sandbox deletion.",
    });
  });

  it("does not alter legacy rebuild validation", () => {
    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", undefined)).toBeNull();
  });

  it("rejects a changed compatible endpoint without selected-route context evidence", () => {
    const catalogHandoff = {
      agent: "openclaw",
      previousProfile: {
        inference: { model: "previous-model", upstreamProvider: "nvidia-prod" },
        dashboard: { agent: "openclaw", bindAddress: "127.0.0.1", wslExposure: false },
        tuning: { contextWindow: 16_384 },
      },
    } as unknown as managedWorkload.ManagedWorkloadRebuildCatalogHandoff;
    const targetConfig = {
      agentDefinition: {},
      resumeConfig: {
        provider: "compatible-endpoint",
        model: "reasoning-model",
        preferredInferenceApi: "openai-completions",
        endpointUrl: "https://inference.example.test/v1",
        compatibleEndpointReasoning: "true",
        compatibleEndpointReasoningEffort: "high",
      },
      durableConfig: { webSearchConfig: null },
      hermesToolGateways: [],
    } as unknown as RebuildTargetConfig;
    const stage = vi
      .spyOn(managedWorkload, "stageManagedWorkloadRebuildProfile")
      .mockReturnValue(handoff);
    vi.spyOn(managedRebuildProfileDependencies, "resolveContextWindowForModel").mockReturnValue(
      null,
    );

    expect(() =>
      prepareManagedRebuildProfileHandoff({
        catalogHandoff,
        gatewayPort: 8080,
        targetConfig,
        recreateOptions: {
          controlUiPort: 18_789,
          toolDisclosure: "progressive",
          dcodeAutoApprovalMode: "disabled",
          observabilityEnabled: false,
        } as unknown as RebuildRecreateOnboardOpts,
        messagingPlan: null,
        environment: {},
      }),
    ).toThrow(
      "Cannot determine a context window for the current OpenClaw target 'compatible-endpoint/reasoning-model'.",
    );
    expect(stage).not.toHaveBeenCalled();

    vi.spyOn(
      managedRebuildProfileDependencies,
      "resolveManagedStartupInferenceRoute",
    ).mockReturnValue({
      providerKey: "compatible-endpoint",
      primaryModelRef: "reasoning-model",
      inferenceBaseUrl: "http://127.0.0.1:8080/v1",
      inferenceApi: "unsupported-api",
      inferenceCompat: null,
    });
    vi.spyOn(managedRebuildProfileDependencies, "resolveContextWindowForModel").mockReturnValue(
      16_384,
    );
    expect(() =>
      prepareManagedRebuildProfileHandoff({
        catalogHandoff,
        gatewayPort: 8080,
        targetConfig,
        recreateOptions: {
          controlUiPort: 18_789,
          toolDisclosure: "progressive",
          dcodeAutoApprovalMode: "disabled",
          observabilityEnabled: false,
        } as unknown as RebuildRecreateOnboardOpts,
        messagingPlan: null,
        environment: {},
      }),
    ).toThrow("Unsupported managed startup inference API 'unsupported-api'.");
  });

  it("rejects a legacy Hermes dashboard before retaining a recorded browser host", () => {
    const previousProfile = managedStartupE2eProfile("hermes");
    const previousDashboard = previousProfile.dashboard as Extract<
      typeof previousProfile.dashboard,
      { readonly agent: "hermes" }
    >;
    expect(previousDashboard.agent).toBe("hermes");
    const browserUrl = "https://secure-link.example/dashboard";
    const catalogHandoff = {
      agent: "hermes",
      previousProfile: {
        ...previousProfile,
        dashboard: { ...previousDashboard, browserUrl },
      },
      previousReceipt: { credentialProxyReplayRequired: false },
      corporateCa: null,
    } as unknown as managedWorkload.ManagedWorkloadRebuildCatalogHandoff;
    const targetConfig = {
      agentDefinition: {},
      resumeConfig: {
        provider: "nvidia",
        model: previousProfile.inference!.model,
        preferredInferenceApi: "openai-completions",
        endpointUrl: null,
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
      },
      durableConfig: { webSearchConfig: null },
      hermesToolGateways: [],
    } as unknown as RebuildTargetConfig;
    vi.spyOn(
      managedRebuildProfileDependencies,
      "resolveManagedStartupInferenceRoute",
    ).mockReturnValue({
      providerKey: "inference",
      primaryModelRef: "inference/unused-for-hermes",
      inferenceBaseUrl: "https://inference.local/v1",
      inferenceApi: "openai-completions",
      inferenceCompat: null,
    });
    const recreateOptions = {
      controlUiPort: 29_443,
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
    } as unknown as RebuildRecreateOnboardOpts;
    const environment = {
      NEMOCLAW_HERMES_DASHBOARD: "1",
      NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: "19443",
    };
    const { browserUrl: _browserUrl, ...legacyDashboard } = previousDashboard;
    expect(() =>
      prepareManagedRebuildProfileHandoff({
        catalogHandoff: {
          ...catalogHandoff,
          previousProfile: {
            ...catalogHandoff.previousProfile,
            dashboard: legacyDashboard,
          },
        },
        gatewayPort: 8080,
        targetConfig,
        recreateOptions,
        messagingPlan: null,
        environment,
      }),
    ).toThrow(
      "Cannot rebuild the Hermes dashboard because its managed startup profile has no recorded browser URL. Rerun onboarding, then rebuild the sandbox.",
    );

    const prepared = prepareManagedRebuildProfileHandoff({
      catalogHandoff,
      gatewayPort: 8080,
      targetConfig,
      recreateOptions,
      messagingPlan: null,
      environment,
    });

    expect(prepared.replacementProfile.profile.dashboard).toMatchObject({
      agent: "hermes",
      browserUrl,
      publicPort: 29_443,
      url: "http://127.0.0.1:29443",
    });
    expect(
      mapManagedStartupProfileToAgentEnvironment(prepared.replacementProfile.profile, {})
        .runtimeEnvironment.CHAT_UI_URL,
    ).toBe(browserUrl);

    const loopbackBrowserUrl = "http://127.0.0.2:18789/dashboard";
    const loopbackPrepared = prepareManagedRebuildProfileHandoff({
      catalogHandoff: {
        ...catalogHandoff,
        previousProfile: {
          ...catalogHandoff.previousProfile,
          dashboard: { ...previousDashboard, browserUrl: loopbackBrowserUrl },
        },
      },
      gatewayPort: 8080,
      targetConfig,
      recreateOptions,
      messagingPlan: null,
      environment,
    });

    expect(loopbackPrepared.replacementProfile.profile.dashboard).toMatchObject({
      browserUrl: "http://127.0.0.2:29443/dashboard",
      publicPort: 29_443,
    });
    expect(
      mapManagedStartupProfileToAgentEnvironment(loopbackPrepared.replacementProfile.profile, {})
        .runtimeEnvironment.CHAT_UI_URL,
    ).toBe("http://127.0.0.2:29443/dashboard");
  });

  describe("OpenClaw dashboard origin (#13177)", () => {
    const previousProfile = managedStartupE2eProfile("openclaw");
    const loopbackDashboard = previousProfile.dashboard as Extract<
      typeof previousProfile.dashboard,
      { readonly agent: "openclaw" }
    >;
    const targetConfig = {
      agentDefinition: {},
      resumeConfig: {
        provider: "nvidia-prod",
        model: previousProfile.inference!.model,
        preferredInferenceApi: "openai-completions",
        endpointUrl: null,
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
      },
      durableConfig: { webSearchConfig: null },
      hermesToolGateways: [],
    } as unknown as RebuildTargetConfig;
    const recreateOptions = {
      controlUiPort: 18_790,
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
    } as unknown as RebuildRecreateOnboardOpts;

    /** Build the OpenClaw replacement profile from a previous dashboard and registry origin. */
    function prepare(
      dashboard: typeof loopbackDashboard,
      options: {
        recordedDashboardExternalUrl?: string | null;
        environment?: NodeJS.ProcessEnv;
      } = {},
    ) {
      vi.spyOn(
        managedRebuildProfileDependencies,
        "resolveManagedStartupInferenceRoute",
      ).mockReturnValue({
        providerKey: "inference",
        primaryModelRef: previousProfile.inference!.primaryModelRef!,
        inferenceBaseUrl: "https://inference.local/v1",
        inferenceApi: "openai-completions",
        inferenceCompat: null,
      });
      vi.spyOn(managedRebuildProfileDependencies, "resolveContextWindowForModel").mockReturnValue(
        131_072,
      );
      const catalogHandoff = {
        agent: "openclaw",
        previousProfile: { ...previousProfile, dashboard },
        previousReceipt: { credentialProxyReplayRequired: false },
        corporateCa: null,
      } as unknown as managedWorkload.ManagedWorkloadRebuildCatalogHandoff;
      const prepared = prepareManagedRebuildProfileHandoff({
        catalogHandoff,
        gatewayPort: 8080,
        targetConfig,
        recreateOptions,
        messagingPlan: null,
        environment: options.environment ?? {},
        recordedDashboardExternalUrl: options.recordedDashboardExternalUrl,
      });
      return {
        dashboard: prepared.replacementProfile.profile.dashboard,
        chatUiUrl: mapManagedStartupProfileToAgentEnvironment(
          prepared.replacementProfile.profile,
          {},
        ).configurationEnvironment.CHAT_UI_URL,
      };
    }

    const remoteDashboard = {
      ...loopbackDashboard,
      mode: "remote" as const,
      url: "https://launchpad.example.test:18789",
    };

    it("keeps the previous profile's browser origin on the effective dashboard port", () => {
      const { dashboard, chatUiUrl } = prepare(remoteDashboard);

      expect(dashboard).toMatchObject({
        agent: "openclaw",
        mode: "remote",
        url: "https://launchpad.example.test:18790",
        port: 18_790,
        bindAddress: "127.0.0.1",
      });
      expect(chatUiUrl).toBe("https://launchpad.example.test:18790");
    });

    it("applies the origin that onboarding recorded for the sandbox", () => {
      const { dashboard } = prepare(loopbackDashboard, {
        recordedDashboardExternalUrl: "https://recorded.example.test:18789",
      });

      expect(dashboard).toMatchObject({
        mode: "remote",
        url: "https://recorded.example.test:18790",
      });
    });

    it("drops the browser origin after onboarding cleared it", () => {
      const { dashboard } = prepare(remoteDashboard, { recordedDashboardExternalUrl: null });

      expect(dashboard).toMatchObject({ mode: "loopback", url: "http://127.0.0.1:18790" });
    });

    it("ignores CHAT_UI_URL from the rebuild environment", () => {
      const { dashboard } = prepare(remoteDashboard, {
        environment: { CHAT_UI_URL: "https://ambient.example.test" },
      });

      expect(dashboard).toMatchObject({ url: "https://launchpad.example.test:18790" });
      expect(
        prepare(loopbackDashboard, {
          environment: { CHAT_UI_URL: "https://ambient.example.test" },
        }).dashboard,
      ).toMatchObject({ mode: "loopback", url: "http://127.0.0.1:18790" });
    });
  });
});

it.each(["configured", "defaults", "wrong-endpoint"])(
  "captures registered model settings before deletion: %s",
  (scenario) => {
    const binding = registeredInferenceFixture(true).binding;
    const model =
      scenario === "configured"
        ? {
            id: "selected",
            contextWindow: 131072,
            maxTokens: 8192,
            input: ["text", "image"],
            reasoning: true,
            compat: { supportsStore: false },
          }
        : { id: "selected" };
    const previousProfile = managedStartupE2eProfile("openclaw");
    const catalog = {
      agent: "openclaw",
      previousProfile,
      previousReceipt: { credentialProxyReplayRequired: false },
      corporateCa: null,
    } as unknown as managedWorkload.ManagedWorkloadRebuildCatalogHandoff;
    const targetConfig = {
      agentDefinition: null,
      resumeConfig: {
        provider: binding.providerName,
        model: "selected",
        preferredInferenceApi: binding.inferenceApi,
        registeredInferenceProviderAttachment: binding,
      },
      durableConfig: { webSearchConfig: null },
      hermesToolGateways: [],
    } as unknown as RebuildTargetConfig;
    const read = vi.spyOn(managedRebuildProfileDependencies, "readSandboxConfig").mockReturnValue({
      models: {
        providers: {
          [binding.providerName]: {
            baseUrl:
              scenario === "wrong-endpoint" ? "https://other.example/v1" : binding.endpointUrl,
            api: binding.inferenceApi,
            models: [model],
          },
        },
      },
    });
    vi.spyOn(managedRebuildProfileDependencies, "resolveAgentConfig").mockReturnValue({
      agentName: "openclaw",
    } as never);
    const stage = vi
      .spyOn(managedWorkload, "stageManagedWorkloadRebuildProfile")
      .mockReturnValue(handoff);
    const result = () =>
      prepareManagedRebuildProfileHandoff({
        catalogHandoff: catalog,
        targetConfig,
        gatewayPort: 18080,
        recreateOptions: { toolDisclosure: "progressive" } as RebuildRecreateOnboardOpts,
        messagingPlan: null,
        environment: {},
      });
    const outcome = (() => {
      try {
        result();
        return "prepared";
      } catch {
        return "refused";
      }
    })();
    expect(outcome).toBe(scenario === "wrong-endpoint" ? "refused" : "prepared");
    expect(read).toHaveBeenCalledWith(
      binding.sandboxName,
      { agentName: "openclaw" },
      binding.gatewayName,
    );
    expect(stage.mock.calls).toEqual(
      scenario === "wrong-endpoint"
        ? []
        : [
            [
              catalog,
              expect.objectContaining({
                inference: expect.objectContaining({
                  routeProvider: binding.providerName,
                  routedBaseUrl: binding.endpointUrl,
                  primaryModelRef: `${binding.providerName}/selected`,
                }),
              }),
              {},
              expect.objectContaining({ openClawSelectedModel: model }),
            ],
          ],
    );
    const environment = managedWorkload.managedWorkloadRebuildProfileEnvironment(
      catalog,
      {},
      { openClawSelectedModel: model },
    );
    expect(environment.NEMOCLAW_CONTEXT_WINDOW).toBe(
      scenario === "configured" ? "131072" : undefined,
    );
    expect(environment.NEMOCLAW_MAX_TOKENS).toBe(scenario === "configured" ? "8192" : undefined);
    expect(environment.NEMOCLAW_INFERENCE_INPUTS).toBe(
      scenario === "configured" ? "text,image" : "text",
    );
    expect(environment.NEMOCLAW_REASONING).toBe(scenario === "configured" ? "true" : "false");
    expect(environment.NEMOCLAW_SERVING_PRESET).toBeUndefined();
  },
);

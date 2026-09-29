// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { VllmProfile } from "../../../inference/vllm";
import { loadServingCatalog } from "../../../inference/serving/catalog-loader";
import * as onboardSession from "../../../state/onboard-session";
import { createSession, type SessionUpdates } from "../../../state/onboard-session";
import type { ServingProfileProvenance } from "../../../inference/serving/types";
import { makeDeps, makeHostState } from "../../__test-helpers__/setup-nim-flow";
import { resolveLocalModelProfilePlan } from "../../local-model-profile/plan";
import { buildCreatedSandboxRegistryEntry } from "../../sandbox-registration";
import { createSetupNim, type SetupNimFlowDeps } from "../../setup-nim-flow";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

const llamaCppProfile: ServingProfileProvenance = {
  schemaVersion: 1,
  catalogDigest: `sha256:${"a".repeat(64)}`,
  preset: {
    id: "llama-cpp.n1x.qwen",
    digest: `sha256:${"b".repeat(64)}`,
    displayName: "N1x Qwen",
    supportState: "experimental",
  },
  recipe: {
    id: "llama-cpp.qwen.n1x.v1",
    digest: `sha256:${"c".repeat(64)}`,
    backend: "install-llama-cpp",
  },
  model: { id: "nvidia/Qwen", revision: "revision-1" },
  runtimeImage: "example.invalid/llama.cpp@sha256:fixture",
  estimatedImageDownloadBytes: 2048,
  estimatedModelDownloadBytes: 1024,
};

const vllmProfile: ServingProfileProvenance = {
  ...llamaCppProfile,
  preset: {
    ...llamaCppProfile.preset,
    id: "local-model-profile.vllm.spark.v1",
    displayName: "DGX Spark vLLM",
  },
  recipe: {
    ...llamaCppProfile.recipe,
    id: "vllm.spark.v1",
    backend: "vllm",
  },
  runtimeImage: "example.invalid/vllm@sha256:fixture",
};

describe("handleProviderInferenceState managed llama.cpp resume", () => {
  it.each([
    { label: "normal resume", authoritativeResumeConfig: false },
    { label: "authoritative rebuild", authoritativeResumeConfig: true },
  ])(
    "recovers the exact runtime before $label skips provider selection (#8144)",
    async ({ authoritativeResumeConfig }) => {
      const session = createSession({
        sandboxName: "spark-agent",
        provider: "llama-cpp-local",
        model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF",
        endpointUrl: "http://host.openshell.internal:8081/v1",
        credentialEnv: "LLAMA_CPP_API_KEY",
        preferredInferenceApi: "openai-completions",
        sandboxPromptProgress: {
          sandboxName: true,
          webSearch: false,
          messaging: false,
          resourceProfile: false,
        },
      });
      session.steps.provider_selection.status = authoritativeResumeConfig ? "pending" : "complete";
      const recoverManagedLlamaCpp = vi.fn(async () => true);
      const { deps, calls } = createDeps({
        ensureManagedLlamaCppResumeReady: recoverManagedLlamaCpp,
        isInferenceRouteReady: vi.fn(() => true),
      });

      const result = await handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        authoritativeResumeConfig,
        sandboxName: "spark-agent",
      });

      expect(recoverManagedLlamaCpp).toHaveBeenCalledOnce();
      expect(recoverManagedLlamaCpp).toHaveBeenCalledWith("llama-cpp-local", "spark-agent");
      expect(recoverManagedLlamaCpp.mock.invocationCallOrder[0]).toBeLessThan(
        calls.recoverProvider.mock.invocationCallOrder[0]!,
      );
      expect(recoverManagedLlamaCpp.mock.invocationCallOrder[0]).toBeLessThan(
        calls.skipped.mock.invocationCallOrder[0]!,
      );
      expect(calls.setupNim).not.toHaveBeenCalled();
      expect(calls.setupInference).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        sandboxName: "spark-agent",
        provider: "llama-cpp-local",
        model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF",
      });
    },
  );

  it("persists a fresh managed llama.cpp recipe through provider and inference completion", async () => {
    const { deps, calls } = createDeps({
      setupNim: vi.fn(async () => ({
        ...baseSelection,
        provider: "llama-cpp-local",
        model: "qwen3.6-35b-a3b",
        endpointUrl: "http://host.openshell.internal:8081/v1",
        credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
        preferredInferenceApi: "openai-completions",
        servingProfileProvenance: llamaCppProfile,
      })),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, createSession()),
      sandboxName: "n1x-agent",
    });

    const persistedUpdates = calls.complete.mock.calls.map(
      ([, updates]) => updates as SessionUpdates,
    );
    expect(persistedUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "llama-cpp-local",
          model: "qwen3.6-35b-a3b",
          servingProfileProvenance: llamaCppProfile,
        }),
      ]),
    );
    expect(persistedUpdates.at(-1)).toMatchObject({
      servingProfileProvenance: llamaCppProfile,
    });
  });

  it("persists installer vLLM profile provenance returned by provider setup (#11896)", async () => {
    const session = createSession({
      servingProfileProvenance: vllmProfile,
    });
    const { deps, calls } = createDeps({
      setupNim: vi.fn(async () => ({
        ...baseSelection,
        provider: "vllm-local",
        model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
        endpointUrl: "http://host.openshell.internal:8000/v1",
        credentialEnv: null,
        preferredInferenceApi: "openai-completions",
        servingProfileProvenance: vllmProfile,
      })),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "spark-agent",
    });

    const persistedUpdates = calls.complete.mock.calls.map(
      ([, updates]) => updates as SessionUpdates,
    );
    expect(persistedUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "vllm-local",
          servingProfileProvenance: vllmProfile,
        }),
      ]),
    );
    expect(persistedUpdates.at(-1)).toMatchObject({
      servingProfileProvenance: vllmProfile,
    });
  });

  it("persists catalog provenance through the production setupNim handoff (#11896)", async () => {
    const catalog = loadServingCatalog();
    const plan = resolveLocalModelProfilePlan(catalog, {
      NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE: "1",
      NEMOCLAW_LOCAL_MODEL_RUNTIME: "vllm",
    })!;
    const profile = { name: "DGX Spark", platform: "spark" } as VllmProfile;
    const onboard = vi.fn<NonNullable<SetupNimFlowDeps["localModelProfileIntegration"]>["onboard"]>(
      async (_plan, _host, state) => {
        state.provider = "vllm-local";
        state.model = plan.recipe.spec.model.id;
        state.endpointUrl = "http://host.openshell.internal:8000/v1";
        state.credentialEnv = null;
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const productionSetupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        localModelProfileIntegration: { resolvePlan: () => plan, onboard },
        detectInferenceProviderHostState: () =>
          makeHostState({ vllmProfile: profile, hasVllmImage: true }),
      }),
    );
    const session = createSession({ sandboxName: "spark-agent" });
    const recordStepComplete = vi.fn(async (_stepName: string, updates: SessionUpdates) => {
      Object.assign(session, onboardSession.filterSafeUpdates(updates));
      return session;
    });
    const { deps } = createDeps({
      setupNim: (gpu, sandboxName, agent, recover, gatewayName, ...rest) =>
        productionSetupNim(
          gpu as Parameters<typeof productionSetupNim>[0],
          sandboxName,
          agent as Parameters<typeof productionSetupNim>[2],
          recover,
          null,
          gatewayName,
          ...rest,
        ),
      recordStepComplete,
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      gpu: { type: "nvidia", platform: "spark" } as never,
      sandboxName: "spark-agent",
    });

    const persistedUpdates = recordStepComplete.mock.calls.map(
      ([, updates]) => updates as SessionUpdates,
    );
    expect(onboard).toHaveBeenCalledOnce();
    expect(persistedUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "vllm-local",
          servingProfileProvenance: plan.servingProfileProvenance,
        }),
      ]),
    );
    expect(persistedUpdates.at(-1)).toMatchObject({
      servingProfileProvenance: plan.servingProfileProvenance,
    });

    const loadSession = vi.spyOn(onboardSession, "loadSession").mockReturnValue(session);
    const entry = (() => {
      try {
        return buildCreatedSandboxRegistryEntry({
          sandboxName: "spark-agent",
          inferenceSelection: {
            model: session.model!,
            provider: session.provider!,
            endpointUrl: session.endpointUrl ?? null,
            credentialEnv: session.credentialEnv ?? null,
            preferredInferenceApi: session.preferredInferenceApi ?? null,
            compatibleEndpointReasoning: null,
            compatibleEndpointReasoningEffort: null,
            nimContainer: session.nimContainer ?? null,
          },
          runtimeFields: {
            gpuEnabled: true,
            hostGpuDetected: true,
            sandboxGpuEnabled: true,
            sandboxGpuMode: "auto",
            sandboxGpuDevice: null,
            openshellDriver: "docker",
            openshellVersion: "0.1.2",
          },
          agent: null,
          agentVersionKnown: true,
          imageTag: null,
          plannedMessagingState: undefined,
          hermesToolGateways: [],
          hermesDashboardState: { enabled: false, config: null },
          dashboardPort: 18789,
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
        });
      } finally {
        loadSession.mockRestore();
      }
    })();

    expect(entry.servingProfileProvenance).toEqual(plan.servingProfileProvenance);
  });

  it("does not authorize vLLM profile provenance from session-only state (#11896)", async () => {
    const session = createSession({
      servingProfileProvenance: vllmProfile,
    });
    const { deps, calls } = createDeps({
      setupNim: vi.fn(async () => ({
        ...baseSelection,
        provider: "vllm-local",
        model: "unrelated/model",
        endpointUrl: "http://host.openshell.internal:8000/v1",
        credentialEnv: null,
        preferredInferenceApi: "openai-completions",
      })),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "spark-agent",
    });

    const persistedUpdates = calls.complete.mock.calls.map(
      ([, updates]) => updates as SessionUpdates,
    );
    expect(persistedUpdates.at(-1)).toMatchObject({
      provider: "vllm-local",
      servingProfileProvenance: null,
    });
  });

  it("clears installer vLLM profile provenance when a different provider is selected", async () => {
    const session = createSession({
      servingProfileProvenance: vllmProfile,
    });
    const { deps, calls } = createDeps();

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "cloud-agent",
    });

    const persistedUpdates = calls.complete.mock.calls.map(
      ([, updates]) => updates as SessionUpdates,
    );
    expect(persistedUpdates.at(-1)).toMatchObject({
      servingProfileProvenance: null,
    });
  });
});

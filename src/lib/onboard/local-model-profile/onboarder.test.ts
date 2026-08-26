// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { loadServingCatalog } from "../../inference/serving/catalog-loader";
import type { VllmProfile } from "../../inference/vllm";
import { OnboardInferenceCapabilityCache } from "../inference-capability-cache";
import type { SetupNimSelectionState } from "../setup-nim-flow";
import { createLocalModelProfileOnboarder, type LocalModelProfileOnboarderDeps } from "./onboarder";
import {
  LOCAL_MODEL_PROFILE_ENABLED_ENV,
  LOCAL_MODEL_PROFILE_RUNTIME_ENV,
  resolveLocalModelProfilePlan,
} from "./plan";

function state(): SetupNimSelectionState {
  return {
    model: null,
    provider: "nvidia-prod",
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
    allowToolsIncompatible: false,
    ollamaContextWindowFloor: 1,
    inferenceCapabilityCache: new OnboardInferenceCapabilityCache(),
    nvidiaFeaturedModels: { select: async () => null },
    openRouterFeaturedModels: { select: async () => null },
  } as unknown as SetupNimSelectionState;
}

function plan() {
  return resolveLocalModelProfilePlan(loadServingCatalog(), {
    [LOCAL_MODEL_PROFILE_ENABLED_ENV]: "1",
    [LOCAL_MODEL_PROFILE_RUNTIME_ENV]: "vllm",
  })!;
}

describe("dedicated local model profile onboarder", () => {
  it("installs the fixed vLLM recipe before attaching its authenticated provider", async () => {
    const selection = state();
    const checkpointVllmInstallModel = vi.fn();
    const handleVllmSelection = vi.fn(async () => "selected" as const);
    const installVllm = vi.fn(async (_profile: VllmProfile, options) => {
      options.checkpointInstallIntent?.("nvidia/Qwen3.6-35B-A3B-NVFP4");
      options.beforeInstall?.("nvidia/Qwen3.6-35B-A3B-NVFP4");
      return { ok: true };
    });
    const onboard = createLocalModelProfileOnboarder({
      env: {},
      installVllm,
      handleVllmSelection,
      prompt: vi.fn(async () => ""),
      error: vi.fn(),
      checkpointVllmInstallModel,
    });
    const vllmProfile = {
      name: "DGX Spark",
      platform: "spark",
      architecture: "arm64",
    } as VllmProfile;

    await expect(
      onboard(
        plan(),
        { hasVllmImage: false, sparkHost: true, vllmProfile, vllmRunning: false },
        selection,
      ),
    ).resolves.toBe("selected");
    expect(installVllm).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultModel: expect.objectContaining({ fixedServeCommand: true, managedBearerAuth: true }),
      }),
      expect.objectContaining({
        nonInteractive: true,
        checkpointInstallIntent: expect.any(Function),
      }),
    );
    expect(checkpointVllmInstallModel).toHaveBeenCalledWith("nvidia/Qwen3.6-35B-A3B-NVFP4");
    expect(handleVllmSelection).toHaveBeenCalledWith(selection, {
      managedInstall: true,
      sparkHost: true,
    });
  });

  it("accepts the resumed fixed model without passing it as an override", async () => {
    const installVllm = vi.fn<LocalModelProfileOnboarderDeps["installVllm"]>(async () => ({
      ok: true,
    }));
    const checkpointVllmInstallModel = vi.fn();
    const onboard = createLocalModelProfileOnboarder({
      env: {},
      installVllm,
      handleVllmSelection: vi.fn(async () => "selected" as const),
      prompt: vi.fn(async () => ""),
      error: vi.fn(),
      getVllmInstallResumeModel: () => "NVIDIA/QWEN3.6-35B-A3B-NVFP4",
      checkpointVllmInstallModel,
    });

    await expect(
      onboard(
        plan(),
        {
          hasVllmImage: false,
          sparkHost: true,
          vllmProfile: {
            name: "DGX Spark",
            platform: "spark",
            architecture: "arm64",
          } as VllmProfile,
          vllmRunning: false,
        },
        state(),
      ),
    ).resolves.toBe("selected");
    expect(installVllm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ checkpointInstallIntent: expect.any(Function) }),
    );
    expect(installVllm.mock.calls[0]?.[1]).not.toHaveProperty("modelIntent");
  });

  it("rejects a conflicting resumed model before installation", async () => {
    const installVllm = vi.fn(async () => ({ ok: true }));
    const error = vi.fn();
    const onboard = createLocalModelProfileOnboarder({
      env: {},
      installVllm,
      handleVllmSelection: vi.fn() as never,
      prompt: vi.fn(async () => ""),
      error,
      getVllmInstallResumeModel: () => "nvidia/a-different-model",
      checkpointVllmInstallModel: vi.fn(),
    });

    await expect(
      onboard(
        plan(),
        {
          hasVllmImage: false,
          sparkHost: true,
          vllmProfile: {
            name: "DGX Spark",
            platform: "spark",
            architecture: "arm64",
          } as VllmProfile,
          vllmRunning: false,
        },
        state(),
      ),
    ).resolves.toBe("retry-selection");
    expect(installVllm).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("resumed vLLM model conflicts"));
  });

  it("refuses vLLM install intent persistence when policy authority changes (#9833)", async () => {
    const selection = state();
    const checkpointVllmInstallModel = vi.fn();
    const installEffect = vi.fn();
    const handleVllmSelection = vi.fn(async () => "selected" as const);
    const observedRoutes: Array<Record<string, unknown>> = [];
    selection.revalidatePolicyRequirements = (operation) => {
      observedRoutes.push({
        operation,
        provider: selection.provider,
        model: selection.model,
        endpointUrl: selection.endpointUrl,
        credentialEnv: selection.credentialEnv,
        preferredInferenceApi: selection.preferredInferenceApi,
      });
      throw new Error("external policy authority must supply local inference");
    };
    const installVllm = vi.fn(async (_profile: VllmProfile, options) => {
      options.checkpointInstallIntent?.("nvidia/Qwen3.6-35B-A3B-NVFP4");
      installEffect();
      options.beforeInstall?.("nvidia/Qwen3.6-35B-A3B-NVFP4");
      return { ok: true };
    });
    const onboard = createLocalModelProfileOnboarder({
      env: {},
      installVllm,
      handleVllmSelection,
      prompt: vi.fn(async () => ""),
      error: vi.fn(),
      checkpointVllmInstallModel,
    });

    await expect(
      onboard(
        plan(),
        {
          hasVllmImage: false,
          sparkHost: true,
          vllmProfile: {
            name: "DGX Spark",
            platform: "spark",
            architecture: "arm64",
          } as VllmProfile,
          vllmRunning: false,
        },
        selection,
      ),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(checkpointVllmInstallModel).not.toHaveBeenCalled();
    expect(installEffect).not.toHaveBeenCalled();
    expect(handleVllmSelection).not.toHaveBeenCalled();
    expect(observedRoutes).toEqual([
      {
        operation: "record managed vLLM install intent",
        provider: "vllm-local",
        model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: "openai-completions",
      },
    ]);
  });

  it("accepts a vLLM host port override for the fixed serving recipe", async () => {
    const installVllm = vi.fn(async () => ({ ok: true }));
    const error = vi.fn();
    const handleVllmSelection = vi.fn(async () => "selected" as const);
    const onboard = createLocalModelProfileOnboarder({
      env: { NEMOCLAW_VLLM_PORT: "9000" },
      installVllm,
      handleVllmSelection,
      prompt: vi.fn(async () => ""),
      error,
      checkpointVllmInstallModel: vi.fn(),
    });

    await expect(
      onboard(
        plan(),
        {
          hasVllmImage: false,
          sparkHost: true,
          vllmProfile: {
            name: "DGX Spark",
            platform: "spark",
            architecture: "arm64",
          } as VllmProfile,
          vllmRunning: false,
        },
        state(),
      ),
    ).resolves.toBe("selected");
    expect(installVllm).toHaveBeenCalledOnce();
    expect(handleVllmSelection).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it("reports invalid vLLM materialization through the retry path", async () => {
    const invalidPlan = structuredClone(plan());
    delete (invalidPlan.recipe.spec.model as { gated?: boolean }).gated;
    const installVllm = vi.fn(async () => ({ ok: true }));
    const error = vi.fn();
    const onboard = createLocalModelProfileOnboarder({
      env: {},
      installVllm,
      handleVllmSelection: vi.fn() as never,
      prompt: vi.fn(async () => ""),
      error,
      checkpointVllmInstallModel: vi.fn(),
    });

    await expect(
      onboard(
        invalidPlan,
        {
          hasVllmImage: false,
          sparkHost: true,
          vllmProfile: {
            name: "DGX Spark",
            platform: "spark",
            architecture: "arm64",
          } as VllmProfile,
          vllmRunning: false,
        },
        state(),
      ),
    ).resolves.toBe("retry-selection");
    expect(installVllm).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("materialization failed"));
  });
});

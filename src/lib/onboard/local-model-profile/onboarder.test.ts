// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { loadServingCatalog } from "../../inference/serving/catalog-loader";
import type { VllmProfile } from "../../inference/vllm";
import { OnboardInferenceCapabilityCache } from "../inference-capability-cache";
import type { SetupNimSelectionState } from "../setup-nim-flow";
import { createLocalModelProfileOnboarder } from "./onboarder";
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
    const handleVllmSelection = vi.fn(async () => "selected" as const);
    const installVllm = vi.fn(async (_profile: VllmProfile, options) => {
      options.beforeInstall?.("nvidia/Qwen3.6-35B-A3B-NVFP4");
      return { ok: true };
    });
    const onboard = createLocalModelProfileOnboarder({
      installVllm,
      handleVllmSelection,
      prompt: vi.fn(async () => ""),
      error: vi.fn(),
    });
    const vllmProfile = { name: "DGX Spark", platform: "spark" } as VllmProfile;

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
      expect.objectContaining({ nonInteractive: true }),
    );
    expect(handleVllmSelection).toHaveBeenCalledWith(selection, {
      managedInstall: true,
      sparkHost: true,
    });
  });

  it("rejects a vLLM port override before installation", async () => {
    const installVllm = vi.fn(async () => ({ ok: true }));
    const error = vi.fn();
    const onboard = createLocalModelProfileOnboarder({
      env: { NEMOCLAW_VLLM_PORT: "9000" },
      installVllm,
      handleVllmSelection: vi.fn() as never,
      prompt: vi.fn(async () => ""),
      error,
    });

    await expect(
      onboard(
        plan(),
        {
          hasVllmImage: false,
          sparkHost: true,
          vllmProfile: { name: "DGX Spark", platform: "spark" } as VllmProfile,
          vllmRunning: false,
        },
        state(),
      ),
    ).resolves.toBe("retry-selection");
    expect(installVllm).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("port"));
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
    });

    await expect(
      onboard(
        invalidPlan,
        {
          hasVllmImage: false,
          sparkHost: true,
          vllmProfile: { name: "DGX Spark", platform: "spark" } as VllmProfile,
          vllmRunning: false,
        },
        state(),
      ),
    ).resolves.toBe("retry-selection");
    expect(installVllm).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("materialization failed"));
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createNvidiaFeaturedModelSession } from "../../src/lib/onboard/nvidia-featured-model-selection.js";
import { createSetupNim } from "../../src/lib/onboard/setup-nim-flow.js";
import { makeDeps } from "../../src/lib/onboard/__test-helpers__/setup-nim-flow.js";

describe("recovered NVIDIA model onboarding", () => {
  it("replaces a retired model before validation (#11364)", async () => {
    const retiredModel = "minimaxai/minimax-m3";
    const replacement = "nvidia/nemotron-3-super-120b-a12b";
    const warn = vi.fn();
    const validateReplacement = vi.fn(async (_model: unknown) => ({ ok: true as const }));
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        readRecordedProvider: () => "nvidia-prod",
        readRecordedModel: () => retiredModel,
        createNvidiaFeaturedModelSession: (options) =>
          createNvidiaFeaturedModelSession({ ...options, warn }),
        handleRemoteProviderSelection: async (
          { selected, requestedModel, recoveredFromSandbox, recoveredModel },
          state,
        ) => {
          expect(selected.key).toBe("build");
          expect(recoveredFromSandbox).toBe(true);
          expect(recoveredModel).toBe(retiredModel);
          const selectedModel = await state.nvidiaFeaturedModels!.select(
            requestedModel,
            recoveredModel,
            true,
            undefined,
          );
          await validateReplacement(selectedModel);
          state.model = selectedModel;
          state.provider = "nvidia-prod";
          state.endpointUrl = "https://integrate.api.nvidia.com/v1";
          state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
          return "selected";
        },
      }),
    );

    const result = await setupNim(null, "alpha");

    expect(result.model).toBe(replacement);
    expect(result.model).not.toBe(retiredModel);
    expect(validateReplacement).toHaveBeenCalledWith(replacement);
    expect(warn).toHaveBeenCalledWith(
      `  Warning: recovered NVIDIA model "${retiredModel}" is retired; using "${replacement}" instead.`,
    );
  });
});

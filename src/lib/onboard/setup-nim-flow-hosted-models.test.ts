// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeDeps } from "./__test-helpers__/setup-nim-flow";
import { createSetupNim } from "./setup-nim-flow";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hosted model setup flow", () => {
  it.each([false, true])(
    "passes hosted Super VL to input capability selection with unattended mode %s",
    async (nonInteractive) => {
      const model = "nvidia/nemotron-3.5-super-vl-120b-a12b";
      const maybePromptForInferenceInputCapability = vi.fn(async () => {});
      const setupNim = createSetupNim(
        makeDeps({
          isNonInteractive: () => nonInteractive,
          getNonInteractiveProvider: () => "build",
          maybePromptForInferenceInputCapability,
          handleRemoteProviderSelection: async ({ selected }, state) => {
            expect(selected.key).toBe("build");
            state.model = model;
            state.provider = "nvidia-prod";
            state.endpointUrl = "https://integrate.api.nvidia.com/v1";
            state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
            return "selected";
          },
        }),
      );

      const result = await setupNim(null);

      expect(result.model).toBe(model);
      expect(maybePromptForInferenceInputCapability).toHaveBeenCalledExactlyOnceWith(model);
    },
  );
});

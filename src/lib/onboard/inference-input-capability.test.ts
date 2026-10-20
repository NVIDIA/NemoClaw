// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { maybePromptForInferenceInputCapability } from "./inference-input-capability";

describe("catalog inference inputs for unattended onboarding", () => {
  it.each([true, false])(
    "defaults hosted Super VL to text and image with unattended=%s",
    async (unattended) => {
      const env: NodeJS.ProcessEnv = {};
      const prompt = vi.fn();
      await maybePromptForInferenceInputCapability("nvidia/nemotron-3.5-super-vl-120b-a12b", {
        env,
        isNonInteractive: () => unattended,
        prompt,
      });
      expect(env.NEMOCLAW_INFERENCE_INPUTS).toBe("text,image");
      expect(prompt).not.toHaveBeenCalled();
    },
  );

  it.each([
    "nemotron-3.5-super-vl-120b",
    "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
    "nvidia-nemotron-3.5-super-vl-120b-a12b-nvfp4",
  ])("enables image input for the registered Super VL identity %s", async (model) => {
    const env: NodeJS.ProcessEnv = {};
    const prompt = vi.fn();
    await maybePromptForInferenceInputCapability(model, {
      env,
      isNonInteractive: () => true,
      prompt,
    });
    expect(env.NEMOCLAW_INFERENCE_INPUTS).toBe("text,image");
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each([
    { model: "unknown-vl-model", inputs: undefined },
    { model: "nemotron-3-ultra-550b-a55b", inputs: undefined },
    { model: null, inputs: undefined },
    { model: "nemotron-3.5-super-vl-120b", inputs: "text" },
    { model: "nemotron-3.5-super-vl-120b", inputs: "image,text" },
    { model: "nvidia/nemotron-3.5-super-vl-120b-a12b", inputs: "text" },
    { model: "nvidia/nemotron-3.5-super-vl-120b-a12b", inputs: "image,text" },
  ])(
    "preserves explicit inputs or unknown capability: $model / $inputs",
    async ({ model, inputs }) => {
      const env: NodeJS.ProcessEnv = { NEMOCLAW_INFERENCE_INPUTS: inputs };
      const prompt = vi.fn();
      await maybePromptForInferenceInputCapability(model, {
        env,
        isNonInteractive: () => true,
        prompt,
      });
      expect(env.NEMOCLAW_INFERENCE_INPUTS).toBe(inputs);
      expect(prompt).not.toHaveBeenCalled();
    },
  );
});

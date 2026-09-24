// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, it, vi } from "vitest";

import { promptCloudModel } from "../inference/model-prompts";
import { createNvidiaFeaturedModelSession } from "./nvidia-featured-model-selection";
import { selectModel } from "./openrouter-selection";
import type { SetupNimSelectionState } from "./setup-nim-selection";

vi.mock("../inference/model-prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../inference/model-prompts")>();
  return { ...actual, promptCloudModel: vi.fn() };
});

beforeEach(() => {
  vi.mocked(promptCloudModel).mockReset();
});

it("preserves a recovered OpenRouter model outside NVIDIA retirement policy", async () => {
  const recoveredModel = "minimaxai/minimax-m3";
  const validateOpenAiLikeModel = vi.fn();
  const state = {
    endpointUrl: "https://openrouter.ai/api/v1",
    model: null,
    provider: "openrouter",
    openRouterFeaturedModels: createNvidiaFeaturedModelSession({ retiredModelIds: [] }),
  } as unknown as SetupNimSelectionState;

  await expect(
    selectModel({
      state,
      requestedModel: null,
      recoveredFromSandbox: true,
      recoveredModel,
      remoteConfig: { endpointUrl: "https://openrouter.ai/api/v1", label: "OpenRouter" },
      validateOpenAiLikeModel,
    }),
  ).resolves.toBe(recoveredModel);
  expect(promptCloudModel).not.toHaveBeenCalled();
  expect(validateOpenAiLikeModel).not.toHaveBeenCalled();
});

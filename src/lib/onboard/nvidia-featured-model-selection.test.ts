// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { promptCloudModel } from "../inference/model-prompts";
import { BACK_TO_SELECTION } from "../navigation";
import { createNvidiaFeaturedModelSession } from "./nvidia-featured-model-selection";

vi.mock("../inference/model-prompts", () => ({
  promptCloudModel: vi.fn(),
}));

vi.mock("../inference/nvidia-featured-models", () => ({
  createNvidiaFeaturedModelPromptOptionsLoader: () => () => ({
    defaultModelId: "nvidia/nemotron-3-super-120b-a12b",
    cloudModelOptions: [],
  }),
}));

describe("NVIDIA featured model selection", () => {
  beforeEach(() => {
    vi.mocked(promptCloudModel).mockReset();
  });

  it("propagates back navigation from the interactive model prompt (#5827)", async () => {
    vi.mocked(promptCloudModel).mockResolvedValueOnce(BACK_TO_SELECTION);

    const selected = await createNvidiaFeaturedModelSession(vi.fn()).select(null, null, false);

    expect(selected).toBe(BACK_TO_SELECTION);
  });

  it("preserves a custom environment model as the manual-entry default (#5827)", async () => {
    vi.mocked(promptCloudModel).mockResolvedValueOnce("custom/provider-model");

    const selected = await createNvidiaFeaturedModelSession(vi.fn()).select(
      null,
      null,
      false,
      " custom/provider-model ",
    );

    expect(selected).toBe("custom/provider-model");
    expect(promptCloudModel).toHaveBeenCalledWith({
      defaultModelId: "nvidia/nemotron-3-super-120b-a12b",
      cloudModelOptions: [],
      manualDefaultModelId: "custom/provider-model",
    });
  });
});

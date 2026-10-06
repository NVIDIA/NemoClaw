// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  promptCloudModel,
  promptInputModel,
  promptManualModelId,
  promptRemoteModel,
} from "./model-prompts";
import { createNvidiaFeaturedModelSession } from "../onboard/nvidia-featured-model-selection";

const approved = "nvidia/nemotron-3-ultra-550b-a55b";
describe("selection-owned model source", () => {
  it("keeps manual entry custom even when its name is approved", async () => {
    const onModelSelected = vi.fn();
    const options = { promptFn: async () => approved, writeLine: () => {}, onModelSelected };
    expect(await promptManualModelId("Model", "Model", null, options)).toBe(approved);
    expect(onModelSelected).toHaveBeenLastCalledWith("custom");
    expect(
      await promptInputModel("Model", approved, null, { ...options, promptFn: async () => "" }),
    ).toBe(approved);
    expect(onModelSelected).toHaveBeenLastCalledWith("custom");
  });
  it.each(["provider_catalog", "product_catalog"] as const)(
    "records the actual %s menu owner",
    async (catalogSelectionSource) => {
      const onModelSelected = vi.fn();
      await promptCloudModel({
        promptFn: async () => "1",
        writeLine: () => {},
        cloudModelOptions: [{ id: approved, label: "Approved" }],
        catalogSelectionSource,
        onModelSelected,
      });
      expect(onModelSelected).toHaveBeenCalledWith(catalogSelectionSource);
    },
  );
  it("does not relabel an unmatched current route as a catalog pick", async () => {
    const onModelSelected = vi.fn();
    await promptRemoteModel("Model", "test", approved, null, {
      promptFn: async () => "3",
      writeLine: () => {},
      remoteModelOptions: { test: ["different"] },
      onModelSelected,
    });
    expect(onModelSelected).toHaveBeenCalledWith("unknown");
  });
  it("records a direct model argument as custom without loading a catalog", async () => {
    const onModelSelected = vi.fn();
    const selector = createNvidiaFeaturedModelSession({ writeLine: () => {} });
    expect(await selector.select(approved, null, true, undefined, { onModelSelected })).toBe(
      approved,
    );
    expect(onModelSelected).toHaveBeenCalledWith("custom");
  });
});

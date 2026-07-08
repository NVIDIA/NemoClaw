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
  createNvidiaFeaturedModelPromptOptionsLoader: () => (defaultModelId?: string | null) => ({
    defaultModelId:
      defaultModelId === "nvidia/nemotron-3-ultra-550b-a55b"
        ? defaultModelId
        : "nvidia/nemotron-3-super-120b-a12b",
    cloudModelOptions: [],
  }),
}));

describe("NVIDIA featured model selection", () => {
  beforeEach(() => {
    vi.mocked(promptCloudModel).mockReset();
  });

  it("propagates back navigation from the interactive model prompt (#5827)", async () => {
    vi.mocked(promptCloudModel).mockResolvedValueOnce(BACK_TO_SELECTION);

    const selected = await createNvidiaFeaturedModelSession({ writeLine: vi.fn() }).select(
      null,
      null,
      false,
    );

    expect(selected).toBe(BACK_TO_SELECTION);
  });

  it("preserves a custom environment model as the manual-entry default (#5827)", async () => {
    vi.mocked(promptCloudModel).mockResolvedValueOnce("custom/provider-model");

    const selected = await createNvidiaFeaturedModelSession({ writeLine: vi.fn() }).select(
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

  it("uses the agent default for interactive and non-interactive selection", async () => {
    const ultra = "nvidia/nemotron-3-ultra-550b-a55b";
    vi.mocked(promptCloudModel).mockResolvedValueOnce(ultra);
    const session = createNvidiaFeaturedModelSession({
      writeLine: vi.fn(),
      defaultModel: ultra,
    });

    await expect(session.select(null, null, true)).resolves.toBe(ultra);
    await expect(session.select(null, null, false)).resolves.toBe(ultra);
    expect(promptCloudModel).toHaveBeenCalledWith({
      defaultModelId: ultra,
      cloudModelOptions: [],
      manualDefaultModelId: undefined,
    });
  });

  it("uses a provider-specific loading message when configured (#5826)", async () => {
    const writeLine = vi.fn();
    vi.mocked(promptCloudModel).mockResolvedValueOnce("moonshotai/kimi-k2.6");
    const session = createNvidiaFeaturedModelSession({
      loadingMessage: "  Loading OpenRouter's featured model catalog...",
      writeLine,
    });

    await expect(session.select(null, null, false)).resolves.toBe("moonshotai/kimi-k2.6");

    expect(writeLine).toHaveBeenCalledWith("  Loading OpenRouter's featured model catalog...");
  });

  it("keeps requested, recovered, and environment models ahead of the agent default", async () => {
    const session = createNvidiaFeaturedModelSession({
      defaultModel: "nvidia/nemotron-3-ultra-550b-a55b",
    });

    await expect(session.select("requested/model", "recovered/model", true)).resolves.toBe(
      "requested/model",
    );
    await expect(session.select(null, "recovered/model", true)).resolves.toBe("recovered/model");
    await expect(session.select(null, null, true, " environment/model ")).resolves.toBe(
      "environment/model",
    );
  });
});

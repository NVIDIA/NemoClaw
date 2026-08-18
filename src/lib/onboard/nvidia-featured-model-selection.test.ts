// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { promptCloudModel } from "../inference/model-prompts";
import { BACK_TO_SELECTION } from "../navigation";
import { shouldReturnToProviderSelection } from "./credential-navigation";
import {
  createNvidiaFeaturedModelSession,
  type NvidiaFeaturedModelSession,
  selectFeaturedModelAfterCredentialPrompt,
} from "./nvidia-featured-model-selection";

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

  it("uses a provider-specific loading message when configured", async () => {
    const writeLine = vi.fn();
    vi.mocked(promptCloudModel).mockResolvedValueOnce("moonshotai/kimi-k2.6");
    const session = createNvidiaFeaturedModelSession({
      loadingMessage: "  Loading partner featured model catalog...",
      writeLine,
    });

    await expect(session.select(null, null, false)).resolves.toBe("moonshotai/kimi-k2.6");

    expect(writeLine).toHaveBeenCalledWith("  Loading partner featured model catalog...");
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

  it("skips the catalog when the NVIDIA API key prompt asks to go back (#9404)", async () => {
    const select = vi.fn().mockResolvedValue("nvidia/selected-model");
    const session = { select } as unknown as NvidiaFeaturedModelSession;
    const exitOnboard = vi.fn(() => {
      throw new Error("exit onboarding");
    }) as unknown as () => never;
    const shouldReturn = (result: unknown) => shouldReturnToProviderSelection(result, exitOnboard);

    await expect(
      selectFeaturedModelAfterCredentialPrompt(
        session,
        { kind: "back" },
        shouldReturn,
        null,
        null,
        false,
      ),
    ).resolves.toBe(BACK_TO_SELECTION);
    expect(select).not.toHaveBeenCalled();
    expect(exitOnboard).not.toHaveBeenCalled();

    await expect(
      selectFeaturedModelAfterCredentialPrompt(
        session,
        { kind: "credential", value: "nvapi-good" },
        shouldReturn,
        null,
        null,
        true,
        "env/model",
      ),
    ).resolves.toBe("nvidia/selected-model");
    expect(select).toHaveBeenCalledWith(null, null, true, "env/model");

    await expect(
      selectFeaturedModelAfterCredentialPrompt(
        session,
        { kind: "exit" },
        shouldReturn,
        null,
        null,
        false,
      ),
    ).rejects.toThrow("exit onboarding");
    expect(select).toHaveBeenCalledTimes(1);
  });
});

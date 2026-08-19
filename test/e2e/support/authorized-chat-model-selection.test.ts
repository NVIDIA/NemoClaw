// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { selectAuthorizedChatModel } from "../lib/select-authorized-chat-model.mts";

const endpoint = "https://inference.example.test/v1";
const currentModel = "nvidia/nvidia/nemotron-3-ultra";

describe("authorized alternate chat model selection", () => {
  it.each([endpoint, "http://127.0.0.1:8000/v1"])(
    "selects the highest-priority catalog model at %s",
    async (permittedEndpoint) => {
      const fetchModels = () => ({
        ok: true as const,
        ids: [
          currentModel,
          "nvidia/nemotron-3-super-120b-a12b",
          "nvidia/nemotron-3-ultra-550b-a55b",
          "nvidia/nv-embedqa-e5-v5",
        ],
      });
      const probeModel = async (_endpoint: string, model: string) => ({
        ok: model === "nvidia/nemotron-3-ultra-550b-a55b",
      });

      await expect(
        selectAuthorizedChatModel({
          apiKey: "test-key",
          currentModel,
          endpoint: permittedEndpoint,
          fetchModels,
          maxCandidates: 1,
          probeModel,
        }),
      ).resolves.toBe("nvidia/nemotron-3-ultra-550b-a55b");
    },
  );

  it("rejects bearer credential transport to a non-loopback HTTP endpoint", async () => {
    const fetchModels = vi.fn();

    await expect(
      selectAuthorizedChatModel({
        apiKey: "test-key",
        currentModel,
        endpoint: "http://inference.example.test/v1",
        fetchModels,
        probeModel: vi.fn(),
      }),
    ).rejects.toThrow("the endpoint must use HTTPS unless it targets loopback");
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it("does not probe when the catalog has no alternate chat model", async () => {
    const probeModel = vi.fn();

    await expect(
      selectAuthorizedChatModel({
        apiKey: "test-key",
        currentModel,
        endpoint,
        fetchModels: () => ({ ok: true, ids: [currentModel, "nvidia/embed-v1"] }),
        probeModel,
      }),
    ).rejects.toThrow("the endpoint listed no alternate chat model");
    expect(probeModel).not.toHaveBeenCalled();
  });

  it("does not probe more candidates than the configured bound", async () => {
    const probeModel = vi.fn().mockResolvedValue({ ok: false });

    await expect(
      selectAuthorizedChatModel({
        apiKey: "test-key",
        currentModel,
        endpoint,
        fetchModels: () => ({ ok: true, ids: ["gpt-a", "gpt-b"] }),
        maxCandidates: 1,
        probeModel,
      }),
    ).rejects.toThrow("none of the first 1 listed chat models passed validation");
    expect(probeModel).toHaveBeenCalledOnce();
  });
});

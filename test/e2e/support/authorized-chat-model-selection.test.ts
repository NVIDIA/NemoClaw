// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { selectAuthorizedChatModel } from "../lib/select-authorized-chat-model.mjs";

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("authorized alternate chat model selection", () => {
  it("tries preferred chat models in order until the credential can invoke one", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          data: [
            { id: "nvidia/nvidia/nemotron-3-ultra" },
            { id: "nvidia/nemotron-3-super-120b-a12b" },
            { id: "nvidia/nemotron-3-ultra-550b-a55b" },
            { id: "nvidia/nv-embedqa-e5-v5" },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ error: "forbidden" }, 403))
      .mockResolvedValueOnce(json({ choices: [] }));

    await expect(
      selectAuthorizedChatModel({
        apiKey: "test-key",
        currentModel: "nvidia/nvidia/nemotron-3-ultra",
        endpoint: "https://inference.example.test/v1",
        fetchImpl,
      }),
    ).resolves.toBe("nvidia/nemotron-3-super-120b-a12b");

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0]?.[0].toString()).toBe(
      "https://inference.example.test/v1/models",
    );
    expect(fetchImpl.mock.calls[1]?.[0].toString()).toBe(
      "https://inference.example.test/v1/chat/completions",
    );
    const firstProbe = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const secondProbe = JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body));
    expect(firstProbe).toEqual({
      max_tokens: 16,
      messages: [{ content: "Reply with exactly: OK", role: "user" }],
      model: "nvidia/nemotron-3-ultra-550b-a55b",
    });
    expect(secondProbe).toEqual({
      max_tokens: 16,
      messages: [{ content: "Reply with exactly: OK", role: "user" }],
      model: "nvidia/nemotron-3-super-120b-a12b",
    });
  });

  it("fails without probing when discovery has no alternate chat model", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        data: [{ id: "nvidia/nvidia/nemotron-3-ultra" }, { id: "nvidia/nv-embedqa-e5-v5" }],
      }),
    );

    await expect(
      selectAuthorizedChatModel({
        apiKey: "test-key",
        currentModel: "nvidia/nvidia/nemotron-3-ultra",
        endpoint: "https://inference.example.test/v1/",
        fetchImpl,
      }),
    ).rejects.toThrow("the endpoint listed no alternate chat model");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries a transient response without spending a request on another model", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          data: [
            { id: "nvidia/nvidia/nemotron-3-ultra" },
            { id: "nvidia/nemotron-3-ultra-550b-a55b" },
            { id: "nvidia/nemotron-3-super-120b-a12b" },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ error: "rate limited" }, 429))
      .mockResolvedValueOnce(json({ choices: [] }));

    await expect(
      selectAuthorizedChatModel({
        apiKey: "test-key",
        currentModel: "nvidia/nvidia/nemotron-3-ultra",
        endpoint: "https://inference.example.test/v1",
        fetchImpl,
      }),
    ).resolves.toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

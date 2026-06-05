// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  extractNousRecommendedModelOptions,
  getHermesProviderModelOptions,
  mergeModelOptions,
} from "../../../dist/lib/inference/nous-models";

describe("Nous recommended model helpers", () => {
  it("prepends paid portal recommendations and keeps fallback models for the full list", () => {
    const models = extractNousRecommendedModelOptions(
      {
        paidRecommendedModels: [
          { modelName: "paid/model-b", position: 1 },
          { modelName: "paid/model-a", position: 0 },
        ],
        freeRecommendedModels: [
          { modelName: "free/model-c", position: 0 },
          { modelName: "bad model", position: 1 },
        ],
      },
      ["paid/model-b", "fallback/model-d"],
    );

    expect(models).toEqual([
      "paid/model-a",
      "paid/model-b",
      "free/model-c",
      "fallback/model-d",
    ]);
  });

  it("falls back when the portal payload has no usable model ids", () => {
    expect(
      extractNousRecommendedModelOptions(
        { paidRecommendedModels: [{ modelName: "not safe" }] },
        ["fallback/model-a", "fallback/model-b"],
      ),
    ).toEqual(["fallback/model-a", "fallback/model-b"]);
  });

  it("deduplicates and filters model option groups", () => {
    expect(
      mergeModelOptions(
        ["model/a", "model/a", "bad model"],
        ["model/b", "model/a"],
      ),
    ).toEqual(["model/a", "model/b"]);
  });

  it("fetches the portal catalog when available", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        paidRecommendedModels: [{ modelName: "portal/model-a", position: 0 }],
      }),
    }));

    await expect(
      getHermesProviderModelOptions({
        fallbackModels: ["fallback/model-b"],
        fetchFn,
        timeoutMs: 0,
        url: "https://example.test/models",
      }),
    ).resolves.toEqual(["portal/model-a", "fallback/model-b"]);
    expect(fetchFn).toHaveBeenCalledWith("https://example.test/models", expect.any(Object));
  });

  it("uses the fallback catalog when the portal request fails", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    }));

    await expect(
      getHermesProviderModelOptions({
        fallbackModels: ["fallback/model-a"],
        fetchFn,
        timeoutMs: 0,
      }),
    ).resolves.toEqual(["fallback/model-a"]);
  });
});

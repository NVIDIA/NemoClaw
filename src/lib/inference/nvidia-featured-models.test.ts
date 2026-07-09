// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createNvidiaFeaturedModelPromptOptionsLoader,
  fetchNvidiaFeaturedModels,
  getNvidiaFeaturedModelOptions,
  getNvidiaFeaturedModelPromptOptions,
  NVIDIA_FEATURED_MODELS_URL,
  parseNvidiaFeaturedModels,
} from "./nvidia-featured-models";
import { OPENROUTER_FEATURED_MODELS_URL } from "./openrouter";

describe("NVIDIA featured model catalog", () => {
  it("prefixes bare Nemotron catalog IDs with the canonical endpoint namespace (#5827)", () => {
    expect(
      parseNvidiaFeaturedModels(
        JSON.stringify({
          "featured-models": [
            {
              model: "nemotron-3-super-120b-a12b",
              "model-name": "Nemotron 3 Super 120B",
            },
          ],
        }),
      ),
    ).toEqual([{ id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B" }]);
  });

  it("rewrites stale Minimax M2.7 catalog IDs and labels to M3 (#5827)", () => {
    expect(
      parseNvidiaFeaturedModels(
        JSON.stringify({
          "featured-models": [
            { model: "minimaxai/minimax-m2.7", "model-name": "Minimax M2.7" },
            { model: "minimaxai/minimax-m3", "model-name": "Minimax M3 duplicate" },
          ],
        }),
      ),
    ).toEqual([{ id: "minimaxai/minimax-m3", label: "Minimax M3" }]);
  });

  it("filters models whose catalogs outlive their NVIDIA Endpoints routes", () => {
    expect(
      parseNvidiaFeaturedModels(
        JSON.stringify({
          "featured-models": [
            { model: "z-ai/glm-5.1", "model-name": "GLM 5.1" },
            { model: "moonshotai/kimi-k2.6", "model-name": "Kimi K2.6" },
            {
              model: "nvidia/nemotron-3-super-120b-a12b",
              "model-name": "Nemotron 3 Super 120B",
            },
          ],
        }),
      ),
    ).toEqual([{ id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B" }]);
  });

  it("sanitizes untrusted catalog labels and bounds the rendered menu", () => {
    const catalog = Array.from({ length: 105 }, (_value, index) => ({
      model: `provider/model-${String(index)}`,
      "model-name":
        index === 0
          ? "\u001b[31mSpoofed\n  2) fake\u202e"
          : `Model ${String(index)}${"x".repeat(200)}`,
    }));
    catalog.unshift({ model: `provider/${"x".repeat(300)}`, "model-name": "Oversized ID" });

    const models = parseNvidiaFeaturedModels(JSON.stringify({ "featured-models": catalog }));

    expect(models).toHaveLength(100);
    expect(models[0]).toEqual({ id: "provider/model-0", label: "Spoofed 2) fake" });
    expect(models[1].label).toHaveLength(160);
    expect(models.map((model) => model.label).join("\n")).not.toMatch(/[\u001b\u202e]/);
    expect(models.some((model) => model.id.length > 256)).toBe(false);
  });

  it("rejects oversized featured catalog responses before rendering", () => {
    expect(() =>
      parseNvidiaFeaturedModels(
        JSON.stringify({ "featured-models": [], padding: "x".repeat(1024 * 1024) }),
      ),
    ).toThrow(/exceeds 1 MiB/);
  });

  it("fetches NVIDIA featured models without requiring an API key", () => {
    const result = fetchNvidiaFeaturedModels({
      runCurlProbeImpl: (argv) => {
        expect(argv.at(-1)).toBe(NVIDIA_FEATURED_MODELS_URL);
        expect(argv.join(" ")).not.toContain("Authorization: Bearer");
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: JSON.stringify({
            "featured-models": [{ model: "minimaxai/minimax-m3", "model-name": "Minimax M3" }],
          }),
          stderr: "",
          message: "",
        };
      },
    });

    expect(result).toEqual({
      ok: true,
      models: [{ id: "minimaxai/minimax-m3", label: "Minimax M3" }],
    });
  });

  it("can fetch OpenRouter's featured catalog from its own endpoint (#5826)", () => {
    const result = fetchNvidiaFeaturedModels({
      catalogUrl: OPENROUTER_FEATURED_MODELS_URL,
      retiredModelIds: [],
      runCurlProbeImpl: (argv) => {
        expect(argv.at(-1)).toBe(
          "https://assets.ngc.nvidia.com/products/api-catalog/featured-models-openrouter.json",
        );
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: JSON.stringify({
            "featured-models": [{ model: "moonshotai/kimi-k2.6", "model-name": "Kimi K2.6" }],
          }),
          stderr: "",
          message: "",
        };
      },
    });

    expect(result).toEqual({
      ok: true,
      models: [{ id: "moonshotai/kimi-k2.6", label: "Kimi K2.6" }],
    });
  });

  it("lets provider-specific catalogs opt out of NVIDIA-only retirement filters (#5826)", () => {
    expect(
      parseNvidiaFeaturedModels(
        JSON.stringify({
          "featured-models": [
            { model: "moonshotai/kimi-k2.6", "model-name": "Kimi K2.6" },
            { model: "z-ai/glm-5.1", "model-name": "GLM 5.1" },
          ],
        }),
        { retiredModelIds: [] },
      ),
    ).toEqual([
      { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6" },
      { id: "z-ai/glm-5.1", label: "GLM 5.1" },
    ]);
  });

  it("falls back to the curated NVIDIA featured model snapshot when the catalog is unavailable", () => {
    const warnings: string[] = [];
    const models = getNvidiaFeaturedModelOptions({
      runCurlProbeImpl: () => ({
        ok: false,
        httpStatus: 503,
        curlStatus: 0,
        body: "",
        stderr: "",
        message: "service unavailable",
      }),
      warn: (message) => warnings.push(message),
    });

    expect(models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3-super-120b-a12b",
      "minimaxai/minimax-m3",
    ]);
    expect(warnings).toEqual([
      "  Warning: failed to load NVIDIA's featured model catalog; falling back to the bundled list (service unavailable; HTTP 503).",
    ]);
  });

  it("removes terminal controls from featured catalog fallback warnings", () => {
    const warnings: string[] = [];
    getNvidiaFeaturedModelOptions({
      runCurlProbeImpl: () => ({
        ok: false,
        httpStatus: 503,
        curlStatus: 0,
        body: "",
        stderr: "",
        message: "\u001b[31mspoofed\nnext\u202e",
      }),
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([
      "  Warning: failed to load NVIDIA's featured model catalog; falling back to the bundled list (spoofed next; HTTP 503).",
    ]);
  });

  it("uses the configured catalog label in fallback warnings (#5826)", () => {
    const warnings: string[] = [];
    getNvidiaFeaturedModelOptions({
      catalogLabel: "OpenRouter's featured model catalog",
      runCurlProbeImpl: () => ({
        ok: false,
        httpStatus: 503,
        curlStatus: 0,
        body: "",
        stderr: "",
        message: "service unavailable",
      }),
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([
      "  Warning: failed to load OpenRouter's featured model catalog; falling back to the bundled list (service unavailable; HTTP 503).",
    ]);
  });

  it.each([
    ["malformed JSON", "not-json", /JSON|Unexpected token|not-json/i],
    ["a missing featured-models array", JSON.stringify({ data: [] }), /featured-models/],
  ])("preserves probe status when the featured catalog contains %s", (_label, body, message) => {
    const result = fetchNvidiaFeaturedModels({
      runCurlProbeImpl: () => ({
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: String(body),
        stderr: "",
        message: "",
      }),
    });

    expect(result).toEqual({
      ok: false,
      httpStatus: 200,
      curlStatus: 0,
      message: expect.stringMatching(message as RegExp),
    });
  });

  it("falls back with a warning when the featured catalog has no safe selectable models", () => {
    const warnings: string[] = [];
    const models = getNvidiaFeaturedModelOptions({
      runCurlProbeImpl: () => ({
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: JSON.stringify({
          "featured-models": [
            { model: "unsafe model id", "model-name": "Unsafe" },
            { model: "z-ai/glm-5.1", "model-name": "Retired" },
            { model: "moonshotai/kimi-k2.6", "model-name": "Also retired" },
          ],
        }),
        stderr: "",
        message: "",
      }),
      warn: (message) => warnings.push(message),
    });

    expect(models).toEqual(
      expect.arrayContaining([{ id: "minimaxai/minimax-m3", label: "Minimax M3" }]),
    );
    expect(warnings).toEqual([
      "  Warning: failed to load NVIDIA's featured model catalog; falling back to the bundled list (catalog returned no safe model IDs).",
    ]);
  });

  it("returns a structured failure when the featured catalog probe throws", () => {
    expect(
      fetchNvidiaFeaturedModels({
        runCurlProbeImpl: () => {
          throw new Error("network unavailable");
        },
      }),
    ).toEqual({
      ok: false,
      httpStatus: 0,
      curlStatus: 0,
      message: "network unavailable",
    });
  });

  it("uses the first live model when the configured default is absent", () => {
    const options = getNvidiaFeaturedModelPromptOptions(null, {
      runCurlProbeImpl: () => ({
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: JSON.stringify({
          "featured-models": [
            { model: "nvidia/nemotron-3-ultra-550b-a55b", "model-name": "Nemotron Ultra" },
          ],
        }),
        stderr: "",
        message: "",
      }),
    });

    expect(options).toEqual({
      defaultModelId: "nvidia/nemotron-3-ultra-550b-a55b",
      cloudModelOptions: [{ id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron Ultra" }],
    });
  });

  it("keeps Nemotron 3 Super as the default when it is present in the live catalog (#5827)", () => {
    const options = getNvidiaFeaturedModelPromptOptions(null, {
      runCurlProbeImpl: () => ({
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: JSON.stringify({
          "featured-models": [
            { model: "moonshotai/kimi-k2.6", "model-name": "Kimi K2.6" },
            {
              model: "nvidia/nemotron-3-super-120b-a12b",
              "model-name": "Nemotron 3 Super 120B",
            },
          ],
        }),
        stderr: "",
        message: "",
      }),
    });

    expect(options.defaultModelId).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(options.cloudModelOptions.map((option) => option.id)).not.toContain(
      "moonshotai/kimi-k2.6",
    );
  });

  it("reuses one featured catalog lookup but recomputes defaults across onboarding retries", () => {
    let probeCount = 0;
    const loadOptions = createNvidiaFeaturedModelPromptOptionsLoader({
      runCurlProbeImpl: () => {
        probeCount += 1;
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: JSON.stringify({
            "featured-models": [
              { model: "moonshotai/kimi-k2.6", "model-name": "Kimi K2.6" },
              {
                model: "nvidia/nemotron-3-ultra-550b-a55b",
                "model-name": "Nemotron Ultra",
              },
            ],
          }),
          stderr: "",
          message: "",
        };
      },
    });

    const retiredDefault = loadOptions("moonshotai/kimi-k2.6");
    const ultraDefault = loadOptions("nvidia/nemotron-3-ultra-550b-a55b");
    expect(retiredDefault.defaultModelId).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(ultraDefault.defaultModelId).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(retiredDefault.cloudModelOptions).toBe(ultraDefault.cloudModelOptions);
    expect(probeCount).toBe(1);
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOllamaModelSelector, type OllamaModelSelectorDeps } from "./ollama-model-selection";

function fail(message: string): never {
  throw new Error(message);
}

function makeDeps() {
  return {
    isNonInteractive: () => false,
    isAutoYes: () => false,
    confirm: vi.fn(async () => false),
    note: vi.fn(),
    abortNonInteractive: (message) => fail(message),
    validateOpenAiLikeSelection: vi.fn<OllamaModelSelectorDeps["validateOpenAiLikeSelection"]>(
      async () => ({
        ok: true,
        api: "openai-completions",
      }),
    ),
    isSafeModelId: () => true,
    getOllamaModelOptions: (): string[] => [],
    resolveNonInteractiveOllamaModel: () => "reviewed/model",
    getLocalProviderValidationBaseUrl: () => "http://127.0.0.1:11434/v1",
    buildOllamaProbeOptions: () => ({}),
    applyOllamaRuntimeContextWindow: () => ({ ok: true }),
    prepareModel: vi.fn(async () => ({ ok: true })),
    modelSizeLabel: () => "1 GB",
  } satisfies OllamaModelSelectorDeps;
}

const lockedDefaults = {
  requestedModel: "reviewed/model",
  recoveredModel: null,
  lockedModel: "reviewed/model",
  promptDefaultModel: "reviewed/model",
};

describe("reviewed Ollama model selection (#6005)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns to provider selection when a locked model download is declined", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps();
    const selector = createOllamaModelSelector(deps);

    await expect(selector(null, "ollama-local", lockedDefaults)).resolves.toEqual({
      outcome: "back-to-selection",
    });
    expect(deps.confirm).toHaveBeenCalledWith(
      "  Download Ollama model 'reviewed/model' (1 GB)?",
      false,
    );
    expect(deps.prepareModel).not.toHaveBeenCalled();
  });

  it("returns to provider selection when a locked installed model fails validation", async () => {
    const deps = makeDeps();
    deps.getOllamaModelOptions = () => ["reviewed/model"];
    deps.validateOpenAiLikeSelection = vi.fn<
      OllamaModelSelectorDeps["validateOpenAiLikeSelection"]
    >(async () => ({
      ok: false,
      retry: "retry",
    }));
    const selector = createOllamaModelSelector(deps);

    await expect(selector(null, "ollama-local", lockedDefaults)).resolves.toEqual({
      outcome: "back-to-selection",
    });
    expect(deps.prepareModel).toHaveBeenCalledOnce();
    expect(deps.validateOpenAiLikeSelection).toHaveBeenCalledOnce();
  });
});

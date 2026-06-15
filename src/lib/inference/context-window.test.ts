// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

// resolveContextWindowForModel takes injected deps, so these mocks only stop the
// real inference stack (and ../runner → ./platform) from loading under vitest;
// the default deps object references them but the tests never exercise it.
vi.mock("./local", () => ({
  getOllamaWarmupCommand: vi.fn(() => ["curl"]),
  resolveOllamaRuntimeContextWindow: vi.fn(() => null),
}));
vi.mock("./vllm-runtime-context", () => ({ resolveVllmContextWindowFromModels: vi.fn() }));

import { type ContextWindowDeps, resolveContextWindowForModel } from "./context-window";

function makeDeps(over: Partial<ContextWindowDeps> = {}): ContextWindowDeps {
  return {
    warmOllamaModel: vi.fn(),
    probeOllamaContextWindow: vi.fn(() => 16384),
    probeVllmContextWindow: vi.fn(() => 262144),
    defaultCloudContextWindow: vi.fn(() => 131072),
    ...over,
  };
}

describe("resolveContextWindowForModel", () => {
  it("ollama-local: warms the model, then returns the probed window", () => {
    const deps = makeDeps({ probeOllamaContextWindow: vi.fn(() => 16384) });

    expect(resolveContextWindowForModel("ollama-local", "qwen2.5:7b", deps)).toBe(16384);
    expect(deps.warmOllamaModel).toHaveBeenCalledWith("qwen2.5:7b");
    expect(deps.defaultCloudContextWindow).not.toHaveBeenCalled();
  });

  it("ollama-local: returns null when the probe cannot read a window", () => {
    const deps = makeDeps({ probeOllamaContextWindow: vi.fn(() => null) });

    expect(resolveContextWindowForModel("ollama-local", "qwen2.5:7b", deps)).toBeNull();
    expect(deps.warmOllamaModel).toHaveBeenCalledTimes(1);
  });

  it("vllm-local: returns the probed max_model_len without warming", () => {
    const deps = makeDeps({ probeVllmContextWindow: vi.fn(() => 262144) });

    expect(resolveContextWindowForModel("vllm-local", "some-model", deps)).toBe(262144);
    expect(deps.probeVllmContextWindow).toHaveBeenCalledWith("some-model");
    expect(deps.warmOllamaModel).not.toHaveBeenCalled();
    expect(deps.probeOllamaContextWindow).not.toHaveBeenCalled();
  });

  it("vllm-local: returns null when the server is unreachable", () => {
    const deps = makeDeps({ probeVllmContextWindow: vi.fn(() => null) });

    expect(resolveContextWindowForModel("vllm-local", "some-model", deps)).toBeNull();
    expect(deps.warmOllamaModel).not.toHaveBeenCalled();
  });

  it("cloud provider: returns the default window without warming or probing", () => {
    const deps = makeDeps({ defaultCloudContextWindow: vi.fn(() => 131072) });

    expect(
      resolveContextWindowForModel("nvidia-prod", "nvidia/nemotron-3-super-120b-a12b", deps),
    ).toBe(131072);
    expect(deps.warmOllamaModel).not.toHaveBeenCalled();
    expect(deps.probeOllamaContextWindow).not.toHaveBeenCalled();
  });
});

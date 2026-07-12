// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

// The helper under test takes its collaborators via injected deps, so these
// mocks only keep the transitive module graph from loading the real inference
// stack — the default deps object references them but the tests never use it.
vi.mock("../inference/local", () => ({ isLocalProviderHostHealthy: vi.fn() }));
vi.mock("../inference/ollama/proxy", () => ({
  ensureOllamaAuthProxy: vi.fn(),
  isProxyHealthy: vi.fn(),
}));
vi.mock("../adapters/docker/runtime", () => ({ detectContainerRuntimeFromDockerInfo: vi.fn() }));
vi.mock("./ollama-systemd", () => ({ ensureOllamaLoopbackSystemdOverride: vi.fn() }));

import {
  ensureLocalProviderReachable,
  type LocalProviderReachabilityDeps,
} from "./local-inference-topology";

function makeDeps(
  over: Partial<LocalProviderReachabilityDeps> = {},
): LocalProviderReachabilityDeps {
  return {
    shouldFrontOllamaWithProxy: vi.fn(() => true),
    ensureOllamaAuthProxy: vi.fn(),
    isProxyHealthy: vi.fn(() => true),
    isLocalProviderHostHealthy: vi.fn(() => true),
    ...over,
  };
}

describe("ensureLocalProviderReachable", () => {
  it("ollama-local behind the proxy: ensures the proxy and returns its health (healthy)", () => {
    const deps = makeDeps({ isProxyHealthy: vi.fn(() => true) });

    expect(ensureLocalProviderReachable("ollama-local", deps)).toBe(true);
    expect(deps.ensureOllamaAuthProxy).toHaveBeenCalledTimes(1);
    expect(deps.isProxyHealthy).toHaveBeenCalledTimes(1);
    // The proxy is the authoritative signal — no host fallback.
    expect(deps.isLocalProviderHostHealthy).not.toHaveBeenCalled();
  });

  it("ollama-local behind the proxy: returns false when the proxy stays unhealthy", () => {
    const deps = makeDeps({ isProxyHealthy: vi.fn(() => false) });

    expect(ensureLocalProviderReachable("ollama-local", deps)).toBe(false);
    expect(deps.ensureOllamaAuthProxy).toHaveBeenCalledTimes(1);
    expect(deps.isLocalProviderHostHealthy).not.toHaveBeenCalled();
  });

  it("ollama-local without the proxy front: uses the host health signal, not the proxy", () => {
    const deps = makeDeps({
      shouldFrontOllamaWithProxy: vi.fn(() => false),
      isLocalProviderHostHealthy: vi.fn(() => true),
    });

    expect(ensureLocalProviderReachable("ollama-local", deps)).toBe(true);
    expect(deps.ensureOllamaAuthProxy).not.toHaveBeenCalled();
    expect(deps.isProxyHealthy).not.toHaveBeenCalled();
    expect(deps.isLocalProviderHostHealthy).toHaveBeenCalledWith("ollama-local");
  });

  it("vllm-local: reachable when the host endpoint responds", () => {
    const deps = makeDeps({ isLocalProviderHostHealthy: vi.fn(() => true) });

    expect(ensureLocalProviderReachable("vllm-local", deps)).toBe(true);
    expect(deps.ensureOllamaAuthProxy).not.toHaveBeenCalled();
    expect(deps.isLocalProviderHostHealthy).toHaveBeenCalledWith("vllm-local");
  });

  it("vllm-local: unreachable when the host endpoint does not respond", () => {
    const deps = makeDeps({ isLocalProviderHostHealthy: vi.fn(() => false) });

    expect(ensureLocalProviderReachable("vllm-local", deps)).toBe(false);
    expect(deps.ensureOllamaAuthProxy).not.toHaveBeenCalled();
  });
});

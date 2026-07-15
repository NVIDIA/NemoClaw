// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The helper under test takes its collaborators via injected deps, so these
// mocks only keep the transitive module graph from loading the real inference
// stack — the default deps object references them but the tests never use it.
vi.mock("../inference/local", () => ({
  applyOllamaRuntimeContextWindow: vi.fn(),
  findReachableOllamaHost: vi.fn(),
  isLocalProviderHostHealthy: vi.fn(),
  validateOllamaModel: vi.fn(),
}));
vi.mock("../inference/ollama/proxy", () => ({
  ensureOllamaAuthProxy: vi.fn(),
  isProxyHealthy: vi.fn(),
}));
vi.mock("../adapters/docker/runtime", () => ({ detectContainerRuntimeFromDockerInfo: vi.fn() }));
vi.mock("./ollama-systemd", () => ({ ensureOllamaLoopbackSystemdOverride: vi.fn() }));

import {
  applyOllamaRuntimeContextWindow,
  findReachableOllamaHost,
  validateOllamaModel,
} from "../inference/local";
import {
  MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW,
  MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
} from "../inference/ollama-runtime-context";
import {
  ensureLocalProviderReachable,
  type LocalProviderReachabilityDeps,
  repairLocalInferenceSystemdOverrideOrExit,
} from "./local-inference-topology";
import { ensureOllamaLoopbackSystemdOverride } from "./ollama-systemd";

const mockedApplyRuntimeContext = vi.mocked(applyOllamaRuntimeContextWindow);
const mockedFindReachableHost = vi.mocked(findReachableOllamaHost);
const mockedValidateModel = vi.mocked(validateOllamaModel);
const mockedEnsureSystemdOverride = vi.mocked(ensureOllamaLoopbackSystemdOverride);

beforeEach(() => {
  vi.clearAllMocks();
  mockedEnsureSystemdOverride.mockReturnValue("ready");
  mockedFindReachableHost.mockReturnValue("127.0.0.1");
  mockedValidateModel.mockReturnValue({ ok: true });
  mockedApplyRuntimeContext.mockReturnValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("repairLocalInferenceSystemdOverrideOrExit (#6760)", () => {
  const recordedModel = "qwen3.5:35b";
  const isNonInteractive = vi.fn(() => true);

  function repairHermesResume(): void {
    repairLocalInferenceSystemdOverrideOrExit({
      provider: "ollama-local",
      model: recordedModel,
      contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
      isNonInteractive,
    });
  }

  function expectFailure(run: () => void, message: string): void {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`unexpected process.exit(${code})`);
    });

    expect(run).toThrow(message);
    expect(error).toHaveBeenCalledWith(`  ${message}`);
    expect(exit).not.toHaveBeenCalled();
  }

  it("warms the recorded Hermes model before verifying its runtime context", () => {
    const callOrder: string[] = [];
    mockedEnsureSystemdOverride.mockImplementation(() => {
      callOrder.push("systemd");
      return "ready";
    });
    mockedFindReachableHost.mockImplementation(() => {
      callOrder.push("host");
      return "127.0.0.1";
    });
    mockedValidateModel.mockImplementation(() => {
      callOrder.push("warm");
      return { ok: true };
    });
    mockedApplyRuntimeContext.mockImplementation(() => {
      callOrder.push("runtime-context");
      return { ok: true };
    });

    repairHermesResume();

    expect(mockedEnsureSystemdOverride).toHaveBeenCalledWith({
      isNonInteractive,
      contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
    });
    expect(mockedValidateModel).toHaveBeenCalledWith(recordedModel);
    expect(mockedApplyRuntimeContext).toHaveBeenCalledWith(recordedModel, {
      contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
    });
    expect(callOrder).toEqual(["systemd", "host", "warm", "runtime-context"]);
  });

  it("preserves the legacy OpenClaw loopback-only repair", () => {
    repairLocalInferenceSystemdOverrideOrExit({
      provider: "ollama-local",
      model: recordedModel,
      contextWindowFloor: MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW,
      isNonInteractive,
    });

    expect(mockedEnsureSystemdOverride).toHaveBeenCalledWith({
      isNonInteractive,
      contextWindowFloor: MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW,
    });
    expect(mockedFindReachableHost).not.toHaveBeenCalled();
    expect(mockedValidateModel).not.toHaveBeenCalled();
    expect(mockedApplyRuntimeContext).not.toHaveBeenCalled();
  });

  it("rejects a strict resume when the recorded model is missing", () => {
    expectFailure(
      () =>
        repairLocalInferenceSystemdOverrideOrExit({
          provider: "ollama-local",
          model: null,
          contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
          isNonInteractive,
        }),
      "The recorded Ollama model is missing, so its runtime context window cannot be verified.",
    );
    expect(mockedFindReachableHost).not.toHaveBeenCalled();
  });

  it("rejects a strict resume when Ollama is unreachable", () => {
    mockedFindReachableHost.mockReturnValue(null);

    expectFailure(
      repairHermesResume,
      "Ollama is not reachable, so the recorded model's runtime context window cannot be verified.",
    );
    expect(mockedValidateModel).not.toHaveBeenCalled();
    expect(mockedApplyRuntimeContext).not.toHaveBeenCalled();
  });

  it("rejects a strict resume when the recorded model cannot be warmed", () => {
    mockedValidateModel.mockReturnValue({ ok: false, message: "recorded model did not answer" });

    expectFailure(repairHermesResume, "recorded model did not answer");
    expect(mockedApplyRuntimeContext).not.toHaveBeenCalled();
  });

  it.each([
    "The recorded model is not loaded.",
    "Ollama did not report a runtime context window.",
    "Ollama reported a malformed runtime context window.",
    "Ollama loaded the recorded model below 64000 tokens.",
  ])("rejects an incomplete strict runtime proof: %s", (message) => {
    mockedApplyRuntimeContext.mockReturnValue({ ok: false, message });

    expectFailure(repairHermesResume, message);
  });
});

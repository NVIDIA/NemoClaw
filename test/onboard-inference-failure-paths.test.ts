// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupInference, SetupInferenceDeps } from "../src/lib/onboard/setup-inference.js";
import {
  createDirectSetupInferenceHarnessFactory,
  directRunResult,
} from "./support/setup-inference-test-harness.js";

const onboard = require("../src/lib/onboard") as {
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
};
const bedrockRuntimeOnboard =
  require("../src/lib/onboard/bedrock-runtime") as typeof import("../src/lib/onboard/bedrock-runtime.js");
const createDirectSetupInferenceHarness = createDirectSetupInferenceHarnessFactory(
  onboard.createSetupInference,
);

type DirectSetupInferenceHarness = ReturnType<typeof createDirectSetupInferenceHarness>;

function stubProcessExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`EXIT_CALLED:${code ?? 0}`);
  }) as typeof process.exit);
}

function expectNoPostFailureSideEffects(harness: DirectSetupInferenceHarness): void {
  expect(harness.commands.map(({ command }) => command)).toEqual(["gateway select nemoclaw"]);
  expect(harness.verifyInferenceRoute).not.toHaveBeenCalled();
  expect(harness.verifyOnboardInferenceSmoke).not.toHaveBeenCalled();
  expect(harness.updateSandbox).not.toHaveBeenCalled();
}

describe("setupInference dependency failures", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("fails closed before provider registration when local vLLM validation fails", async () => {
    const exit = stubProcessExit();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const validateLocalProvider = vi.fn(() => ({
      ok: false,
      message: "vLLM is unreachable",
      diagnostic: "container probe failed",
    }));
    const getLocalProviderHealthCheck = vi.fn(() => ["curl", "-sf", "http://127.0.0.1:8000"]);
    const run = vi.fn(() => directRunResult({ status: 7 }));
    const harness = createDirectSetupInferenceHarness({
      overrides: { validateLocalProvider, getLocalProviderHealthCheck, run },
    });

    await expect(harness.setupInference("test-box", "meta-llama", "vllm-local")).rejects.toThrow(
      "EXIT_CALLED:1",
    );

    expect(validateLocalProvider).toHaveBeenCalledWith("vllm-local");
    expect(getLocalProviderHealthCheck).toHaveBeenCalledWith("vllm-local");
    expect(run).toHaveBeenCalledWith(["curl", "-sf", "http://127.0.0.1:8000"], {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith("  vLLM is unreachable");
    expect(error).toHaveBeenCalledWith("  Diagnostic: container probe failed");
    expectNoPostFailureSideEffects(harness);
  });

  it("propagates local vLLM health-check errors before provider registration", async () => {
    const exit = stubProcessExit();
    const run = vi.fn(() => directRunResult());
    const getLocalProviderHealthCheck = vi.fn(() => {
      throw new Error("health probe exploded");
    });
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        validateLocalProvider: () => ({ ok: false, message: "vLLM is unreachable" }),
        getLocalProviderHealthCheck,
        run,
      },
    });

    await expect(harness.setupInference("test-box", "meta-llama", "vllm-local")).rejects.toThrow(
      "health probe exploded",
    );

    expect(getLocalProviderHealthCheck).toHaveBeenCalledWith("vllm-local");
    expect(run).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expectNoPostFailureSideEffects(harness);
  });

  it("propagates Ollama proxy startup errors before reading credentials", async () => {
    const exit = stubProcessExit();
    const ensureOllamaAuthProxy = vi.fn(() => {
      throw new Error("proxy startup failed");
    });
    const getOllamaProxyToken = vi.fn(() => "unused-token");
    const persistAndProbeOllamaProxy = vi.fn(async () => {});
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        shouldFrontOllamaWithProxy: () => true,
        ensureOllamaAuthProxy,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
      },
    });

    await expect(harness.setupInference("test-box", "qwen3.5:9b", "ollama-local")).rejects.toThrow(
      "proxy startup failed",
    );

    expect(ensureOllamaAuthProxy).toHaveBeenCalledOnce();
    expect(getOllamaProxyToken).not.toHaveBeenCalled();
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expectNoPostFailureSideEffects(harness);
  });

  it("fails closed when the recovered Ollama proxy remains unhealthy", async () => {
    const exit = stubProcessExit();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ensureOllamaAuthProxy = vi.fn();
    const isProxyHealthy = vi.fn(() => false);
    const getOllamaProxyToken = vi.fn(() => "unused-token");
    const persistAndProbeOllamaProxy = vi.fn(async () => {});
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        validateLocalProvider: () => ({
          ok: false,
          message: "container cannot reach Ollama",
          diagnostic: "proxy probe failed",
        }),
        shouldFrontOllamaWithProxy: () => true,
        ensureOllamaAuthProxy,
        isProxyHealthy,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
      },
    });

    await expect(harness.setupInference("test-box", "qwen3.5:9b", "ollama-local")).rejects.toThrow(
      "EXIT_CALLED:1",
    );

    expect(ensureOllamaAuthProxy).toHaveBeenCalledOnce();
    expect(isProxyHealthy).toHaveBeenCalledOnce();
    expect(getOllamaProxyToken).not.toHaveBeenCalled();
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith("  container cannot reach Ollama");
    expect(error).toHaveBeenCalledWith("  Diagnostic: proxy probe failed");
    expectNoPostFailureSideEffects(harness);
  });

  it("fails closed when proxy-fronted Ollama has no credential token", async () => {
    const exit = stubProcessExit();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ensureOllamaAuthProxy = vi.fn();
    const getOllamaProxyToken = vi.fn(() => null);
    const persistAndProbeOllamaProxy = vi.fn(async () => {});
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        shouldFrontOllamaWithProxy: () => true,
        ensureOllamaAuthProxy,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
      },
    });

    await expect(harness.setupInference("test-box", "qwen3.5:9b", "ollama-local")).rejects.toThrow(
      "EXIT_CALLED:1",
    );

    expect(ensureOllamaAuthProxy).toHaveBeenCalledOnce();
    expect(getOllamaProxyToken).toHaveBeenCalledOnce();
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      "  Ollama auth proxy token is not set. Re-run onboard to initialize the proxy.",
    );
    expectNoPostFailureSideEffects(harness);
  });

  it("propagates Ollama proxy persistence errors before provider registration", async () => {
    const exit = stubProcessExit();
    const persistAndProbeOllamaProxy = vi.fn(async () => {
      throw new Error("proxy persistence failed");
    });
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        shouldFrontOllamaWithProxy: () => true,
        ensureOllamaAuthProxy: () => {},
        getOllamaProxyToken: () => "proxy-token",
        persistAndProbeOllamaProxy,
      },
    });

    await expect(harness.setupInference("test-box", "qwen3.5:9b", "ollama-local")).rejects.toThrow(
      "proxy persistence failed",
    );

    expect(persistAndProbeOllamaProxy).toHaveBeenCalledWith("proxy-token");
    expect(exit).not.toHaveBeenCalled();
    expectNoPostFailureSideEffects(harness);
  });

  it("returns to provider selection when the Bedrock adapter cannot start", async () => {
    vi.stubEnv("COMPATIBLE_ANTHROPIC_API_KEY", "bedrock-bearer");
    const exit = stubProcessExit();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ensureAdapter = vi.fn(async () => {
      throw new Error("adapter unavailable");
    });
    const setupBedrockRuntimeInference = bedrockRuntimeOnboard.setupBedrockRuntimeInference;
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        bedrockRuntimeOnboard: {
          setupBedrockRuntimeInference: (input) =>
            setupBedrockRuntimeInference({ ...input, ensureAdapter }),
        },
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        "anthropic.claude-3-5-sonnet-20240620-v1:0",
        "compatible-anthropic-endpoint",
        "https://bedrock-runtime.us-east-1.amazonaws.com",
        "COMPATIBLE_ANTHROPIC_API_KEY",
      ),
    ).resolves.toEqual({ retry: "selection" });

    expect(ensureAdapter).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "  Failed to start Bedrock Runtime adapter: adapter unavailable",
    );
    expect(exit).not.toHaveBeenCalled();
    expectNoPostFailureSideEffects(harness);
  });

  it("uses an injected Hermes DNS lookup before rejecting an unpinnable HTTPS endpoint", async () => {
    const exit = stubProcessExit();
    const lookup = vi.fn<NonNullable<SetupInferenceDeps["lookup"]>>(async () => [
      { address: "8.8.8.8", family: 4 },
    ]);
    const harness = createDirectSetupInferenceHarness({ overrides: { lookup } });

    await expect(
      harness.setupInference(
        "test-box",
        "moonshotai/kimi-k2.6",
        "hermes-provider",
        "https://api.public.example.test/v1",
      ),
    ).rejects.toThrow("DNS-backed HTTPS URLs are not supported");

    expect(lookup).toHaveBeenCalledWith("api.public.example.test", { all: true });
    expect(exit).not.toHaveBeenCalled();
    expectNoPostFailureSideEffects(harness);
  });

  it("fails closed before routed-provider registration when model-router reconciliation fails", async () => {
    const exit = stubProcessExit();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const reconcileModelRouter = vi.fn(async () => {
      throw new Error("router unavailable");
    });
    const upsertRoutedProvider = vi.fn(() => ({ ok: true, result: {} }));
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isRoutedInferenceProvider: (provider) => provider === "nvidia-router",
        reconcileModelRouter,
        routedInference: { upsertRoutedProvider },
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        "router/model",
        "nvidia-router",
        "http://host.openshell.internal:4000/v1",
        "NVIDIA_INFERENCE_API_KEY",
      ),
    ).rejects.toThrow("EXIT_CALLED:1");

    expect(reconcileModelRouter).toHaveBeenCalledOnce();
    expect(upsertRoutedProvider).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith("  ✗ Failed to start model router: router unavailable");
    expectNoPostFailureSideEffects(harness);
  });
});

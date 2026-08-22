// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { setupOllamaLocalInference } from "./inference-providers/ollama-local";
import { createProviderReviewDeps } from "./setup-inference";

describe("createProviderReviewDeps", () => {
  it("prepares the Ollama proxy after review acceptance", async () => {
    const updateSession = vi.fn();
    const checkpointSandboxName = vi.fn(async () => undefined);
    const startOllamaAuthProxy = vi.fn(() => true);
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const getOllamaProxyToken = vi.fn(() => "proxy-token");
    const deps = createProviderReviewDeps(
      updateSession,
      checkpointSandboxName,
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
      },
      exitProcess,
      vi.fn(),
    );

    const preparedToken = await deps.prepareLocalProviderForInference("ollama-local");

    expect(startOllamaAuthProxy).toHaveBeenCalledOnce();
    expect(getOllamaProxyToken).toHaveBeenCalledOnce();
    expect(persistAndProbeOllamaProxy).toHaveBeenCalledWith("proxy-token");
    expect(preparedToken).toBe("proxy-token");
  });

  it("does not mutate local provider state for another provider", async () => {
    const startOllamaAuthProxy = vi.fn(() => true);
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const deps = createProviderReviewDeps(
      vi.fn(),
      vi.fn(async () => undefined),
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy,
        getOllamaProxyToken: () => "proxy-token",
        persistAndProbeOllamaProxy,
      },
      (code): never => {
        throw new Error(`exit ${code}`);
      },
      vi.fn(),
    );

    await expect(deps.prepareLocalProviderForInference("nvidia-prod")).resolves.toBeNull();

    expect(startOllamaAuthProxy).not.toHaveBeenCalled();
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
  });

  it("exits without persisting when the Ollama proxy cannot start", async () => {
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const deps = createProviderReviewDeps(
      vi.fn(),
      vi.fn(async () => undefined),
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy: () => false,
        getOllamaProxyToken: () => "proxy-token",
        persistAndProbeOllamaProxy,
      },
      exitProcess,
      vi.fn(),
    );

    await expect(deps.prepareLocalProviderForInference("ollama-local")).rejects.toThrow("exit 1");

    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
  });

  it("exits without persisting when the Ollama proxy token is unavailable", async () => {
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const writeError = vi.fn();
    const deps = createProviderReviewDeps(
      vi.fn(),
      vi.fn(async () => undefined),
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy: () => true,
        getOllamaProxyToken: () => null,
        persistAndProbeOllamaProxy,
      },
      exitProcess,
      writeError,
    );

    await expect(deps.prepareLocalProviderForInference("ollama-local")).rejects.toThrow("exit 1");

    expect(writeError).toHaveBeenCalledWith(expect.stringContaining("proxy token is not set"));
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
  });

  it("hands the accepted proxy token to provider setup without repeating proxy mutations", async () => {
    const startOllamaAuthProxy = vi.fn(() => true);
    const getOllamaProxyToken = vi.fn(() => "proxy-token");
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const reviewDeps = createProviderReviewDeps(
      vi.fn(),
      vi.fn(async () => undefined),
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
      },
      (code): never => {
        throw new Error(`exit ${code}`);
      },
      vi.fn(),
    );
    const preparedProxyToken = await reviewDeps.prepareLocalProviderForInference("ollama-local");
    const ensureOllamaAuthProxy = vi.fn();

    await setupOllamaLocalInference(
      {
        model: "qwen3.5:9b",
        provider: "ollama-local",
        allowToolsIncompatible: false,
        preparedProxyToken: preparedProxyToken ?? undefined,
      },
      {
        runOpenshell: () => ({ status: 0 }),
        upsertProvider: () => ({ ok: true }),
        verifyInferenceRoute: vi.fn(),
        verifyOnboardInferenceSmoke: vi.fn(),
        isNonInteractive: () => true,
        registry: { updateSandbox: vi.fn() as never },
        exitProcess: (code): never => {
          throw new Error(`exit ${code}`);
        },
        error: vi.fn(),
        log: vi.fn(),
        validateLocalProvider: () => ({ ok: true }),
        getLocalProviderBaseUrl: () => "http://host.openshell.internal:11435/v1",
        applyLocalInferenceRoute: async () => false,
        getOllamaWarmupCommand: () => ["ollama", "run", "qwen3.5:9b"],
        run: vi.fn() as never,
        shouldFrontOllamaWithProxy: () => true,
        ensureOllamaAuthProxy,
        isProxyHealthy: () => true,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
        localInference: {
          validateOllamaModelWithToolsOverride: () => ({ ok: true }),
          validateSandboxFacingOllamaModel: () => ({ ok: true }),
        },
        OLLAMA_PROXY_CREDENTIAL_ENV: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      },
    );

    expect(startOllamaAuthProxy).toHaveBeenCalledOnce();
    expect(getOllamaProxyToken).toHaveBeenCalledOnce();
    expect(persistAndProbeOllamaProxy).toHaveBeenCalledOnce();
    expect(ensureOllamaAuthProxy).not.toHaveBeenCalled();
  });
});

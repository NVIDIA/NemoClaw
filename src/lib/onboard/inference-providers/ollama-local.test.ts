// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { setupOllamaLocalInference } from "./ollama-local";
import type { OllamaDeps } from "./types";

const CREDENTIAL_ENV = "NEMOCLAW_OLLAMA_PROXY_TOKEN";

const SANDBOX_ENDPOINT_MISMATCH =
  "Selected Ollama model 'llama3.2:1b' answers on http://127.0.0.1:11434, but the daemon the " +
  "sandbox reaches through http://host.openshell.internal:11434 does not serve it " +
  "(reported models: qwen3.5:2b, gemma4:26b).";

function deps(overrides: Partial<OllamaDeps> = {}): OllamaDeps {
  return {
    runOpenshell: vi.fn(() => ({ status: 0 })),
    upsertProvider: vi.fn(() => ({ ok: true })),
    verifyInferenceRoute: vi.fn(),
    verifyOnboardInferenceSmoke: vi.fn(),
    isNonInteractive: () => true,
    registry: { updateSandbox: vi.fn() as OllamaDeps["registry"]["updateSandbox"] },
    exitProcess: (code) => {
      throw new Error(`exit ${code}`);
    },
    error: vi.fn(),
    log: vi.fn(),
    validateLocalProvider: () => ({ ok: true }),
    getLocalProviderBaseUrl: () => "http://host.openshell.internal:11434/v1",
    applyLocalInferenceRoute: async () => false,
    getOllamaWarmupCommand: () => ["ollama", "run", "llama3.2:1b"],
    run: vi.fn(() => ({ status: 0 })),
    shouldFrontOllamaWithProxy: () => false,
    ensureOllamaAuthProxy: vi.fn(),
    isProxyHealthy: () => true,
    getOllamaProxyToken: () => "token",
    persistAndProbeOllamaProxy: async () => {},
    localInference: {
      validateOllamaModelWithToolsOverride: () => ({ ok: true }),
      validateSandboxFacingOllamaModel: () => ({ ok: true }),
    },
    OLLAMA_PROXY_CREDENTIAL_ENV: CREDENTIAL_ENV,
    ...overrides,
  };
}

describe("Ollama local provider sandbox-facing model gate", () => {
  it("refuses to record a route the sandbox endpoint cannot serve (#9454)", async () => {
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const error = vi.fn();
    const validateSandboxFacingOllamaModel = vi.fn(() => ({
      ok: false,
      message: SANDBOX_ENDPOINT_MISMATCH,
    }));

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          upsertProvider,
          error,
          localInference: {
            validateOllamaModelWithToolsOverride: () => ({ ok: true }),
            validateSandboxFacingOllamaModel,
          },
        }),
      ),
    ).rejects.toThrow("exit 1");

    expect(validateSandboxFacingOllamaModel).toHaveBeenCalledWith("llama3.2:1b");
    expect(upsertProvider).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(`  ${SANDBOX_ENDPOINT_MISMATCH}`);
  });

  it("blocks even when every host-side check passes (#9454)", async () => {
    const validateOllamaModelWithToolsOverride = vi.fn(() => ({ ok: true }));
    const run = vi.fn(() => ({ status: 0 }));

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          run,
          validateLocalProvider: () => ({ ok: true }),
          localInference: {
            validateOllamaModelWithToolsOverride,
            validateSandboxFacingOllamaModel: () => ({
              ok: false,
              message: SANDBOX_ENDPOINT_MISMATCH,
            }),
          },
        }),
      ),
    ).rejects.toThrow("exit 1");

    expect(validateOllamaModelWithToolsOverride).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("records the route when the sandbox endpoint serves the model", async () => {
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const persistResolvedOllamaHost = vi.fn();

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          upsertProvider,
          localInference: {
            validateOllamaModelWithToolsOverride: () => ({ ok: true }),
            validateSandboxFacingOllamaModel: () => ({ ok: true }),
            persistResolvedOllamaHost,
          },
        }),
      ),
    ).resolves.toEqual({ done: false });

    expect(upsertProvider).toHaveBeenCalledWith(
      "ollama-local",
      "openai",
      CREDENTIAL_ENV,
      "http://host.openshell.internal:11434/v1",
      { [CREDENTIAL_ENV]: "ollama" },
    );
    expect(persistResolvedOllamaHost).toHaveBeenCalledOnce();
  });

  it("fails setup when the accepted cleanup route cannot be persisted", async () => {
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const error = vi.fn();

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          upsertProvider,
          error,
          localInference: {
            validateOllamaModelWithToolsOverride: () => ({ ok: true }),
            validateSandboxFacingOllamaModel: () => ({ ok: true }),
            persistResolvedOllamaHost: () => {
              throw new Error("state path is unsafe");
            },
          },
        }),
      ),
    ).rejects.toThrow("exit 1");

    expect(upsertProvider).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("state path is unsafe"));
  });

  it("does not persist a route when provider registration fails", async () => {
    const persistResolvedOllamaHost = vi.fn();

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          upsertProvider: () => ({ ok: false, status: 1, message: "provider rejected" }),
          localInference: {
            validateOllamaModelWithToolsOverride: () => ({ ok: true }),
            validateSandboxFacingOllamaModel: () => ({ ok: true }),
            persistResolvedOllamaHost,
          },
        }),
      ),
    ).rejects.toThrow("exit 1");

    expect(persistResolvedOllamaHost).not.toHaveBeenCalled();
  });

  it("does not persist a route when route application requests reselection", async () => {
    const persistResolvedOllamaHost = vi.fn();

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          applyLocalInferenceRoute: async () => true,
          localInference: {
            validateOllamaModelWithToolsOverride: () => ({ ok: true }),
            validateSandboxFacingOllamaModel: () => ({ ok: true }),
            persistResolvedOllamaHost,
          },
        }),
      ),
    ).resolves.toEqual({ done: true, result: { retry: "selection" } });

    expect(persistResolvedOllamaHost).not.toHaveBeenCalled();
  });
});

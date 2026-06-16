// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, it, vi } from "vitest";

import { createSetupNimOllamaHandlers } from "./setup-nim-ollama";
import type { SetupNimSelectionState } from "./setup-nim-selection";

function makeState(): SetupNimSelectionState {
  return {
    model: null,
    provider: "nvidia-prod",
    endpointUrl: null,
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    nimContainer: null,
    allowToolsIncompatible: false,
  };
}

type Deps = Parameters<typeof createSetupNimOllamaHandlers>[0];

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    OLLAMA_PORT: 11434,
    OLLAMA_PROXY_PORT: 11435,
    process,
    isNonInteractive: () => true,
    prompt: async () => "y",
    checkOllamaPortsOrWarn: () => true,
    ensureOllamaLoopbackSystemdOverride: () => "unchanged",
    runOllamaStartupOrGate: () => ({ kind: "ready" }),
    shouldFrontOllamaWithProxy: () => false,
    startOllamaAuthProxy: () => true,
    getLocalProviderBaseUrl: () => "http://127.0.0.1:11434/v1",
    selectAndValidateOllamaModel: async () => ({
      outcome: "selected",
      model: "llama3.1:8b",
      allowToolsIncompatible: true,
    }),
    printOllamaExposureWarning: () => {},
    switchToWindowsOllamaHost: () => {},
    installOllamaOnWindowsHost: async () => ({ ok: true, path: "C:/Ollama/ollama.exe" }),
    awaitWindowsOllamaReady: () => true,
    setupWindowsOllamaWith0000Binding: () => true,
    printWindowsOllamaTimeoutDiagnostics: () => {},
    resetOllamaHostCache: () => {},
    installOllamaOnMacOS: () => ({ ok: true }),
    installOllamaOnLinux: () => ({ ok: true }),
    abortNonInteractive: (message: string): never => {
      throw new Error(message);
    },
    assertOllamaUpgradeApplied: () => ({ ok: true }),
    ...overrides,
  };
}

describe("createSetupNimOllamaHandlers", () => {
  it("preserves accepted tools-incompatible state for running Ollama", async () => {
    const state = makeState();
    const { handleRunningOllamaSelection } = createSetupNimOllamaHandlers(makeDeps());

    const result = await handleRunningOllamaSelection(null, "requested", "recovered", true, state);

    assert.equal(result, "selected");
    assert.equal(state.model, "llama3.1:8b");
    assert.equal(state.provider, "ollama-local");
    assert.equal(state.allowToolsIncompatible, true);
  });

  it("preserves accepted tools-incompatible state for Windows-host Ollama", async () => {
    const state = makeState();
    const { handleWindowsHostOllamaSelection } = createSetupNimOllamaHandlers(makeDeps());

    const result = await handleWindowsHostOllamaSelection(
      null,
      "start-windows-ollama",
      "requested",
      true,
      false,
      null,
      state,
    );

    assert.equal(result, "selected");
    assert.equal(state.provider, "ollama-local");
    assert.equal(state.allowToolsIncompatible, true);
  });

  it("preserves accepted tools-incompatible state for installed Ollama", async () => {
    const state = makeState();
    const { handleInstallOllamaSelection } = createSetupNimOllamaHandlers(makeDeps());

    const result = await handleInstallOllamaSelection(null, "requested", "recovered", state, {
      hasUpgradableOllama: false,
    });

    assert.equal(result, "selected");
    assert.equal(state.provider, "ollama-local");
    assert.equal(state.allowToolsIncompatible, true);
  });

  it("fails closed on unknown Ollama startup outcomes without mutating state", async () => {
    const state = makeState();
    const before = { ...state, hermesToolGateways: [...state.hermesToolGateways] };
    const exit = vi.fn((code?: number) => {
      throw new Error(`exit ${code}`);
    });
    const startProxy = vi.fn(() => true);
    const selectModel = vi.fn(async () => ({
      outcome: "selected" as const,
      model: "should-not-run",
      allowToolsIncompatible: true,
    }));
    const { handleRunningOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        process: { ...process, exit: exit as never },
        runOllamaStartupOrGate: () => ({ kind: "mystery" }) as never,
        startOllamaAuthProxy: startProxy,
        selectAndValidateOllamaModel: selectModel,
      }),
    );

    await assert.rejects(
      handleRunningOllamaSelection(null, "requested", "recovered", true, state),
      /exit 1/,
    );

    assert.deepEqual(state, before);
    assert.equal(exit.mock.calls[0]?.[0], 1);
    assert.equal(startProxy.mock.calls.length, 0);
    assert.equal(selectModel.mock.calls.length, 0);
  });

  it("applies a complete safe fallback state from a dirty prior selection", async () => {
    const state = makeState();
    state.provider = "openai-api";
    state.endpointUrl = "https://api.openai.example/v1";
    state.credentialEnv = "OPENAI_API_KEY";
    state.model = "gpt-stale";
    state.preferredInferenceApi = "responses";
    state.nimContainer = "stale-nim";
    state.allowToolsIncompatible = true;
    const startProxy = vi.fn(() => true);
    const selectModel = vi.fn(async () => ({
      outcome: "selected" as const,
      model: "should-not-run",
      allowToolsIncompatible: true,
    }));
    const { handleRunningOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        runOllamaStartupOrGate: () => ({
          kind: "fallback",
          result: {
            provider: "ollama-local",
            credentialEnv: null,
            endpointUrl: "http://127.0.0.1:11434/v1",
            model: "qwen3:0.6b",
            preferredInferenceApi: "openai-completions",
          },
        }),
        startOllamaAuthProxy: startProxy,
        selectAndValidateOllamaModel: selectModel,
      }),
    );

    const result = await handleRunningOllamaSelection(null, "requested", "recovered", false, state);

    assert.equal(result, "selected");
    assert.deepEqual(state, {
      model: "qwen3:0.6b",
      provider: "ollama-local",
      endpointUrl: "http://127.0.0.1:11434/v1",
      credentialEnv: null,
      hermesAuthMethod: null,
      hermesToolGateways: [],
      preferredInferenceApi: "openai-completions",
      nimContainer: null,
      allowToolsIncompatible: false,
    });
    assert.equal(startProxy.mock.calls.length, 0);
    assert.equal(selectModel.mock.calls.length, 0);
  });
});

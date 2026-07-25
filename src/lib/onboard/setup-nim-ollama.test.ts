// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MIN_HERMES_OLLAMA_CONTEXT_WINDOW } from "../inference/ollama-runtime-context";
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
    skipHostInferenceSmoke: false,
  };
}

type Deps = Parameters<typeof createSetupNimOllamaHandlers>[0];

afterEach(() => {
  vi.restoreAllMocks();
});

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
  it("guards the selected route before systemd recovery and model preparation (#6315)", async () => {
    const events: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const state = makeState();
    state.assertRouteCompatible = () => {
      events.push(`guard:${String(state.model)}`);
      return {
        requiredModel: "required/model",
        requiredEndpointUrl: null,
        requiredInferenceApi: null,
      };
    };
    const { handleRunningOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        isNonInteractive: () => false,
        ensureOllamaLoopbackSystemdOverride: () => {
          events.push("systemd");
          return "unchanged";
        },
        selectAndValidateOllamaModel: async (_gpu, _provider, args, onModelSelected) => {
          expect(args.lockedModel).toBe("required/model");
          expect(args.promptDefaultModel).toBeNull();
          events.push("prepare-model");
          onModelSelected?.("required/model");
          return { outcome: "selected", model: "required/model", allowToolsIncompatible: false };
        },
      }),
    );

    await handleRunningOllamaSelection(null, "required/model", null, true, state);

    expect(events).toEqual([
      "guard:required/model",
      "systemd",
      "prepare-model",
      "guard:required/model",
    ]);
    expect(log.mock.calls.map(([message]) => message)).toContain(
      "  Shared gateway route requires Ollama model 'required/model'.",
    );
    expect(log.mock.calls.map(([message]) => message)).toContain(
      "  To use a different model for this agent, rerun with an unused NEMOCLAW_GATEWAY_PORT.",
    );
    log.mockRestore();
  });

  it("keeps shared-route guidance silent in non-interactive mode (#6758)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const selectModel = vi.fn<Deps["selectAndValidateOllamaModel"]>(async () => ({
      outcome: "selected" as const,
      model: "required/model",
      allowToolsIncompatible: false,
    }));
    const state = makeState();
    state.assertRouteCompatible = () => ({
      requiredModel: "required/model",
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    });
    const { handleRunningOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({ selectAndValidateOllamaModel: selectModel }),
    );

    await handleRunningOllamaSelection(null, "required/model", null, true, state);

    expect(selectModel.mock.calls[0]?.[2].lockedModel).toBe("required/model");
    expect(log).not.toHaveBeenCalledWith(
      "  Shared gateway route requires Ollama model 'required/model'.",
    );
    expect(log).not.toHaveBeenCalledWith(
      "  To use a different model for this agent, rerun with an unused NEMOCLAW_GATEWAY_PORT.",
    );
    log.mockRestore();
  });

  it("passes NEMOCLAW_MODEL as the interactive Ollama prompt default", async () => {
    const state = makeState();
    const selectModel = vi.fn(async (_gpu, _provider, args) => {
      expect(args.requestedModel).toBeNull();
      expect(args.lockedModel).toBeNull();
      expect(args.promptDefaultModel).toBe("qwen3.6:35b");
      return { outcome: "selected" as const, model: "qwen3.6:35b", allowToolsIncompatible: false };
    });
    const { handleRunningOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        isNonInteractive: () => false,
        process: {
          ...process,
          env: { ...process.env, NEMOCLAW_MODEL: "qwen3.6:35b" },
        } as NodeJS.Process,
        selectAndValidateOllamaModel: selectModel,
      }),
    );

    const result = await handleRunningOllamaSelection(null, null, null, true, state);

    expect(result).toBe("selected");
    expect(selectModel).toHaveBeenCalledTimes(1);
  });

  it("passes NEMOCLAW_PROVIDER_MODEL as the interactive Ollama prompt default fallback", async () => {
    const state = makeState();
    const selectModel = vi.fn(async (_gpu, _provider, args) => {
      expect(args.requestedModel).toBeNull();
      expect(args.lockedModel).toBeNull();
      expect(args.promptDefaultModel).toBe("qwen3.6:35b");
      return { outcome: "selected" as const, model: "qwen3.6:35b", allowToolsIncompatible: false };
    });
    const { handleRunningOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        isNonInteractive: () => false,
        process: {
          ...process,
          env: {
            ...process.env,
            NEMOCLAW_MODEL: undefined,
            NEMOCLAW_PROVIDER_MODEL: "qwen3.6:35b",
          },
        } as NodeJS.Process,
        selectAndValidateOllamaModel: selectModel,
      }),
    );

    const result = await handleRunningOllamaSelection(null, null, null, true, state);

    expect(result).toBe("selected");
    expect(selectModel).toHaveBeenCalledTimes(1);
  });

  it("does not install Ollama when shared-gateway preflight rejects", async () => {
    const state = makeState();
    state.assertRouteCompatible = () => {
      throw new Error("route conflict");
    };
    const install = vi.fn(() => ({ ok: true }));
    const { handleInstallOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({ installOllamaOnLinux: install, installOllamaOnMacOS: install }),
    );

    await expect(
      handleInstallOllamaSelection(null, "conflict/model", null, state, {
        hasUpgradableOllama: false,
      }),
    ).rejects.toThrow("route conflict");
    expect(install).not.toHaveBeenCalled();
  });

  it("does not switch, install, or restart Windows Ollama when preflight rejects", async () => {
    const state = makeState();
    state.assertRouteCompatible = () => {
      throw new Error("route conflict");
    };
    const switchHost = vi.fn();
    const install = vi.fn(async () => ({ ok: true }));
    const restart = vi.fn(() => true);
    const { handleWindowsHostOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        switchToWindowsOllamaHost: switchHost,
        installOllamaOnWindowsHost: install,
        setupWindowsOllamaWith0000Binding: restart,
      }),
    );

    await expect(
      handleWindowsHostOllamaSelection(
        null,
        "start-windows-ollama",
        "conflict/model",
        true,
        false,
        null,
        state,
      ),
    ).rejects.toThrow("route conflict");
    expect(switchHost).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("preserves accepted tools-incompatible state for running Ollama", async () => {
    const state = makeState();
    const { handleRunningOllamaSelection } = createSetupNimOllamaHandlers(makeDeps());

    const result = await handleRunningOllamaSelection(null, "requested", "recovered", true, state);

    assert.equal(result, "selected");
    assert.equal(state.model, "llama3.1:8b");
    assert.equal(state.provider, "ollama-local");
    assert.equal(state.allowToolsIncompatible, true);
  });

  it("uses the reachable Windows-host endpoint for running Ollama (#7472)", async () => {
    const state = makeState();
    const { handleRunningOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        getLocalProviderBaseUrl: () => "http://host.docker.internal:11434/v1",
      }),
    );

    const result = await handleRunningOllamaSelection(null, "qwen3.6:35b", null, true, state);

    expect(result).toBe("selected");
    expect(state).toMatchObject({
      model: "llama3.1:8b",
      provider: "ollama-local",
      endpointUrl: "http://host.docker.internal:11434/v1",
    });
  });

  it("passes the Hermes Ollama context floor to systemd repair and model validation", async () => {
    const state = makeState();
    state.ollamaContextWindowFloor = MIN_HERMES_OLLAMA_CONTEXT_WINDOW;
    const ensureOverride = vi.fn(() => "unchanged");
    const runStartup = vi.fn(() => ({ kind: "ready" as const }));
    const selectModel = vi.fn(async (_gpu, _provider, args) => {
      expect(args.contextWindowFloor).toBe(MIN_HERMES_OLLAMA_CONTEXT_WINDOW);
      return { outcome: "selected" as const, model: "llama3.2:1b", allowToolsIncompatible: false };
    });
    const { handleRunningOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        ensureOllamaLoopbackSystemdOverride: ensureOverride,
        runOllamaStartupOrGate: runStartup,
        selectAndValidateOllamaModel: selectModel,
      }),
    );

    const result = await handleRunningOllamaSelection(null, "llama3.2:1b", null, true, state);

    expect(result).toBe("selected");
    expect(ensureOverride).toHaveBeenCalledWith({
      isNonInteractive: expect.any(Function),
      contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
    });
    expect(runStartup).toHaveBeenCalledWith({
      ollamaReady: true,
      ollamaPort: 11434,
      getLocalProviderBaseUrl: expect.any(Function),
      isNonInteractive: expect.any(Function),
      contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
    });
    expect(selectModel).toHaveBeenCalledTimes(1);
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
      skipHostInferenceSmoke: false,
    });
    assert.equal(startProxy.mock.calls.length, 0);
    assert.equal(selectModel.mock.calls.length, 0);
  });
});

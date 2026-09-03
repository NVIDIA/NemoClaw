// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MIN_HERMES_OLLAMA_CONTEXT_WINDOW } from "../inference/ollama-runtime-context";
import { OllamaSelectionFatalError } from "./ollama-probe-failure";
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
    getLocalProviderBaseUrl: () => "http://127.0.0.1:11434/v1",
    selectAndValidateOllamaModel: async () => ({
      outcome: "selected",
      model: "llama3.1:8b",
      allowToolsIncompatible: true,
    }),
    printOllamaExposureWarning: () => {},
    switchToWindowsOllamaHost: () => {},
    installOllamaOnWindowsHost: async () => ({
      ok: true,
      path: "C:/Ollama/ollama.exe",
      commit: () => {},
      rollback: () => {},
    }),
    setupWindowsOllamaWith0000Binding: () => ({
      ok: true,
      commit: () => {},
      rollback: () => {},
    }),
    printWindowsOllamaSnapshotDiagnostics: () => {},
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
        binaryNeedsUpgrade: false,
      }),
    ).rejects.toThrow("route conflict");
    expect(install).not.toHaveBeenCalled();
  });

  it("stops before local Ollama install effects when sandbox identity changes (#9833)", async () => {
    const selection = makeState();
    selection.revalidateSandboxIdentity = () => {
      throw new Error("Sandbox identity changed before local inference");
    };
    const install = vi.fn(() => ({ ok: true }));
    const start = vi.fn(() => ({ kind: "ready" as const }));
    const { handleInstallOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        process: { ...process, platform: "linux" } as NodeJS.Process,
        installOllamaOnLinux: install,
        runOllamaStartupOrGate: start,
      }),
    );

    await expect(
      handleInstallOllamaSelection(null, "qwen3:8b", null, selection, {
        hasUpgradableOllama: false,
        binaryNeedsUpgrade: false,
      }),
    ).rejects.toThrow(/Sandbox identity changed before/u);

    expect(install).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("installs a missing binary while recovering a stale daemon", async () => {
    const install = vi.fn(() => ({ ok: true }));
    const { handleInstallOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        process: { ...process, platform: "linux" } as NodeJS.Process,
        installOllamaOnLinux: install,
      }),
    );

    await handleInstallOllamaSelection(null, "qwen3:8b", null, makeState(), {
      hasUpgradableOllama: true,
      binaryNeedsUpgrade: true,
    });

    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ isUpgrade: true, restartOnly: false }),
    );
  });

  it("does not switch, install, or restart Windows Ollama when preflight rejects", async () => {
    const state = makeState();
    state.assertRouteCompatible = () => {
      throw new Error("route conflict");
    };
    const switchHost = vi.fn();
    const install = vi.fn(async () => ({
      ok: true as const,
      path: "C:/Ollama/ollama.exe",
      commit: () => {},
      rollback: () => {},
    }));
    const restart = vi.fn(() => ({
      ok: true as const,
      commit: () => {},
      rollback: () => {},
    }));
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

  it("stops before Windows Ollama install effects when sandbox identity changes (#9833)", async () => {
    const selection = makeState();
    selection.revalidateSandboxIdentity = () => {
      throw new Error("Sandbox identity changed before local inference");
    };
    const install = vi.fn(async () => ({
      ok: true as const,
      path: "C:/Ollama/ollama.exe",
      commit: () => {},
      rollback: () => {},
    }));
    const start = vi.fn(() => ({
      ok: true as const,
      commit: () => {},
      rollback: () => {},
    }));
    const { handleWindowsHostOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        installOllamaOnWindowsHost: install,
        setupWindowsOllamaWith0000Binding: start,
      }),
    );

    await expect(
      handleWindowsHostOllamaSelection(
        null,
        "install-windows-ollama",
        "qwen3:8b",
        false,
        false,
        null,
        selection,
      ),
    ).rejects.toThrow(/Sandbox identity changed before/u);

    expect(install).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("reports a Windows snapshot failure without claiming a startup timeout", async () => {
    const snapshotDiagnostic = vi.fn();
    const timeoutDiagnostic = vi.fn();
    const { handleWindowsHostOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        isNonInteractive: () => false,
        printWindowsOllamaSnapshotDiagnostics: snapshotDiagnostic,
        printWindowsOllamaTimeoutDiagnostics: timeoutDiagnostic,
        setupWindowsOllamaWith0000Binding: () => ({ ok: false, reason: "snapshot" }),
      }),
    );

    await expect(
      handleWindowsHostOllamaSelection(
        null,
        "start-windows-ollama",
        "qwen3:8b",
        false,
        true,
        "C:/Ollama/ollama.exe",
        makeState(),
      ),
    ).resolves.toBe("retry-selection");

    expect(snapshotDiagnostic).toHaveBeenCalledOnce();
    expect(timeoutDiagnostic).not.toHaveBeenCalled();
  });

  it("commits a new Windows Ollama install after model selection", async () => {
    const commit = vi.fn();
    const rollback = vi.fn();
    const revalidate = vi.fn();
    const install = vi.fn(async (args: { beforeRestart: () => void }) => {
      args.beforeRestart();
      return {
        ok: true as const,
        path: "C:/Ollama/ollama.exe",
        commit,
        rollback,
      };
    });
    const state = makeState();
    state.revalidateSandboxIdentity = revalidate;
    const { handleWindowsHostOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({ installOllamaOnWindowsHost: install }),
    );

    await expect(
      handleWindowsHostOllamaSelection(
        null,
        "install-windows-ollama",
        "qwen3:8b",
        false,
        false,
        null,
        state,
      ),
    ).resolves.toBe("selected");

    expect(revalidate.mock.calls.map(([operation]) => operation)).toEqual([
      "install the Windows Ollama runtime",
      "start the Windows Ollama runtime",
    ]);
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rolls back a new Windows Ollama install when model selection returns", async () => {
    const commit = vi.fn();
    const rollback = vi.fn();
    const install = vi.fn(async () => ({
      ok: true as const,
      path: "C:/Ollama/ollama.exe",
      commit,
      rollback,
    }));
    const resetHost = vi.fn();
    const state = makeState();
    const { handleWindowsHostOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        isNonInteractive: () => false,
        installOllamaOnWindowsHost: install,
        resetOllamaHostCache: resetHost,
        selectAndValidateOllamaModel: async () => ({ outcome: "back-to-selection" }),
      }),
    );

    await expect(
      handleWindowsHostOllamaSelection(
        null,
        "install-windows-ollama",
        "qwen3:8b",
        false,
        false,
        null,
        state,
      ),
    ).resolves.toBe("retry-selection");

    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
    expect(resetHost).toHaveBeenCalledOnce();
  });

  it("rolls back a Windows Ollama restart when model selection returns", async () => {
    const commit = vi.fn();
    const rollback = vi.fn();
    const restart = vi.fn(() => ({ ok: true as const, commit, rollback }));
    const resetHost = vi.fn();
    const { handleWindowsHostOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        isNonInteractive: () => false,
        resetOllamaHostCache: resetHost,
        selectAndValidateOllamaModel: async () => ({ outcome: "back-to-selection" }),
        setupWindowsOllamaWith0000Binding: restart,
      }),
    );

    await expect(
      handleWindowsHostOllamaSelection(
        null,
        "start-windows-ollama",
        "qwen3:8b",
        false,
        true,
        "C:/Ollama/ollama.exe",
        makeState(),
      ),
    ).resolves.toBe("retry-selection");

    expect(restart).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
    expect(resetHost).toHaveBeenCalledOnce();
  });

  it("rolls back a Windows Ollama restart when model selection throws", async () => {
    const rollback = vi.fn();
    const restart = vi.fn(() => ({ ok: true as const, commit: vi.fn(), rollback }));
    const { handleWindowsHostOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        selectAndValidateOllamaModel: async () => {
          throw new Error("model selection failed");
        },
        setupWindowsOllamaWith0000Binding: restart,
      }),
    );

    await expect(
      handleWindowsHostOllamaSelection(
        null,
        "start-windows-ollama",
        "qwen3:8b",
        false,
        true,
        "C:/Ollama/ollama.exe",
        makeState(),
      ),
    ).rejects.toThrow("model selection failed");

    expect(restart).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("awaits Windows rollback before terminating a fatal model selection", async () => {
    const events: string[] = [];
    const rollback = vi.fn(async () => {
      events.push("rollback:start");
      await Promise.resolve();
      events.push("rollback:done");
    });
    const exit = vi.fn((code?: number): never => {
      events.push(`exit:${String(code)}`);
      throw new Error(`process.exit:${String(code)}`);
    });
    const restart = vi.fn(() => ({ ok: true as const, commit: vi.fn(), rollback }));
    const { handleWindowsHostOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        process: { ...process, exit } as unknown as NodeJS.Process,
        selectAndValidateOllamaModel: async () => {
          throw new OllamaSelectionFatalError("process", "fatal model selection");
        },
        setupWindowsOllamaWith0000Binding: restart,
      }),
    );

    await expect(
      handleWindowsHostOllamaSelection(
        null,
        "start-windows-ollama",
        "qwen3:8b",
        false,
        true,
        "C:/Ollama/ollama.exe",
        makeState(),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(events).toEqual(["rollback:start", "rollback:done", "exit:1"]);
    expect(rollback).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
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

    const result = await handleRunningOllamaSelection(null, "qwen3.6:35b", null, true, state, true);

    expect(result).toBe("selected");
    expect(state).toMatchObject({
      model: "llama3.1:8b",
      provider: "ollama-local",
      endpointUrl: "http://host.docker.internal:11434/v1",
    });
  });

  it("skips the Linux systemd loopback override for a Windows-host Ollama daemon (#8596)", async () => {
    const state = makeState();
    const ensureOverride = vi.fn<Deps["ensureOllamaLoopbackSystemdOverride"]>(() => "unchanged");
    const runStartup = vi.fn<Deps["runOllamaStartupOrGate"]>(() => ({ kind: "ready" }));
    const { handleRunningOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        ensureOllamaLoopbackSystemdOverride: ensureOverride,
        runOllamaStartupOrGate: runStartup,
        getLocalProviderBaseUrl: () => "http://host.docker.internal:11434/v1",
      }),
    );

    const result = await handleRunningOllamaSelection(null, "qwen3.6:35b", null, true, state, true);

    expect(result).toBe("selected");
    expect(ensureOverride).not.toHaveBeenCalled();
    expect(runStartup).toHaveBeenCalledWith(expect.objectContaining({ ollamaReady: true }));
    expect(state.endpointUrl).toBe("http://host.docker.internal:11434/v1");
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
      binaryNeedsUpgrade: false,
    });

    assert.equal(result, "selected");
    assert.equal(state.provider, "ollama-local");
    assert.equal(state.allowToolsIncompatible, true);
  });

  it("selects the proxy route without starting it before configuration review (#7318)", async () => {
    const state = makeState();
    const install = vi.fn(() => ({ ok: true }));
    const selectModel = vi.fn<Deps["selectAndValidateOllamaModel"]>(async () => ({
      outcome: "selected",
      model: "qwen3:0.6b",
      allowToolsIncompatible: false,
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleInstallOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        process: { ...process, platform: "linux" } as NodeJS.Process,
        installOllamaOnLinux: install,
        shouldFrontOllamaWithProxy: () => true,
        getLocalProviderBaseUrl: () => "http://host.openshell.internal:11435/v1",
        selectAndValidateOllamaModel: selectModel,
      }),
    );

    const result = await handleInstallOllamaSelection(null, null, null, state, {
      hasUpgradableOllama: false,
      binaryNeedsUpgrade: false,
    });

    expect(result).toBe("selected");
    expect(install).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      provider: "ollama-local",
      endpointUrl: "http://host.openshell.internal:11435/v1",
      model: "qwen3:0.6b",
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
    expect(state.endpointUrl).not.toContain("127.0.0.1");
    expect(log).toHaveBeenCalledWith("  ✓ Using Ollama on localhost:11434 (proxy on :11435)");
    log.mockRestore();
  });

  it("fails closed on unknown Ollama startup outcomes without mutating state", async () => {
    const state = makeState();
    const before = { ...state, hermesToolGateways: [...state.hermesToolGateways] };
    const exit = vi.fn((code?: number) => {
      throw new Error(`exit ${code}`);
    });
    const selectModel = vi.fn(async () => ({
      outcome: "selected" as const,
      model: "should-not-run",
      allowToolsIncompatible: true,
    }));
    const { handleRunningOllamaSelection } = createSetupNimOllamaHandlers(
      makeDeps({
        process: { ...process, exit: exit as never },
        runOllamaStartupOrGate: () => ({ kind: "mystery" }) as never,
        selectAndValidateOllamaModel: selectModel,
      }),
    );

    await assert.rejects(
      handleRunningOllamaSelection(null, "requested", "recovered", true, state),
      /exit 1/,
    );

    assert.deepEqual(state, before);
    assert.equal(exit.mock.calls[0]?.[0], 1);
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
    assert.equal(selectModel.mock.calls.length, 0);
  });
});

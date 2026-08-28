// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { makeDeps, makeHostState, unexpected } from "./__test-helpers__/setup-nim-flow";
import { getWindowsHostOllamaDockerRequirement } from "./local-inference-topology";
import { createSetupNim, type SetupNimFlowDeps } from "./setup-nim-flow";

describe("createSetupNim Windows-host Ollama", () => {
  it("reuses reachable Windows-host Ollama when PowerShell cannot find its executable (#7472)", async () => {
    const model = "qwen3.6:35b";
    const handleRunningOllamaSelection = vi.fn<SetupNimFlowDeps["handleRunningOllamaSelection"]>(
      async (_gpu, requestedModel, _recoveredModel, ollamaRunning, state, isWindowsHostOllama) => {
        expect(requestedModel).toBe(model);
        expect(ollamaRunning).toBe(true);
        // The flow must tell the handler the daemon is on the Windows host so it
        // skips the Linux systemd loopback override (#8596).
        expect(isWindowsHostOllama).toBe(true);
        state.model = model;
        state.provider = "ollama-local";
        state.endpointUrl = "http://host.docker.internal:11434/v1";
        state.credentialEnv = null;
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-windows-ollama",
        getNonInteractiveModel: () => model,
        detectInferenceProviderHostState: () =>
          makeHostState({
            ollamaHost: "host.docker.internal",
            ollamaRunning: true,
            isWindowsHostOllama: true,
            isWsl: true,
            hasWindowsOllama: false,
            windowsOllamaReachable: true,
            windowsHostOllamaDockerRequirement:
              getWindowsHostOllamaDockerRequirement("docker-desktop"),
          }),
        handleRunningOllamaSelection,
      }),
    );

    await setupNim(null, null);

    expect(handleRunningOllamaSelection).toHaveBeenCalledTimes(1);
  });

  it("reuses the running daemon when mirrored networking exposes the Windows host on WSL loopback (#7472)", async () => {
    const model = "qwen3.6:35b";
    const handleRunningOllamaSelection = vi.fn<SetupNimFlowDeps["handleRunningOllamaSelection"]>(
      async (_gpu, requestedModel, _recoveredModel, ollamaRunning, state) => {
        expect(requestedModel).toBe(model);
        expect(ollamaRunning).toBe(true);
        state.model = model;
        state.provider = "ollama-local";
        state.endpointUrl = "http://127.0.0.1:11434/v1";
        state.credentialEnv = null;
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const handleWindowsHostOllamaSelection = vi.fn<
      SetupNimFlowDeps["handleWindowsHostOllamaSelection"]
    >(async () => unexpected("Windows-host Ollama selection"));
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-windows-ollama",
        getNonInteractiveModel: () => model,
        detectInferenceProviderHostState: () =>
          makeHostState({
            // Mirrored networking puts the Windows daemon on the distro's own
            // loopback, so the first probe candidate answers and the host reads
            // as local even though the daemon is the Windows one.
            ollamaHost: "127.0.0.1",
            ollamaRunning: true,
            isWindowsHostOllama: false,
            isWsl: true,
            hasWindowsOllama: false,
            windowsHostOllamaDockerRequirement:
              getWindowsHostOllamaDockerRequirement("docker-desktop"),
          }),
        handleRunningOllamaSelection,
        handleWindowsHostOllamaSelection,
      }),
    );

    await setupNim(null, null);

    expect(handleRunningOllamaSelection).toHaveBeenCalledTimes(1);
    expect(handleWindowsHostOllamaSelection).not.toHaveBeenCalled();
  });

  it("restarts Docker-unreachable Windows-host Ollama after an interactive Ollama choice (#10100)", async () => {
    const model = "qwen3.5:9b";
    const handleRunningOllamaSelection = vi.fn<SetupNimFlowDeps["handleRunningOllamaSelection"]>(
      async () => unexpected("running Ollama selection"),
    );
    const handleWindowsHostOllamaSelection = vi.fn<
      SetupNimFlowDeps["handleWindowsHostOllamaSelection"]
    >(
      async (
        _gpu,
        providerKey,
        requestedModel,
        windowsOllamaReachable,
        _winOllamaLoopbackOnly,
        _winOllamaInstalledPath,
        state,
      ) => {
        expect(providerKey).toBe("start-windows-ollama");
        expect(requestedModel).toBeNull();
        expect(windowsOllamaReachable).toBe(false);
        state.model = model;
        state.provider = "ollama-local";
        state.endpointUrl = "http://host.docker.internal:11434/v1";
        state.credentialEnv = null;
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        prompt: async () => "ollama",
        selectFromNumberedMenu: (_rawChoice, _defaultIndex, options) =>
          options.find((option) => option.key === "ollama")!,
        detectInferenceProviderHostState: () =>
          makeHostState({
            hasOllama: true,
            ollamaHost: "host.docker.internal",
            ollamaRunning: true,
            isWindowsHostOllama: true,
            isWsl: true,
            hasWindowsOllama: false,
            windowsOllamaReachable: false,
            windowsHostOllamaDockerRequirement:
              getWindowsHostOllamaDockerRequirement("docker-desktop"),
          }),
        handleRunningOllamaSelection,
        handleWindowsHostOllamaSelection,
      }),
    );

    await setupNim(null, null);

    expect(handleWindowsHostOllamaSelection).toHaveBeenCalledTimes(1);
    expect(handleRunningOllamaSelection).not.toHaveBeenCalled();
  });

  it("restarts Docker-unreachable Windows-host Ollama for an explicit Ollama request (#10100)", async () => {
    const model = "qwen3.5:9b";
    const handleRunningOllamaSelection = vi.fn<SetupNimFlowDeps["handleRunningOllamaSelection"]>(
      async () => unexpected("running Ollama selection"),
    );
    const handleWindowsHostOllamaSelection = vi.fn<
      SetupNimFlowDeps["handleWindowsHostOllamaSelection"]
    >(
      async (
        _gpu,
        providerKey,
        requestedModel,
        windowsOllamaReachable,
        _winOllamaLoopbackOnly,
        _winOllamaInstalledPath,
        state,
      ) => {
        expect(providerKey).toBe("start-windows-ollama");
        expect(requestedModel).toBe(model);
        expect(windowsOllamaReachable).toBe(false);
        state.model = model;
        state.provider = "ollama-local";
        state.endpointUrl = "http://host.docker.internal:11434/v1";
        state.credentialEnv = null;
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "ollama",
        getNonInteractiveModel: () => model,
        detectInferenceProviderHostState: () =>
          makeHostState({
            hasOllama: true,
            ollamaHost: "host.docker.internal",
            ollamaRunning: true,
            isWindowsHostOllama: true,
            isWsl: true,
            hasWindowsOllama: true,
            windowsOllamaReachable: false,
            windowsHostOllamaDockerRequirement:
              getWindowsHostOllamaDockerRequirement("docker-desktop"),
          }),
        handleRunningOllamaSelection,
        handleWindowsHostOllamaSelection,
      }),
    );

    await setupNim(null, null);

    expect(handleWindowsHostOllamaSelection).toHaveBeenCalledTimes(1);
    expect(handleRunningOllamaSelection).not.toHaveBeenCalled();
  });
});

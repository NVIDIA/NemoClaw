// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { makeDeps, makeHostState, unexpected } from "./__test-helpers__/setup-nim-flow";
import { getWindowsHostOllamaDockerRequirement } from "./local-inference-topology";
import { createSetupNim, type SetupNimFlowDeps } from "./setup-nim-flow";

describe("setupNim Ollama host topology", () => {
  it("skips Linux service management for a mirrored Windows daemon on WSL loopback (#9300)", async () => {
    const model = "qwen2.5:1.5b";
    const handleRunningOllamaSelection = vi.fn<SetupNimFlowDeps["handleRunningOllamaSelection"]>(
      async (_gpu, requestedModel, _recoveredModel, ollamaRunning, state, isWindowsHostOllama) => {
        expect(requestedModel).toBe(model);
        expect(ollamaRunning).toBe(true);
        // The reuse handler reads this argument to decide whether to apply the
        // Linux loopback systemd override, which needs sudo and targets a
        // service the Windows daemon does not have.
        expect(isWindowsHostOllama).toBe(true);
        state.model = model;
        state.provider = "ollama-local";
        state.endpointUrl = "http://127.0.0.1:11434/v1";
        state.credentialEnv = null;
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const handleInstallOllamaSelection = vi.fn<SetupNimFlowDeps["handleInstallOllamaSelection"]>(
      async () => unexpected("Ollama install selection"),
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "ollama",
        getNonInteractiveModel: () => model,
        detectInferenceProviderHostState: () =>
          makeHostState({
            hasOllama: true,
            ollamaHost: "127.0.0.1",
            ollamaRunning: true,
            isWindowsHostOllama: false,
            windowsDaemonOnWslLoopback: true,
            isWsl: true,
            hasWindowsOllama: true,
            windowsOllamaReachable: true,
            windowsHostOllamaDockerRequirement:
              getWindowsHostOllamaDockerRequirement("docker-desktop"),
          }),
        handleRunningOllamaSelection,
        handleInstallOllamaSelection,
      }),
    );

    await setupNim(null, null);

    expect(handleRunningOllamaSelection).toHaveBeenCalledTimes(1);
    expect(handleInstallOllamaSelection).not.toHaveBeenCalled();
  });
});

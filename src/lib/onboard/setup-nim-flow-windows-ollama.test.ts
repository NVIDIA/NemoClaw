// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { makeDeps, makeHostState, unexpected } from "./__test-helpers__/setup-nim-flow";
import { getWindowsHostOllamaDockerRequirement } from "./local-inference-topology";
import { createSetupNim, type SetupNimFlowDeps } from "./setup-nim-flow";

describe("createSetupNim Windows-host Ollama", () => {
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

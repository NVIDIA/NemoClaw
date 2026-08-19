// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import { makeDeps, makeHostState, unexpected } from "./__test-helpers__/setup-nim-flow";
import { detectInferenceProviderHostState } from "./provider-host-state";
import { createSetupNim, type SetupNimFlowDeps, type SetupNimGpu } from "./setup-nim-flow";

afterEach(() => vi.unstubAllEnvs());

describe("fresh Hermes Portable provider selection", () => {
  it("selects managed Ollama without probing or starting host Ollama (#9596)", async () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    vi.stubEnv("NEMOCLAW_OLLAMA_NO_AUTOSTART", "1");
    const dockerCapture = vi.fn(() => unexpected("default Docker inspection"));
    const hostCommandExists = vi.fn(() => unexpected("host Ollama discovery"));
    const detectHostState = vi.fn((input: Parameters<typeof detectInferenceProviderHostState>[0]) =>
      detectInferenceProviderHostState({
        ...input,
        deps: { dockerCapture, hostCommandExists },
      }),
    );
    const handleRunningOllamaSelection = vi.fn<SetupNimFlowDeps["handleRunningOllamaSelection"]>(
      async () => unexpected("legacy host Ollama selection"),
    );
    const handleInstallOllamaSelection = vi.fn<SetupNimFlowDeps["handleInstallOllamaSelection"]>(
      async () => unexpected("host Ollama installation"),
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "ollama",
        getNonInteractiveModel: () => "qwen3-vl:4b",
        localModelProfileIntegration: {
          resolvePlan: () => null,
          onboard: async () => unexpected("local model profile onboarding"),
        },
        detectInferenceProviderHostState: detectHostState,
        handleRunningOllamaSelection,
        handleInstallOllamaSelection,
      }),
    );

    const result = await setupNim(
      { type: "nvidia" } as SetupNimGpu,
      "portable-hermes",
      { name: "hermes" } as AgentDefinition,
      false,
    );

    expect(detectHostState).not.toHaveBeenCalled();
    expect(dockerCapture).not.toHaveBeenCalled();
    expect(hostCommandExists).not.toHaveBeenCalled();
    expect(handleRunningOllamaSelection).not.toHaveBeenCalled();
    expect(handleInstallOllamaSelection).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: "ollama-local",
      model: "qwen3-vl:4b",
      endpointUrl: null,
      endpointSource: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
  });

  it("uses the ordinary Ollama model prompt when an interactive selection has no model (#9596)", async () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const handleRunningOllamaSelection = vi.fn<SetupNimFlowDeps["handleRunningOllamaSelection"]>(
      async (_gpu, requestedModel, _recoveredModel, _running, state) => {
        expect(requestedModel).toBeNull();
        state.provider = "ollama-local";
        state.model = "prompted-model";
        state.endpointUrl = "http://127.0.0.1:11434/v1";
        state.credentialEnv = null;
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const detectHostState = vi.fn(() =>
      makeHostState({ hasOllama: true, ollamaRunning: true, ollamaHost: "127.0.0.1" }),
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => false,
        getNonInteractiveProvider: () => "ollama",
        getNonInteractiveModel: () => null,
        detectInferenceProviderHostState: detectHostState,
        handleRunningOllamaSelection,
      }),
    );

    await expect(
      setupNim(
        { type: "nvidia" } as SetupNimGpu,
        "portable-hermes",
        { name: "hermes" } as AgentDefinition,
        false,
      ),
    ).resolves.toMatchObject({ provider: "ollama-local", model: "prompted-model" });

    expect(detectHostState).toHaveBeenCalledOnce();
    expect(handleRunningOllamaSelection).toHaveBeenCalledOnce();
  });

  it("requires an explicit Portable Ollama model in non-interactive mode (#9596)", async () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const abortNonInteractive = vi.fn<SetupNimFlowDeps["abortNonInteractive"]>((message) => {
      throw new Error(message);
    });
    const detectHostState = vi.fn(() => makeHostState());
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "ollama",
        getNonInteractiveModel: () => null,
        abortNonInteractive,
        detectInferenceProviderHostState: detectHostState,
      }),
    );

    await expect(
      setupNim(
        { type: "nvidia" } as SetupNimGpu,
        "portable-hermes",
        { name: "hermes" } as AgentDefinition,
        false,
      ),
    ).rejects.toThrow("requires an explicit local model selection");

    expect(abortNonInteractive).toHaveBeenCalledOnce();
    expect(detectHostState).not.toHaveBeenCalled();
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { makeDeps, makeHostState } from "./__test-helpers__/setup-nim-flow";
import { discoverInferenceIntentChoices } from "./setup-nim-flow";

describe("discoverInferenceIntentChoices", () => {
  it("discovers review choices without invoking provider handlers or installers (#6005)", () => {
    const detectInferenceProviderHostState = vi.fn(() =>
      makeHostState({
        hasOllama: true,
        ollamaHost: "127.0.0.1",
        ollamaRunning: true,
      }),
    );
    const handleRemoteProviderSelection = vi.fn();
    const handleRunningOllamaSelection = vi.fn();
    const installVllm = vi.fn();
    const remoteProviderConfig = makeDeps().remoteProviderConfig;
    const deps = makeDeps({
      remoteProviderConfig: {
        ...remoteProviderConfig,
        build: {
          ...remoteProviderConfig.build,
          defaultModel: "nvidia/reviewed-default",
        },
      },
      detectInferenceProviderHostState,
      getAgentInferenceProviderOptions: () => Object.keys(remoteProviderConfig),
      handleRemoteProviderSelection,
      handleRunningOllamaSelection,
      installVllm,
    });

    const choices = discoverInferenceIntentChoices(deps, null, null);

    expect(choices).toEqual(
      expect.arrayContaining([
        {
          key: "build",
          label: "NVIDIA Endpoints",
          defaultModel: "nvidia/reviewed-default",
        },
        expect.objectContaining({ key: "ollama" }),
      ]),
    );
    expect(detectInferenceProviderHostState).toHaveBeenCalledWith({
      gpu: null,
      experimental: false,
      probeOllama: true,
      probeVllm: true,
    });
    expect(handleRemoteProviderSelection).not.toHaveBeenCalled();
    expect(handleRunningOllamaSelection).not.toHaveBeenCalled();
    expect(installVllm).not.toHaveBeenCalled();
  });
});

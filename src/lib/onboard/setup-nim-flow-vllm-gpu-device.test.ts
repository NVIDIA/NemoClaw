// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { NEMOCLAW_VLLM_GPU_DEVICE_ENV } from "../inference/vllm-models";
import { makeDeps, makeHostState } from "./__test-helpers__/setup-nim-flow";
import type { SetupNimFlowDeps } from "./setup-nim-flow";
import { createSetupNim } from "./setup-nim-flow";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("managed vLLM GPU provider selection", () => {
  it("rejects the GPU device when non-interactive onboarding selects another provider", async () => {
    vi.stubEnv(NEMOCLAW_VLLM_GPU_DEVICE_ENV, "2");
    const abortNonInteractive = vi.fn((message: string): never => {
      throw new Error(message);
    });
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "build",
        abortNonInteractive,
      }),
    );

    await expect(setupNim(null, null, null, false)).rejects.toThrow(
      "applies only when NemoClaw installs managed vLLM",
    );
    expect(abortNonInteractive).toHaveBeenCalledWith(
      expect.stringContaining("selected provider is 'build'"),
    );
  });

  it("rejects an existing local vLLM selected during fresh onboarding", async () => {
    vi.stubEnv(NEMOCLAW_VLLM_GPU_DEVICE_ENV, "2");
    const abortNonInteractive = vi.fn((message: string): never => {
      throw new Error(message);
    });
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>();
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "vllm",
        detectInferenceProviderHostState: () =>
          makeHostState({
            vllmRunning: true,
            vllmEntries: [{ key: "vllm", label: "Local vLLM - running" }],
          }),
        abortNonInteractive,
        handleVllmSelection,
      }),
    );

    await expect(setupNim(null)).rejects.toThrow(
      "applies only when NemoClaw installs managed vLLM",
    );
    expect(abortNonInteractive).toHaveBeenCalledWith(
      expect.stringContaining("selected provider is 'vllm'"),
    );
    expect(handleVllmSelection).not.toHaveBeenCalled();
  });

  it("allows the persisted device when resuming its managed vLLM provider", async () => {
    vi.stubEnv(NEMOCLAW_VLLM_GPU_DEVICE_ENV, "2");
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>(async (state) => {
      state.model = "resumed-model";
      state.provider = "vllm-local";
      return "selected";
    });
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        detectInferenceProviderHostState: () =>
          makeHostState({
            vllmRunning: true,
            vllmEntries: [{ key: "vllm", label: "Local vLLM - running" }],
          }),
        readRecordedProvider: () => "vllm-local",
        readRecordedNimContainer: () => null,
        readRecordedModel: () => "resumed-model",
        handleVllmSelection,
      }),
    );

    await expect(setupNim(null, "existing-sandbox")).resolves.toMatchObject({
      model: "resumed-model",
      provider: "vllm-local",
    });
    expect(handleVllmSelection).toHaveBeenCalledOnce();
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { VllmProfile } from "../inference/vllm";
import { makeDeps, makeHostState } from "./__test-helpers__/setup-nim-flow";
import { createSetupNim, type SetupNimFlowDeps } from "./setup-nim-flow";

const servingProfileModel = {
  presetId: "vllm.dgx-spark-gb10.single.muse-glimmer-30b-nvfp4-w4a4",
  backend: "vllm",
  servedName: "muse-glimmer",
  modelId: "Inferact/Muse-Glimmer-30B-NVFP4-W4A4",
};

const routeGuard = () => ({
  requiredModel: null,
  requiredEndpointUrl: null,
  requiredInferenceApi: null,
});

function runningVllmHostState() {
  return makeHostState({
    vllmRunning: true,
    vllmProfile: { name: "DGX Spark" } as VllmProfile,
    hasVllmImage: true,
    vllmEntries: [{ key: "vllm", label: "Local vLLM (localhost:8000) — running (suggested)" }],
  });
}

function acceptVllmSelection(observedModels?: unknown[]) {
  return vi.fn<SetupNimFlowDeps["handleVllmSelection"]>(async (state) => {
    observedModels?.push(state.model);
    state.provider = "vllm";
    state.model = "muse-glimmer";
    state.endpointUrl = "http://127.0.0.1:8000/v1";
    state.credentialEnv = null;
    state.preferredInferenceApi = "openai-completions";
    return "selected";
  });
}

async function selectAgainstRunningVllm(
  handleVllmSelection: ReturnType<typeof acceptVllmSelection>,
  resolveRequestedServingProfileModel: SetupNimFlowDeps["resolveRequestedServingProfileModel"],
  selectVllmModelFromEnv: SetupNimFlowDeps["selectVllmModelFromEnv"] = () => null,
) {
  const setupNim = createSetupNim(
    makeDeps({
      isNonInteractive: () => true,
      getNonInteractiveProvider: () => "install-vllm",
      detectInferenceProviderHostState: () => runningVllmHostState(),
      handleVllmSelection,
      resolveRequestedServingProfileModel,
      selectVllmModelFromEnv,
    }),
  );
  const sparkGpu = { platform: "spark" } as unknown as Parameters<typeof setupNim>[0];
  return await setupNim(sparkGpu, null, null, true, null, "nemoclaw", routeGuard);
}

describe("serving profile onboarding against a running vLLM", () => {
  it("passes the requested profile's model to the running-server selection (#9563)", async () => {
    // `--profile` exports NEMOCLAW_PROVIDER=install-vllm, but a running server
    // leaves only the `vllm` entry, so the request collapses onto a deployment
    // the profile never selected. The test leaves `installVllm` at the shared
    // `unexpected` guard, so a call would fail the test: nothing installs on
    // this path, which is why the flow must pass the profile's model on.
    const handleVllmSelection = acceptVllmSelection();

    const result = await selectAgainstRunningVllm(handleVllmSelection, () => servingProfileModel);

    expect(handleVllmSelection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ managedInstall: false, servingProfileModel }),
    );
    expect(result).toMatchObject({ provider: "vllm", model: "muse-glimmer" });
  });

  it("passes no profile model when the run requested no profile", async () => {
    const handleVllmSelection = acceptVllmSelection();

    await selectAgainstRunningVllm(handleVllmSelection, () => null);

    expect(handleVllmSelection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ servingProfileModel: null }),
    );
  });

  it("passes an explicit managed model to the running-server selection", async () => {
    const observedModels: unknown[] = [];
    const handleVllmSelection = acceptVllmSelection(observedModels);

    await selectAgainstRunningVllm(handleVllmSelection, () => null, () => ({
      id: "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4",
      servedModelId: "nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4",
    }));

    expect(observedModels).toEqual(["nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4"]);
    expect(handleVllmSelection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ managedInstall: false }),
    );
  });

  it("does not compare a preset that another backend serves (#9563)", async () => {
    const handleVllmSelection = acceptVllmSelection();

    await selectAgainstRunningVllm(handleVllmSelection, () => ({
      ...servingProfileModel,
      presetId: "llama-cpp.dgx-spark-gb10.single.muse-glimmer-30b",
      backend: "install-llama-cpp",
    }));

    expect(handleVllmSelection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ servingProfileModel: null }),
    );
  });
});

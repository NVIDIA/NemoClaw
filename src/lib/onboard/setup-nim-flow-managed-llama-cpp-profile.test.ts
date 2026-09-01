// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveManagedLlamaCppSelectionForGpu } from "../inference/llama-cpp/managed-selection";
import { makeDeps } from "./__test-helpers__/setup-nim-flow";
import { createSetupNim, type SetupNimFlowDeps, type SetupNimGpu } from "./setup-nim-flow";

afterEach(() => {
  vi.unstubAllEnvs();
});

function n1xProofHarness(proofPassed: boolean) {
  const selection = {
    preset: { metadata: { id: "llama-cpp.n1x-wsl-arm64.single.qwen3-6-35b-a3b" } },
    recipe: {
      metadata: { id: "llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1" },
      spec: { model: { servedName: "qwen3.6-35b-a3b" } },
    },
  } as never;
  const resolveManagedLlamaCppSelection = vi.fn((_env?: NodeJS.ProcessEnv, gpu?: SetupNimGpu) =>
    gpu?.wslDockerDesktopGpuProofPassed === true
      ? { kind: "selected" as const, selection }
      : { kind: "rejected" as const, reason: "WSL GPU proof is unavailable" },
  );
  const installManagedLlamaCpp = vi.fn(async () => ({
    ok: true as const,
    apiKey: "a".repeat(64),
    model: "qwen3.6-35b-a3b",
    receipt: { schemaVersion: 1 } as never,
  }));
  const handleLlamaCppSelection = vi.fn<SetupNimFlowDeps["handleLlamaCppSelection"]>(
    async (state, requestedModel) => {
      state.provider = "llama-cpp-local";
      state.model = requestedModel;
      return "selected";
    },
  );
  return {
    gpu: { platform: "n1x", wslDockerDesktopGpuProofPassed: proofPassed } as never,
    installManagedLlamaCpp,
    resolveManagedLlamaCppSelection,
    setupNim: createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-llama-cpp",
        resolveManagedLlamaCppSelection,
        installManagedLlamaCpp,
        handleLlamaCppSelection,
      }),
    ),
  };
}

describe("managed llama.cpp profile onboarding", () => {
  it("installs an interactive profile despite a different recipe environment", async () => {
    vi.stubEnv("NEMOCLAW_LLAMACPP_RECIPE", "llama-cpp.recommended.v1");
    const selectedProfile = (recipeId: string, displayName: string, model: string) =>
      ({
        preset: { metadata: { id: `${recipeId}.preset`, displayName } },
        recipe: {
          metadata: { id: recipeId, displayName },
          spec: { model: { servedName: model } },
        },
      }) as never;
    const recommended = selectedProfile(
      "llama-cpp.recommended.v1",
      "Recommended model",
      "recommended-model",
    );
    const alternate = selectedProfile(
      "llama-cpp.alternate.v1",
      "Alternate model",
      "alternate-model",
    );
    const resolveManagedLlamaCppSelection = vi.fn((env?: NodeJS.ProcessEnv) => ({
      kind: "selected" as const,
      selection:
        env?.NEMOCLAW_LLAMACPP_RECIPE === "llama-cpp.alternate.v1" ? alternate : recommended,
    }));
    const selectFromNumberedMenu = vi.fn<SetupNimFlowDeps["selectFromNumberedMenu"]>(
      (_rawChoice, _defaultIndex, options) => {
        expect(options.filter(({ key }) => key === "install-llama-cpp")).toEqual([
          {
            key: "install-llama-cpp",
            label: "Managed llama.cpp: Recommended model (recommended)",
            managedLlamaCppRecipeId: "llama-cpp.recommended.v1",
          },
          {
            key: "install-llama-cpp",
            label: "Managed llama.cpp: Alternate model",
            managedLlamaCppRecipeId: "llama-cpp.alternate.v1",
          },
        ]);
        return options.find(
          ({ managedLlamaCppRecipeId }) => managedLlamaCppRecipeId === "llama-cpp.alternate.v1",
        )!;
      },
    );
    const installManagedLlamaCpp = vi.fn(async () => ({
      ok: true as const,
      apiKey: "a".repeat(64),
      model: "alternate-model",
      receipt: { schemaVersion: 1 } as never,
    }));
    const handleLlamaCppSelection = vi.fn<SetupNimFlowDeps["handleLlamaCppSelection"]>(
      async (state, requestedModel) => {
        state.provider = "llama-cpp-local";
        state.model = requestedModel;
        state.endpointUrl = "http://127.0.0.1:8081/v1";
        state.credentialEnv = "NEMOCLAW_LLAMACPP_LOCAL_TOKEN";
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        prompt: async () => "1",
        selectFromNumberedMenu,
        resolveManagedLlamaCppSelection,
        listManagedLlamaCppSelectionChoices: () => [
          { priority: 500, selection: recommended },
          { priority: 450, selection: alternate },
        ],
        installManagedLlamaCpp,
        handleLlamaCppSelection,
      }),
    );

    await expect(setupNim({ platform: "spark" } as never, "spark-agent")).resolves.toMatchObject({
      provider: "llama-cpp-local",
      model: "alternate-model",
    });
    expect(resolveManagedLlamaCppSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ NEMOCLAW_LLAMACPP_RECIPE: "llama-cpp.alternate.v1" }),
      expect.objectContaining({ platform: "spark" }),
    );
    expect(resolveManagedLlamaCppSelection).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ NEMOCLAW_LLAMACPP_RECIPE: "" }),
      expect.objectContaining({ platform: "spark" }),
    );
    expect(installManagedLlamaCpp).toHaveBeenCalledWith(
      alternate,
      expect.objectContaining({ sandboxName: "spark-agent" }),
    );
  });

  it("carries successful N1x Docker Desktop GPU proof into managed selection", async () => {
    const harness = n1xProofHarness(true);

    await expect(harness.setupNim(harness.gpu, "n1x-agent")).resolves.toMatchObject({
      provider: "llama-cpp-local",
      model: "qwen3.6-35b-a3b",
    });
    expect(harness.installManagedLlamaCpp).toHaveBeenCalledOnce();
    expect(harness.resolveManagedLlamaCppSelection).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ wslDockerDesktopGpuProofPassed: true }),
    );
  });

  it("rejects managed N1x selection when Docker Desktop GPU proof fails", async () => {
    const harness = n1xProofHarness(false);

    await expect(harness.setupNim(harness.gpu, "n1x-agent")).rejects.toThrow(
      "WSL GPU proof is unavailable",
    );
    expect(harness.installManagedLlamaCpp).not.toHaveBeenCalled();
    expect(harness.resolveManagedLlamaCppSelection).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ wslDockerDesktopGpuProofPassed: false }),
    );
  });

  it("rejects a remote Docker context before managed N1x installation", async () => {
    vi.stubEnv("NEMOCLAW_LLAMACPP_RECIPE", "llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1");
    vi.stubEnv("DOCKER_CONTEXT", "remote-builder");
    const installManagedLlamaCpp = vi.fn();
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-llama-cpp",
        resolveManagedLlamaCppSelection: resolveManagedLlamaCppSelectionForGpu,
        installManagedLlamaCpp,
      }),
    );

    await expect(
      setupNim({ platform: "n1x", wslDockerDesktopGpuProofPassed: true } as never, "n1x-agent"),
    ).rejects.toThrow("effective Docker context");
    expect(installManagedLlamaCpp).not.toHaveBeenCalled();
  });

  it("reports optional profile discovery failures while keeping other providers available", async () => {
    const note = vi.fn();
    const selectFromNumberedMenu = vi.fn<SetupNimFlowDeps["selectFromNumberedMenu"]>(
      (_rawChoice, _defaultIndex, options) => {
        expect(options.map(({ key }) => key)).not.toContain("install-llama-cpp");
        return options.find(({ key }) => key === "build")!;
      },
    );
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (_args, state) => {
        state.provider = "nvidia-prod";
        state.model = "nvidia/nemotron-3-super-120b-a12b";
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        note,
        prompt: async () => "1",
        selectFromNumberedMenu,
        resolveManagedLlamaCppSelection: () => ({
          kind: "rejected",
          reason: "managed-inference catalog is unavailable",
        }),
        listManagedLlamaCppSelectionChoices: () => {
          throw new Error("managed-inference catalog is unavailable");
        },
        handleRemoteProviderSelection,
      }),
    );

    await expect(setupNim({ platform: "spark" } as never, "spark-agent")).resolves.toMatchObject({
      provider: "nvidia-prod",
    });
    expect(note).toHaveBeenCalledWith(
      "  Managed llama.cpp profiles unavailable: managed-inference catalog is unavailable",
    );
  });
});

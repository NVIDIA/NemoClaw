// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverManagedLlamaCppSelectionsForGpu } from "../inference/llama-cpp/managed-selection";
import { makeDeps } from "./__test-helpers__/setup-nim-flow";
import { createSetupNim, type SetupNimFlowDeps, type SetupNimGpu } from "./setup-nim-flow";

afterEach(() => {
  vi.unstubAllEnvs();
});

function n1xProofHarness(proofPassed: boolean, requestedProvider: string | null) {
  const selection = {
    preset: { metadata: { id: "llama-cpp.n1x-wsl-arm64.single.qwen3-6-35b-a3b" } },
    recipe: {
      metadata: { id: "llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1" },
      spec: { model: { servedName: "qwen3.6-35b-a3b" } },
    },
  } as never;
  const discoverManagedLlamaCppSelections = vi.fn(
    (_env?: NodeJS.ProcessEnv, gpu?: SetupNimGpu) =>
      gpu?.wslDockerDesktopGpuProofPassed === true
        ? {
            choices: [{ priority: 500, selection }],
            resolution: { kind: "selected" as const, selection },
          }
        : {
            choices: [],
            resolution: { kind: "rejected" as const, reason: "WSL GPU proof is unavailable" },
          },
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
  const runtimeProvider = makeDeps().getRuntimeProvider();
  const getRuntimeProvider = vi.fn(() => runtimeProvider);
  return {
    gpu: { platform: "n1x", wslDockerDesktopGpuProofPassed: proofPassed } as never,
    getRuntimeProvider,
    handleLlamaCppSelection,
    installManagedLlamaCpp,
    discoverManagedLlamaCppSelections,
    runtimeProvider,
    selection,
    setupNim: createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => requestedProvider,
        discoverManagedLlamaCppSelections,
        installManagedLlamaCpp,
        handleLlamaCppSelection,
        getRuntimeProvider,
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
    const discoverManagedLlamaCppSelections = vi.fn((env?: NodeJS.ProcessEnv) => {
      const selection =
        env?.NEMOCLAW_LLAMACPP_RECIPE === "llama-cpp.alternate.v1" ? alternate : recommended;
      return {
        choices: [
          { priority: 500, selection: recommended },
          { priority: 450, selection: alternate },
        ],
        resolution: { kind: "selected" as const, selection },
      };
    });
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
        discoverManagedLlamaCppSelections,
        installManagedLlamaCpp,
        handleLlamaCppSelection,
      }),
    );

    await expect(setupNim({ platform: "spark" } as never, "spark-agent")).resolves.toMatchObject({
      provider: "llama-cpp-local",
      model: "alternate-model",
    });
    expect(discoverManagedLlamaCppSelections).toHaveBeenLastCalledWith(
      expect.objectContaining({ NEMOCLAW_LLAMACPP_RECIPE: "llama-cpp.alternate.v1" }),
      expect.objectContaining({ platform: "spark" }),
      undefined,
      undefined,
      { runtimeProviderId: "docker" },
    );
    expect(discoverManagedLlamaCppSelections).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ NEMOCLAW_LLAMACPP_RECIPE: "" }),
      expect.objectContaining({ platform: "spark" }),
      undefined,
      undefined,
      { runtimeProviderId: "docker" },
    );
    expect(installManagedLlamaCpp).toHaveBeenCalledWith(
      alternate,
      expect.objectContaining({ sandboxName: "spark-agent" }),
    );
  });

  it("zero-decision onboarding selects managed Qwen on a proven N1x WSL GPU (#10962)", async () => {
    const harness = n1xProofHarness(true, null);

    await expect(harness.setupNim(harness.gpu, "n1x-agent")).resolves.toMatchObject({
      provider: "llama-cpp-local",
      model: "qwen3.6-35b-a3b",
    });
    expect(harness.discoverManagedLlamaCppSelections).toHaveBeenCalledTimes(2);
    expect(harness.discoverManagedLlamaCppSelections).toHaveBeenNthCalledWith(
      1,
      undefined,
      expect.objectContaining({ wslDockerDesktopGpuProofPassed: true }),
      undefined,
      undefined,
      { runtimeProviderId: "docker" },
    );
    expect(harness.discoverManagedLlamaCppSelections).toHaveBeenNthCalledWith(
      2,
      undefined,
      harness.gpu,
      undefined,
      undefined,
      { runtimeProviderId: "docker" },
    );
    expect(harness.installManagedLlamaCpp).toHaveBeenCalledWith(
      harness.selection,
      expect.objectContaining({
        sandboxName: "n1x-agent",
        runtimeProvider: harness.runtimeProvider,
      }),
    );
    expect(harness.handleLlamaCppSelection).toHaveBeenCalledWith(
      expect.any(Object),
      "qwen3.6-35b-a3b",
      null,
    );
    expect(harness.getRuntimeProvider).toHaveBeenCalledTimes(2);
  });

  it("rejects managed N1x selection when Docker Desktop GPU proof fails", async () => {
    const harness = n1xProofHarness(false, "install-llama-cpp");

    await expect(harness.setupNim(harness.gpu, "n1x-agent")).rejects.toThrow(
      "WSL GPU proof is unavailable",
    );
    expect(harness.installManagedLlamaCpp).not.toHaveBeenCalled();
    expect(harness.discoverManagedLlamaCppSelections).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ wslDockerDesktopGpuProofPassed: false }),
      undefined,
      undefined,
      { runtimeProviderId: "docker" },
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
        discoverManagedLlamaCppSelections: discoverManagedLlamaCppSelectionsForGpu,
        installManagedLlamaCpp,
      }),
    );

    await expect(
      setupNim({ platform: "n1x", wslDockerDesktopGpuProofPassed: true } as never, "n1x-agent"),
    ).rejects.toThrow("effective Docker context");
    expect(installManagedLlamaCpp).not.toHaveBeenCalled();
  });

  it("does not offer a Docker-qualified N1x profile under a resolved Podman provider", async () => {
    const dockerProvider = makeDeps().getRuntimeProvider();
    const podmanProvider = {
      ...dockerProvider,
      identity: { ...dockerProvider.identity, id: "podman", displayName: "Podman" },
    } as never;
    const discoverManagedLlamaCppSelections = vi.fn(() => ({
      choices: [],
      resolution: {
        kind: "rejected" as const,
        reason: "the selected preset requires the Docker runtime provider",
      },
    }));
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
        discoverManagedLlamaCppSelections,
        getRuntimeProvider: () => podmanProvider,
        handleRemoteProviderSelection,
        prompt: async () => "1",
        selectFromNumberedMenu,
      }),
    );

    await expect(setupNim({ platform: "n1x" } as never, "n1x-agent")).resolves.toMatchObject({
      provider: "nvidia-prod",
    });
    expect(discoverManagedLlamaCppSelections).toHaveBeenCalledWith(
      expect.objectContaining({ NEMOCLAW_LLAMACPP_RECIPE: "" }),
      expect.objectContaining({ platform: "n1x" }),
      undefined,
      undefined,
      { runtimeProviderId: "podman" },
    );
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
        discoverManagedLlamaCppSelections: () => {
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

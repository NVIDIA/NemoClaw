// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { VllmProfile } from "../inference/vllm";
import * as onboardSession from "../state/onboard-session";
import { makeDeps, makeHostState, unexpected } from "./__test-helpers__/setup-nim-flow";
import {
  LOCAL_MODEL_PROFILE_ENABLED_ENV,
  LOCAL_MODEL_PROFILE_RUNTIME_ENV,
} from "./local-model-profile/plan";
import { createSetupNim, type SetupNimFlowDeps } from "./setup-nim-flow";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("createSetupNim vLLM resume", () => {
  it("resumes a checkpointed install without prompting for a provider (#9582)", async () => {
    const profile = { name: "DGX Spark" } as VllmProfile;
    const prompt = vi.fn(async () => unexpected("provider prompt"));
    const checkpointVllmInstallModel = vi.fn();
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      vllmInstallModel: "nvidia/resumed-model",
      steps: { provider_selection: { status: "failed" } },
    } as unknown as ReturnType<typeof onboardSession.loadSession>);
    const installVllm = vi.fn<SetupNimFlowDeps["installVllm"]>(async (_profile, options) => {
      options.beforeInstall?.("nvidia/resumed-model");
      return { ok: true };
    });
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>(async (state) => {
      state.provider = "vllm";
      state.endpointUrl = "http://127.0.0.1:8000/v1";
      state.credentialEnv = null;
      state.preferredInferenceApi = "openai-completions";
      return "selected";
    });
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => null,
        checkpointVllmInstallModel,
        prompt,
        detectInferenceProviderHostState: () =>
          makeHostState({
            vllmProfile: profile,
            hasVllmImage: true,
            vllmEntries: [{ key: "install-vllm", label: "Start vLLM (DGX Spark)" }],
          }),
        installVllm,
        handleVllmSelection,
      }),
    );

    await expect(setupNim(null, null, null, true)).resolves.toMatchObject({
      model: "nvidia/resumed-model",
      provider: "vllm",
    });
    expect(installVllm).toHaveBeenCalledWith(
      profile,
      expect.objectContaining({
        checkpointInstallIntent: expect.any(Function),
        modelIntent: "nvidia/resumed-model",
        nonInteractive: true,
      }),
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it("refuses checkpoint-first vLLM installation when sandbox identity changes (#9833)", async () => {
    const profile = { name: "DGX Spark" } as VllmProfile;
    const checkpointVllmInstallModel = vi.fn();
    const installEffect = vi.fn();
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>();
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      vllmInstallModel: "nvidia/resumed-model",
      steps: { provider_selection: { status: "failed" } },
    } as unknown as ReturnType<typeof onboardSession.loadSession>);
    const installVllm = vi.fn<SetupNimFlowDeps["installVllm"]>(async (_profile, options) => {
      options.checkpointInstallIntent?.("nvidia/resumed-model");
      installEffect();
      options.beforeInstall?.("nvidia/resumed-model");
      return { ok: true };
    });
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => null,
        checkpointVllmInstallModel,
        detectInferenceProviderHostState: () =>
          makeHostState({
            vllmProfile: profile,
            hasVllmImage: true,
            vllmEntries: [{ key: "install-vllm", label: "Start vLLM (DGX Spark)" }],
          }),
        installVllm,
        handleVllmSelection,
      }),
    );
    const revalidateSandboxIdentity = vi.fn(() => {
      throw new Error("Sandbox identity changed before local inference");
    });

    await expect(
      setupNim(
        null,
        null,
        null,
        true,
        null,
        null,
        undefined,
        undefined,
        undefined,
        revalidateSandboxIdentity,
      ),
    ).rejects.toThrow(/Sandbox identity changed before/u);

    expect(revalidateSandboxIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "vllm-local",
        model: "nvidia/resumed-model",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: "openai-completions",
      }),
      "record managed vLLM install intent",
    );
    expect(checkpointVllmInstallModel).not.toHaveBeenCalled();
    expect(installEffect).not.toHaveBeenCalled();
    expect(handleVllmSelection).not.toHaveBeenCalled();
  });

  it("uses the session fallback to checkpoint and retry a dedicated local profile (#9582)", async () => {
    vi.stubEnv(LOCAL_MODEL_PROFILE_ENABLED_ENV, "1");
    vi.stubEnv(LOCAL_MODEL_PROFILE_RUNTIME_ENV, "vllm");
    let sessionModel: string | null = null;
    vi.spyOn(onboardSession, "loadSession").mockImplementation(
      () =>
        ({
          vllmInstallModel: sessionModel,
          steps: { provider_selection: { status: "in_progress" } },
        }) as unknown as ReturnType<typeof onboardSession.loadSession>,
    );
    const checkpointVllmInstallModel = vi
      .spyOn(onboardSession, "checkpointVllmInstallModel")
      .mockImplementation((modelId) => {
        sessionModel = modelId;
        return {} as ReturnType<typeof onboardSession.checkpointVllmInstallModel>;
      });
    const profile = {
      name: "DGX Spark",
      platform: "spark",
      architecture: "arm64",
    } as VllmProfile;
    const installVllm = vi
      .fn<SetupNimFlowDeps["installVllm"]>()
      .mockImplementationOnce(async (selected, options) => {
        options.checkpointInstallIntent?.(selected.defaultModel.id);
        return { ok: false };
      })
      .mockImplementationOnce(async (selected, options) => {
        options.checkpointInstallIntent?.(selected.defaultModel.id);
        options.beforeInstall?.(selected.defaultModel.servedModelId ?? selected.defaultModel.id);
        return { ok: !("modelIntent" in options) };
      });
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>(async (state) => {
      state.provider = "vllm";
      state.endpointUrl = "http://127.0.0.1:8000/v1";
      state.credentialEnv = null;
      state.preferredInferenceApi = "openai-completions";
      return "selected";
    });
    const prompt = vi.fn(async () => unexpected("provider prompt"));
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => null,
        prompt,
        abortNonInteractive: (message) => {
          throw new Error(message);
        },
        resolveManagedLlamaCppSelection: () => ({
          kind: "rejected",
          reason: "the vLLM profile test does not select llama.cpp",
        }),
        listManagedLlamaCppSelectionChoices: () => [],
        detectInferenceProviderHostState: () =>
          makeHostState({ vllmProfile: profile, hasVllmImage: true }),
        installVllm,
        handleVllmSelection,
      }),
    );
    const sparkGpu = { type: "nvidia", spark: true, platform: "spark" } as never;

    await expect(setupNim(sparkGpu)).rejects.toThrow(
      "The local model profile could not be configured.",
    );
    expect(sessionModel).toBe("nvidia/Qwen3.6-35B-A3B-NVFP4");

    await expect(setupNim(sparkGpu)).resolves.toMatchObject({
      model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
      provider: "vllm",
    });
    expect(checkpointVllmInstallModel).toHaveBeenCalledTimes(2);
    expect(prompt).not.toHaveBeenCalled();
  });
});

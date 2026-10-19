// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  clearSession,
  createSession,
  loadSession,
  markStepComplete,
  markStepFailed,
  markStepStarted,
  saveSession,
  updateSession,
} from "../../../state/onboard-session";
import { checkpointSandboxName } from "../../session-bootstrap";
import { withStationExpressResumeEnvironment } from "../../station-express-resume";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

describe("Station Express provider binding (#7048)", () => {
  it("revalidates the model after selection fails while committing a reviewed provider", async () => {
    const selection = {
      ...baseSelection,
      provider: "vllm-local",
      model: "nvidia-nemotron-3.5-super-vl-120b-a12b-nvfp4",
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
      vllmModelIdentity: "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
    };
    const setupNim = vi
      .fn()
      .mockResolvedValue(selection)
      .mockResolvedValueOnce({
        ...selection,
        vllmModelIdentity: "/tmp/nemoclaw-reviewed-model/snapshot",
      });
    const { deps, calls } = createDeps({
      setupNim,
      startRecordedStep: async (step, updates) => {
        markStepStarted(step);
        updateSession((current) => Object.assign(current, updates));
      },
      recordStepComplete: async (step, updates) => markStepComplete(step, updates),
      checkpointSandboxIdentity: (name, agent) => checkpointSandboxName(name, agent, updateSession),
    });
    const session = saveSession(
      createSession({
        mode: "non-interactive",
        stationExpressIntent: {
          version: 1,
          model: "nemotron-3.5-super-vl-120b",
          sandboxName: "my-assistant",
        },
      }),
    );
    try {
      await expect(
        handleProviderInferenceState({
          ...baseOptions(deps, session),
          sandboxName: "my-assistant",
        }),
      ).rejects.toThrow("Cannot record an invalid DGX Station Express provider selection.");
      markStepFailed("provider_selection", "Model identity rejected");
      const saved = loadSession()!;
      expect(saved).toMatchObject({
        provider: selection.provider,
        model: selection.model,
        sandboxPromptProgress: { sandboxName: true },
        steps: { provider_selection: { status: "failed" } },
      });

      await handleProviderInferenceState({
        ...baseOptions(deps, saved),
        resume: true,
        sandboxName: "my-assistant",
      });
      expect(setupNim).toHaveBeenCalledTimes(2);
      expect(calls.skipped).not.toHaveBeenCalledWith("provider_selection", expect.anything());
      expect(loadSession()).toMatchObject({
        steps: { provider_selection: { status: "complete" } },
        stationExpressIntent: {
          servedModel: selection.model,
          checkpointModel: selection.vllmModelIdentity,
        },
      });
    } finally {
      clearSession();
    }
  });

  it("carries validated vLLM checkpoint identity into the atomic session update", async () => {
    const setupNim = vi.fn(async () => ({
      model: "nemotron-ultra",
      provider: "vllm-local",
      endpointUrl: null,
      credentialEnv: null,
      hermesAuthMethod: null,
      hermesToolGateways: [],
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      nimContainer: null,
      vllmModelIdentity: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
    }));
    const { deps, calls } = createDeps({ setupNim });
    const session = createSession({
      mode: "non-interactive",
      stationExpressIntent: {
        version: 1,
        model: "nemotron-3-ultra-550b-a55b",
        sandboxName: "my-assistant",
      },
    });
    calls.complete.mockResolvedValue(session);

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "my-assistant",
    });

    expect(calls.complete).toHaveBeenCalledWith(
      "provider_selection",
      expect.objectContaining({
        provider: "vllm-local",
        model: "nemotron-ultra",
        stationExpressModelIdentity: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
      }),
    );
  });

  it("retries a failed managed install from the saved non-interactive selection (#7048)", async () => {
    const checkpointModel = "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4";
    const session = createSession({
      mode: "non-interactive",
      stationExpressIntent: {
        version: 1,
        model: "nemotron-3-ultra-550b-a55b",
        sandboxName: "my-assistant",
      },
    });
    const resumeEnv: NodeJS.ProcessEnv = {};
    const setupNim = vi
      .fn()
      .mockRejectedValueOnce(new Error("injected managed vLLM download failure"))
      .mockImplementationOnce(async () => {
        expect(resumeEnv).toMatchObject({
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_PROVIDER: "install-vllm",
          NEMOCLAW_VLLM_MODEL: "nemotron-3-ultra-550b-a55b",
          NEMOCLAW_MODEL: "nvidia/nemotron-3-ultra-550b-a55b",
        });
        return {
          model: "nemotron-ultra",
          provider: "vllm-local",
          endpointUrl: null,
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
          vllmModelIdentity: checkpointModel,
        };
      });
    const { deps, calls } = createDeps({ setupNim });
    calls.complete.mockResolvedValue(session);

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("injected managed vLLM download failure");
    expect(session.provider).toBeNull();
    expect(session.model).toBeNull();
    expect(session.steps.provider_selection.status).toBe("pending");
    session.status = "failed";

    const run = withStationExpressResumeEnvironment(
      async (options?: { resume?: boolean }) => {
        await handleProviderInferenceState({
          ...baseOptions(deps, session),
          resume: options?.resume === true,
          sandboxName: "my-assistant",
        });
      },
      {
        loadSession: () => session,
        clearInstallerResume: vi.fn(),
        cleanupReceiptRetirementClaims: vi.fn(),
        reconcileReceiptRetirement: vi.fn(),
        error: vi.fn(),
        exitProcess: vi.fn((code: number): never => {
          throw new Error(`exit ${String(code)}`);
        }),
      },
      resumeEnv,
    );

    await run({ resume: true });

    expect(setupNim).toHaveBeenCalledTimes(2);
    expect(calls.complete).toHaveBeenCalledWith(
      "provider_selection",
      expect.objectContaining({
        provider: "vllm-local",
        model: "nemotron-ultra",
        stationExpressModelIdentity: checkpointModel,
      }),
    );
    expect(calls.promptName).not.toHaveBeenCalled();
    expect(resumeEnv).toEqual({});
  });
});

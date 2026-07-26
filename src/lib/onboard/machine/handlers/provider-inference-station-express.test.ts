// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { withStationExpressResumeEnvironment } from "../../station-express-resume";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("Station Express provider binding (#7048)", () => {
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

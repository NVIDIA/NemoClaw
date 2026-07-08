// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import type { OnboardFlowContext } from "../flow-context";
import { advanceTo, branchTo } from "../result";
import { createProviderInferencePhase, createSandboxPhase } from "./provider-sandbox";

function context(
  patch: Partial<OnboardFlowContext<null, null, { mode: string }>> = {},
): OnboardFlowContext<null, null, { mode: string }> {
  return {
    resume: false,
    fresh: false,
    session: createSession(),
    agent: null,
    recordedSandboxName: null,
    requestedSandboxName: null,
    sandboxName: null,
    fromDockerfile: null,
    model: null,
    provider: null,
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,
    nimContainer: null,
    webSearchConfig: null,
    webSearchSupported: false,
    selectedMessagingChannels: [],
    gpu: null,
    sandboxGpuConfig: { mode: "0" },
    gpuPassthrough: false,
    ...patch,
  };
}

describe("provider/sandbox flow phases", () => {
  it("passes full context and results through the shared handoff", async () => {
    const providerPhase = createProviderInferencePhase(async (current) => ({
      context: {
        ...current,
        session: createSession(),
        sandboxName: "my-assistant",
        provider: "nvidia-prod",
        model: "model",
        endpointUrl: "https://example.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        hermesAuthMethod: null,
        hermesToolGateways: [],
        preferredInferenceApi: "openai-responses",
        compatibleEndpointReasoning: null,
        nimContainer: null,
        webSearchConfig: null,
      },
      result: [advanceTo("inference"), advanceTo("sandbox")],
    }));
    const branchResult = branchTo("openclaw", {
      metadata: { sandboxName: "my-assistant", state: "sandbox" },
    });
    const runSandbox = vi.fn(async (current) => ({
      context: {
        ...current,
        session: createSession(),
        sandboxName: "my-assistant",
        webSearchConfig: null,
        selectedMessagingChannels: ["telegram"],
        webSearchSupported: true,
      },
      result: branchResult,
    }));
    const sandboxPhase = createSandboxPhase(runSandbox);

    const providerResult = await providerPhase.run(
      context({ fromDockerfile: "Dockerfile", selectedMessagingChannels: ["slack"] }),
    );
    const sandboxResult = await sandboxPhase.run(providerResult.context);

    expect(providerPhase.state).toBe("provider_selection");
    expect(sandboxPhase.state).toBe("sandbox");
    expect(runSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "nvidia-prod",
        model: "model",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        fromDockerfile: "Dockerfile",
        sandboxGpuConfig: { mode: "0" },
        selectedMessagingChannels: ["slack"],
      }),
    );
    expect(sandboxResult.context).toMatchObject({
      sandboxName: "my-assistant",
      provider: "nvidia-prod",
      model: "model",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      fromDockerfile: "Dockerfile",
      selectedMessagingChannels: ["telegram"],
      webSearchSupported: true,
    });
    expect(providerResult.result).toEqual([advanceTo("inference"), advanceTo("sandbox")]);
    expect(sandboxResult.result).toEqual(branchResult);
  });

  it.each([
    "model",
    "provider",
    "sandboxGpuConfig",
  ] as const)("rejects sandbox phase execution before %s is selected (#5938)", async (missingField) => {
    const runSandbox = vi.fn(async (current) => ({
      context: {
        ...current,
        session: createSession(),
        sandboxName: "my-assistant",
        webSearchConfig: null,
        selectedMessagingChannels: [],
        webSearchSupported: false,
      },
      result: branchTo("openclaw"),
    }));
    const phase = createSandboxPhase(runSandbox);
    const incomplete = context({
      model: "model",
      provider: "nvidia-prod",
      sandboxGpuConfig: { mode: "0" },
    });
    incomplete[missingField] = null;

    await expect(phase.run(incomplete)).rejects.toThrow(
      /Onboarding state is incomplete before sandbox setup\./,
    );
    expect(runSandbox).not.toHaveBeenCalled();
  });
});

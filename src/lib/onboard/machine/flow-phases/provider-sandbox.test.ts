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
  it("maps provider inference context updates and ordered FSM results", async () => {
    const phase = createProviderInferencePhase(async () => ({
      context: {
        session: createSession(),
        sandboxName: "my-assistant",
        provider: "nvidia-prod",
        model: "model",
        endpointUrl: "https://example.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        hermesAuthMethod: null,
        hermesToolGateways: [],
        preferredInferenceApi: "openai-responses",
        nimContainer: null,
        webSearchConfig: null,
      },
      result: [advanceTo("inference"), advanceTo("sandbox")],
    }));

    const result = await phase.run(context());

    expect(phase.state).toBe("provider_selection");
    expect(result.context).toMatchObject({
      sandboxName: "my-assistant",
      provider: "nvidia-prod",
      model: "model",
      preferredInferenceApi: "openai-responses",
    });
    expect(result.result).toEqual([advanceTo("inference"), advanceTo("sandbox")]);
  });

  it("maps sandbox context updates and branch result", async () => {
    const branchResult = branchTo("openclaw", {
      metadata: { sandboxName: "my-assistant", state: "sandbox" },
    });
    const phase = createSandboxPhase(async () => ({
      context: {
        session: createSession(),
        sandboxName: "my-assistant",
        webSearchConfig: null,
        selectedMessagingChannels: ["telegram"],
        webSearchSupported: true,
      },
      result: branchResult,
    }));

    const result = await phase.run(
      context({ model: "model", provider: "nvidia-prod", sandboxGpuConfig: { mode: "0" } }),
    );

    expect(phase.state).toBe("sandbox");
    expect(result.context).toMatchObject({
      sandboxName: "my-assistant",
      selectedMessagingChannels: ["telegram"],
      webSearchSupported: true,
    });
    expect(result.result).toEqual(branchResult);
  });

  it("rejects sandbox phase execution before sandbox GPU config is selected", async () => {
    const runSandbox = vi.fn(async () => ({
      context: {
        session: createSession(),
        sandboxName: "my-assistant",
        webSearchConfig: null,
        selectedMessagingChannels: [],
        webSearchSupported: false,
      },
      result: branchTo("openclaw"),
    }));
    const phase = createSandboxPhase(runSandbox);

    await expect(
      phase.run(context({ model: "model", provider: "nvidia-prod", sandboxGpuConfig: null })),
    ).rejects.toThrow(/Onboarding state is incomplete before sandbox setup\./);
    expect(runSandbox).not.toHaveBeenCalled();
  });
});

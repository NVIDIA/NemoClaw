// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession } from "../../state/onboard-session";
import { advanceTo } from "./result";
import {
  mergeOnboardFlowContext,
  onboardFlowPhaseResult,
  type OnboardFlowContext,
} from "./flow-context";

function baseContext(): OnboardFlowContext<null, { type: string }, { mode: string }> {
  return {
    resume: false,
    fresh: false,
    session: createSession(),
    agent: null,
    recordedSandboxName: null,
    requestedSandboxName: "requested",
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
    gpu: { type: "nvidia" },
    sandboxGpuConfig: { mode: "0" },
    gpuPassthrough: false,
  };
}

describe("onboard flow context helpers", () => {
  it("merges typed context patches", () => {
    const merged = mergeOnboardFlowContext(baseContext(), {
      sandboxName: "my-assistant",
      provider: "nvidia-prod",
      model: "model",
    });

    expect(merged).toMatchObject({
      requestedSandboxName: "requested",
      sandboxName: "my-assistant",
      provider: "nvidia-prod",
      model: "model",
    });
  });

  it("pairs context updates with FSM handler results", () => {
    const context = mergeOnboardFlowContext(baseContext(), { provider: "nvidia-prod" });
    const result = onboardFlowPhaseResult(context, advanceTo("gateway"));

    expect(result.context.provider).toBe("nvidia-prod");
    expect(result.result).toMatchObject({ next: "gateway", transitionKind: "advance" });
  });
});

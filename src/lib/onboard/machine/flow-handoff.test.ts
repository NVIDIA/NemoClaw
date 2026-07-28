// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../state/onboard-session";
import type { OnboardFlowContext } from "./flow-context";
import { prepareCoreOnboardFlowContext, prepareFinalOnboardFlowContext } from "./flow-handoff";

function context(): OnboardFlowContext & {
  gpu: string | null;
  sandboxGpuConfig: { mode: string } | null;
  gpuPassthrough: boolean;
} {
  return {
    resume: false,
    fresh: true,
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
    gpu: "nvidia",
    sandboxGpuConfig: { mode: "cdi" },
    gpuPassthrough: true,
  };
}

describe("onboard flow handoffs", () => {
  it("constructs core context from the initial result and requested name", () => {
    const initialContext = context();
    const persisted = createSession();
    const assertSandboxNameAllowed = vi.fn();

    const result = prepareCoreOnboardFlowContext({
      initial: { context: initialContext, session: persisted },
      recordedSandboxName: null,
      requestedSandboxName: "requested",
      checkpointedSandboxName: "checkpointed",
      selectedMessagingChannels: ["slack"],
      assertSandboxNameAllowed,
    });

    expect(result).toMatchObject({
      session: persisted,
      sandboxName: "requested",
      selectedMessagingChannels: ["slack"],
      gpu: "nvidia",
      sandboxGpuConfig: { mode: "cdi" },
      gpuPassthrough: true,
    });
    expect(assertSandboxNameAllowed).toHaveBeenCalledWith("requested");
  });

  it("rejects a missing preflight GPU configuration", () => {
    const initialContext = { ...context(), sandboxGpuConfig: null };
    const persisted = createSession();

    expect(() =>
      prepareCoreOnboardFlowContext({
        initial: { context: initialContext, session: persisted },
        recordedSandboxName: null,
        requestedSandboxName: null,
        checkpointedSandboxName: null,
        selectedMessagingChannels: [],
        assertSandboxNameAllowed: vi.fn(),
      }),
    ).toThrow("Preflight did not produce a sandbox GPU configuration.");
  });

  it("constructs final context only after sandbox identity and inference are complete", () => {
    const persisted = createSession();
    const coreContext = {
      ...context(),
      sandboxName: "ready",
      model: "model",
      provider: "provider",
    };

    expect(
      prepareFinalOnboardFlowContext({
        context: coreContext,
        session: persisted,
      }),
    ).toMatchObject({ sandboxName: "ready", model: "model", provider: "provider" });
    expect(() =>
      prepareFinalOnboardFlowContext({
        context: { ...coreContext, model: null },
        session: persisted,
      }),
    ).toThrow("Onboarding state is incomplete after sandbox setup.");
  });
});

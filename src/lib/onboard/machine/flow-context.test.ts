// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession } from "../../state/onboard-session";
import {
  assertProviderModelSelectedContext,
  assertProviderSelectedContext,
  assertSandboxCreatedContext,
  mergeOnboardFlowContext,
  mergeProviderModelSelectedContext,
  mergeSandboxCreatedContext,
  type OnboardFlowContext,
  onboardFlowPhaseResult,
} from "./flow-context";
import { advanceTo } from "./result";

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
    compatibleEndpointReasoning: null,
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

  it("merges provider/model-selected context updates", () => {
    const context = mergeProviderModelSelectedContext(baseContext(), {
      session: createSession(),
      sandboxName: "my-assistant",
      provider: "nvidia-prod",
      model: "model",
      endpointUrl: "https://example.test/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      hermesAuthMethod: null,
      hermesToolGateways: [],
      preferredInferenceApi: "openai-responses",
      compatibleEndpointReasoning: null,
      nimContainer: null,
      webSearchConfig: null,
    });

    expect(context).toMatchObject({
      sandboxName: "my-assistant",
      provider: "nvidia-prod",
      model: "model",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });
  });

  it("asserts provider/model-selected context before consumers use provider output", () => {
    const context = mergeOnboardFlowContext(baseContext(), {
      provider: "nvidia-prod",
      model: "model",
    });

    expect(() =>
      assertProviderModelSelectedContext(context, "provider inference result"),
    ).not.toThrow();
  });

  it("asserts provider-selected context before sandbox setup", () => {
    const context = mergeOnboardFlowContext(baseContext(), {
      provider: "nvidia-prod",
      model: "model",
    });

    expect(() => assertProviderSelectedContext(context, "sandbox setup")).not.toThrow();
  });

  it("rejects missing provider/model-selected context fields", () => {
    expect(() =>
      assertProviderModelSelectedContext(baseContext(), "provider inference result"),
    ).toThrow(/Onboarding state is incomplete before provider inference result\./);
  });

  it("rejects missing provider-selected context fields", () => {
    expect(() => assertProviderSelectedContext(baseContext(), "sandbox setup")).toThrow(
      /Onboarding state is incomplete before sandbox setup\./,
    );
  });

  it("merges sandbox-created context updates", () => {
    const providerContext = mergeProviderModelSelectedContext(baseContext(), {
      session: createSession(),
      sandboxName: null,
      provider: "nvidia-prod",
      model: "model",
      endpointUrl: null,
      credentialEnv: null,
      hermesAuthMethod: null,
      hermesToolGateways: [],
      preferredInferenceApi: null,
      compatibleEndpointReasoning: null,
      nimContainer: null,
      webSearchConfig: null,
    });
    const context = mergeSandboxCreatedContext(providerContext, {
      session: createSession(),
      sandboxName: "my-assistant",
      webSearchConfig: null,
      webSearchConfigChanged: false,
      hermesToolGateways: [],
      selectedMessagingChannels: ["telegram"],
      webSearchSupported: true,
    });

    expect(context).toMatchObject({
      sandboxName: "my-assistant",
      selectedMessagingChannels: ["telegram"],
      webSearchSupported: true,
    });
  });

  it("asserts sandbox-created context before final phases", () => {
    const context = mergeOnboardFlowContext(baseContext(), {
      sandboxName: "my-assistant",
      provider: "nvidia-prod",
      model: "model",
      sandboxGpuConfig: null,
    });

    expect(() => assertSandboxCreatedContext(context, "policies")).not.toThrow();
  });

  it("rejects missing sandbox name before final phases", () => {
    const context = mergeOnboardFlowContext(baseContext(), {
      provider: "nvidia-prod",
      model: "model",
    });

    expect(() => assertSandboxCreatedContext(context, "policies")).toThrow(
      /Onboarding state is incomplete before policies\./,
    );
  });
});

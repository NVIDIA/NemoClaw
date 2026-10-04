// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { REASONING_EFFORT_ENV, type ReasoningEffort } from "../../reasoning-mode";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

function recordedSession(compatibleEndpointReasoningEffort: ReasoningEffort | null) {
  return createSession({
    provider: "compatible-endpoint",
    model: "nemotron-3-super",
    endpointUrl: "https://compatible.example.test/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    preferredInferenceApi: "openai-completions",
    compatibleEndpointReasoning: "true",
    compatibleEndpointReasoningEffort,
  });
}

function recordedRoute(provider: string, preferredInferenceApi: string) {
  return createSession({
    provider,
    model: "nemotron-3-super",
    endpointUrl: "https://inference.example.test/v1",
    credentialEnv: "INFERENCE_API_KEY",
    preferredInferenceApi,
  });
}

function resumeOptions(
  session: ReturnType<typeof recordedSession>,
  deps: unknown,
  env: NodeJS.ProcessEnv = {},
) {
  return {
    ...baseOptions(deps as never, session),
    resume: true,
    authoritativeResumeConfig: true,
    sandboxName: "spark-assistant",
    env,
  };
}

describe("resumed compatible-endpoint reasoning effort (#7659)", () => {
  it("keeps the recorded effort and reports the request it ignores", async () => {
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    const result = await handleProviderInferenceState(
      resumeOptions(recordedSession("low"), deps, {
        [REASONING_EFFORT_ENV]: "high",
      }),
    );

    expect(calls.log).toHaveBeenCalledWith(
      expect.stringContaining(`Ignoring ${REASONING_EFFORT_ENV}=high`),
    );
    expect(calls.log).toHaveBeenCalledWith(
      expect.stringContaining("recorded as reasoning effort=low"),
    );
    expect(result.compatibleEndpointReasoningEffort).toBe("low");
  });

  it("stays quiet when the request matches the recorded effort", async () => {
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    await handleProviderInferenceState(
      resumeOptions(recordedSession("low"), deps, {
        [REASONING_EFFORT_ENV]: "low",
      }),
    );

    expect(calls.log).not.toHaveBeenCalledWith(
      expect.stringContaining(`Ignoring ${REASONING_EFFORT_ENV}`),
    );
  });

  it("replays the recorded default instead of adopting an ambient request", async () => {
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    const env = { [REASONING_EFFORT_ENV]: "medium" };
    const result = await handleProviderInferenceState(
      resumeOptions(recordedSession(null), deps, env),
    );

    expect(calls.log).toHaveBeenCalledWith(
      expect.stringContaining(`Ignoring ${REASONING_EFFORT_ENV}=medium`),
    );
    expect(result.compatibleEndpointReasoningEffort).toBeNull();
    expect(env[REASONING_EFFORT_ENV]).toBeUndefined();
  });

  it("rejects an invalid injected request before provider effects", async () => {
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    await expect(
      handleProviderInferenceState(
        resumeOptions(recordedSession(null), deps, {
          [REASONING_EFFORT_ENV]: "extreme",
        }),
      ),
    ).rejects.toThrow(/must be one of/);
    expect(calls.recoverProvider).not.toHaveBeenCalled();
    expect(calls.recordSkip).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("rejects an explicit effort for another provider before resume effects", async () => {
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    await expect(
      handleProviderInferenceState(
        resumeOptions(recordedRoute("nvidia-prod", "openai-responses"), deps, {
          [REASONING_EFFORT_ENV]: "high",
        }),
      ),
    ).rejects.toThrow(/only to the compatible-endpoint provider/);
    expect(calls.recoverProvider).not.toHaveBeenCalled();
    expect(calls.recordSkip).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("rejects an explicit effort for another API before resume effects", async () => {
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    await expect(
      handleProviderInferenceState(
        resumeOptions(recordedRoute("compatible-endpoint", "anthropic-messages"), deps, {
          [REASONING_EFFORT_ENV]: "default",
        }),
      ),
    ).rejects.toThrow(/only to compatible-endpoint routes using openai-completions/);
    expect(calls.recoverProvider).not.toHaveBeenCalled();
    expect(calls.recordSkip).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });
});

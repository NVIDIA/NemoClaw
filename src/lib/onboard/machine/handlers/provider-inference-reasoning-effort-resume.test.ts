// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { REASONING_EFFORT_ENV } from "../../reasoning-mode";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

function recordedSession(compatibleEndpointReasoningEffort: string | null) {
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

function resumeOptions(session: ReturnType<typeof recordedSession>, deps: unknown) {
  return {
    ...baseOptions(deps as never, session),
    resume: true,
    authoritativeResumeConfig: true,
    sandboxName: "spark-assistant",
  };
}

describe("resumed compatible-endpoint reasoning effort (#7659)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the recorded effort and reports the request it ignores", async () => {
    vi.stubEnv(REASONING_EFFORT_ENV, "high");
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    const result = await handleProviderInferenceState(resumeOptions(recordedSession("low"), deps));

    expect(calls.log).toHaveBeenCalledWith(
      expect.stringContaining(`Ignoring ${REASONING_EFFORT_ENV}=high`),
    );
    expect(calls.log).toHaveBeenCalledWith(
      expect.stringContaining("recorded as reasoning effort=low"),
    );
    expect(result.compatibleEndpointReasoningEffort).toBe("low");
  });

  it("stays quiet when the request matches the recorded effort", async () => {
    vi.stubEnv(REASONING_EFFORT_ENV, "low");
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    await handleProviderInferenceState(resumeOptions(recordedSession("low"), deps));

    expect(calls.log).not.toHaveBeenCalledWith(
      expect.stringContaining(`Ignoring ${REASONING_EFFORT_ENV}`),
    );
  });

  it("adopts the request when the sandbox has no recorded effort", async () => {
    vi.stubEnv(REASONING_EFFORT_ENV, "medium");
    const { deps } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    const result = await handleProviderInferenceState(resumeOptions(recordedSession(null), deps));

    expect(result.compatibleEndpointReasoningEffort).toBe("medium");
  });
});

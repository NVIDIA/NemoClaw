// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

function recordedSession(compatibleEndpointReasoning: "true" | "false") {
  return createSession({
    provider: "compatible-endpoint",
    model: "nemotron-3-super",
    endpointUrl: "https://compatible.example.test/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    preferredInferenceApi: "openai-completions",
    compatibleEndpointReasoning,
  });
}

describe("resumed compatible-endpoint reasoning flag (#7462)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the recorded flag and the recreate command when the env disagrees", async () => {
    vi.stubEnv("NEMOCLAW_REASONING", "true");
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, recordedSession("false")),
      resume: true,
      authoritativeResumeConfig: true,
      sandboxName: "spark-assistant",
    });

    expect(calls.log).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring NEMOCLAW_REASONING=true"),
    );
    // The message must name the recorded value, not only honor it internally.
    expect(calls.log).toHaveBeenCalledWith(expect.stringContaining("recorded as reasoning=false"));
    expect(calls.log).toHaveBeenCalledWith(
      expect.stringContaining("nemoclaw onboard --fresh --name <sandbox> --recreate-sandbox"),
    );
    expect(result.compatibleEndpointReasoning).toBe("false");
  });

  it("stays quiet when the env agrees with the recorded flag", async () => {
    vi.stubEnv("NEMOCLAW_REASONING", "true");
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    await handleProviderInferenceState({
      ...baseOptions(deps, recordedSession("true")),
      resume: true,
      authoritativeResumeConfig: true,
      sandboxName: "spark-assistant",
    });

    expect(calls.log).not.toHaveBeenCalledWith(
      expect.stringContaining("Ignoring NEMOCLAW_REASONING"),
    );
  });
});

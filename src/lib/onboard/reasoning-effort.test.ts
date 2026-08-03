// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearCompatibleEndpointReasoningEffort,
  compatibleEndpointReasoningClearDeps,
  compatibleEndpointReasoningConfigureDeps,
  configureCompatibleEndpointReasoningEffort,
  describeIgnoredReasoningEffortEnv,
  getCompatibleEndpointReasoningSessionState,
  normalizeReasoningEffort,
  REASONING_EFFORT_ENV,
  resolveReasoningEffortRequest,
} from "./reasoning-mode";

describe("reasoning-effort input contract (#7659)", () => {
  beforeEach(() => {
    vi.stubEnv(REASONING_EFFORT_ENV, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts every supported effort regardless of surrounding case or spacing", () => {
    expect(normalizeReasoningEffort(" Low ")).toBe("low");
    expect(normalizeReasoningEffort("MEDIUM")).toBe("medium");
    expect(normalizeReasoningEffort("high")).toBe("high");
  });

  it("treats an unsupported or non-string value as unset", () => {
    expect(normalizeReasoningEffort("extreme")).toBeNull();
    expect(normalizeReasoningEffort("")).toBeNull();
    expect(normalizeReasoningEffort(42)).toBeNull();
    expect(normalizeReasoningEffort(undefined)).toBeNull();
  });

  it("rejects an unsupported request instead of silently discarding it", () => {
    expect(() => resolveReasoningEffortRequest("extreme")).toThrow(
      /must be one of: low, medium, high, default/,
    );
    vi.stubEnv(REASONING_EFFORT_ENV, "maximum");
    expect(() => resolveReasoningEffortRequest(null)).toThrow(/must be one of/);
  });

  it("reports no request when neither the flag nor the variable is set", () => {
    expect(resolveReasoningEffortRequest(null)).toEqual({ effort: null, explicit: false });
    vi.stubEnv(REASONING_EFFORT_ENV, "   ");
    expect(resolveReasoningEffortRequest("  ")).toEqual({ effort: null, explicit: false });
  });

  it("prefers the flag over the variable", () => {
    vi.stubEnv(REASONING_EFFORT_ENV, "low");
    expect(resolveReasoningEffortRequest("high")).toEqual({ effort: "high", explicit: true });
  });

  it("reads the variable when no flag is supplied", () => {
    vi.stubEnv(REASONING_EFFORT_ENV, "medium");
    expect(resolveReasoningEffortRequest(null)).toEqual({ effort: "medium", explicit: true });
  });

  it("treats default as an explicit request for the unset state", () => {
    expect(resolveReasoningEffortRequest("default")).toEqual({ effort: null, explicit: true });
  });

  it("treats default from the environment as an explicit request for the unset state", () => {
    vi.stubEnv(REASONING_EFFORT_ENV, "default");

    expect(resolveReasoningEffortRequest(null)).toEqual({ effort: null, explicit: true });
  });

  it("pins the recorded effort in the environment the config build reads", async () => {
    vi.stubEnv(REASONING_EFFORT_ENV, "low");

    await expect(configureCompatibleEndpointReasoningEffort("high")).resolves.toBe("high");
    expect(process.env[REASONING_EFFORT_ENV]).toBe("high");
  });

  it("falls back to the request when nothing is recorded", async () => {
    vi.stubEnv(REASONING_EFFORT_ENV, "medium");

    await expect(configureCompatibleEndpointReasoningEffort(null)).resolves.toBe("medium");
    expect(process.env[REASONING_EFFORT_ENV]).toBe("medium");
  });

  it("replays an explicit recorded default without adopting the request", async () => {
    const env = { [REASONING_EFFORT_ENV]: "medium" };

    await expect(configureCompatibleEndpointReasoningEffort(null, env, false)).resolves.toBeNull();
    expect(env[REASONING_EFFORT_ENV]).toBeUndefined();
  });

  it("removes the variable for a provider that does not carry the setting", () => {
    vi.stubEnv(REASONING_EFFORT_ENV, "high");

    expect(clearCompatibleEndpointReasoningEffort()).toBeNull();
    expect(process.env[REASONING_EFFORT_ENV]).toBeUndefined();
  });

  it("bundles paired dependency wiring without changing either behavior", () => {
    expect(compatibleEndpointReasoningConfigureDeps).toEqual({
      configureCompatibleEndpointReasoning: expect.any(Function),
      configureCompatibleEndpointReasoningEffort: expect.any(Function),
    });
    expect(compatibleEndpointReasoningClearDeps).toEqual({
      clearCompatibleEndpointReasoning: expect.any(Function),
      clearCompatibleEndpointReasoningEffort: expect.any(Function),
    });
  });

  it("maps a recorded session into the paired flow context", () => {
    expect(
      getCompatibleEndpointReasoningSessionState({
        compatibleEndpointReasoning: "true",
        compatibleEndpointReasoningEffort: "medium",
      }),
    ).toEqual({
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: "medium",
    });
    expect(getCompatibleEndpointReasoningSessionState(null)).toEqual({
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
    });
  });
});

describe("resume conflict for a recorded reasoning effort (#7659)", () => {
  beforeEach(() => {
    vi.stubEnv(REASONING_EFFORT_ENV, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names the recorded effort and the command that changes it", () => {
    const message = describeIgnoredReasoningEffortEnv("low", "nemoclaw", {
      [REASONING_EFFORT_ENV]: "high",
    } as NodeJS.ProcessEnv);

    expect(message).toContain(`Ignoring ${REASONING_EFFORT_ENV}=high`);
    expect(message).toContain("recorded as reasoning effort=low");
    expect(message).toContain("nemoclaw onboard --fresh --name <sandbox> --recreate-sandbox");
  });

  it("stays quiet when the request matches the recorded effort", () => {
    expect(
      describeIgnoredReasoningEffortEnv("high", "nemoclaw", {
        [REASONING_EFFORT_ENV]: "high",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("stays quiet when nothing was requested", () => {
    expect(
      describeIgnoredReasoningEffortEnv("high", "nemoclaw", {} as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("reports a request that would clear a recorded effort", () => {
    const message = describeIgnoredReasoningEffortEnv("high", "nemoclaw", {
      [REASONING_EFFORT_ENV]: "default",
    } as NodeJS.ProcessEnv);

    expect(message).toContain(`Ignoring ${REASONING_EFFORT_ENV}=default`);
    expect(message).toContain("recorded as reasoning effort=high");
  });
});

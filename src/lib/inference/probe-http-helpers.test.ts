// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const {
  buildValidationProbeTimingProfile,
  getExtendedNvidiaEndpointValidationProbeCurlArgs,
  getKimiK26ValidationProbeCurlArgs,
  getProbeProcessTimeoutMs,
  getValidationProbeCurlArgs,
  getStreamingEventProbeCurlArgs,
  STREAMING_EVENT_PROBE_MAX_SECONDS,
} = require("./probe-http-helpers");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("validation probe curl timing helpers", () => {
  it("derives a tighter fast-network profile from calibration latency", () => {
    expect(
      buildValidationProbeTimingProfile({
        isWsl: false,
        calibration: { ok: true, durationMs: 180 },
      }),
    ).toEqual({
      connectTimeoutSeconds: 5,
      maxTimeSeconds: 15,
      observedMs: 180,
      source: "calibrated",
    });
    expect(
      getValidationProbeCurlArgs({ isWsl: false, calibration: { ok: true, durationMs: 180 } }),
    ).toEqual(["--connect-timeout", "5", "--max-time", "15"]);
  });

  it("derives a slower non-WSL profile from calibration latency", () => {
    expect(
      buildValidationProbeTimingProfile({
        isWsl: false,
        calibration: { ok: true, durationMs: 6_400 },
      }),
    ).toEqual({
      connectTimeoutSeconds: 28,
      maxTimeSeconds: 42,
      observedMs: 6400,
      source: "calibrated",
    });
  });

  it("keeps the WSL floor when calibration samples a fast endpoint (#10413)", () => {
    // Calibration times a cheap `GET /models` and scales that one sample up for
    // the far heavier chat-completions POST. On WSL2 the sample can return in
    // milliseconds while the POST needs tens of seconds, so the calibrated
    // budget must not fall below the floor the uncalibrated branch applies.
    expect(
      buildValidationProbeTimingProfile({
        isWsl: true,
        calibration: { ok: true, durationMs: 180 },
      }),
    ).toEqual({
      connectTimeoutSeconds: 20,
      maxTimeSeconds: 30,
      observedMs: 180,
      source: "calibrated",
    });
  });

  it("lets calibration raise the budget above the WSL floor (#10413)", () => {
    expect(
      buildValidationProbeTimingProfile({
        isWsl: true,
        calibration: { ok: true, durationMs: 6_400 },
      }),
    ).toEqual({
      connectTimeoutSeconds: 28,
      maxTimeSeconds: 42,
      observedMs: 6400,
      source: "calibrated",
    });
  });

  it("falls back to the safe widened budget when calibration fails", () => {
    expect(
      getValidationProbeCurlArgs({ calibration: { ok: false, reason: "curl timed out" } }),
    ).toEqual(["--connect-timeout", "20", "--max-time", "30"]);
  });

  it("keeps the existing WSL fallback when no calibration result is available", () => {
    expect(getValidationProbeCurlArgs({ isWsl: true })).toEqual([
      "--connect-timeout",
      "20",
      "--max-time",
      "30",
    ]);
  });

  it("raises onboard validation connection and maximum times from the environment", () => {
    vi.stubEnv("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS", "300");
    expect(getValidationProbeCurlArgs({ isWsl: false })).toEqual([
      "--connect-timeout",
      "300",
      "--max-time",
      "300",
    ]);
    expect(getKimiK26ValidationProbeCurlArgs({ isWsl: false })).toEqual([
      "--connect-timeout",
      "300",
      "--max-time",
      "300",
    ]);
  });

  it("raises the WSL extended-profile connection deadline with the recovery override", () => {
    vi.stubEnv("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS", "360");
    expect(getExtendedNvidiaEndpointValidationProbeCurlArgs({ isWsl: true })).toEqual([
      "--connect-timeout",
      "360",
      "--max-time",
      "360",
    ]);
  });

  it("does not lower the WSL extended-profile total deadline", () => {
    vi.stubEnv("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS", "60");
    expect(getExtendedNvidiaEndpointValidationProbeCurlArgs({ isWsl: true })).toEqual([
      "--connect-timeout",
      "60",
      "--max-time",
      "300",
    ]);
  });

  it("caps an excessive finite validation override and its process watchdog", () => {
    vi.stubEnv("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS", "1e308");
    const args = getValidationProbeCurlArgs({ isWsl: true });
    expect({ args, processTimeoutMs: getProbeProcessTimeoutMs(args) }).toEqual({
      args: ["--connect-timeout", "600", "--max-time", "600"],
      processTimeoutMs: 605_000,
    });
  });

  // Streaming probe carries its own short deadline so a stall can't hang onboard (#7792).
  it("caps the streaming event probe max-time below the standard budget (#7792)", () => {
    expect(getStreamingEventProbeCurlArgs({ isWsl: false })).toEqual([
      "--connect-timeout",
      "10",
      "--max-time",
      "5",
    ]);
    expect(STREAMING_EVENT_PROBE_MAX_SECONDS).toBe(5);
    // Non-stream standard budget stays at the full 15s for comparison.
    expect(getValidationProbeCurlArgs({ isWsl: false })).toEqual([
      "--connect-timeout",
      "10",
      "--max-time",
      "15",
    ]);
  });

  it("keeps the streaming event probe bounded even when the env raises the budget (#7792)", () => {
    vi.stubEnv("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS", "300");
    expect(getStreamingEventProbeCurlArgs({ isWsl: false })).toEqual([
      "--connect-timeout",
      "10",
      "--max-time",
      "5",
    ]);
  });
});

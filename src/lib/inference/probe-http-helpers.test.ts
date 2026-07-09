// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const {
  buildValidationProbeTimingProfile,
  getKimiK26ValidationProbeCurlArgs,
  getValidationProbeCurlArgs,
} = require("./probe-http-helpers");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("validation probe curl timing helpers", () => {
  it("derives a tighter fast-network profile from calibration latency", () => {
    expect(
      buildValidationProbeTimingProfile({ calibration: { ok: true, durationMs: 180 } }),
    ).toEqual({
      connectTimeoutSeconds: 5,
      maxTimeSeconds: 15,
      observedMs: 180,
      source: "calibrated",
    });
    expect(getValidationProbeCurlArgs({ calibration: { ok: true, durationMs: 180 } })).toEqual([
      "--connect-timeout",
      "5",
      "--max-time",
      "15",
    ]);
  });

  it("derives a slower non-WSL profile from calibration latency", () => {
    expect(
      buildValidationProbeTimingProfile({ calibration: { ok: true, durationMs: 6_400 } }),
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

  it("allows onboard validation max-time to be raised from the environment", () => {
    vi.stubEnv("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS", "300");
    expect(getValidationProbeCurlArgs({ isWsl: false })).toEqual([
      "--connect-timeout",
      "10",
      "--max-time",
      "300",
    ]);
    expect(getKimiK26ValidationProbeCurlArgs({ isWsl: false })).toEqual([
      "--connect-timeout",
      "10",
      "--max-time",
      "300",
    ]);
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  outputLooksLikeMarkerlessGatewayLaunch,
  sandboxRecoveryAttemptFromExecResult,
} from "./markerless-recovery";

describe("markerless recovery output", () => {
  it("treats launcher-started output as provisional recovery only", () => {
    expect(
      outputLooksLikeMarkerlessGatewayLaunch({
        status: 0,
        stdout: "OpenClaw gateway launcher started without legacy recovery marker",
        stderr: "",
      }),
    ).toBe(true);
  });

  it("ignores generic launcher output without gateway-specific wording", () => {
    expect(
      outputLooksLikeMarkerlessGatewayLaunch({
        status: 0,
        stdout: "launcher started for debugging",
        stderr: "",
      }),
    ).toBe(false);
  });

  it("rejects failed or unrelated output", () => {
    expect(
      outputLooksLikeMarkerlessGatewayLaunch({
        status: 0,
        stdout: "RECOVERY_FAILED",
        stderr: "gateway failed",
      }),
    ).toBe(false);
    expect(
      outputLooksLikeMarkerlessGatewayLaunch({
        status: 0,
        stdout: "plain sandbox exec output",
        stderr: "",
      }),
    ).toBe(false);
    expect(
      outputLooksLikeMarkerlessGatewayLaunch({
        status: 1,
        stdout: "launcher started",
        stderr: "",
      }),
    ).toBe(false);
  });

  it("keeps markerless recovery provisional until health is verified by the caller", () => {
    expect(
      sandboxRecoveryAttemptFromExecResult(
        {
          status: 0,
          stdout: "OpenClaw gateway launcher started without legacy recovery marker",
          stderr: "",
        },
        false,
      ),
    ).toEqual({ recovered: false, mayHaveStarted: true });
    expect(sandboxRecoveryAttemptFromExecResult(null, false)).toBeNull();
    expect(
      sandboxRecoveryAttemptFromExecResult(
        {
          status: 0,
          stdout: "GATEWAY_PID=123",
          stderr: "",
        },
        true,
      ),
    ).toEqual({ recovered: true, mayHaveStarted: false });
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveIssue2478RecoverySettings } from "../live/issue-2478-recovery-profile.ts";

describe("gateway crash-loop recovery profiles", () => {
  it("keeps the functional profile to one crash cycle and one stability sample (#7919)", () => {
    expect(
      resolveIssue2478RecoverySettings({
        NEMOCLAW_E2E_RECOVERY_PROFILE: "functional",
      }),
    ).toEqual({
      profile: "functional",
      crashCycles: 1,
      soakSeconds: 15,
    });
  });

  it("retains the full repeated-cycle soak contract by default (#7919)", () => {
    expect(resolveIssue2478RecoverySettings({})).toEqual({
      profile: "soak",
      crashCycles: 5,
      soakSeconds: 300,
    });
  });

  it("keeps the Sunday soak as a strict superset of the functional profile (#7919)", () => {
    const functional = resolveIssue2478RecoverySettings({
      NEMOCLAW_E2E_RECOVERY_PROFILE: "functional",
    });
    const soak = resolveIssue2478RecoverySettings({
      NEMOCLAW_E2E_RECOVERY_PROFILE: "soak",
    });

    expect(soak.crashCycles).toBeGreaterThan(functional.crashCycles);
    expect(soak.soakSeconds).toBeGreaterThan(functional.soakSeconds);
  });

  it("allows positive explicit cycle and soak overrides for diagnostics (#7919)", () => {
    expect(
      resolveIssue2478RecoverySettings({
        NEMOCLAW_E2E_RECOVERY_PROFILE: "soak",
        NEMOCLAW_E2E_CRASH_CYCLES: "2",
        NEMOCLAW_E2E_SOAK_SECONDS: "45",
      }),
    ).toEqual({
      profile: "soak",
      crashCycles: 2,
      soakSeconds: 45,
    });
  });

  it("rejects unknown profiles instead of silently weakening the soak (#7919)", () => {
    expect(() =>
      resolveIssue2478RecoverySettings({
        NEMOCLAW_E2E_RECOVERY_PROFILE: "quick",
      }),
    ).toThrow(/must be 'functional' or 'soak'/);
  });

  it.each([
    ["NEMOCLAW_E2E_CRASH_CYCLES", "0"],
    ["NEMOCLAW_E2E_SOAK_SECONDS", "abc"],
  ] as const)("rejects malformed %s overrides instead of silently using defaults (#7919)", (name, value) => {
    expect(() =>
      resolveIssue2478RecoverySettings({
        [name]: value,
      }),
    ).toThrow(`${name} must be a positive integer`);
  });
});

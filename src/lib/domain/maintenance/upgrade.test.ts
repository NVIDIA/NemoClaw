// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyUpgradeableSandboxes,
  shouldSkipUpgradeConfirmation,
  splitRebuildableSandboxes,
  type SandboxVersionCheck,
} from "./upgrade";

describe("upgrade sandboxes helpers", () => {
  it("detects upgrade confirmation bypass modes", () => {
    expect(shouldSkipUpgradeConfirmation({ auto: true })).toBe(true);
    expect(shouldSkipUpgradeConfirmation({ yes: true })).toBe(true);
    expect(shouldSkipUpgradeConfirmation({ check: true })).toBe(false);
  });

  it("classifies stale and unknown sandboxes with running state", () => {
    const checks: Record<string, SandboxVersionCheck> = {
      staleRunning: { isStale: true, sandboxVersion: "1.0.0", expectedVersion: "2.0.0" },
      staleStopped: { isStale: true, sandboxVersion: null, expectedVersion: "2.0.0" },
      unknown: { isStale: false, detectionMethod: "unavailable", expectedVersion: "2.0.0" },
      current: { isStale: false, sandboxVersion: "2.0.0", expectedVersion: "2.0.0" },
    };

    expect(
      classifyUpgradeableSandboxes(
        [
          { name: "staleRunning" },
          { name: "staleStopped" },
          { name: "unknown" },
          { name: "current" },
        ],
        new Set(["staleRunning", "unknown"]),
        (name) => checks[name],
      ),
    ).toEqual({
      stale: [
        { name: "staleRunning", current: "1.0.0", expected: "2.0.0", running: true },
        { name: "staleStopped", current: null, expected: "2.0.0", running: false },
      ],
      unknown: [{ name: "unknown", expected: "2.0.0", running: true }],
    });
  });

  it("splits stale sandboxes into rebuildable and stopped groups", () => {
    expect(
      splitRebuildableSandboxes([
        { name: "alpha", running: true, expected: "2.0.0" },
        { name: "beta", running: false, expected: "2.0.0" },
      ]),
    ).toEqual({
      rebuildable: [{ name: "alpha", running: true, expected: "2.0.0" }],
      stopped: [{ name: "beta", running: false, expected: "2.0.0" }],
    });
  });
});

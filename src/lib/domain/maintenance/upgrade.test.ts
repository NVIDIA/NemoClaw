// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyUpgradeableSandboxes,
  isNemoclawImageStale,
  type SandboxVersionCheck,
  shouldSkipUpgradeConfirmation,
  splitRebuildableSandboxes,
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
        {
          name: "staleRunning",
          current: "1.0.0",
          expected: "2.0.0",
          running: true,
          reasons: ["agent-version"],
        },
        {
          name: "staleStopped",
          current: null,
          expected: "2.0.0",
          running: false,
          reasons: ["agent-version"],
        },
      ],
      unknown: [{ name: "unknown", expected: "2.0.0", running: true }],
    });
  });

  it("detects NemoClaw image drift only on a recorded, differing fingerprint (#5026)", () => {
    // Recorded fingerprint older than the running build = stale.
    expect(isNemoclawImageStale("0.0.60", "0.0.61")).toBe(true);
    // Matching fingerprint = current.
    expect(isNemoclawImageStale("0.0.61", "0.0.61")).toBe(false);
    // Missing fingerprint (legacy or custom image) = NOT flagged — ambiguous,
    // so it opts in only once rebuilt and stamped. This avoids rebuilding a
    // custom-image sandbox onto the default image.
    expect(isNemoclawImageStale(undefined, "0.0.61")).toBe(false);
    expect(isNemoclawImageStale(null, "0.0.61")).toBe(false);
    // Unknown running build = drift detection disabled.
    expect(isNemoclawImageStale("0.0.60", null)).toBe(false);
  });

  it("flags image drift even when the agent version is unchanged (#5026)", () => {
    const checks: Record<string, SandboxVersionCheck> = {
      // Agent version matches expected — agent-version check says "current".
      imageDrift: {
        isStale: false,
        sandboxVersion: "2026.5.27",
        expectedVersion: "2026.5.27",
        detectionMethod: "registry",
      },
      // Both agent version and image are behind.
      both: { isStale: true, sandboxVersion: "1.0.0", expectedVersion: "2.0.0" },
      // No recorded fingerprint (legacy or custom image) but current agent
      // version — NOT flagged; opts in once rebuilt and stamped (#5026).
      legacy: {
        isStale: false,
        sandboxVersion: "2026.5.27",
        expectedVersion: "2026.5.27",
        detectionMethod: "registry",
      },
      // Fingerprint matches the running build — up to date.
      current: {
        isStale: false,
        sandboxVersion: "2026.5.27",
        expectedVersion: "2026.5.27",
        detectionMethod: "registry",
      },
    };

    expect(
      classifyUpgradeableSandboxes(
        [
          { name: "imageDrift", nemoclawVersion: "0.0.60" },
          { name: "both", nemoclawVersion: "0.0.60" },
          { name: "legacy" },
          { name: "current", nemoclawVersion: "0.0.61" },
        ],
        new Set(["imageDrift", "both", "legacy", "current"]),
        (name) => checks[name],
        { currentNemoclawVersion: "0.0.61" },
      ),
    ).toEqual({
      stale: [
        {
          name: "imageDrift",
          current: "2026.5.27",
          expected: "2026.5.27",
          running: true,
          reasons: ["image-drift"],
          imageCurrent: "0.0.60",
          imageExpected: "0.0.61",
        },
        {
          name: "both",
          current: "1.0.0",
          expected: "2.0.0",
          running: true,
          reasons: ["agent-version", "image-drift"],
          imageCurrent: "0.0.60",
          imageExpected: "0.0.61",
        },
      ],
      // `legacy` (no fingerprint) and `current` (matching fingerprint) are both
      // up to date.
      unknown: [],
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

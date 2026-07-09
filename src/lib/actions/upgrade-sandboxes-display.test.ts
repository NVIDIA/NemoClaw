// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { UpgradeSandboxCandidate } from "../domain/maintenance/upgrade";
import { describeStaleUpgrade } from "./upgrade-sandboxes";

function candidate(overrides: Partial<UpgradeSandboxCandidate>): UpgradeSandboxCandidate {
  return { name: "my-assistant", running: false, ...overrides };
}

describe("describeStaleUpgrade version-change labeling (#6520)", () => {
  it("labels a NemoClaw image downgrade explicitly instead of framing it as a routine upgrade", () => {
    expect(
      describeStaleUpgrade(
        candidate({
          current: "2026.6.10",
          expected: "2026.6.10",
          reasons: ["image-drift"],
          imageCurrent: "0.0.77",
          imageExpected: "0.0.76",
        }),
      ),
    ).toBe("v2026.6.10 unchanged; NemoClaw image v0.0.77 → v0.0.76 (downgrade)");
  });

  it("labels an agent-version downgrade explicitly", () => {
    expect(
      describeStaleUpgrade(
        candidate({ current: "2026.6.10", expected: "2026.5.1", reasons: ["agent-version"] }),
      ),
    ).toBe("v2026.6.10 → v2026.5.1 (downgrade)");
  });

  it("keeps upgrade descriptions unchanged", () => {
    expect(
      describeStaleUpgrade(
        candidate({
          current: "2026.6.10",
          expected: "2026.6.10",
          reasons: ["image-drift"],
          imageCurrent: "0.0.76",
          imageExpected: "0.0.77",
        }),
      ),
    ).toBe("v2026.6.10 unchanged; NemoClaw image v0.0.76 → v0.0.77");
  });

  it("does not label a downgrade when the recorded image build is unknown", () => {
    expect(
      describeStaleUpgrade(
        candidate({
          current: "2026.6.10",
          expected: "2026.6.10",
          reasons: ["image-drift"],
          imageCurrent: null,
          imageExpected: "0.0.76",
        }),
      ),
    ).toBe("v2026.6.10 unchanged; NemoClaw image unknown build → v0.0.76");
  });
});

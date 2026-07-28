// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { formatSnapshotBaselineExclusionSummary } from "./snapshot-baseline-exclusion-summary";

describe("formatSnapshotBaselineExclusionSummary (#7178)", () => {
  it("discloses active exclusions and their support impact", () => {
    expect(
      formatSnapshotBaselineExclusionSummary([
        { version: 1, agent: "hermes", key: "nous_research", digest: "digest-a" },
        { version: 1, agent: "hermes", key: "managed_inference", digest: "digest-b" },
      ]),
    ).toEqual([
      "Active baseline exclusions: nous_research, managed_inference",
      expect.stringMatching(/^Support impact: .*unsupported/),
    ]);
  });

  it("omits the summary when no exclusions are active", () => {
    expect(formatSnapshotBaselineExclusionSummary([])).toEqual([]);
  });
});

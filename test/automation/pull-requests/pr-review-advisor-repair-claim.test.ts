// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assertRepairAttemptUnclaimed } from "../../../tools/pr-review-advisor/repair-claim.mts";

const attemptKey = `sha256:${"a".repeat(64)}`;

describe("PR Review Advisor one-shot claim", () => {
  it("rejects a matching attempt beyond the first hundred check runs (#10791)", () => {
    const firstPage = {
      total_count: 101,
      check_runs: Array.from({ length: 100 }, (_, index) => ({ external_id: `other-${index}` })),
    };
    const secondPage = { total_count: 101, check_runs: [{ external_id: attemptKey }] };

    expect(() => assertRepairAttemptUnclaimed([firstPage, secondPage], attemptKey)).toThrow(
      "already claimed",
    );
  });

  it("accepts a complete page set without the exact attempt key (#10791)", () => {
    expect(() =>
      assertRepairAttemptUnclaimed(
        [{ total_count: 1, check_runs: [{ external_id: "different" }] }],
        attemptKey,
      ),
    ).not.toThrow();
  });

  it.each([
    ["missing totals", [{ check_runs: [] }]],
    [
      "inconsistent totals",
      [
        { total_count: 1, check_runs: [] },
        { total_count: 2, check_runs: [] },
      ],
    ],
    ["truncated results", [{ total_count: 2, check_runs: [{ external_id: "different" }] }]],
  ])("rejects %s in the paginated claim input (#10791)", (_case, pages) => {
    expect(() => assertRepairAttemptUnclaimed(pages, attemptKey)).toThrow();
  });
});

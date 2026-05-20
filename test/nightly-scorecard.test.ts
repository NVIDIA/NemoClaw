// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

type WorkflowRun = {
  status: string;
  event: string;
  created_at: string;
  conclusion: string | null;
};

function findPriorScheduledRunFromFirstPage(
  runs: WorkflowRun[],
  since24h: string,
): WorkflowRun | undefined {
  return runs.filter(
    (run) =>
      run.status === "completed" &&
      run.event === "schedule" &&
      new Date(run.created_at) < new Date(since24h),
  )[0];
}

describe("nightly scorecard prior-day trend lookup", () => {
  it("finds the prior scheduled run even when selective dispatches fill the first API page", () => {
    const since24h = "2026-05-19T01:02:21.000Z";
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      status: "completed",
      event: index === 20 ? "schedule" : "workflow_dispatch",
      created_at:
        index === 20
          ? "2026-05-20T00:21:09Z"
          : `2026-05-20T${String(23 - Math.floor(index / 5)).padStart(2, "0")}:00:00Z`,
      conclusion: index % 3 === 0 ? "failure" : "success",
    }));
    const secondPage = [
      {
        status: "completed",
        event: "schedule",
        created_at: "2026-05-19T00:20:30Z",
        conclusion: "failure",
      },
    ];

    const currentImplementationResult = findPriorScheduledRunFromFirstPage(
      firstPage,
      since24h,
    );

    expect(currentImplementationResult?.created_at).toBe(secondPage[0].created_at);
  });
});

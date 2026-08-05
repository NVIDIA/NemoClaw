// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { CoordinatorFixture } from "./check-gates-coordinator-test-fixtures.ts";
import {
  coordinatorJobs,
  DEFAULT_COORDINATOR_RANGES,
  historicalCoordinatorRun,
  paginatedRunIds,
  runGateWithCoordinator,
} from "./check-gates-coordinator-test-fixtures.ts";
import { BASE_SHA, e2eCoordinatorRun, HEAD_SHA } from "./check-gates-test-fixtures.ts";

describe("maintainer merge-gate E2E coordinator evidence", () => {
  it("rejects a workflow-run inventory at the 1,000-result cap", () => {
    const cappedIds = Array.from({ length: 1_000 }, (_value, index) => 30_000 + index);
    const result = runGateWithCoordinator({
      coordinatorRunPartitions: [
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[0],
          runPages: paginatedRunIds(cappedIds),
          totalCount: 1_000,
          fallbackCreatedAt: "2025-12-31T06:00:00Z",
        },
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[1],
          runPages: [[]],
        },
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[2],
          runPages: [[9500]],
        },
      ],
    });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
    expect(output.gates.ci.failingChecks).toContain(
      "E2E / PR Gate: latest attempt evidence incomplete",
    );
  });

  const rejectedCoordinatorEvidence: Array<
    CoordinatorFixture & {
      condition: string;
    }
  > = [
    {
      condition: "an inclusive boundary repeats changed metadata for the same run",
      coordinator: { createdAt: "2026-01-01T00:00:00Z" },
      coordinatorRunPartitions: [
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[0],
          runPages: [[]],
        },
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[1],
          runPages: [[9500]],
        },
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[2],
          runPages: [[9500]],
          runOverrides: {
            "9500": { updatedAt: "2026-01-01T00:02:33Z" },
          },
        },
      ],
    },
    {
      condition: "the same run appears outside adjacent partition boundaries",
      coordinatorRunPartitions: [
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[0],
          runPages: [[10000]],
          fallbackCreatedAt: "2025-12-31T06:00:00Z",
        },
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[1],
          runPages: [[]],
        },
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[2],
          runPages: [[10000, 9500]],
          fallbackCreatedAt: "2026-01-01T00:01:00Z",
        },
      ],
    },
    {
      condition: "coordinator metadata changes between inventory and detail reads",
      coordinatorList: { updatedAt: "2026-01-01T00:02:33Z" },
    },
    {
      condition: "a partition reports inconsistent totals across pages",
      coordinatorRunPartitions: [
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[0],
          runPages: [[]],
        },
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[1],
          runPages: [[]],
        },
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[2],
          runPages: [[9500], []],
          pageTotalCounts: [1, 2],
        },
      ],
    },
    {
      condition: "the custom check has no coordinator",
      coordinatorRunPages: [[]],
    },
    {
      condition: "two coordinator runs enclose the current custom check",
      coordinatorRunPages: [[9500, 9501]],
      extraRuns: { "9501": e2eCoordinatorRun() },
    },
    {
      condition: "older same-revision coordinator metadata is malformed",
      coordinatorRunPages: [[9501, 9500]],
      extraRuns: {
        "9501": {
          ...historicalCoordinatorRun(),
          repository: "example/NemoClaw",
        },
      },
    },
    {
      condition: "an older same-revision coordinator run failed",
      coordinatorRunPages: [[9501, 9500]],
      extraRuns: {
        "9501": {
          ...historicalCoordinatorRun(),
          conclusion: "failure",
        },
      },
    },
    {
      condition: "an older same-revision coordinate job failed",
      coordinatorRunPages: [[9501, 9500]],
      extraRuns: {
        "9501": {
          ...historicalCoordinatorRun(),
          jobs: coordinatorJobs({
            conclusion: "failure",
            startedAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:59Z",
          }),
        },
      },
    },
    {
      condition: "an older same-revision coordinate job completes after its run",
      coordinatorRunPages: [[9501, 9500]],
      extraRuns: {
        "9501": {
          ...historicalCoordinatorRun(),
          jobs: coordinatorJobs({
            startedAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:01:01Z",
          }),
        },
      },
    },
    {
      condition: "a failed same-revision coordinator overlaps the current custom check",
      coordinatorRunPages: [[9501, 9500]],
      extraRuns: {
        "9501": e2eCoordinatorRun("failure", coordinatorJobs({ conclusion: "failure" })),
      },
    },
    {
      condition: "the coordinator title does not match",
      coordinator: { displayTitle: "E2E Gate coordinate from another workflow" },
    },
    {
      condition: "the coordinator title names another PR head",
      coordinator: {
        displayTitle:
          "E2E Gate coordinate from CI PR #42 head " +
          "c".repeat(40) +
          " base " +
          BASE_SHA +
          " gate true",
      },
    },
    {
      condition: "the coordinator title names another PR base",
      coordinator: {
        displayTitle:
          "E2E Gate coordinate from CI PR #42 head " +
          HEAD_SHA +
          " base " +
          "c".repeat(40) +
          " gate true",
      },
    },
    {
      condition: "the coordinator title sets gate false",
      coordinator: {
        displayTitle:
          "E2E Gate coordinate from CI PR #42 head " +
          HEAD_SHA +
          " base " +
          BASE_SHA +
          " gate false",
      },
    },
    {
      condition: "the coordinator uses another event",
      coordinator: { event: "pull_request_target" },
    },
    {
      condition: "the coordinator uses another workflow path",
      coordinator: { path: ".github/workflows/pr.yaml" },
    },
    {
      condition: "the coordinator runs on another branch",
      coordinator: { headBranch: "release" },
    },
    {
      condition: "the coordinator head commit SHA is malformed",
      coordinator: { headSha: "not-a-sha" },
    },
    {
      condition: "the coordinator commit SHA does not match the captured base SHA",
      coordinator: { headSha: "d".repeat(40) },
    },
    {
      condition: "the coordinator belongs to another repository",
      coordinator: { repository: "example/NemoClaw" },
    },
    {
      condition: "the coordinator head belongs to another repository",
      coordinator: { headRepository: "example/NemoClaw" },
    },
    {
      condition: "the coordinator uses another attempt",
      coordinator: { attempt: 2 },
    },
    {
      condition: "the coordinator run is not completed",
      coordinator: { status: "in_progress", conclusion: null },
    },
    {
      condition: "the coordinator run has a non-success conclusion",
      coordinator: { conclusion: "neutral" },
    },
    {
      condition: "the coordinator run failed",
      coordinator: { conclusion: "failure" },
    },
    {
      condition: "the coordinator has no coordinate job",
      coordinatorJobs: coordinatorJobs().filter((job) => job.name !== "coordinate"),
    },
    {
      condition: "the coordinator has duplicate coordinate jobs",
      coordinatorJobs: [
        ...coordinatorJobs(),
        {
          ...coordinatorJobs().find((job) => job.name === "coordinate")!,
          id: 954,
        },
      ],
    },
    {
      condition: "the coordinator job has another name",
      coordinatorJobs: coordinatorJobs({ name: "finish" }),
    },
    {
      condition: "the coordinate job is not completed",
      coordinatorJobs: coordinatorJobs({ status: "in_progress", conclusion: null }),
    },
    {
      condition: "the coordinate job failed",
      coordinatorJobs: coordinatorJobs({ conclusion: "failure" }),
    },
    {
      condition: "the coordinate job has no started_at timestamp",
      coordinatorJobs: coordinatorJobs({ omitStartedAt: true }),
    },
    {
      condition: "the coordinate job has no completed_at timestamp",
      coordinatorJobs: coordinatorJobs({ omitCompletedAt: true }),
    },
    {
      condition: "the coordinate job started_at timestamp is null",
      coordinatorJobs: coordinatorJobs({ startedAt: null }),
    },
    {
      condition: "the coordinate job completed_at timestamp is null",
      coordinatorJobs: coordinatorJobs({ completedAt: null }),
    },
    {
      condition: "the coordinate job started_at timestamp is malformed",
      coordinatorJobs: coordinatorJobs({ startedAt: "not-a-time" }),
    },
    {
      condition: "the coordinate job completed_at timestamp is malformed",
      coordinatorJobs: coordinatorJobs({ completedAt: "not-a-time" }),
    },
    {
      condition: "the coordinate job starts after it completes",
      coordinatorJobs: coordinatorJobs({
        startedAt: "2026-01-01T00:02:32Z",
        completedAt: "2026-01-01T00:02:31Z",
      }),
    },
    {
      condition: "the coordinate job completes before custom check completion",
      coordinatorJobs: coordinatorJobs({
        completedAt: "2026-01-01T00:02:29Z",
      }),
    },
    {
      condition: "the coordinate job starts after custom check completion",
      coordinatorJobs: coordinatorJobs({
        startedAt: "2026-01-01T00:02:31Z",
      }),
    },
    {
      condition: "the coordinator run has no created_at timestamp",
      coordinator: { omitCreatedAt: true },
    },
    {
      condition: "the coordinator run has no updated_at timestamp",
      coordinator: { omitUpdatedAt: true },
    },
    {
      condition: "the coordinator run created_at timestamp is malformed",
      coordinator: { createdAt: "not-a-time" },
    },
    {
      condition: "the coordinator run updated_at timestamp is malformed",
      coordinator: { updatedAt: "not-a-time" },
    },
    {
      condition: "the coordinator run is updated before it is created",
      coordinator: {
        createdAt: "2026-01-01T00:02:33Z",
        updatedAt: "2026-01-01T00:02:32Z",
      },
    },
  ];

  it.each(rejectedCoordinatorEvidence)("rejects terminal custom check evidence when $condition", ({
    condition: _condition,
    ...fixture
  }) => {
    const result = runGateWithCoordinator(fixture);
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
    expect(output.gates.ci.failingChecks).toContain(
      "E2E / PR Gate: latest attempt evidence incomplete",
    );
  });
});

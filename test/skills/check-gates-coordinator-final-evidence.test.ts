// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  coordinatorJobs,
  DEFAULT_COORDINATOR_RANGES,
  paginatedRunIds,
  retryableFailure,
  runGateWithCoordinator,
} from "./check-gates-coordinator-test-fixtures.ts";
import { coordinationCheck, e2eCoordinatorRun } from "./check-gates-test-fixtures.ts";

describe("maintainer merge-gate E2E coordinator evidence", () => {
  it("accepts more than 1,000 workflow runs when each partition returns its reported total", () => {
    const firstPartitionIds = Array.from({ length: 600 }, (_value, index) => 10_000 + index);
    const secondPartitionIds = Array.from({ length: 600 }, (_value, index) => 20_000 + index);
    const result = runGateWithCoordinator({
      coordinatorRunPartitions: [
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[0],
          runPages: paginatedRunIds(firstPartitionIds),
          fallbackCreatedAt: "2025-12-31T06:00:00Z",
        },
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[1],
          runPages: paginatedRunIds(secondPartitionIds),
          fallbackCreatedAt: "2025-12-31T18:00:00Z",
        },
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[2],
          runPages: [[9500]],
        },
      ],
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it("deduplicates an identical coordinator returned at an inclusive partition boundary", () => {
    const result = runGateWithCoordinator({
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
        },
      ],
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it("rejects a newer custom-check retry that appears during final observation", () => {
    const result = runGateWithCoordinator({
      finalCoordinationCheckPages: [
        {
          total_count: 2,
          check_runs: [
            coordinationCheck(),
            coordinationCheck({
              id: 8001,
              status: "in_progress",
              conclusion: null,
              started_at: "2026-01-01T00:02:31Z",
              completed_at: null,
            }),
          ],
        },
      ],
    });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
    expect(output.gates.ci.failingChecks).toContain("E2E / PR Gate: final evidence changed");
  });

  it("rejects a newer queued coordinator before it creates a custom check", () => {
    const result = runGateWithCoordinator({
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
          runPages: [[9500]],
          finalRunPages: [[9500, 9501]],
        },
      ],
      extraRuns: {
        "9501": {
          ...e2eCoordinatorRun(),
          createdAt: "2026-01-01T00:02:40Z",
          updatedAt: "2026-01-01T00:02:40Z",
          status: "queued",
          conclusion: null,
          jobs: [],
        },
      },
    });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
    expect(output.gates.ci.failingChecks).toContain("E2E / PR Gate: final evidence changed");
  });

  it("rejects a PR revision that changes while final CI evidence is read", () => {
    const result = runGateWithCoordinator({
      finalPrAfterCiEvidence: {
        body: "Signed-off-by: Example User <user@example.com>\n\nChanged during final CI.",
      },
    });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      allPass: false,
      gates: {
        conflicts: {
          pass: false,
          details:
            "PR revision or merge state changed during gate evaluation; rerun the gate checker",
        },
      },
    });
  });

  it("rejects failed coordinator history from an earlier day for the same revision", () => {
    const result = runGateWithCoordinator({
      coordinationCheckPages: [
        {
          total_count: 2,
          check_runs: [
            retryableFailure(7999, "2025-12-29T00:01:00Z", "2025-12-29T00:03:00Z"),
            coordinationCheck(),
          ],
        },
      ],
      coordinatorRunPartitions: [
        {
          createdRange: "2025-12-28T00:00:00Z..2025-12-28T12:00:00Z",
          runPages: [[]],
        },
        {
          createdRange: "2025-12-28T12:00:00Z..2025-12-29T00:00:00Z",
          runPages: [[]],
        },
        {
          createdRange: "2025-12-29T00:00:00Z..2025-12-29T12:00:00Z",
          runPages: [[9501]],
        },
        {
          createdRange: "2025-12-29T12:00:00Z..2025-12-30T00:00:00Z",
          runPages: [[]],
        },
        {
          createdRange: "2025-12-30T00:00:00Z..2025-12-30T12:00:00Z",
          runPages: [[]],
        },
        {
          createdRange: "2025-12-30T12:00:00Z..2025-12-31T00:00:00Z",
          runPages: [[]],
        },
        {
          createdRange: "2025-12-31T00:00:00Z..2025-12-31T12:00:00Z",
          runPages: [[]],
        },
        {
          createdRange: "2025-12-31T12:00:00Z..2026-01-01T00:00:00Z",
          runPages: [[]],
        },
        {
          createdRange: DEFAULT_COORDINATOR_RANGES[2],
          runPages: [[9500]],
        },
      ],
      extraRuns: {
        "9501": {
          ...e2eCoordinatorRun("failure"),
          createdAt: "2025-12-29T00:02:00Z",
          updatedAt: "2025-12-29T00:03:01Z",
          jobs: coordinatorJobs({
            startedAt: "2025-12-29T00:02:01Z",
            completedAt: "2025-12-29T00:03:00Z",
          }),
        },
      },
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

  it("rejects a custom-check timestamp span beyond the 14-day inventory limit", () => {
    const result = runGateWithCoordinator({
      customCheck: {
        started_at: "2000-01-01T00:00:00Z",
        completed_at: "2026-01-01T00:02:30Z",
      },
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

  it.each([
    {
      field: "status",
      overrides: { status: "in_progress", conclusion: null, completed_at: null },
    },
    { field: "conclusion", overrides: { conclusion: "neutral" } },
    { field: "start time", overrides: { started_at: "2026-01-01T00:01:31Z" } },
    { field: "completion time", overrides: { completed_at: "2026-01-01T00:02:31Z" } },
    {
      field: "details URL",
      overrides: { details_url: "https://github.com/NVIDIA/NemoClaw/runs/8001" },
    },
  ])("rejects a changed selected custom-check $field during final observation", ({ overrides }) => {
    const result = runGateWithCoordinator({
      finalCoordinationCheckPages: [
        {
          total_count: 1,
          check_runs: [coordinationCheck(overrides)],
        },
      ],
    });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
    expect(output.gates.ci.failingChecks).toContain("E2E / PR Gate: final evidence changed");
  });

  it("rejects changed former custom-check history during final observation", () => {
    const result = runGateWithCoordinator({
      finalFormerCoordinationCheckPages: [
        {
          total_count: 1,
          check_runs: [
            coordinationCheck({
              id: 7999,
              name: "E2E / PR Gate Coordination",
            }),
          ],
        },
      ],
    });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
    expect(output.gates.ci.failingChecks).toContain("E2E / PR Gate: final evidence changed");
  });

  it.each([
    {
      condition: "fails",
      status: "COMPLETED",
      conclusion: "FAILURE",
      resultField: "failingChecks",
      expected: "Repository policy: FAILURE",
    },
    {
      condition: "remains pending",
      status: "IN_PROGRESS",
      conclusion: undefined,
      resultField: "pendingChecks",
      expected: "Repository policy",
    },
  ])("rejects a non-required repository check that $condition after final E2E evidence", ({
    status,
    conclusion,
    resultField,
    expected,
  }) => {
    const result = runGateWithCoordinator({
      additionalChecksAfterE2eEvidence: [
        {
          __typename: "CheckRun",
          name: "Repository policy",
          detailsUrl: "https://github.com/NVIDIA/NemoClaw/runs/99001",
          startedAt: "2026-01-01T00:02:40Z",
          completedAt: status === "COMPLETED" ? "2026-01-01T00:02:50Z" : undefined,
          status,
          conclusion,
        },
      ],
    });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
    expect(output.gates.ci[resultField]).toContain(expected);
  });

  it("rejects a changed passing required-check record during final observation", () => {
    const result = runGateWithCoordinator({
      finalCheckOverrides: {
        checks: { startedAt: "2026-01-01T00:00:01Z" },
      },
    });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
    expect(output.gates.ci.failingChecks).toContain(
      "Required check rollup changed during gate evaluation",
    );
  });

  it("rejects a required check that fails during final observation", () => {
    const result = runGateWithCoordinator({
      finalCheckOverrides: {
        checks: { conclusion: "FAILURE" },
      },
    });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
    expect(output.gates.ci.failingChecks).toContain("checks: FAILURE");
  });

  it("rejects a required check that becomes pending during final observation", () => {
    const result = runGateWithCoordinator({
      finalCheckOverrides: {
        checks: { conclusion: undefined, status: "IN_PROGRESS" },
      },
    });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
    expect(output.gates.ci.pendingChecks).toContain("checks");
  });
});

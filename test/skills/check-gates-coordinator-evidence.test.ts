// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type {
  ActionJobFixture,
  ActionRunFixture,
  ComplianceFixture,
  CoordinatorRunPartitionFixture,
} from "./check-gates-test-fixtures.ts";
import {
  BASE_SHA,
  coordinationCheck,
  e2eCoordinatorRun,
  e2eManualCoordinatorRun,
  exactDiffGateRun,
  HEAD_SHA,
  prWorkflowRun,
  runGate,
  successfulRequiredChecks,
} from "./check-gates-test-fixtures.ts";

function seedJobs(): ActionJobFixture[] {
  return [
    { id: 471, name: "cancel-superseded" },
    { id: 472, name: "initialize" },
    { id: 473, name: "coordinate", conclusion: "skipped" },
  ].map((job) => ({
    ...job,
    startedAt: "2026-01-01T00:01:00Z",
    completedAt: "2026-01-01T00:01:31Z",
  }));
}

function laterSeedJobs(): ActionJobFixture[] {
  return seedJobs().map((job) => ({
    ...job,
    id: job.id + 100,
    startedAt: "2026-01-01T00:02:42Z",
    completedAt: "2026-01-01T00:02:50Z",
  }));
}

function coordinatorJobs(overrides: Partial<ActionJobFixture> = {}): ActionJobFixture[] {
  return (e2eCoordinatorRun().jobs ?? []).map((job) =>
    job.name === "coordinate" ? { ...job, ...overrides } : job,
  );
}

function historicalCoordinatorRun(): ActionRunFixture {
  return {
    ...e2eCoordinatorRun(
      "success",
      coordinatorJobs({
        conclusion: "success",
        startedAt: "2026-01-01T00:00:20Z",
        completedAt: "2026-01-01T00:00:59Z",
      }),
    ),
    createdAt: "2026-01-01T00:00:10Z",
    updatedAt: "2026-01-01T00:01:00Z",
  };
}

function retryableFailure(id: number, startedAt: string, completedAt: string) {
  return coordinationCheck({
    id,
    conclusion: "failure",
    started_at: startedAt,
    completed_at: completedAt,
    output: {
      title: "Retryable E2E failure",
      summary: "Retryable failure.\n\n<!-- nemoclaw-pr-e2e-retry:v1:prerequisite-ci -->",
    },
  });
}

const DEFAULT_COORDINATOR_RANGES = [
  "2025-12-31T00:00:00Z..2025-12-31T12:00:00Z",
  "2025-12-31T12:00:00Z..2026-01-01T00:00:00Z",
  "2026-01-01T00:00:00Z..2026-01-01T00:03:00Z",
] as const;

function paginatedRunIds(ids: number[]): number[][] {
  return Array.from({ length: Math.ceil(ids.length / 100) }, (_value, index) =>
    ids.slice(index * 100, (index + 1) * 100),
  );
}

interface CoordinatorFixture {
  additionalStatusChecks?: NonNullable<ComplianceFixture["statusChecks"]>;
  coordinator?: Partial<ActionRunFixture>;
  coordinatorList?: Partial<ActionRunFixture>;
  coordinatorJobs?: ActionJobFixture[];
  coordinatorRunPages?: number[][];
  coordinatorRunPartitions?: CoordinatorRunPartitionFixture[];
  coordinationCheckPages?: unknown[];
  customCheck?: Record<string, unknown>;
  extraRuns?: Record<string, ActionRunFixture>;
  finalCheckOverrides?: Record<
    string,
    Partial<NonNullable<ComplianceFixture["statusChecks"]>[number]>
  >;
  finalCoordinationCheckPages?: unknown[];
  finalFormerCoordinationCheckPages?: unknown[];
  finalPrAfterCiEvidence?: Record<string, unknown>;
  additionalChecksAfterE2eEvidence?: NonNullable<ComplianceFixture["statusChecks"]>;
  headRepository?: string;
  includeInitialSeedEvidence?: boolean;
  observationTime?: string;
  seedRun?: Partial<ActionRunFixture>;
  currentBaseSha?: string | null;
}

const LIVE_FORK_COORDINATOR_RANGES = [
  "2026-08-03T00:00:00Z..2026-08-03T12:00:00Z",
  "2026-08-03T12:00:00Z..2026-08-04T00:00:00Z",
  "2026-08-04T00:00:00Z..2026-08-04T12:00:00Z",
  "2026-08-04T12:00:00Z..2026-08-04T14:58:00Z",
] as const;

function authorizedForkLifecycleFixture(
  additionalAutomaticRuns: Record<string, ActionRunFixture> = {},
): CoordinatorFixture {
  const automaticCoordinator = {
    ...e2eCoordinatorRun(),
    createdAt: "2026-08-04T14:36:34Z",
    updatedAt: "2026-08-04T14:37:04Z",
    jobs: coordinatorJobs({
      startedAt: "2026-08-04T14:36:35Z",
      completedAt: "2026-08-04T14:37:03Z",
    }),
  };
  const manualCoordinator = {
    ...e2eManualCoordinatorRun(),
    createdAt: "2026-08-04T14:38:13Z",
    updatedAt: "2026-08-04T14:57:43Z",
    jobs: coordinatorJobs({
      startedAt: "2026-08-04T14:38:14Z",
      completedAt: "2026-08-04T14:57:42Z",
    }),
  };
  const automaticRunIds = [9501, ...Object.keys(additionalAutomaticRuns).map(Number)];
  return {
    headRepository: "example/fork",
    observationTime: "2026-08-04T14:58:00Z",
    customCheck: {
      started_at: "2026-08-04T14:23:40Z",
      completed_at: "2026-08-04T14:57:39Z",
    },
    coordinator: manualCoordinator,
    seedRun: {
      headRepository: "example/fork",
      createdAt: "2026-08-04T14:21:55Z",
      updatedAt: "2026-08-04T14:23:47Z",
      jobs: seedJobs().map((job) => ({
        ...job,
        startedAt: "2026-08-04T14:23:15Z",
        completedAt: "2026-08-04T14:23:42Z",
      })),
    },
    coordinatorRunPartitions: [
      ...LIVE_FORK_COORDINATOR_RANGES.map((createdRange, index) => ({
        createdRange,
        runPages: [index === LIVE_FORK_COORDINATOR_RANGES.length - 1 ? automaticRunIds : []],
      })),
      {
        createdRange: LIVE_FORK_COORDINATOR_RANGES.at(-1)!,
        event: "workflow_dispatch",
        runPages: [[9500]],
      },
    ],
    extraRuns: {
      "90": {
        ...prWorkflowRun(
          "success",
          [
            { id: 1, name: "checks" },
            { id: 2, name: "changes" },
          ],
          true,
        ),
        headRepository: "example/fork",
        pullRequests: [],
      },
      "9501": automaticCoordinator,
      ...additionalAutomaticRuns,
    },
  };
}

function delayedRetryFixture(): CoordinatorFixture {
  return {
    seedRun: {
      createdAt: "2026-08-04T14:07:32Z",
      updatedAt: "2026-08-04T14:08:01Z",
      jobs: seedJobs().map((job) => ({
        ...job,
        startedAt: "2026-08-04T14:07:40Z",
        completedAt: "2026-08-04T14:08:00Z",
      })),
    },
    customCheck: {
      started_at: "2026-08-04T14:28:06Z",
      completed_at: "2026-08-04T14:38:01Z",
    },
    coordinator: {
      createdAt: "2026-08-04T14:27:44Z",
      updatedAt: "2026-08-04T14:38:06Z",
    },
    coordinatorJobs: coordinatorJobs({
      startedAt: "2026-08-04T14:27:47Z",
      completedAt: "2026-08-04T14:38:05Z",
    }),
    coordinatorRunPartitions: [
      {
        createdRange: "2026-08-03T00:00:00Z..2026-08-03T12:00:00Z",
        runPages: [[]],
      },
      {
        createdRange: "2026-08-03T12:00:00Z..2026-08-04T00:00:00Z",
        runPages: [[]],
      },
      {
        createdRange: "2026-08-04T00:00:00Z..2026-08-04T12:00:00Z",
        runPages: [[]],
      },
      {
        createdRange: "2026-08-04T12:00:00Z..2026-08-04T14:38:01Z",
        runPages: [[9500]],
      },
    ],
  };
}

function seedStatusChecks(
  runId: number,
  jobs: ActionJobFixture[],
  fallbackStartedAt = "2026-01-01T00:01:00Z",
) {
  return jobs.map((job) => ({
    __typename: "CheckRun",
    name: job.name,
    workflowName: "E2E / PR Gate Controller",
    detailsUrl: `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}/job/${job.id}`,
    startedAt: job.startedAt ?? fallbackStartedAt,
    status: (job.status ?? "completed").toUpperCase(),
    ...(job.conclusion === null ? {} : { conclusion: (job.conclusion ?? "success").toUpperCase() }),
  }));
}

function manualOnlyCoordinatorPartitions(): CoordinatorRunPartitionFixture[] {
  return DEFAULT_COORDINATOR_RANGES.map((createdRange, index) => ({
    createdRange,
    event: "workflow_dispatch",
    runPages: [index === DEFAULT_COORDINATOR_RANGES.length - 1 ? [9500] : []],
  }));
}

function runGateWithCoordinator({
  additionalStatusChecks = [],
  coordinator = {},
  coordinatorList,
  coordinatorJobs: configuredJobs,
  coordinatorRunPages = [[9500]],
  coordinatorRunPartitions,
  coordinationCheckPages,
  customCheck = {},
  extraRuns = {},
  finalCheckOverrides = {},
  finalCoordinationCheckPages,
  finalFormerCoordinationCheckPages,
  finalPrAfterCiEvidence,
  additionalChecksAfterE2eEvidence,
  headRepository,
  includeInitialSeedEvidence = true,
  observationTime,
  seedRun = {},
  currentBaseSha,
}: CoordinatorFixture = {}) {
  const defaultCoordinator = e2eCoordinatorRun();
  const jobs = seedRun.jobs ?? seedJobs();
  const statusChecks = [
    ...successfulRequiredChecks().filter((check) => check.name !== "initialize"),
    ...(includeInitialSeedEvidence
      ? seedStatusChecks(407, jobs, seedRun.createdAt ?? undefined)
      : []),
    ...additionalStatusChecks,
  ];
  const finalStatusChecks =
    Object.keys(finalCheckOverrides).length > 0
      ? statusChecks.map((check) => {
          const overrides = check.name === undefined ? undefined : finalCheckOverrides[check.name];
          return { ...check, ...overrides };
        })
      : undefined;
  const coordinatorJobs = configuredJobs ?? coordinator.jobs ?? defaultCoordinator.jobs;
  return runGate({
    body: "Signed-off-by: Example User <user@example.com>",
    verified: true,
    headRepository,
    observationTime,
    currentBaseSha,
    statusChecks,
    coordinatorRunPages,
    coordinatorRunPartitions,
    coordinatorListAttempts: coordinatorList
      ? {
          "9500": {
            ...defaultCoordinator,
            ...coordinator,
            ...coordinatorList,
            jobs: coordinatorJobs,
          },
        }
      : undefined,
    coordinationCheckPages: coordinationCheckPages ?? [
      {
        total_count: 1,
        check_runs: [coordinationCheck(customCheck)],
      },
    ],
    finalCoordinationCheckPages,
    finalFormerCoordinationCheckPages,
    finalPr: finalStatusChecks ? { statusCheckRollup: finalStatusChecks } : undefined,
    finalPrAfterCiEvidence: additionalChecksAfterE2eEvidence
      ? {
          ...finalPrAfterCiEvidence,
          statusCheckRollup: [
            ...(finalStatusChecks ?? statusChecks),
            ...additionalChecksAfterE2eEvidence,
          ],
        }
      : finalPrAfterCiEvidence,
    actionRunAttempts: {
      "9500": {
        ...defaultCoordinator,
        ...coordinator,
        jobs: coordinatorJobs,
      },
      "407": {
        ...exactDiffGateRun("success", jobs),
        createdAt: "2026-01-01T00:01:00Z",
        updatedAt: "2026-01-01T00:01:31Z",
        pullRequests: [],
        ...seedRun,
        jobs,
      },
      ...extraRuns,
    },
  });
}

describe("maintainer merge-gate E2E coordinator evidence", () => {
  it("accepts a custom check completed after its seed run when the repository coordinator encloses completion", () => {
    const result = runGateWithCoordinator();

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it("authenticates coordinator runs against the captured workflow revision", () => {
    const workflowSha = "d".repeat(40);
    const result = runGateWithCoordinator({
      coordinator: { headSha: workflowSha },
      currentBaseSha: workflowSha,
    });
    const output = JSON.parse(result.stdout);

    expect(output.gates.ci).toMatchObject({ pass: true });
    expect(output.gates.conflicts).toMatchObject({
      pass: false,
      baseSha: BASE_SHA,
      currentBaseSha: workflowSha,
    });
    expect(output.allPass).toBe(false);
  });

  it("rejects a manual coordinator for a fork with no automatic predecessor", () => {
    const manualCoordinator = e2eManualCoordinatorRun();
    const result = runGateWithCoordinator({
      headRepository: "example/fork",
      coordinator: manualCoordinator,
      seedRun: { headRepository: "example/fork" },
      coordinatorRunPartitions: manualOnlyCoordinatorPartitions(),
      extraRuns: {
        "90": {
          ...prWorkflowRun(
            "success",
            [
              { id: 1, name: "checks" },
              { id: 2, name: "changes" },
            ],
            true,
          ),
          headRepository: "example/fork",
          pullRequests: [],
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

  it("rejects a manual coordinator for a same-repository revision", () => {
    const result = runGateWithCoordinator({
      coordinator: e2eManualCoordinatorRun(),
      coordinatorRunPartitions: manualOnlyCoordinatorPartitions(),
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

  it("accepts a fork check completed by manual authorization after automatic coordination", () => {
    const result = runGateWithCoordinator(authorizedForkLifecycleFixture());

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it("rejects a successful custom check without initial E2E seed evidence in the status rollup", () => {
    const result = runGateWithCoordinator({ includeInitialSeedEvidence: false });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
    expect(output.gates.ci.failingChecks).toContain(
      "E2E / PR Gate: latest attempt evidence incomplete",
    );
  });

  it("rejects two initial E2E seed runs in the status rollup", () => {
    const duplicateSeedJobs = seedJobs().map((job) => ({ ...job, id: job.id + 100 }));
    const result = runGateWithCoordinator({
      additionalStatusChecks: seedStatusChecks(408, duplicateSeedJobs).filter(
        (check) => check.name === "initialize",
      ),
      extraRuns: {
        "408": {
          ...exactDiffGateRun("success", duplicateSeedJobs),
          createdAt: "2026-01-01T00:01:00Z",
          updatedAt: "2026-01-01T00:01:31Z",
          pullRequests: [],
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

  it("rejects two authenticated initial E2E seed runs with different creation times and overlapping initialize windows", () => {
    const staggeredSeedJobs = seedJobs().map((job) => ({
      ...job,
      id: job.id + 200,
      startedAt: "2026-01-01T00:01:01Z",
      completedAt: "2026-01-01T00:01:31Z",
    }));
    const result = runGateWithCoordinator({
      additionalStatusChecks: seedStatusChecks(409, staggeredSeedJobs).filter(
        (check) => check.name === "initialize",
      ),
      extraRuns: {
        "409": {
          ...exactDiffGateRun("success", staggeredSeedJobs),
          createdAt: "2026-01-01T00:01:01Z",
          updatedAt: "2026-01-01T00:01:31Z",
          pullRequests: [],
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

  it("rejects two automatic authorization predecessors for one manual coordinator", () => {
    const result = runGateWithCoordinator(
      authorizedForkLifecycleFixture({
        "9502": {
          ...e2eCoordinatorRun(),
          createdAt: "2026-08-04T14:37:05Z",
          updatedAt: "2026-08-04T14:37:34Z",
          jobs: coordinatorJobs({
            startedAt: "2026-08-04T14:37:06Z",
            completedAt: "2026-08-04T14:37:33Z",
          }),
        },
      }),
    );
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
    expect(output.gates.ci.failingChecks).toContain(
      "E2E / PR Gate: latest attempt evidence incomplete",
    );
  });

  it("accepts a matching coordinator from a later page of a complete workflow-run inventory", () => {
    const unrelatedRun = {
      ...e2eCoordinatorRun(),
      displayTitle: "E2E Gate coordinate from unrelated CI",
    };
    const result = runGateWithCoordinator({
      coordinatorRunPages: [[9501], [9500]],
      extraRuns: { "9501": unrelatedRun },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it("accepts one enclosing coordinator with older same-revision coordinator history", () => {
    const result = runGateWithCoordinator({
      coordinatorRunPages: [[9501, 9500]],
      extraRuns: { "9501": historicalCoordinatorRun() },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it("accepts a retry coordinator created before the current custom check", () => {
    const result = runGateWithCoordinator({
      coordinator: { createdAt: "2026-01-01T00:01:20Z" },
      coordinatorJobs: coordinatorJobs({
        startedAt: "2026-01-01T00:01:25Z",
      }),
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it("accepts a retry check created after its authenticated seed run finishes", () => {
    const fixture = delayedRetryFixture();
    const result = runGateWithCoordinator({
      ...fixture,
      coordinationCheckPages: [
        {
          total_count: 2,
          check_runs: [
            retryableFailure(7999, "2026-08-04T14:07:50Z", "2026-08-04T14:08:00Z"),
            coordinationCheck(fixture.customCheck),
          ],
        },
      ],
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it("rejects a retry check that starts before the previous check completes", () => {
    const fixture = delayedRetryFixture();
    const result = runGateWithCoordinator({
      ...fixture,
      coordinationCheckPages: [
        {
          total_count: 2,
          check_runs: [
            retryableFailure(7999, "2026-08-04T14:07:50Z", "2026-08-04T14:28:07Z"),
            coordinationCheck(fixture.customCheck),
          ],
        },
      ],
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: false,
      gates: {
        ci: {
          pass: false,
          failingChecks: [
            "E2E / PR Gate: latest attempt evidence incomplete",
            "cancel-superseded: latest attempt evidence incomplete",
            "coordinate: latest attempt evidence incomplete",
            "initialize: latest attempt evidence incomplete",
          ],
        },
      },
    });
  });

  it("rejects a stale seed with no predecessor for a newer coordination check", () => {
    const result = runGateWithCoordinator(delayedRetryFixture());

    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false } },
    });
    expect(output.gates.ci.failingChecks).toContain(
      "initialize: latest attempt evidence incomplete",
    );
  });

  it("rejects a seed run without observable initialize timing", () => {
    const result = runGateWithCoordinator({
      seedRun: {
        jobs: seedJobs().map((job) =>
          job.name === "initialize" ? { ...job, omitStartedAt: true } : job,
        ),
      },
    });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({ allPass: false, gates: { ci: { pass: false } } });
    expect(output.gates.ci.failingChecks).toContain(
      "initialize: latest attempt evidence incomplete",
    );
  });

  it("rejects a seed run that encloses one check without an initialize job", () => {
    const result = runGateWithCoordinator({
      seedRun: {
        updatedAt: "2026-01-01T00:02:31Z",
        jobs: seedJobs().filter((job) => job.name !== "initialize"),
      },
    });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({ allPass: false, gates: { ci: { pass: false } } });
    expect(output.gates.ci.failingChecks).toContain(
      "cancel-superseded: latest attempt evidence incomplete",
    );
  });

  it("ignores a later successful seed that reuses the authenticated check", () => {
    const reuseJobs = laterSeedJobs();
    const result = runGateWithCoordinator({
      additionalStatusChecks: seedStatusChecks(408, reuseJobs),
      extraRuns: {
        "408": {
          ...exactDiffGateRun("success", reuseJobs),
          createdAt: "2026-01-01T00:02:40Z",
          updatedAt: "2026-01-01T00:02:51Z",
          pullRequests: [],
        },
      },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it.each([
    {
      state: "failed",
      run: { status: "completed", conclusion: "failure" },
      updateJobs: (jobs: ActionJobFixture[]) =>
        jobs.map((job) =>
          job.name === "cancel-superseded" ? { ...job, conclusion: "failure" } : job,
        ),
    },
    {
      state: "pending",
      run: { status: "in_progress", conclusion: null },
      updateJobs: (jobs: ActionJobFixture[]) =>
        jobs.map((job) =>
          job.name === "cancel-superseded"
            ? { ...job, status: "in_progress", conclusion: null, completedAt: null }
            : job,
        ),
    },
  ])("keeps a later $state seed reuse blocking", ({ run, updateJobs }) => {
    const reuseJobs = updateJobs(laterSeedJobs());
    const result = runGateWithCoordinator({
      additionalStatusChecks: seedStatusChecks(408, reuseJobs),
      extraRuns: {
        "408": {
          ...exactDiffGateRun(run.conclusion ?? "success", reuseJobs),
          ...run,
          createdAt: "2026-01-01T00:02:40Z",
          updatedAt: "2026-01-01T00:02:51Z",
          pullRequests: [],
        },
      },
    });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({ allPass: false, gates: { ci: { pass: false } } });
    expect(output.gates.ci.failingChecks).toContain(
      "initialize: latest attempt evidence incomplete",
    );
  });

  it("finds a coordinator created before midnight for a check completed after midnight", () => {
    const result = runGateWithCoordinator({
      customCheck: {
        started_at: "2026-01-02T00:00:10Z",
        completed_at: "2026-01-02T00:00:40Z",
      },
      coordinator: {
        createdAt: "2026-01-01T23:59:50Z",
        updatedAt: "2026-01-02T00:00:45Z",
      },
      coordinatorJobs: coordinatorJobs({
        startedAt: "2026-01-01T23:59:55Z",
        completedAt: "2026-01-02T00:00:44Z",
      }),
      seedRun: {
        createdAt: "2026-01-01T23:59:59Z",
        updatedAt: "2026-01-02T00:00:11Z",
        jobs: seedJobs().map((job) => ({
          ...job,
          startedAt: "2026-01-02T00:00:00Z",
          completedAt: "2026-01-02T00:00:11Z",
        })),
      },
      coordinatorRunPartitions: [
        {
          createdRange: "2026-01-01T00:00:00Z..2026-01-01T12:00:00Z",
          runPages: [[]],
        },
        {
          createdRange: "2026-01-01T12:00:00Z..2026-01-02T00:00:00Z",
          runPages: [[9500]],
        },
        {
          createdRange: "2026-01-02T00:00:00Z..2026-01-02T00:00:40Z",
          runPages: [[]],
        },
      ],
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

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

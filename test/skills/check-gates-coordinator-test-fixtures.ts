// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ActionJobFixture,
  ActionRunFixture,
  ComplianceFixture,
  CoordinatorRunPartitionFixture,
} from "./check-gates-test-fixtures.ts";
import {
  coordinationCheck,
  e2eCoordinatorRun,
  e2eManualCoordinatorRun,
  exactDiffGateRun,
  prWorkflowRun,
  runGate,
  successfulRequiredChecks,
} from "./check-gates-test-fixtures.ts";

export function seedJobs(): ActionJobFixture[] {
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

export function laterSeedJobs(): ActionJobFixture[] {
  return seedJobs().map((job) => ({
    ...job,
    id: job.id + 100,
    startedAt: "2026-01-01T00:02:42Z",
    completedAt: "2026-01-01T00:02:50Z",
  }));
}

export function coordinatorJobs(overrides: Partial<ActionJobFixture> = {}): ActionJobFixture[] {
  return (e2eCoordinatorRun().jobs ?? []).map((job) =>
    job.name === "coordinate" ? { ...job, ...overrides } : job,
  );
}

export function historicalCoordinatorRun(): ActionRunFixture {
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

export function retryableFailure(id: number, startedAt: string, completedAt: string) {
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

export const DEFAULT_COORDINATOR_RANGES = [
  "2025-12-31T00:00:00Z..2025-12-31T12:00:00Z",
  "2025-12-31T12:00:00Z..2026-01-01T00:00:00Z",
  "2026-01-01T00:00:00Z..2026-01-01T00:03:00Z",
] as const;

export function paginatedRunIds(ids: number[]): number[][] {
  return Array.from({ length: Math.ceil(ids.length / 100) }, (_value, index) =>
    ids.slice(index * 100, (index + 1) * 100),
  );
}

export interface CoordinatorFixture {
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

export function authorizedForkLifecycleFixture(
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

export function delayedRetryFixture(): CoordinatorFixture {
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

export function seedStatusChecks(
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

export function manualOnlyCoordinatorPartitions(): CoordinatorRunPartitionFixture[] {
  return DEFAULT_COORDINATOR_RANGES.map((createdRange, index) => ({
    createdRange,
    event: "workflow_dispatch",
    runPages: [index === DEFAULT_COORDINATOR_RANGES.length - 1 ? [9500] : []],
  }));
}

export function runGateWithCoordinator({
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

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  authorizedForkLifecycleFixture,
  coordinatorJobs,
  delayedRetryFixture,
  historicalCoordinatorRun,
  laterSeedJobs,
  manualOnlyCoordinatorPartitions,
  retryableFailure,
  runGateWithCoordinator,
  seedJobs,
  seedStatusChecks,
} from "./check-gates-coordinator-test-fixtures.ts";
import type { ActionJobFixture } from "./check-gates-test-fixtures.ts";
import {
  BASE_SHA,
  coordinationCheck,
  e2eCoordinatorRun,
  e2eManualCoordinatorRun,
  exactDiffGateRun,
  prWorkflowRun,
} from "./check-gates-test-fixtures.ts";

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
});

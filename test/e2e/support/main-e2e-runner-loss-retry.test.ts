// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { retryMainE2eRunnerLoss } from "../../../tools/e2e/main-e2e-runner-loss-retry.mts";
import {
  createGitHubFetchRouter,
  type GitHubFetchRoute,
  githubFetchRoute,
  type RecordedGitHubRequest,
} from "../../support/github-fetch-router.ts";

const REPOSITORY = "NVIDIA/NemoClaw";
const RUN_ID = 42;
const HEAD_SHA = "a".repeat(40);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function githubResponse(value?: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (value === undefined ? "" : JSON.stringify(value)),
  } as Response;
}

function mainRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    name: "E2E",
    path: ".github/workflows/e2e.yaml",
    event: "schedule",
    head_branch: "main",
    head_sha: HEAD_SHA,
    display_title: "E2E main",
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function mainComparison(overrides: Record<string, unknown> = {}) {
  return {
    status: "ahead",
    ahead_by: 2,
    behind_by: 0,
    base_commit: { sha: HEAD_SHA },
    merge_base_commit: { sha: HEAD_SHA },
    ...overrides,
  };
}

function lostRunnerJob(id = 7) {
  return {
    id,
    name: `runner-loss-${id}`,
    status: "completed",
    conclusion: "failure",
    runner_id: id,
    runner_name: `GitHub Actions ${id}`,
    labels: ["ubuntu-latest"],
    steps: [
      { name: "Prepare", status: "completed", conclusion: "success" },
      { name: "Run live test", status: "in_progress", conclusion: null },
      { name: "Upload artifacts", status: "pending", conclusion: null },
    ],
  };
}

function assertionJob(id = 8) {
  return {
    id,
    name: `assertion-${id}`,
    status: "completed",
    conclusion: "failure",
    runner_id: id,
    runner_name: `GitHub Actions ${id}`,
    labels: ["ubuntu-latest"],
    steps: [{ name: "Run tests", status: "completed", conclusion: "failure" }],
  };
}

function optionalSecondPageRoute(options: {
  secondPage?: unknown[];
  totalCount?: number;
}): GitHubFetchRoute[] {
  return options.secondPage === undefined
    ? []
    : [
        githubFetchRoute(
          ({ url, method }) =>
            url.includes(`/runs/${RUN_ID}/attempts/1/jobs?per_page=100&page=2`) && method === "GET",
          () => githubResponse({ total_count: options.totalCount, jobs: options.secondPage }),
        ),
      ];
}

function controllerRoutes(options: {
  run?: Record<string, unknown>;
  comparison?: Record<string, unknown>;
  jobs: unknown[];
  totalCount?: number;
  secondPage?: unknown[];
}): GitHubFetchRoute[] {
  const run = options.run ?? mainRun();
  const routes = [
    githubFetchRoute(
      ({ url, method }) =>
        url.endsWith(`/repos/${REPOSITORY}/actions/runs/${RUN_ID}`) && method === "GET",
      () => githubResponse(run),
    ),
    githubFetchRoute(
      ({ url, method }) =>
        url.endsWith(`/repos/${REPOSITORY}/compare/${HEAD_SHA}...main`) && method === "GET",
      () => githubResponse(options.comparison ?? mainComparison()),
    ),
    githubFetchRoute(
      ({ url, method }) =>
        url.includes(`/runs/${RUN_ID}/attempts/1/jobs?per_page=100&page=1`) && method === "GET",
      () =>
        githubResponse({
          total_count: options.totalCount ?? options.jobs.length,
          jobs: options.jobs,
        }),
    ),
    ...optionalSecondPageRoute(options),
  ];
  routes.push(
    githubFetchRoute(
      ({ url, method }) =>
        url.endsWith(`/repos/${REPOSITORY}/actions/runs/${RUN_ID}/rerun-failed-jobs`) &&
        method === "POST",
      () => githubResponse(undefined, 201),
    ),
  );
  return routes;
}

async function runController(routes: GitHubFetchRoute[], requests: RecordedGitHubRequest[]) {
  vi.stubGlobal("fetch", createGitHubFetchRouter(routes, requests));
  return retryMainE2eRunnerLoss({
    repository: REPOSITORY,
    token: "token",
    runId: RUN_ID,
    expectedRunAttempt: 1,
  });
}

describe("final-main E2E runner-loss retry for item 5 (#7140)", () => {
  it("reruns failed jobs once when every failed job has the hosted-runner-loss marker", async () => {
    const requests: RecordedGitHubRequest[] = [];
    const result = await runController(
      controllerRoutes({ jobs: [lostRunnerJob(), lostRunnerJob(9)] }),
      requests,
    );

    expect(result.retry).toBe(true);
    expect(result.runnerLostMarkerCount).toBe(2);
    expect(result.reason).toContain("single permitted retry");
    expect(requests.filter((request) => request.method === "POST")).toEqual([
      expect.objectContaining({ url: expect.stringContaining("/rerun-failed-jobs") }),
    ]);
  });

  it("never retries an ordinary assertion failure", async () => {
    const requests: RecordedGitHubRequest[] = [];
    const result = await runController(controllerRoutes({ jobs: [assertionJob()] }), requests);

    expect(result.retry).toBe(false);
    expect(result.runnerLostMarkerCount).toBe(0);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("never retries mixed runner loss and deterministic failure", async () => {
    const requests: RecordedGitHubRequest[] = [];
    const result = await runController(
      controllerRoutes({ jobs: [lostRunnerJob(), assertionJob()] }),
      requests,
    );

    expect(result.retry).toBe(false);
    expect(result.runnerLostMarkerCount).toBe(1);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("never retries a timed-out job beside runner loss", async () => {
    const requests: RecordedGitHubRequest[] = [];
    const timedOut = {
      ...assertionJob(),
      conclusion: "timed_out",
      steps: [{ name: "Run tests", status: "completed", conclusion: "timed_out" }],
    };
    const result = await runController(
      controllerRoutes({ jobs: [lostRunnerJob(), timedOut] }),
      requests,
    );

    expect(result.retry).toBe(false);
    expect(result.runnerLostMarkerCount).toBe(1);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("does not retry a stale event after the run advanced to attempt two", async () => {
    const requests: RecordedGitHubRequest[] = [];
    const result = await runController(
      controllerRoutes({
        run: mainRun({ run_attempt: 2, status: "in_progress", conclusion: null }),
        jobs: [],
      }),
      requests,
    );

    expect(result.retry).toBe(false);
    expect(result.reason).toContain("already advanced to attempt 2");
    expect(requests).toHaveLength(1);
  });

  it("rejects selective PR dispatch identity before reading job evidence", async () => {
    const requests: RecordedGitHubRequest[] = [];
    await expect(
      runController(
        controllerRoutes({
          run: mainRun({ display_title: "E2E PR #7342 (correlation)" }),
          jobs: [],
        }),
        requests,
      ),
    ).rejects.toThrow("not a trusted final-main E2E run");
    expect(requests).toHaveLength(1);
  });

  it("rejects a failed SHA that is no longer in current main history", async () => {
    const requests: RecordedGitHubRequest[] = [];
    await expect(
      runController(
        controllerRoutes({
          comparison: mainComparison({ status: "diverged", behind_by: 1 }),
          jobs: [lostRunnerJob()],
        }),
        requests,
      ),
    ).rejects.toThrow("not an authenticated ancestor");
    expect(requests.some((request) => request.url.includes("/jobs?"))).toBe(false);
  });

  it("fails closed when GitHub does not return the complete job listing", async () => {
    const requests: RecordedGitHubRequest[] = [];
    const firstPage: unknown[] = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `successful-${index + 1}`,
      status: "completed",
      conclusion: "success",
      steps: [],
    }));
    firstPage[0] = lostRunnerJob(1);
    const result = await runController(
      controllerRoutes({ jobs: firstPage, totalCount: 101, secondPage: [] }),
      requests,
    );

    expect(result.retry).toBe(false);
    expect(result.runnerLostMarkerCount).toBe(0);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });
});

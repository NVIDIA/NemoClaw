// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  E2E_MAX_ATTEMPTS,
  E2E_MAX_RETRIES,
  evaluateMainRunRetry,
} from "../../../tools/e2e/main-run-retry.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const RUN_ID = 12345;
const WORKFLOW_ID = 678;
const SHA = "a".repeat(40);

function sourceRun(attempt: number, conclusion: string, overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    workflow_id: WORKFLOW_ID,
    run_attempt: attempt,
    status: "completed",
    conclusion,
    event: "push",
    path: ".github/workflows/e2e.yaml",
    display_title: "E2E main",
    head_branch: "main",
    head_sha: SHA,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function job(attempt: number, conclusion = "success") {
  return {
    id: attempt * 100,
    name: `E2E job ${attempt}`,
    run_attempt: attempt,
    status: "completed",
    conclusion,
    started_at: `2026-08-06T00:0${attempt}:00Z`,
    completed_at: `2026-08-06T00:0${attempt + 5}:00Z`,
  };
}

function setup(options: { attempt: number; conclusion: string; latestRunId?: number }) {
  const requests: Array<{ method: string; path: string }> = [];
  const run = sourceRun(options.attempt, options.conclusion);
  const request = async (path: string, init?: { method?: "GET" | "POST" }) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path });
    switch (true) {
      case method === "POST":
        return undefined;
      case path.endsWith(`/actions/runs/${RUN_ID}`):
        return run;
      case path.includes(`/actions/workflows/${WORKFLOW_ID}/runs?`):
        return {
          total_count: 1,
          workflow_runs: [
            sourceRun(options.attempt, options.conclusion, {
              id: options.latestRunId ?? RUN_ID,
            }),
          ],
        };
      case /\/attempts\/(\d+)\/jobs/u.test(path): {
        const attempt = Number(/\/attempts\/(\d+)\/jobs/u.exec(path)![1]);
        return {
          total_count: 1,
          jobs: [job(attempt, attempt === options.attempt ? options.conclusion : "failure")],
        };
      }
      default:
        throw new Error(`unexpected request ${method} ${path}`);
    }
  };
  return { request, requests };
}

async function evaluate(options: { attempt: number; conclusion: string; latestRunId?: number }) {
  const fixture = setup(options);
  const evidence = await evaluateMainRunRetry({
    repository: REPOSITORY,
    token: "token",
    sourceRunId: RUN_ID,
    controllerAttempt: 1,
    request: fixture.request,
  });
  return { evidence, requests: fixture.requests };
}

describe("main E2E retry controller", () => {
  it.each([1, 2])("requests retry %s before the attempt limit", async (attempt) => {
    const { evidence, requests } = await evaluate({ attempt, conclusion: "failure" });

    expect(E2E_MAX_RETRIES).toBe(2);
    expect(E2E_MAX_ATTEMPTS).toBe(3);
    expect(evidence).toMatchObject({
      action: "retry-requested",
      flaky: false,
      sourceAttempt: attempt,
    });
    expect(requests).toContainEqual({
      method: "POST",
      path: `repos/${REPOSITORY}/actions/runs/${RUN_ID}/rerun-failed-jobs`,
    });
  });

  it("stops after the third failed attempt", async () => {
    const { evidence, requests } = await evaluate({ attempt: 3, conclusion: "failure" });

    expect(evidence.action).toBe("failed-after-retries");
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("reports a successful retry as flaky and sums runner minutes across attempts", async () => {
    const { evidence, requests } = await evaluate({ attempt: 2, conclusion: "success" });

    expect(evidence).toMatchObject({
      action: "passed-after-retry",
      flaky: true,
      sourceAttempt: 2,
      totalRunnerMinutes: 10,
    });
    expect(evidence.attempts).toHaveLength(2);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("reports a first-attempt pass without flaky evidence", async () => {
    const { evidence } = await evaluate({ attempt: 1, conclusion: "success" });

    expect(evidence).toMatchObject({ action: "passed-first-attempt", flaky: false });
  });

  it("does not retry a run superseded by a newer main push", async () => {
    const { evidence, requests } = await evaluate({
      attempt: 1,
      conclusion: "failure",
      latestRunId: RUN_ID + 1,
    });

    expect(evidence).toMatchObject({ action: "ignored", reason: "a newer E2E main push exists" });
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("rejects manual workflow runs", async () => {
    const fixture = setup({ attempt: 1, conclusion: "failure" });
    const originalRequest = fixture.request;
    const request = async (path: string, init?: { method?: "GET" | "POST" }) => {
      const response = await originalRequest(path, init);
      return path.endsWith(`/actions/runs/${RUN_ID}`)
        ? { ...(response as Record<string, unknown>), event: "workflow_dispatch" }
        : response;
    };

    await expect(
      evaluateMainRunRetry({
        repository: REPOSITORY,
        token: "token",
        sourceRunId: RUN_ID,
        controllerAttempt: 1,
        request,
      }),
    ).rejects.toThrow("source run is not a completed trusted E2E main push");
  });
  it("rejects a truncated attempt job listing", async () => {
    const fixture = setup({ attempt: 1, conclusion: "failure" });
    const request = async (path: string, init?: { method?: "GET" | "POST" }) =>
      path.includes("/attempts/1/jobs")
        ? { total_count: 2, jobs: [job(1, "failure")] }
        : fixture.request(path, init);

    await expect(
      evaluateMainRunRetry({
        repository: REPOSITORY,
        token: "token",
        sourceRunId: RUN_ID,
        controllerAttempt: 1,
        request,
      }),
    ).rejects.toThrow("GitHub returned an invalid or truncated E2E job list");
  });

  it("rejects an unbounded job name before evidence serialization", async () => {
    const fixture = setup({ attempt: 1, conclusion: "failure" });
    const request = async (path: string, init?: { method?: "GET" | "POST" }) =>
      path.includes("/attempts/1/jobs")
        ? { total_count: 1, jobs: [{ ...job(1, "failure"), name: "x".repeat(257) }] }
        : fixture.request(path, init);

    await expect(
      evaluateMainRunRetry({
        repository: REPOSITORY,
        token: "token",
        sourceRunId: RUN_ID,
        controllerAttempt: 1,
        request,
      }),
    ).rejects.toThrow("GitHub returned invalid E2E job identity");
  });

  it("rejects an empty successful attempt job listing", async () => {
    const fixture = setup({ attempt: 1, conclusion: "success" });
    const request = async (path: string, init?: { method?: "GET" | "POST" }) =>
      path.includes("/attempts/1/jobs")
        ? { total_count: 0, jobs: [] }
        : fixture.request(path, init);

    await expect(
      evaluateMainRunRetry({
        repository: REPOSITORY,
        token: "token",
        sourceRunId: RUN_ID,
        controllerAttempt: 1,
        request,
      }),
    ).rejects.toThrow("GitHub returned an invalid or truncated E2E job list");
  });
});

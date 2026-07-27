// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { cancelPrGate, prGateExternalId } from "../tools/e2e/pr-e2e-gate.mts";
import {
  createGitHubFetchRouter,
  githubFetchRoute,
  type RecordedGitHubRequest,
} from "./support/github-fetch-router.ts";

const REPOSITORY = "NVIDIA/NemoClaw";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "d".repeat(40);
const CONTROLLER_RUN_URL = `https://github.com/${REPOSITORY}/actions/runs/23`;
const INTERNAL_APPROVAL_ENVIRONMENT = "approve-credentialed-e2e-for-internal-pr";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function githubResponse(value?: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () => (value === undefined ? "" : JSON.stringify(value)),
  } as Response;
}

function pullRequest(state = "open") {
  return {
    number: 42,
    state,
    changed_files: 1,
    head: {
      ref: "feature/pr-e2e-gate",
      sha: HEAD_SHA,
      repo: { full_name: REPOSITORY },
    },
    base: { sha: BASE_SHA, repo: { full_name: REPOSITORY } },
  };
}

function pendingApprovalCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    name: "E2E / PR Gate Coordination",
    head_sha: HEAD_SHA,
    external_id: prGateExternalId(42, HEAD_SHA, BASE_SHA),
    status: "in_progress",
    conclusion: null,
    details_url: `https://github.com/${REPOSITORY}/runs/17`,
    output: {
      title: "E2E reviewer authorization required to run E2E",
      summary: [
        "No selected E2E job or target ran and no repository secret was exposed.",
        `Open [E2E / PR Gate Controller run 23](${CONTROLLER_RUN_URL}), choose Review deployments, and approve the protected environment.`,
      ].join("\n\n"),
    },
    app: { id: 15368 },
    ...overrides,
  };
}

function approvalControllerRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 23,
    name: "E2E Gate workflow_run 23",
    display_title: "E2E Gate workflow_run 23",
    path: ".github/workflows/pr-e2e-gate.yaml",
    workflow_id: 123,
    event: "workflow_run",
    head_branch: "main",
    head_sha: WORKFLOW_SHA,
    run_attempt: 1,
    status: "waiting",
    conclusion: null,
    html_url: CONTROLLER_RUN_URL,
    repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function pendingDeployments(environment = INTERNAL_APPROVAL_ENVIRONMENT) {
  return [
    {
      environment: {
        id: 456,
        name: environment,
        url: `https://api.github.com/repos/${REPOSITORY}/environments/${environment}`,
      },
    },
  ];
}

function emptyActiveRunsRoute() {
  return githubFetchRoute(
    ({ url, method }) => url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
    () => githubResponse({ workflow_runs: [] }),
  );
}

function checkListingRoute(check: Record<string, unknown>) {
  return githubFetchRoute(
    ({ url, method }) => url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
    () => githubResponse({ total_count: 1, check_runs: [check] }),
  );
}

function deterministicPolling(timeoutMs = 10) {
  let time = 0;
  return {
    pollIntervalMs: 1,
    timeoutMs,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

describe("PR E2E close approval cleanup", () => {
  it("cancels the exact controller from an earlier base and closes its check (#7140)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
    const requests: RecordedGitHubRequest[] = [];
    const earlierBaseSha = "c".repeat(40);
    const check = pendingApprovalCheck({
      external_id: prGateExternalId(42, HEAD_SHA, earlierBaseSha),
    });
    let runReads = 0;
    let terminalControllerRead = -1;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          emptyActiveRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest("closed")),
          ),
          checkListingRoute(check),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => {
              runReads += 1;
              const terminal = runReads >= 4;
              if (terminal) terminalControllerRead = requests.length - 1;
              return githubResponse(
                approvalControllerRun(
                  runReads === 1
                    ? {}
                    : terminal
                      ? { status: "completed", conclusion: "cancelled" }
                      : { status: "in_progress", conclusion: null },
                ),
              );
            },
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/runs/23/pending_deployments") && method === "GET",
            () => githubResponse(pendingDeployments()),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => githubResponse(check),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23/cancel") && method === "POST",
            () => githubResponse(undefined, 202),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            (request) =>
              githubResponse({
                ...check,
                ...(request.body as Record<string, unknown> | undefined),
              }),
          ),
        ],
        requests,
      ),
    );

    await expect(
      cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, deterministicPolling()),
    ).resolves.toBe(1);
    expect(runReads).toBe(4);
    const cancellation = requests.findIndex((request) =>
      request.url.endsWith("/actions/runs/23/cancel"),
    );
    const completion = requests.findIndex(
      (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
    );
    expect(completion).toBeGreaterThan(cancellation);
    expect(completion).toBeGreaterThan(terminalControllerRead);
    expect(requests[completion]?.body).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      details_url: CONTROLLER_RUN_URL,
      output: {
        title: "PR closed — gate no longer applies",
        summary: expect.stringContaining("head `aaaaaaa` on base `ccccccc` no longer applies"),
      },
    });
  });

  it("does not close a pending check while cancellation remains nonterminal (#7140)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
    const requests: RecordedGitHubRequest[] = [];
    const check = pendingApprovalCheck();
    let runReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          emptyActiveRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest("closed")),
          ),
          checkListingRoute(check),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => {
              runReads += 1;
              return githubResponse(approvalControllerRun());
            },
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/runs/23/pending_deployments") && method === "GET",
            () => githubResponse(pendingDeployments()),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => githubResponse(check),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23/cancel") && method === "POST",
            () => githubResponse(undefined, 202),
          ),
        ],
        requests,
      ),
    );

    await expect(
      cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, deterministicPolling(3)),
    ).rejects.toThrow("Approval controller 23 did not become terminal within 3ms");
    expect(runReads).toBe(5);
    expect(requests.some((request) => request.url.endsWith("/actions/runs/23/cancel"))).toBe(true);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("does not cancel when the PR reopens before close reconciliation (#7140)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
    const requests: RecordedGitHubRequest[] = [];
    const check = pendingApprovalCheck();
    let pullReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          emptyActiveRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => {
              pullReads += 1;
              return githubResponse(pullRequest(pullReads === 1 ? "closed" : "open"));
            },
          ),
          checkListingRoute(check),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => githubResponse(approvalControllerRun()),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/runs/23/pending_deployments") && method === "GET",
            () => githubResponse(pendingDeployments()),
          ),
        ],
        requests,
      ),
    );

    await expect(cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA)).resolves.toBe(0);
    expect(pullReads).toBe(2);
    expect(requests.some((request) => request.url.endsWith("/cancel"))).toBe(false);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("closes a check that advances while its controller is cancelled (#7140)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
    const requests: RecordedGitHubRequest[] = [];
    const pendingCheck = pendingApprovalCheck();
    const advancedCheck = pendingApprovalCheck({
      output: {
        title: "E2E execution authorized by @maintainer",
        summary: "Running the exact reviewed head and base revision.",
      },
    });
    let runReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          emptyActiveRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest("closed")),
          ),
          checkListingRoute(pendingCheck),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => {
              runReads += 1;
              return githubResponse(
                approvalControllerRun(
                  runReads === 1
                    ? {}
                    : runReads === 2
                      ? { status: "in_progress", conclusion: null }
                      : { status: "completed", conclusion: "cancelled" },
                ),
              );
            },
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/runs/23/pending_deployments") && method === "GET",
            () => githubResponse([]),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => githubResponse(advancedCheck),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23/cancel") && method === "POST",
            () => githubResponse(undefined, 202),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            (request) =>
              githubResponse({
                ...advancedCheck,
                ...(request.body as Record<string, unknown> | undefined),
              }),
          ),
        ],
        requests,
      ),
    );

    await expect(
      cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, deterministicPolling()),
    ).resolves.toBe(1);
    expect(runReads).toBe(3);
    expect(requests.some((request) => request.url.endsWith("/cancel"))).toBe(true);
    const completion = requests.find(
      (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
    );
    expect(completion?.body).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      output: { title: "PR closed — gate no longer applies" },
    });
  });

  it("rejects a waiting controller bound to another approval environment (#7140)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
    const requests: RecordedGitHubRequest[] = [];
    const check = pendingApprovalCheck();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          emptyActiveRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest("closed")),
          ),
          checkListingRoute(check),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => githubResponse(approvalControllerRun()),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/runs/23/pending_deployments") && method === "GET",
            () => githubResponse(pendingDeployments("approve-credentialed-e2e-for-fork-pr")),
          ),
        ],
        requests,
      ),
    );

    await expect(cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA)).rejects.toThrow(
      "linked E2E approval controller has no exact pending protected environment",
    );
    expect(requests.some((request) => request.url.endsWith("/cancel"))).toBe(false);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });
});

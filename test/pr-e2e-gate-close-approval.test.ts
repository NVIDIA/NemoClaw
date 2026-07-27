// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { cancelPrGate, prGateExternalId } from "../tools/e2e/pr-e2e-gate.mts";
import {
  createGitHubFetchRouter,
  githubFetchRoute,
  type RecordedGitHubRequest,
} from "./support/github-fetch-router.ts";
import {
  approvalControllerRun,
  BASE_SHA,
  CONTROLLER_RUN_URL,
  checkListingRoute,
  deterministicPolling,
  emptyActiveRunsRoute,
  githubResponse,
  HEAD_SHA,
  INTERNAL_APPROVAL_ENVIRONMENT,
  pendingApprovalCheck,
  pendingApprovalCheckFor,
  pendingDeployments,
  pullRequest,
  REPOSITORY,
} from "./support/pr-e2e-close-approval-fixtures.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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
                  23,
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
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => githubResponse(check),
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
                  23,
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

  it("preflights every controller environment before cancelling any lineage (#7140)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
    const requests: RecordedGitHubRequest[] = [];
    const firstCheck = pendingApprovalCheckFor({ checkId: 17, runId: 23 });
    const secondCheck = pendingApprovalCheckFor({
      checkId: 18,
      baseSha: "c".repeat(40),
      runId: 24,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          emptyActiveRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest("closed")),
          ),
          checkListingRoute(firstCheck, secondCheck),
          githubFetchRoute(
            ({ url, method }) => /\/actions\/runs\/(?:23|24)$/u.test(url) && method === "GET",
            ({ url }) => githubResponse(approvalControllerRun(Number(url.split("/").at(-1)))),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              /\/actions\/runs\/(?:23|24)\/pending_deployments$/u.test(url) && method === "GET",
            ({ url }) =>
              githubResponse(
                pendingDeployments(
                  url.includes("/24/")
                    ? "approve-credentialed-e2e-for-fork-pr"
                    : INTERNAL_APPROVAL_ENVIRONMENT,
                ),
              ),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => githubResponse(firstCheck),
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

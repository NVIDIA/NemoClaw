// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { cancelPrGate } from "../tools/e2e/pr-e2e-gate.mts";
import {
  createGitHubFetchRouter,
  githubFetchRoute,
  type RecordedGitHubRequest,
} from "./support/github-fetch-router.ts";
import {
  approvalControllerRun,
  BASE_SHA,
  checkListingRoute,
  deterministicPolling,
  githubResponse,
  HEAD_SHA,
  pendingApprovalCheck,
  pendingDeployments,
  prE2eChildRun,
  pullRequest,
  REPOSITORY,
} from "./support/pr-e2e-close-approval-fixtures.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function configureRepository(): void {
  vi.stubEnv("GITHUB_TOKEN", "token");
  vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
}

describe("PR E2E close and reopen races", () => {
  it("cancels only the old controller child when the PR reopens during late dispatch (#7140)", async () => {
    configureRepository();
    const requests: RecordedGitHubRequest[] = [];
    const pendingCheck = pendingApprovalCheck();
    const oldChild = prE2eChildRun();
    const newChild = prE2eChildRun({
      id: 100,
      display_title: "E2E PR #42 (22222222-2222-4222-8222-222222222222) [controller 24]",
      html_url: `https://github.com/${REPOSITORY}/actions/runs/100`,
    });
    const legacyNewChild = prE2eChildRun({
      id: 101,
      display_title: "E2E PR #42 (33333333-3333-4333-8333-333333333333)",
      html_url: `https://github.com/${REPOSITORY}/actions/runs/101`,
    });
    const oldChildUrl = `https://github.com/${REPOSITORY}/actions/runs/99`;
    const runningOldCheck = pendingApprovalCheck({
      details_url: oldChildUrl,
      output: {
        title: "Running 1 E2E check",
        summary: `Risk plan ${"c".repeat(64)} selected jobs: rebuild-hermes; targets: none. Child run: ${oldChildUrl}.`,
      },
    });
    let inventoryRequests = 0;
    let oldChildCancelled = false;
    let controllerReads = 0;
    let childReads = 0;
    let pullReads = 0;
    let checkReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
            ({ url }) => {
              inventoryRequests += 1;
              const status = new URL(url).searchParams.get("status");
              const lateInventory = inventoryRequests > 5 && status === "in_progress";
              return githubResponse({
                workflow_runs: lateInventory
                  ? [...(oldChildCancelled ? [] : [oldChild]), newChild, legacyNewChild]
                  : [],
              });
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => {
              pullReads += 1;
              return githubResponse(pullRequest(pullReads < 3 ? "closed" : "open"));
            },
          ),
          checkListingRoute(pendingCheck),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => {
              controllerReads += 1;
              return githubResponse(
                approvalControllerRun(
                  23,
                  controllerReads === 1
                    ? {}
                    : controllerReads === 2
                      ? { status: "in_progress", conclusion: null }
                      : { status: "completed", conclusion: "cancelled" },
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
            () => {
              checkReads += 1;
              return githubResponse(checkReads === 1 ? pendingCheck : runningOldCheck);
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23/cancel") && method === "POST",
            () => githubResponse(undefined, 202),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/99/cancel") && method === "POST",
            () => {
              oldChildCancelled = true;
              return githubResponse(undefined, 202);
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/99") && method === "GET",
            () => {
              childReads += 1;
              return githubResponse(
                prE2eChildRun(
                  childReads > 1 ? { status: "completed", conclusion: "cancelled" } : {},
                ),
              );
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            (request) =>
              githubResponse({
                ...runningOldCheck,
                ...(request.body as Record<string, unknown> | undefined),
              }),
          ),
        ],
        requests,
      ),
    );

    await expect(
      cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, deterministicPolling()),
    ).resolves.toBe(2);
    expect(requests.some((request) => request.url.endsWith("/actions/runs/99/cancel"))).toBe(true);
    expect(requests.some((request) => request.url.endsWith("/actions/runs/100/cancel"))).toBe(
      false,
    );
    expect(requests.some((request) => request.url.endsWith("/actions/runs/101/cancel"))).toBe(
      false,
    );
    const mutation = requests.find(
      (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
    );
    expect(mutation?.body).toMatchObject({
      status: "in_progress",
      output: { title: "Waiting for PR CI" },
    });
  });

  it("does not cancel an observed child when a stale close already sees the PR open (#7140)", async () => {
    configureRepository();
    const requests: RecordedGitHubRequest[] = [];
    const child = prE2eChildRun();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
            ({ url }) =>
              githubResponse({
                workflow_runs:
                  new URL(url).searchParams.get("status") === "in_progress" ? [child] : [],
              }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest("open")),
          ),
        ],
        requests,
      ),
    );

    await expect(
      cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, deterministicPolling()),
    ).resolves.toBe(0);
    expect(requests.some((request) => request.url.endsWith("/cancel"))).toBe(false);
  });

  it.each([
    {
      label: "base",
      livePull: {
        ...pullRequest("open"),
        base: { sha: "c".repeat(40), repo: { full_name: REPOSITORY } },
      },
    },
    {
      label: "head",
      livePull: {
        ...pullRequest("open"),
        head: {
          ...pullRequest("open").head,
          sha: "c".repeat(40),
        },
      },
    },
  ])("supersedes the old check after reopen changes the $label revision (#7140)", async ({
    livePull,
  }) => {
    configureRepository();
    const requests: RecordedGitHubRequest[] = [];
    const check = pendingApprovalCheck();
    let pullReads = 0;
    let controllerReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
            () => githubResponse({ workflow_runs: [] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => {
              pullReads += 1;
              return githubResponse(pullReads < 3 ? pullRequest("closed") : livePull);
            },
          ),
          checkListingRoute(check),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => {
              controllerReads += 1;
              return githubResponse(
                approvalControllerRun(
                  23,
                  controllerReads < 3
                    ? controllerReads === 1
                      ? {}
                      : { status: "in_progress", conclusion: null }
                    : { status: "completed", conclusion: "cancelled" },
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
    const mutation = requests.find(
      (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
    );
    expect(mutation?.body).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      output: { title: "Superseded by PR update" },
    });
  });
});

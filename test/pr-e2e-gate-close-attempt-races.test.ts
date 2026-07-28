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
  pendingApprovalCheckFor,
  pendingDeployments,
  prE2eChildRun,
  pullRequest,
  REPOSITORY,
} from "./support/pr-e2e-close-approval-fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function configureRepository(): void {
  vi.stubEnv("GITHUB_TOKEN", "token");
  vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
}

describe("PR E2E close cancellation attempt races", () => {
  it("continues every lineage when one controller naturally completes during cancellation (#7140)", async () => {
    configureRepository();
    const requests: RecordedGitHubRequest[] = [];
    const firstCheck = pendingApprovalCheckFor({ checkId: 17, runId: 23 });
    const secondCheck = pendingApprovalCheckFor({
      checkId: 18,
      baseSha: "c".repeat(40),
      runId: 24,
    });
    const child = prE2eChildRun();
    const controllerReads = new Map<number, number>();
    let inventoryRequests = 0;
    let childCancelled = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
            ({ url }) => {
              inventoryRequests += 1;
              return githubResponse({
                workflow_runs:
                  inventoryRequests > 5 &&
                  new URL(url).searchParams.get("status") === "in_progress" &&
                  !childCancelled
                    ? [child]
                    : [],
              });
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest("closed")),
          ),
          checkListingRoute(firstCheck, secondCheck),
          githubFetchRoute(
            ({ url, method }) => /\/actions\/runs\/(?:23|24)$/u.test(url) && method === "GET",
            ({ url }) => {
              const runId = Number(url.split("/").at(-1));
              const reads = (controllerReads.get(runId) ?? 0) + 1;
              controllerReads.set(runId, reads);
              if (reads === 1) return githubResponse(approvalControllerRun(runId));
              if (runId === 23) {
                return githubResponse(
                  approvalControllerRun(runId, {
                    status: "completed",
                    conclusion: "success",
                  }),
                );
              }
              return githubResponse(
                approvalControllerRun(
                  runId,
                  reads === 2
                    ? { status: "in_progress", conclusion: null }
                    : { status: "completed", conclusion: "cancelled" },
                ),
              );
            },
          ),
          githubFetchRoute(
            ({ url, method }) =>
              /\/actions\/runs\/(?:23|24)\/pending_deployments$/u.test(url) && method === "GET",
            () => githubResponse(pendingDeployments()),
          ),
          githubFetchRoute(
            ({ url, method }) => /\/check-runs\/(?:17|18)$/u.test(url) && method === "GET",
            ({ url }) => githubResponse(url.endsWith("/17") ? firstCheck : secondCheck),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/24/cancel") && method === "POST",
            () => githubResponse(undefined, 202),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/99/cancel") && method === "POST",
            () => {
              childCancelled = true;
              return githubResponse(undefined, 202);
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/99") && method === "GET",
            () => githubResponse(prE2eChildRun({ status: "completed", conclusion: "cancelled" })),
          ),
          githubFetchRoute(
            ({ url, method }) => /\/check-runs\/(?:17|18)$/u.test(url) && method === "PATCH",
            (request) =>
              githubResponse({
                ...(request.url.endsWith("/17") ? firstCheck : secondCheck),
                ...(request.body as Record<string, unknown> | undefined),
              }),
          ),
        ],
        requests,
      ),
    );

    await expect(
      cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, deterministicPolling()),
    ).resolves.toBe(3);
    expect(requests.some((request) => request.url.endsWith("/actions/runs/23/cancel"))).toBe(false);
    expect(requests.some((request) => request.url.endsWith("/actions/runs/24/cancel"))).toBe(true);
    expect(requests.some((request) => request.url.endsWith("/actions/runs/99/cancel"))).toBe(true);
    expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(2);
  });

  it.each([
    { kind: "tagged", displayTitle: prE2eChildRun().display_title },
    {
      kind: "known legacy",
      displayTitle: "E2E PR #42 (11111111-1111-4111-8111-111111111111)",
    },
  ])("cancels a later attempt of the same $kind child run during the quiet window (#7140)", async ({
    displayTitle,
  }) => {
    configureRepository();
    const requests: RecordedGitHubRequest[] = [];
    const check = pendingApprovalCheck();
    const attemptOne = prE2eChildRun({ display_title: displayTitle });
    const attemptTwo = prE2eChildRun({ display_title: displayTitle, run_attempt: 2 });
    let inventoryRequests = 0;
    let childCancellations = 0;
    let childReads = 0;
    let controllerReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
            ({ url }) => {
              inventoryRequests += 1;
              const inProgress = new URL(url).searchParams.get("status") === "in_progress";
              return githubResponse({
                workflow_runs: !inProgress
                  ? []
                  : inventoryRequests <= 5
                    ? [attemptOne]
                    : childCancellations < 2
                      ? [attemptTwo]
                      : [],
              });
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest("closed")),
          ),
          checkListingRoute(check),
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
            () => githubResponse(check),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23/cancel") && method === "POST",
            () => githubResponse(undefined, 202),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/99/cancel") && method === "POST",
            () => {
              childCancellations += 1;
              return githubResponse(undefined, 202);
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/99") && method === "GET",
            () => {
              childReads += 1;
              return githubResponse(
                prE2eChildRun({
                  display_title: displayTitle,
                  run_attempt: childReads === 1 ? 1 : 2,
                  status: "completed",
                  conclusion: "cancelled",
                }),
              );
            },
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
    ).resolves.toBe(3);
    expect(
      requests.filter((request) => request.url.endsWith("/actions/runs/99/cancel")),
    ).toHaveLength(2);
  });

  it("re-cancels the controller when its run attempt advances while polling (#7140)", async () => {
    configureRepository();
    const requests: RecordedGitHubRequest[] = [];
    const check = pendingApprovalCheck();
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
            () => githubResponse(pullRequest("closed")),
          ),
          checkListingRoute(check),
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
                      : controllerReads === 3
                        ? { run_attempt: 2, status: "in_progress", conclusion: null }
                        : { run_attempt: 2, status: "completed", conclusion: "cancelled" },
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
    expect(
      requests.filter((request) => request.url.endsWith("/actions/runs/23/cancel")),
    ).toHaveLength(2);
  });

  it("retries a bounded controller status read before the overall deadline (#7140)", async () => {
    vi.useFakeTimers();
    configureRepository();
    const requests: RecordedGitHubRequest[] = [];
    const check = pendingApprovalCheck();
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
            () => githubResponse(pullRequest("closed")),
          ),
          checkListingRoute(check),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => {
              controllerReads += 1;
              if (controllerReads === 3) return new Promise<Response>(() => undefined);
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

    const attempt = cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, {
      ...deterministicPolling(),
      requestTimeoutMs: 1,
    });
    await vi.runAllTimersAsync();
    await expect(attempt).resolves.toBe(1);
    expect(controllerReads).toBe(4);
  });

  it("fails before cancellation when one child run has conflicting identities (#7140)", async () => {
    configureRepository();
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
            ({ url }) => {
              const status = new URL(url).searchParams.get("status");
              return githubResponse({
                workflow_runs:
                  status === "requested"
                    ? [prE2eChildRun({ status: "requested" })]
                    : status === "queued"
                      ? [prE2eChildRun({ status: "queued", head_sha: "e".repeat(40) })]
                      : [],
              });
            },
          ),
        ],
        requests,
      ),
    );

    await expect(
      cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, deterministicPolling()),
    ).rejects.toThrow("GitHub returned conflicting PR E2E run identities");
    expect(requests.some((request) => request.url.endsWith("/cancel"))).toBe(false);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });
});

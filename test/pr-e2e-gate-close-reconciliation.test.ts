// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { cancelPrGate, quiesceClosedPrGate } from "../tools/e2e/pr-e2e-gate.mts";
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
  emptyActiveRunsRoute,
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("PR E2E close cancellation reconciliation", () => {
  it.each([
    "workflow_run",
    "workflow_dispatch",
  ] as const)("quiesces the old $controllerEvent controller without mutating its check (#7140)", async (controllerEvent) => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
    const requests: RecordedGitHubRequest[] = [];
    const check = pendingApprovalCheck();
    let controllerReads = 0;
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
              controllerReads += 1;
              const name = `E2E Gate ${controllerEvent} 23`;
              return githubResponse(
                approvalControllerRun(23, {
                  ...(controllerReads === 1
                    ? {}
                    : controllerReads === 2
                      ? { status: "in_progress", conclusion: null }
                      : { status: "completed", conclusion: "cancelled" }),
                  display_title: name,
                  event: controllerEvent,
                  name,
                }),
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
        ],
        requests,
      ),
    );

    await expect(quiesceClosedPrGate(42, HEAD_SHA, BASE_SHA, deterministicPolling())).resolves.toBe(
      1,
    );
    expect(requests.some((request) => request.url.endsWith("/actions/runs/23/cancel"))).toBe(true);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it.each([
    {
      exactCheckCompleted: false,
      kind: "current running-check",
      legacyChild: false,
      stalePendingListing: false,
    },
    {
      exactCheckCompleted: false,
      kind: "stale pending-check legacy",
      legacyChild: true,
      stalePendingListing: true,
    },
    {
      exactCheckCompleted: true,
      kind: "naturally completed-check",
      legacyChild: false,
      stalePendingListing: false,
    },
  ])("recovers a $kind child missed by the initial close inventory (#7140)", async ({
    exactCheckCompleted,
    stalePendingListing,
    legacyChild,
  }) => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
    const requests: RecordedGitHubRequest[] = [];
    const child = prE2eChildRun(
      legacyChild ? { display_title: "E2E PR #42 (11111111-1111-4111-8111-111111111111)" } : {},
    );
    const childUrl = child.html_url;
    const runningCheck = {
      ...pendingApprovalCheck(),
      details_url: childUrl,
      output: {
        title: "Running 1 E2E check",
        summary: `Risk plan ${"c".repeat(64)} selected jobs: rebuild-hermes; targets: none. Child run: ${childUrl}.`,
      },
    };
    let childReads = 0;
    let controllerReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          emptyActiveRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest("closed")),
          ),
          checkListingRoute(stalePendingListing ? pendingApprovalCheck() : runningCheck),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () =>
              githubResponse(
                exactCheckCompleted
                  ? { ...runningCheck, status: "completed", conclusion: "success" }
                  : runningCheck,
              ),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/99") && method === "GET",
            () => {
              childReads += 1;
              return githubResponse(
                childReads === 1
                  ? child
                  : prE2eChildRun({
                      ...(legacyChild ? { display_title: child.display_title } : {}),
                      status: "completed",
                      conclusion: "cancelled",
                    }),
              );
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => {
              controllerReads += 1;
              return githubResponse(
                approvalControllerRun(
                  23,
                  controllerReads < 3
                    ? { status: "in_progress", conclusion: null }
                    : { status: "completed", conclusion: "cancelled" },
                ),
              );
            },
          ),
          githubFetchRoute(
            ({ url, method }) =>
              /\/actions\/runs\/(?:23|99)\/cancel$/u.test(url) && method === "POST",
            () => githubResponse(undefined, 202),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            (request) =>
              githubResponse({
                ...runningCheck,
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
    expect(requests.some((request) => request.url.endsWith("/actions/runs/23/cancel"))).toBe(true);
    expect(requests.some((request) => request.url.endsWith("/actions/runs/99/cancel"))).toBe(true);
    expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(
      exactCheckCompleted ? 0 : 1,
    );
  });

  it("cancels a child dispatched after the first inventory before closing the check (#7140)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
    const requests: RecordedGitHubRequest[] = [];
    const check = pendingApprovalCheck();
    const child = prE2eChildRun();
    let controllerReads = 0;
    let childReads = 0;
    let inventoryScans = 0;
    let terminalChildRead = -1;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
            ({ url }) => {
              const status = new URL(url).searchParams.get("status");
              if (status === "requested") inventoryScans += 1;
              return githubResponse({
                workflow_runs: inventoryScans === 3 && status === "in_progress" ? [child] : [],
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
            () => githubResponse(undefined, 202),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/99") && method === "GET",
            () => {
              childReads += 1;
              const terminal = childReads >= 2;
              if (terminal) terminalChildRead = requests.length - 1;
              return githubResponse(
                prE2eChildRun(terminal ? { status: "completed", conclusion: "cancelled" } : {}),
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
    ).resolves.toBe(2);
    expect(inventoryScans).toBe(5);
    expect(childReads).toBe(2);
    const childCancellation = requests.findIndex((request) =>
      request.url.endsWith("/actions/runs/99/cancel"),
    );
    const completion = requests.findIndex(
      (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
    );
    expect(childCancellation).toBeGreaterThan(-1);
    expect(completion).toBeGreaterThan(terminalChildRead);
    expect(requests[completion]?.body).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
  });

  it("resets an unchanged old check when the PR reopens after controller cancellation (#7140)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
    const requests: RecordedGitHubRequest[] = [];
    const check = pendingApprovalCheck();
    let controllerReads = 0;
    let pullReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          emptyActiveRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => {
              pullReads += 1;
              return githubResponse(pullRequest(pullReads < 3 ? "closed" : "open"));
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

    await expect(
      cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, deterministicPolling()),
    ).resolves.toBe(1);
    const mutations = requests.filter((request) => request.method === "PATCH");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.body).toMatchObject({
      status: "in_progress",
      output: {
        title: "Waiting for PR CI",
        summary:
          "This PR SHA and base SHA are reserved for deterministic E2E planning after CI completes.",
      },
    });
    expect(
      requests.filter((request) => request.url.includes("/actions/workflows/e2e.yaml/runs?")),
    ).toHaveLength(15);
  });

  it("leaves a check newly claimed after reopen unchanged (#7140)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
    const requests: RecordedGitHubRequest[] = [];
    const pendingCheck = pendingApprovalCheck();
    const newlyClaimedCheck = pendingApprovalCheck({
      output: {
        title: "Evaluating PR commit",
        summary: "Validating the reopened PR before dispatch.",
      },
    });
    let checkReads = 0;
    let controllerReads = 0;
    let pullReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          emptyActiveRunsRoute(),
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
              return githubResponse(checkReads === 1 ? pendingCheck : newlyClaimedCheck);
            },
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
      cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, deterministicPolling()),
    ).resolves.toBe(1);
    expect(checkReads).toBe(2);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
    expect(
      requests.filter((request) => request.url.includes("/actions/workflows/e2e.yaml/runs?")),
    ).toHaveLength(15);
  });

  it("cancels a child dispatched from a validated descendant of its controller revision (#7140)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
    const requests: RecordedGitHubRequest[] = [];
    const check = pendingApprovalCheck();
    const child = prE2eChildRun({ head_sha: "e".repeat(40) });
    let controllerReads = 0;
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
            ({ url, method }) =>
              /\/actions\/runs\/(?:23|99)\/cancel$/u.test(url) && method === "POST",
            () => githubResponse(undefined, 202),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/99") && method === "GET",
            () =>
              githubResponse(
                prE2eChildRun({
                  head_sha: "e".repeat(40),
                  status: "completed",
                  conclusion: "cancelled",
                }),
              ),
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
    ).resolves.toBe(2);
    expect(requests.some((request) => request.url.endsWith("/actions/runs/23/cancel"))).toBe(true);
    expect(requests.some((request) => request.url.endsWith("/actions/runs/99/cancel"))).toBe(true);
    expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it("reconciles every controller lineage before closing any check (#7140)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
    const requests: RecordedGitHubRequest[] = [];
    const earlierBaseSha = "c".repeat(40);
    const firstCheck = pendingApprovalCheckFor({
      checkId: 17,
      baseSha: earlierBaseSha,
      runId: 23,
    });
    const listedSecondCheck = pendingApprovalCheckFor({
      checkId: 18,
      baseSha: BASE_SHA,
      runId: 24,
    });
    const advancedSecondCheck = {
      ...listedSecondCheck,
      output: {
        title: "E2E execution authorized by @maintainer",
        summary: "Running the exact reviewed head and base revision.",
      },
    };
    const controllerReads = new Map<number, number>();
    const terminalReads = new Map<number, number>();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          emptyActiveRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest("closed")),
          ),
          checkListingRoute(firstCheck, listedSecondCheck),
          githubFetchRoute(
            ({ url, method }) => /\/actions\/runs\/(?:23|24)$/u.test(url) && method === "GET",
            ({ url }) => {
              const runId = Number(url.split("/").at(-1));
              const reads = (controllerReads.get(runId) ?? 0) + 1;
              controllerReads.set(runId, reads);
              const terminal = runId === 23 ? reads >= 4 : reads >= 3;
              if (terminal) terminalReads.set(runId, requests.length - 1);
              return githubResponse(
                approvalControllerRun(
                  runId,
                  reads === 1
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
              /\/actions\/runs\/(?:23|24)\/pending_deployments$/u.test(url) && method === "GET",
            () => githubResponse(pendingDeployments()),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => githubResponse(firstCheck),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/18") && method === "GET",
            () => githubResponse(advancedSecondCheck),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              /\/actions\/runs\/(?:23|24)\/cancel$/u.test(url) && method === "POST",
            () => githubResponse(undefined, 202),
          ),
          githubFetchRoute(
            ({ url, method }) => /\/check-runs\/(?:17|18)$/u.test(url) && method === "PATCH",
            (request) => {
              const check = request.url.endsWith("/17") ? firstCheck : advancedSecondCheck;
              return githubResponse({
                ...check,
                ...(request.body as Record<string, unknown> | undefined),
              });
            },
          ),
        ],
        requests,
      ),
    );

    await expect(
      cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, deterministicPolling()),
    ).resolves.toBe(2);
    expect(controllerReads).toEqual(
      new Map([
        [23, 4],
        [24, 3],
      ]),
    );
    const cancellationIndexes = requests
      .map((request, index) => ({ request, index }))
      .filter(({ request }) => request.url.endsWith("/cancel"))
      .map(({ index }) => index);
    const completionIndexes = requests
      .map((request, index) => ({ request, index }))
      .filter(({ request }) => request.method === "PATCH")
      .map(({ index }) => index);
    expect(cancellationIndexes).toHaveLength(2);
    expect(terminalReads.size).toBe(2);
    expect(Math.max(...cancellationIndexes)).toBeLessThan(Math.min(...terminalReads.values()));
    expect(completionIndexes).toHaveLength(2);
    expect(Math.min(...completionIndexes)).toBeGreaterThan(Math.max(...terminalReads.values()));
    for (const index of completionIndexes) {
      expect(requests[index]?.body).toMatchObject({
        status: "completed",
        conclusion: "cancelled",
        output: { title: "PR closed — gate no longer applies" },
      });
    }
  });
});

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

function neverResponds(): Promise<Response> {
  return new Promise<Response>(() => undefined);
}

function closeControllerRoutes(options: {
  inventory: (url: string) => Response | Promise<Response>;
  pull: () => Response | Promise<Response>;
  check: () => Response | Promise<Response>;
}) {
  const check = pendingApprovalCheck();
  let controllerReads = 0;
  return [
    githubFetchRoute(
      ({ url, method }) => url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
      ({ url }) => options.inventory(url),
    ),
    githubFetchRoute(
      ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
      options.pull,
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
      ({ url, method }) => url.endsWith("/actions/runs/23/pending_deployments") && method === "GET",
      () => githubResponse(pendingDeployments()),
    ),
    githubFetchRoute(
      ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
      options.check,
    ),
    githubFetchRoute(
      ({ url, method }) => url.endsWith("/actions/runs/23/cancel") && method === "POST",
      () => githubResponse(undefined, 202),
    ),
  ];
}

function boundedPolling() {
  return {
    ...deterministicPolling(),
    requestTimeoutMs: 1,
  };
}

describe("PR E2E close cancellation read deadlines", () => {
  it("bounds the initial active-run inventory before any mutation (#7140)", async () => {
    vi.useFakeTimers();
    configureRepository();
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
            neverResponds,
          ),
        ],
        requests,
      ),
    );

    const attempt = cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, boundedPolling());
    const rejection = expect(attempt).rejects.toThrow(
      "PR E2E requested inventory page 1 timed out after 1ms",
    );
    await vi.runAllTimersAsync();
    await rejection;
    expect(requests.some((request) => request.method === "POST")).toBe(false);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("bounds a late-child inventory read after cancelling the controller (#7140)", async () => {
    vi.useFakeTimers();
    configureRepository();
    const requests: RecordedGitHubRequest[] = [];
    const check = pendingApprovalCheck();
    let inventoryReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        closeControllerRoutes({
          inventory: () => {
            inventoryReads += 1;
            return inventoryReads > 5 ? neverResponds() : githubResponse({ workflow_runs: [] });
          },
          pull: () => githubResponse(pullRequest("closed")),
          check: () => githubResponse(check),
        }),
        requests,
      ),
    );

    const attempt = cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, boundedPolling());
    const rejection = expect(attempt).rejects.toThrow(
      "PR E2E requested inventory page 1 timed out after 1ms",
    );
    await vi.runAllTimersAsync();
    await rejection;
    expect(requests.some((request) => request.url.endsWith("/actions/runs/23/cancel"))).toBe(true);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("bounds the final pull-request read after controller reconciliation (#7140)", async () => {
    vi.useFakeTimers();
    configureRepository();
    const requests: RecordedGitHubRequest[] = [];
    const check = pendingApprovalCheck();
    let pullReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        closeControllerRoutes({
          inventory: () => githubResponse({ workflow_runs: [] }),
          pull: () => {
            pullReads += 1;
            return pullReads > 2 ? neverResponds() : githubResponse(pullRequest("closed"));
          },
          check: () => githubResponse(check),
        }),
        requests,
      ),
    );

    const attempt = cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, boundedPolling());
    const rejection = expect(attempt).rejects.toThrow(
      "Final PR reconciliation read timed out after 1ms",
    );
    await vi.runAllTimersAsync();
    await rejection;
    expect(requests.some((request) => request.url.endsWith("/actions/runs/23/cancel"))).toBe(true);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("bounds the final exact-check read before mutation (#7140)", async () => {
    vi.useFakeTimers();
    configureRepository();
    const requests: RecordedGitHubRequest[] = [];
    const check = pendingApprovalCheck();
    let checkReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        closeControllerRoutes({
          inventory: () => githubResponse({ workflow_runs: [] }),
          pull: () => githubResponse(pullRequest("closed")),
          check: () => {
            checkReads += 1;
            return checkReads > 1 ? neverResponds() : githubResponse(check);
          },
        }),
        requests,
      ),
    );

    const attempt = cancelPrGate(42, HEAD_SHA, HEAD_SHA, BASE_SHA, boundedPolling());
    const rejection = expect(attempt).rejects.toThrow(
      "PR gate check 17 final read timed out after 1ms",
    );
    await vi.runAllTimersAsync();
    await rejection;
    expect(requests.some((request) => request.url.endsWith("/actions/runs/23/cancel"))).toBe(true);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });
});

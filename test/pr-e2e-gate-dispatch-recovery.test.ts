// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dispatchPrGate,
  type PullRequest,
  parseControllerCommand,
  prGateExternalId,
  startPrGate,
} from "../tools/e2e/pr-e2e-gate.mts";
import {
  createGitHubFetchRouter,
  githubFetchRoute,
  type RecordedGitHubRequest,
} from "./support/github-fetch-router.ts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "d".repeat(40);
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const START_TIME = new Date("2026-07-26T18:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function githubResponse(value?: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(value === undefined ? undefined : JSON.stringify(value), {
    status,
    headers,
  });
}

function pullRequest(): PullRequest {
  return {
    number: 42,
    state: "open",
    changed_files: 1,
    head: {
      ref: "feature/dispatch-reconciliation",
      sha: HEAD_SHA,
      repo: { full_name: "NVIDIA/NemoClaw" },
    },
    base: {
      sha: BASE_SHA,
      repo: { full_name: "NVIDIA/NemoClaw" },
    },
  };
}

function pullRequestListItem(): Omit<PullRequest, "changed_files"> {
  const { changed_files: _changedFiles, ...item } = pullRequest();
  return item;
}

function reservedCheck(id = 17, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: "E2E / PR Gate Coordination",
    head_sha: HEAD_SHA,
    external_id: prGateExternalId(42, HEAD_SHA, BASE_SHA),
    status: "in_progress",
    conclusion: null,
    details_url: null,
    output: {
      title: "Waiting for PR CI",
      summary:
        "This PR SHA and base SHA are reserved for deterministic E2E planning after CI completes.",
    },
    app: { id: 15368 },
    ...overrides,
  };
}

function startCommand(workDir: string) {
  const command = parseControllerCommand([
    "--mode",
    "start",
    "--head",
    HEAD_SHA,
    "--head-repo",
    "NVIDIA/NemoClaw",
    "--head-branch",
    "feature/dispatch-reconciliation",
    "--workflow-sha",
    WORKFLOW_SHA,
    "--ci-conclusion",
    "success",
    "--ci-display-title",
    `CI PR #42 head ${HEAD_SHA} base ${BASE_SHA} gate true`,
    "--ci-run-attempt",
    "1",
    "--ci-run-id",
    "99",
    "--gate-run-id",
    "77",
    "--pr",
    "42",
    "--work-dir",
    workDir,
  ]);
  expect(command.mode).toBe("start");
  return command as Extract<ReturnType<typeof parseControllerCommand>, { mode: "start" }>;
}

function reconciledWorkflowRun() {
  return {
    id: 23,
    name: `E2E PR #42 (${CORRELATION_ID})`,
    path: ".github/workflows/e2e.yaml",
    workflow_id: 901,
    created_at: new Date(START_TIME.getTime() + 1_000).toISOString(),
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: WORKFLOW_SHA,
    run_attempt: 1,
    status: "queued",
    conclusion: null,
    display_title: `E2E PR #42 (${CORRELATION_ID})`,
    url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/23",
    html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
    repository: { full_name: "NVIDIA/NemoClaw" },
    head_repository: { full_name: "NVIDIA/NemoClaw" },
    actor: { login: "github-actions[bot]" },
    triggering_actor: { login: "github-actions[bot]" },
  };
}

describe("PR E2E dispatch-not-observed recovery", () => {
  it("uses the exact direct check when the new check is not yet visible in history", async () => {
    const requests: RecordedGitHubRequest[] = [];
    const preDispatchCheck = reservedCheck(17, {
      output: {
        title: "Evaluating PR commit",
        summary: "Validating the PR SHA and selecting deterministic E2E jobs and typed targets.",
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/git/ref/heads/main") && method === "GET",
            () =>
              githubResponse({
                ref: "refs/heads/main",
                object: { type: "commit", sha: WORKFLOW_SHA },
              }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: 0, check_runs: [] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => githubResponse(preDispatchCheck),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/workflows/e2e.yaml/dispatches") && method === "POST",
            () =>
              githubResponse({
                workflow_run_id: 23,
                run_url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/23",
                html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
              }),
          ),
        ],
        requests,
      ),
    );

    await expect(
      dispatchPrGate({
        repository: "NVIDIA/NemoClaw",
        checkoutRepository: "NVIDIA/NemoClaw",
        token: "token",
        controllerCheckId: 17,
        jobs: ["onboard-repair"],
        prNumber: 42,
        commitSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        planHash: "c".repeat(64),
        correlationId: CORRELATION_ID,
        expectedCheckTitle: "Evaluating PR commit",
      }),
    ).resolves.toEqual({ runId: 23, workflowSha: WORKFLOW_SHA });

    const listIndex = requests.findIndex((request) => request.url.includes("/check-runs?"));
    const directIndex = requests.findIndex((request) => request.url.endsWith("/check-runs/17"));
    const dispatchIndex = requests.findIndex((request) => request.url.endsWith("/dispatches"));
    expect(directIndex).toBeGreaterThan(listIndex);
    expect(dispatchIndex).toBeGreaterThan(directIndex);
  });

  it("rejects a stale matching list when the exact check advanced before dispatch", async () => {
    const requests: RecordedGitHubRequest[] = [];
    const listedCheck = reservedCheck(17, {
      output: {
        title: "Evaluating PR commit",
        summary: "Validating the PR SHA and selecting deterministic E2E jobs and typed targets.",
      },
    });
    const advancedCheck = reservedCheck(17, {
      details_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/22",
      output: {
        title: "Running 1 E2E check",
        summary: "Selected E2E is running.",
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/git/ref/heads/main") && method === "GET",
            () =>
              githubResponse({
                ref: "refs/heads/main",
                object: { type: "commit", sha: WORKFLOW_SHA },
              }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: 1, check_runs: [listedCheck] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => githubResponse(advancedCheck),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/workflows/e2e.yaml/dispatches") && method === "POST",
            () => githubResponse({ workflow_run_id: 23 }),
          ),
        ],
        requests,
      ),
    );

    await expect(
      dispatchPrGate({
        repository: "NVIDIA/NemoClaw",
        checkoutRepository: "NVIDIA/NemoClaw",
        token: "token",
        controllerCheckId: 17,
        jobs: ["onboard-repair"],
        prNumber: 42,
        commitSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        planHash: "c".repeat(64),
        correlationId: CORRELATION_ID,
        expectedCheckTitle: "Evaluating PR commit",
      }),
    ).rejects.toThrow(/exact pre-dispatch state/u);

    expect(requests.filter((request) => request.url.endsWith("/check-runs/17"))).toHaveLength(1);
    expect(requests.filter((request) => request.url.endsWith("/dispatches"))).toHaveLength(0);
  });

  it("bounds the authoritative check read before dispatch", async () => {
    vi.useFakeTimers();
    const requests: RecordedGitHubRequest[] = [];
    const listedCheck = reservedCheck(17, {
      output: {
        title: "Evaluating PR commit",
        summary: "Validating the PR SHA and selecting deterministic E2E jobs and typed targets.",
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/git/ref/heads/main") && method === "GET",
            () =>
              githubResponse({
                ref: "refs/heads/main",
                object: { type: "commit", sha: WORKFLOW_SHA },
              }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: 1, check_runs: [listedCheck] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => new Promise<Response>(() => undefined),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/workflows/e2e.yaml/dispatches") && method === "POST",
            () => githubResponse({ workflow_run_id: 23 }),
          ),
        ],
        requests,
      ),
    );

    const attempt = dispatchPrGate({
      repository: "NVIDIA/NemoClaw",
      checkoutRepository: "NVIDIA/NemoClaw",
      token: "token",
      controllerCheckId: 17,
      jobs: ["onboard-repair"],
      prNumber: 42,
      commitSha: HEAD_SHA,
      baseSha: BASE_SHA,
      workflowSha: WORKFLOW_SHA,
      planHash: "c".repeat(64),
      correlationId: CORRELATION_ID,
      expectedCheckTitle: "Evaluating PR commit",
    });
    const result = expect(attempt).rejects.toThrow(
      /Pre-dispatch controller check read timed out after 5000ms/u,
    );
    await vi.runAllTimersAsync();
    await result;

    expect(requests.filter((request) => request.url.endsWith("/dispatches"))).toHaveLength(0);
  });

  it("revalidates the exact PR and current check before adopting a reconciled child", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const requests: RecordedGitHubRequest[] = [];
    let checkListReads = 0;
    const preDispatchCheck = reservedCheck(17, {
      output: {
        title: "Evaluating PR commit",
        summary: "Validating the PR SHA and selecting deterministic E2E jobs and typed targets.",
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/git/ref/heads/main") && method === "GET",
            () =>
              githubResponse({
                ref: "refs/heads/main",
                object: { type: "commit", sha: WORKFLOW_SHA },
              }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/workflows/e2e.yaml/dispatches") && method === "POST",
            () =>
              githubResponse({ message: "Failed to run workflow dispatch" }, 500, {
                "x-github-request-id": "ADOPT:1234",
              }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
            () => githubResponse({ total_count: 1, workflow_runs: [reconciledWorkflowRun()] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => githubResponse(reconciledWorkflowRun()),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => {
              checkListReads += 1;
              return checkListReads === 1
                ? githubResponse({ total_count: 1, check_runs: [preDispatchCheck] })
                : githubResponse({ total_count: 0, check_runs: [] });
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => githubResponse(preDispatchCheck),
          ),
        ],
        requests,
      ),
    );

    const attempt = dispatchPrGate({
      repository: "NVIDIA/NemoClaw",
      checkoutRepository: "NVIDIA/NemoClaw",
      token: "token",
      controllerCheckId: 17,
      jobs: ["onboard-repair"],
      prNumber: 42,
      commitSha: HEAD_SHA,
      baseSha: BASE_SHA,
      workflowSha: WORKFLOW_SHA,
      planHash: "c".repeat(64),
      correlationId: CORRELATION_ID,
      expectedCheckTitle: "Evaluating PR commit",
    });
    const result = expect(attempt).resolves.toEqual({ runId: 23, workflowSha: WORKFLOW_SHA });
    await vi.runAllTimersAsync();
    await result;

    const confirmationIndex = requests.findIndex((request) =>
      request.url.endsWith("/actions/runs/23"),
    );
    const pullIndex = requests.findIndex((request) => request.url.endsWith("/pulls/42"));
    const checkIndex = requests.findIndex(
      (request, index) =>
        index > pullIndex && request.url.includes(`/commits/${HEAD_SHA}/check-runs?`),
    );
    expect(confirmationIndex).toBeGreaterThanOrEqual(0);
    expect(pullIndex).toBeGreaterThan(confirmationIndex);
    expect(checkIndex).toBeGreaterThan(pullIndex);
    expect(
      requests.filter(
        (request) =>
          request.url.endsWith("/actions/workflows/e2e.yaml/dispatches") &&
          request.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("cancels an adopted child when the exact check advanced behind a stale list", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const requests: RecordedGitHubRequest[] = [];
    let directReads = 0;
    const listedCheck = reservedCheck(17, {
      output: {
        title: "Evaluating PR commit",
        summary: "Validating the PR SHA and selecting deterministic E2E jobs and typed targets.",
      },
    });
    const advancedCheck = reservedCheck(17, {
      details_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/22",
      output: {
        title: "Running 1 E2E check",
        summary: "A different child was authorized.",
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/git/ref/heads/main") && method === "GET",
            () =>
              githubResponse({
                ref: "refs/heads/main",
                object: { type: "commit", sha: WORKFLOW_SHA },
              }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: 1, check_runs: [listedCheck] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => {
              directReads += 1;
              return githubResponse(directReads === 1 ? listedCheck : advancedCheck);
            },
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/workflows/e2e.yaml/dispatches") && method === "POST",
            () => githubResponse({ message: "Failed to run workflow dispatch" }, 500),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
            () => githubResponse({ total_count: 1, workflow_runs: [reconciledWorkflowRun()] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => githubResponse(reconciledWorkflowRun()),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23/cancel") && method === "POST",
            () => githubResponse(undefined, 202),
          ),
        ],
        requests,
      ),
    );

    const attempt = dispatchPrGate({
      repository: "NVIDIA/NemoClaw",
      checkoutRepository: "NVIDIA/NemoClaw",
      token: "token",
      controllerCheckId: 17,
      jobs: ["onboard-repair"],
      prNumber: 42,
      commitSha: HEAD_SHA,
      baseSha: BASE_SHA,
      workflowSha: WORKFLOW_SHA,
      planHash: "c".repeat(64),
      correlationId: CORRELATION_ID,
      expectedCheckTitle: "Evaluating PR commit",
    });
    const result = expect(attempt).rejects.toThrow(/reconciled child cancellation requested/u);
    await vi.runAllTimersAsync();
    await result;

    const directIndexes = requests.flatMap((request, index) =>
      request.url.endsWith("/check-runs/17") && request.method === "GET" ? [index] : [],
    );
    const cancelIndex = requests.findIndex(
      (request) => request.url.endsWith("/actions/runs/23/cancel") && request.method === "POST",
    );
    expect(directIndexes).toHaveLength(2);
    expect(cancelIndex).toBeGreaterThan(directIndexes[1]!);
    expect(requests.filter((request) => request.url.endsWith("/dispatches"))).toHaveLength(1);
  });

  it("cancels every correlation-bearing run after mixed inventory validation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const requests: RecordedGitHubRequest[] = [];
    const preDispatchCheck = reservedCheck(17, {
      output: {
        title: "Evaluating PR commit",
        summary: "Validating the PR SHA and selecting deterministic E2E jobs and typed targets.",
      },
    });
    const validRun = reconciledWorkflowRun();
    const malformedRun = {
      ...reconciledWorkflowRun(),
      id: 24,
      path: ".github/workflows/other.yaml",
      url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/24",
      html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/24",
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/git/ref/heads/main") && method === "GET",
            () =>
              githubResponse({
                ref: "refs/heads/main",
                object: { type: "commit", sha: WORKFLOW_SHA },
              }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: 1, check_runs: [preDispatchCheck] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => githubResponse(preDispatchCheck),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/workflows/e2e.yaml/dispatches") && method === "POST",
            () => githubResponse({ message: "Failed to run workflow dispatch" }, 500),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
            () =>
              githubResponse({
                total_count: 2,
                workflow_runs: [malformedRun, validRun],
              }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              /\/actions\/runs\/(?:23|24)\/cancel$/u.test(url) && method === "POST",
            () => githubResponse(undefined, 202),
          ),
        ],
        requests,
      ),
    );

    const attempt = dispatchPrGate({
      repository: "NVIDIA/NemoClaw",
      checkoutRepository: "NVIDIA/NemoClaw",
      token: "token",
      controllerCheckId: 17,
      jobs: ["onboard-repair"],
      prNumber: 42,
      commitSha: HEAD_SHA,
      baseSha: BASE_SHA,
      workflowSha: WORKFLOW_SHA,
      planHash: "c".repeat(64),
      correlationId: CORRELATION_ID,
      expectedCheckTitle: "Evaluating PR commit",
    });
    const result = expect(attempt).rejects.toThrow(/failed path validation/u);
    await vi.runAllTimersAsync();
    await result;

    expect(
      requests
        .filter(
          (request) =>
            /\/actions\/runs\/(?:23|24)\/cancel$/u.test(request.url) && request.method === "POST",
        )
        .map((request) => request.url)
        .sort(),
    ).toEqual([
      "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/23/cancel",
      "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/24/cancel",
    ]);
  });

  it.each([
    {
      label: "exact child URL",
      publishedDetailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
    },
    {
      label: "canonical check URL",
      publishedDetailsUrl: "https://github.com/NVIDIA/NemoClaw/runs/17",
    },
  ])("accepts an exact child authorization with $label after the PATCH response is lost", async ({
    publishedDetailsUrl,
  }) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-auth-response-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    let check: Record<string, unknown> = reservedCheck();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: 1, check_runs: [check] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.includes("/pulls?state=open&head=") && method === "GET",
            () => githubResponse([pullRequestListItem()]),
          ),
          githubFetchRoute(
            ({ url, method }) => url.includes("/pulls/42/files?") && method === "GET",
            () => githubResponse([{ filename: "src/lib/onboard.ts" }]),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/git/ref/heads/main") && method === "GET",
            () =>
              githubResponse({
                ref: "refs/heads/main",
                object: { type: "commit", sha: WORKFLOW_SHA },
              }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            (request) => {
              const title = (request.body as { output?: { title?: string } } | undefined)?.output
                ?.title;
              check = {
                ...check,
                ...((request.body ?? {}) as Record<string, unknown>),
                ...(title?.startsWith("Running ")
                  ? { details_url: publishedDetailsUrl }
                  : undefined),
              };
              return title?.startsWith("Running ")
                ? new Response("{", { status: 200 })
                : githubResponse(check);
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => githubResponse(check),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/workflows/e2e.yaml/dispatches") && method === "POST",
            () =>
              githubResponse({
                workflow_run_id: 23,
                run_url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/23",
                html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
              }),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(startPrGate(startCommand(workDir))).resolves.toBeUndefined();
      expect(check).toMatchObject({
        status: "in_progress",
        conclusion: null,
        details_url: publishedDetailsUrl,
        output: { title: expect.stringMatching(/^Running /u) },
      });
      expect(requests.filter((request) => request.url.endsWith("/dispatches"))).toHaveLength(1);
      expect(requests.some((request) => request.url.endsWith("/actions/runs/23/cancel"))).toBe(
        false,
      );
      expect(fs.readFileSync(outputPath, "utf8")).toContain("dispatched=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("dispatches controller-only changes through the normal evidence path", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-controller-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const controllerFiles = [".github/workflows/pr-e2e-gate.yaml", "tools/e2e/pr-e2e-gate.mts"];
    const controllerPull = { ...pullRequest(), changed_files: controllerFiles.length };
    const { changed_files: _changedFiles, ...controllerPullListItem } = controllerPull;
    const requests: RecordedGitHubRequest[] = [];
    let check = reservedCheck();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: 1, check_runs: [check] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.includes("/pulls?state=open&head=") && method === "GET",
            () => githubResponse([controllerPullListItem]),
          ),
          githubFetchRoute(
            ({ url, method }) => url.includes("/pulls/42/files?") && method === "GET",
            () => githubResponse(controllerFiles.map((filename) => ({ filename }))),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(controllerPull),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/git/ref/heads/main") && method === "GET",
            () =>
              githubResponse({
                ref: "refs/heads/main",
                object: { type: "commit", sha: WORKFLOW_SHA },
              }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            (request) => {
              check = { ...check, ...((request.body ?? {}) as Record<string, unknown>) };
              return githubResponse(check);
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => githubResponse(check),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/workflows/e2e.yaml/dispatches") && method === "POST",
            () =>
              githubResponse({
                workflow_run_id: 23,
                run_url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/23",
                html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
              }),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(startPrGate(startCommand(workDir))).resolves.toBeUndefined();
      expect(requests.find((request) => request.url.endsWith("/dispatches"))?.body).toMatchObject({
        inputs: {
          jobs: "cloud-inference,cloud-onboard,security-posture",
          checkout_sha: HEAD_SHA,
          base_sha: BASE_SHA,
        },
      });
      expect(check).toMatchObject({
        details_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
        output: { title: "Running 3 E2E checks" },
      });
      const outputs = fs.readFileSync(outputPath, "utf8");
      expect(outputs).toContain("dispatched=true");
      expect(outputs).not.toContain("approval_mode=");
      expect(outputs).not.toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("terminalizes the uncertain attempt before creating a fresh check and correlation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-dispatch-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);

    const requests: RecordedGitHubRequest[] = [];
    const checks: Array<Record<string, unknown>> = [reservedCheck()];
    let dispatches = 0;
    const fetchMock = createGitHubFetchRouter(
      [
        githubFetchRoute(
          ({ url, method }) => url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
          () => githubResponse({ total_count: checks.length, check_runs: checks }),
        ),
        githubFetchRoute(
          ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
          (request) => {
            const created = reservedCheck(18, request.body as Record<string, unknown>);
            checks.push(created);
            return githubResponse(created);
          },
        ),
        githubFetchRoute(
          ({ url, method }) => /\/check-runs\/(?:17|18)$/u.test(url) && method === "PATCH",
          (request) => {
            const id = Number(urlRunId(request.url));
            const index = checks.findIndex((check) => check.id === id);
            checks[index] = {
              ...checks[index],
              ...(request.body as Record<string, unknown>),
            };
            return githubResponse(checks[index]);
          },
        ),
        githubFetchRoute(
          ({ url, method }) => /\/check-runs\/(?:17|18)$/u.test(url) && method === "GET",
          (request) =>
            githubResponse(checks.find((check) => check.id === Number(urlRunId(request.url)))),
        ),
        githubFetchRoute(
          ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
          () => githubResponse(pullRequest()),
        ),
        githubFetchRoute(
          ({ url, method }) => url.includes("/pulls?state=open&head=") && method === "GET",
          () => githubResponse([pullRequestListItem()]),
        ),
        githubFetchRoute(
          ({ url, method }) => url.includes("/pulls/42/files?") && method === "GET",
          () => githubResponse([{ filename: "src/lib/onboard.ts" }]),
        ),
        githubFetchRoute(
          ({ url, method }) => url.endsWith("/git/ref/heads/main") && method === "GET",
          () =>
            githubResponse({
              ref: "refs/heads/main",
              object: { type: "commit", sha: WORKFLOW_SHA },
            }),
        ),
        githubFetchRoute(
          ({ url, method }) =>
            url.endsWith("/actions/workflows/e2e.yaml/dispatches") && method === "POST",
          () => {
            dispatches += 1;
            return dispatches === 1
              ? githubResponse({ message: "Failed to run workflow dispatch" }, 500, {
                  "x-github-request-id": "ABCD:1234",
                })
              : githubResponse({
                  workflow_run_id: 24,
                  run_url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/24",
                  html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/24",
                });
          },
        ),
        githubFetchRoute(
          ({ url, method }) =>
            url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
          () => githubResponse({ total_count: 0, workflow_runs: [] }),
        ),
      ],
      requests,
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    try {
      const firstAttempt = startPrGate(startCommand(workDir));
      const firstResult = expect(firstAttempt).rejects.toThrow(
        /not observed after bounded reconciliation/u,
      );
      await vi.runAllTimersAsync();
      await firstResult;

      const firstDispatch = requests.find(
        (request) =>
          request.url.endsWith("/actions/workflows/e2e.yaml/dispatches") &&
          request.method === "POST",
      );
      const firstCorrelation = (
        firstDispatch?.body as { inputs?: { correlation_id?: string } } | undefined
      )?.inputs?.correlation_id;
      expect(firstCorrelation).toMatch(/^[a-f0-9-]{36}$/u);
      expect(checks[0]).toMatchObject({
        id: 17,
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Workflow dispatch was not observed",
          summary: expect.stringContaining(
            "<!-- nemoclaw-pr-e2e-retry:v1:dispatch-not-observed -->",
          ),
        },
      });
      expect(JSON.stringify(checks[0])).toContain("nemoclaw-pr-e2e-dispatch:v1:");
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");

      const requestCountBeforeRetry = requests.length;
      await expect(startPrGate(startCommand(workDir))).resolves.toBeUndefined();
      const retryRequests = requests.slice(requestCountBeforeRetry);
      const recheckIndexes = retryRequests.flatMap((request, index) =>
        request.url.includes("/actions/workflows/e2e.yaml/runs?") ? [index] : [],
      );
      const createIndex = retryRequests.findIndex(
        (request) => request.url.endsWith("/check-runs") && request.method === "POST",
      );
      const dispatchIndex = retryRequests.findIndex(
        (request) =>
          request.url.endsWith("/actions/workflows/e2e.yaml/dispatches") &&
          request.method === "POST",
      );
      expect(recheckIndexes.length).toBeGreaterThanOrEqual(2);
      expect(createIndex).toBeGreaterThan(recheckIndexes[0]!);
      expect(recheckIndexes.at(-1)).toBeGreaterThan(createIndex);
      expect(dispatchIndex).toBeGreaterThan(createIndex);
      expect(dispatchIndex).toBeGreaterThan(recheckIndexes.at(-1)!);
      const secondDispatch = retryRequests[dispatchIndex];
      const secondCorrelation = (
        secondDispatch?.body as { inputs?: { correlation_id?: string } } | undefined
      )?.inputs?.correlation_id;
      expect(secondCorrelation).toMatch(/^[a-f0-9-]{36}$/u);
      expect(secondCorrelation).not.toBe(firstCorrelation);
      expect(checks[0]).toMatchObject({
        id: 17,
        status: "completed",
        conclusion: "failure",
      });
      expect(checks[1]).toMatchObject({
        id: 18,
        status: "in_progress",
        conclusion: null,
        details_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/24",
      });
      expect(dispatches).toBe(2);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("cancels an adopted child when the PR changes before authorization publication", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const requests: RecordedGitHubRequest[] = [];
    let pullReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/git/ref/heads/main") && method === "GET",
            () =>
              githubResponse({
                ref: "refs/heads/main",
                object: { type: "commit", sha: WORKFLOW_SHA },
              }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () =>
              githubResponse({
                total_count: 1,
                check_runs: [
                  reservedCheck(17, {
                    output: {
                      title: "Evaluating PR commit",
                      summary:
                        "Validating the PR SHA and selecting deterministic E2E jobs and typed targets.",
                    },
                  }),
                ],
              }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () =>
              githubResponse(
                reservedCheck(17, {
                  output: {
                    title: "Evaluating PR commit",
                    summary:
                      "Validating the PR SHA and selecting deterministic E2E jobs and typed targets.",
                  },
                }),
              ),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/workflows/e2e.yaml/dispatches") && method === "POST",
            () => githubResponse({ message: "dispatch response lost" }, 500),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
            () => githubResponse({ total_count: 1, workflow_runs: [reconciledWorkflowRun()] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => githubResponse(reconciledWorkflowRun()),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => {
              pullReads += 1;
              return githubResponse({
                ...pullRequest(),
                head: { ...pullRequest().head, sha: "e".repeat(40) },
              });
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

    const attempt = dispatchPrGate({
      repository: "NVIDIA/NemoClaw",
      checkoutRepository: "NVIDIA/NemoClaw",
      token: "token",
      controllerCheckId: 17,
      jobs: ["onboard-repair"],
      prNumber: 42,
      commitSha: HEAD_SHA,
      baseSha: BASE_SHA,
      workflowSha: WORKFLOW_SHA,
      planHash: "c".repeat(64),
      correlationId: CORRELATION_ID,
      expectedCheckTitle: "Evaluating PR commit",
    });
    const result = expect(attempt).rejects.toThrow(/reconciled child cancellation requested/u);
    await vi.runAllTimersAsync();
    await result;

    expect(pullReads).toBe(1);
    expect(
      requests.filter(
        (request) => request.url.endsWith("/actions/runs/23/cancel") && request.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (request) =>
          request.url.endsWith("/actions/workflows/e2e.yaml/dispatches") &&
          request.method === "POST",
      ),
    ).toHaveLength(1);
  });
});

function urlRunId(url: string): string {
  const match = /\/check-runs\/([1-9][0-9]*)$/u.exec(url);
  expect(match).not.toBeNull();
  return match![1]!;
}

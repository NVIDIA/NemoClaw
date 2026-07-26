// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type PrGateState,
  prGateExternalId,
  retryRunnerLossPrGate,
} from "../tools/e2e/pr-e2e-gate.mts";
import {
  createGitHubFetchRouter,
  githubFetchRoute,
  type RecordedGitHubRequest,
} from "./support/github-fetch-router.ts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "d".repeat(40);
const ORIGINAL_CORRELATION_ID = "12345678-1234-4123-8123-123456789abc";
const ORIGINAL_RUN_URL = "https://github.com/NVIDIA/NemoClaw/actions/runs/23";
const RETRY_MARKER = "<!-- nemoclaw-pr-e2e-retry:v1:child-cancelled -->";
const START_TIME = new Date("2026-07-26T18:00:00.000Z");
const JOB_ID = 89_074_697_099;

afterEach(() => {
  vi.useRealTimers();
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

function state(): PrGateState {
  return {
    version: 4,
    commitSha: HEAD_SHA,
    baseSha: BASE_SHA,
    checkoutRepository: "NVIDIA/NemoClaw",
    workflowSha: WORKFLOW_SHA,
    planHash: "c".repeat(64),
    correlationId: ORIGINAL_CORRELATION_ID,
    prNumber: 42,
    expectedJobs: ["onboard-repair", "onboard-resume"],
    expectedTargets: [],
    expectedShards: {
      "onboard-repair": ["default"],
      "onboard-resume": ["default"],
    },
  };
}

function sourceCheck() {
  return {
    id: 17,
    name: "E2E / PR Gate Coordination",
    head_sha: HEAD_SHA,
    external_id: prGateExternalId(42, HEAD_SHA, BASE_SHA),
    status: "completed",
    conclusion: "failure",
    details_url: "https://github.com/NVIDIA/NemoClaw/runs/17",
    output: {
      title: "Hermes security-posture failed",
      summary: [
        `[Selected E2E run 23](${ORIGINAL_RUN_URL}) concluded \`failure\`. No passing result was accepted.`,
        "Runner-loss policy: retry once after confirmed GitHub-hosted runner loss.",
        "",
        RETRY_MARKER,
      ].join("\n"),
    },
    app: { id: 15368 },
  };
}

function originalWorkflowRun() {
  return {
    id: 23,
    name: "E2E",
    path: ".github/workflows/e2e.yaml",
    workflow_id: 304_268_429,
    event: "workflow_dispatch",
    head_sha: WORKFLOW_SHA,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    display_title: `E2E PR #42 (${ORIGINAL_CORRELATION_ID})`,
    html_url: ORIGINAL_RUN_URL,
  };
}

function hostedRunnerLossJob() {
  return {
    id: JOB_ID,
    run_id: 23,
    run_attempt: 1,
    head_sha: WORKFLOW_SHA,
    run_url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/23",
    url: `https://api.github.com/repos/NVIDIA/NemoClaw/actions/jobs/${JOB_ID}`,
    html_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/23/job/${JOB_ID}`,
    check_run_url: `https://api.github.com/repos/NVIDIA/NemoClaw/check-runs/${JOB_ID}`,
    name: "Hermes security-posture",
    status: "completed",
    conclusion: "failure",
    started_at: "2026-07-23T07:26:56Z",
    completed_at: "2026-07-23T07:32:54Z",
    runner_id: 1_021_277_393,
    runner_name: "GitHub Actions 1021277393",
    runner_group_id: 0,
    runner_group_name: "GitHub Actions",
    labels: ["ubuntu-latest"],
    steps: [
      { name: "Set up job", status: "completed", conclusion: "success" },
      {
        name: "Run security posture live Vitest test",
        status: "completed",
        conclusion: "cancelled",
        started_at: "2026-07-23T07:27:43Z",
        completed_at: "2026-07-23T07:32:49Z",
      },
      { name: "Upload security posture artifacts", status: "completed", conclusion: "skipped" },
      { name: "Clean up Docker auth", status: "completed", conclusion: "skipped" },
      { name: "Complete job", status: "completed", conclusion: "success" },
    ],
  };
}

function workflowJobCheck() {
  const job = hostedRunnerLossJob();
  return {
    id: job.id,
    name: job.name,
    head_sha: job.head_sha,
    url: job.check_run_url,
    html_url: job.html_url,
    details_url: job.html_url,
    status: "completed",
    conclusion: "failure",
    app: { id: 15368, slug: "github-actions" },
    output: {
      annotations_count: 1,
      annotations_url: `${job.check_run_url}/annotations`,
    },
  };
}

function runnerLossAnnotation() {
  return {
    path: ".github",
    blob_href: `https://github.com/NVIDIA/NemoClaw/blob/${WORKFLOW_SHA}/.github`,
    start_line: 1,
    start_column: null,
    end_line: 1,
    end_column: null,
    annotation_level: "failure",
    title: "",
    message:
      "The hosted runner lost communication with the server. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.",
    raw_details: "",
  };
}

function pullRequest() {
  return {
    number: 42,
    state: "open",
    changed_files: 1,
    head: {
      ref: "feature/pr-e2e-gate",
      sha: HEAD_SHA,
      repo: { full_name: "NVIDIA/NemoClaw" },
    },
    base: { sha: BASE_SHA, repo: { full_name: "NVIDIA/NemoClaw" } },
  };
}

function reconciledRun(runId: number, correlationId: string) {
  return {
    id: runId,
    name: `E2E PR #42 (${correlationId})`,
    path: ".github/workflows/e2e.yaml",
    workflow_id: 304_268_429,
    created_at: new Date(START_TIME.getTime() + 1_000).toISOString(),
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: WORKFLOW_SHA,
    run_attempt: 1,
    status: "queued",
    conclusion: null,
    display_title: `E2E PR #42 (${correlationId})`,
    url: `https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/${runId}`,
    html_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}`,
    repository: { full_name: "NVIDIA/NemoClaw" },
    head_repository: { full_name: "NVIDIA/NemoClaw" },
    actor: { login: "github-actions[bot]" },
    triggering_actor: { login: "github-actions[bot]" },
  };
}

function setup() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runner-loss-dispatch-"));
  const outputPath = path.join(workDir, "github-output");
  const statePath = path.join(workDir, "controller-state.json");
  const retryStatePath = path.join(workDir, "controller-state-runner-loss-retry.json");
  const serializedState = `${JSON.stringify(state(), null, 2)}\n`;
  fs.writeFileSync(outputPath, "", { mode: 0o600 });
  fs.writeFileSync(statePath, serializedState, { mode: 0o600 });
  vi.stubEnv("GITHUB_TOKEN", "token");
  vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
  vi.stubEnv("GITHUB_OUTPUT", outputPath);
  return {
    workDir,
    outputPath,
    command: {
      mode: "retry-runner-loss" as const,
      checkRunId: 17,
      childRunId: 23,
      workflowRunAttempt: 1,
      stateHash: createHash("sha256").update(serializedState).digest("hex"),
      statePath,
      retryStatePath,
    },
  };
}

describe("runner-loss retry dispatch reconciliation", () => {
  it.each([
    {
      label: "zero candidates",
      candidateIds: [] as number[],
      title: "Workflow dispatch was not observed",
    },
    {
      label: "multiple candidates",
      candidateIds: [24, 25],
      title: "Runner-loss retry could not start",
    },
  ])("fails closed after $label without a second dispatch", async ({ candidateIds, title }) => {
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    const source = sourceCheck();
    let retryCheck: Record<string, unknown> | undefined;
    let correlationId = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => githubResponse(originalWorkflowRun()),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => {
              const checks = retryCheck ? [source, retryCheck] : [source];
              return githubResponse({ total_count: checks.length, check_runs: checks });
            },
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/runs/23/attempts/1/jobs?") && method === "GET",
            () => githubResponse({ total_count: 1, jobs: [hostedRunnerLossJob()] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith(`/check-runs/${JOB_ID}`) && method === "GET",
            () => githubResponse(workflowJobCheck()),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/check-runs/${JOB_ID}/annotations?`) && method === "GET",
            () => githubResponse([runnerLossAnnotation()]),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
            (request) => {
              retryCheck = {
                id: 18,
                conclusion: null,
                details_url: null,
                app: { id: 15368 },
                ...((request.body ?? {}) as Record<string, unknown>),
              };
              return githubResponse(retryCheck);
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/18") && method === "PATCH",
            (request) => {
              retryCheck = {
                ...retryCheck,
                ...((request.body ?? {}) as Record<string, unknown>),
              };
              return githubResponse(retryCheck);
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/18") && method === "GET",
            () => githubResponse(retryCheck),
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
            (request) => {
              correlationId =
                (request.body as { inputs?: { correlation_id?: string } } | undefined)?.inputs
                  ?.correlation_id ?? "";
              return githubResponse({ message: "dispatch response lost" }, 500);
            },
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
            () =>
              githubResponse({
                total_count: candidateIds.length,
                workflow_runs: candidateIds.map((runId) => reconciledRun(runId, correlationId)),
              }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              /\/actions\/runs\/(?:24|25)\/cancel$/u.test(url) && method === "POST",
            () => githubResponse(undefined, 202),
          ),
        ],
        requests,
      ),
    );

    try {
      const attempt = retryRunnerLossPrGate(context.command);
      const result = expect(attempt).rejects.toThrow(
        candidateIds.length === 0
          ? /not observed after bounded reconciliation/u
          : /multiple correlated runs/u,
      );
      await vi.runAllTimersAsync();
      await result;

      expect(retryCheck).toMatchObject({
        id: 18,
        status: "completed",
        conclusion: "failure",
        output: { title },
      });
      expect(requests.filter((request) => request.url.endsWith("/dispatches"))).toHaveLength(1);
      expect(
        requests.filter((request) => /\/actions\/runs\/(?:24|25)\/cancel$/u.test(request.url)),
      ).toHaveLength(candidateIds.length);
      expect(
        requests.filter(
          (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
        ),
      ).toHaveLength(0);
      const serializedCheck = JSON.stringify(retryCheck);
      const dispatchWasNotObserved = candidateIds.length === 0;
      expect(serializedCheck.includes("nemoclaw-pr-e2e-dispatch:v1:")).toBe(dispatchWasNotObserved);
      expect(serializedCheck.includes("dispatch-not-observed")).toBe(dispatchWasNotObserved);
      expect(fs.readFileSync(context.outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(context.workDir, { recursive: true, force: true });
    }
  });
});

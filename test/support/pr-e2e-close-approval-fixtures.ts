// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { prGateExternalId } from "../../tools/e2e/pr-e2e-gate.mts";
import { githubFetchRoute } from "./github-fetch-router.ts";

export const REPOSITORY = "NVIDIA/NemoClaw";
export const HEAD_SHA = "a".repeat(40);
export const BASE_SHA = "b".repeat(40);
export const WORKFLOW_SHA = "d".repeat(40);
export const CONTROLLER_RUN_URL = `https://github.com/${REPOSITORY}/actions/runs/23`;
export const INTERNAL_APPROVAL_ENVIRONMENT = "approve-credentialed-e2e-for-internal-pr";
const CORRELATION_ID = "11111111-1111-4111-8111-111111111111";

export function githubResponse(value?: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () => (value === undefined ? "" : JSON.stringify(value)),
  } as Response;
}

export function pullRequest(state = "open") {
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

export function pendingApprovalCheckFor({
  checkId = 17,
  baseSha = BASE_SHA,
  runId = 23,
  overrides = {},
}: {
  checkId?: number;
  baseSha?: string;
  runId?: number;
  overrides?: Record<string, unknown>;
} = {}) {
  const runUrl = `https://github.com/${REPOSITORY}/actions/runs/${runId}`;
  return {
    id: checkId,
    name: "E2E / PR Gate Coordination",
    head_sha: HEAD_SHA,
    external_id: prGateExternalId(42, HEAD_SHA, baseSha),
    status: "in_progress",
    conclusion: null,
    details_url: `https://github.com/${REPOSITORY}/runs/${checkId}`,
    output: {
      title: "E2E reviewer authorization required to run E2E",
      summary: [
        "No selected E2E job or target ran and no repository secret was exposed.",
        `Open [E2E / PR Gate Controller run ${runId}](${runUrl}), choose Review deployments, and approve the protected environment.`,
      ].join("\n\n"),
    },
    app: { id: 15368 },
    ...overrides,
  };
}

export function pendingApprovalCheck(overrides: Record<string, unknown> = {}) {
  return pendingApprovalCheckFor({ overrides });
}

export function approvalControllerRun(runId = 23, overrides: Record<string, unknown> = {}) {
  const runUrl = `https://github.com/${REPOSITORY}/actions/runs/${runId}`;
  return {
    id: runId,
    name: `E2E Gate workflow_run ${runId}`,
    display_title: `E2E Gate workflow_run ${runId}`,
    path: ".github/workflows/pr-e2e-gate.yaml",
    workflow_id: 123,
    event: "workflow_run",
    head_branch: "main",
    head_sha: WORKFLOW_SHA,
    run_attempt: 1,
    status: "waiting",
    conclusion: null,
    html_url: runUrl,
    repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

export function prE2eChildRun(overrides: Record<string, unknown> = {}) {
  const runId = typeof overrides.id === "number" ? overrides.id : 99;
  return {
    id: runId,
    name: "E2E",
    display_title: `E2E PR #42 (${CORRELATION_ID})`,
    path: ".github/workflows/e2e.yaml",
    workflow_id: 789,
    event: "workflow_dispatch",
    head_sha: WORKFLOW_SHA,
    run_attempt: 1,
    status: "in_progress",
    conclusion: null,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    ...overrides,
  };
}

export function deterministicPolling(timeoutMs = 10) {
  let time = 0;
  return {
    pollIntervalMs: 1,
    timeoutMs,
    childVisibilityWindowMs: 2,
    childPollIntervalMs: 1,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

export function pendingDeployments(environment = INTERNAL_APPROVAL_ENVIRONMENT) {
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

export function emptyActiveRunsRoute() {
  return githubFetchRoute(
    ({ url, method }) => url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
    () => githubResponse({ workflow_runs: [] }),
  );
}

export function checkListingRoute(...checks: Record<string, unknown>[]) {
  return githubFetchRoute(
    ({ url, method }) => url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
    () => githubResponse({ total_count: checks.length, check_runs: checks }),
  );
}

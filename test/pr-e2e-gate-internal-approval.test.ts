// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PullRequest,
  parseControllerCommand,
  prGateExternalId,
  startApprovedControlPlanePrGate,
} from "../tools/e2e/pr-e2e-gate.mts";
import {
  createGitHubFetchRouter,
  githubFetchRoute,
  type RecordedGitHubRequest,
} from "./support/github-fetch-router.ts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "d".repeat(40);
const APPROVAL_RUN_ID = 123;

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

function pullRequest(): PullRequest {
  return {
    number: 42,
    state: "open",
    changed_files: 1,
    head: {
      ref: "feature/pr-e2e-gate",
      sha: HEAD_SHA,
      repo: { full_name: "NVIDIA/NemoClaw" },
    },
    base: {
      sha: BASE_SHA,
      repo: { full_name: "NVIDIA/NemoClaw" },
    },
  };
}

function approvedControlPlaneCommand(workDir: string) {
  const command = parseControllerCommand([
    "--mode",
    "start-approved-control-plane",
    "--pr",
    "42",
    "--head",
    HEAD_SHA,
    "--base",
    BASE_SHA,
    "--workflow-sha",
    WORKFLOW_SHA,
    "--approval-run-id",
    String(APPROVAL_RUN_ID),
    "--approval-run-attempt",
    "1",
    "--gate-run-id",
    String(APPROVAL_RUN_ID),
    "--workflow-run-attempt",
    "1",
    "--work-dir",
    workDir,
  ]);
  expect(command.mode).toBe("start-approved-control-plane");
  return command as Extract<
    ReturnType<typeof parseControllerCommand>,
    { mode: "start-approved-control-plane" }
  >;
}

function approvalWorkflowRun() {
  return {
    id: APPROVAL_RUN_ID,
    name: `E2E Gate workflow_run ${APPROVAL_RUN_ID}`,
    path: ".github/workflows/pr-e2e-gate.yaml",
    event: "workflow_run",
    head_sha: WORKFLOW_SHA,
    head_branch: "main",
    status: "in_progress",
    conclusion: null,
    run_attempt: 1,
    html_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${APPROVAL_RUN_ID}`,
  };
}

function approvalRunRoute() {
  return githubFetchRoute(
    ({ url, method }) => url.endsWith(`/actions/runs/${APPROVAL_RUN_ID}`) && method === "GET",
    () => githubResponse(approvalWorkflowRun()),
  );
}

function approvalHistoryRoute(value: unknown) {
  return githubFetchRoute(
    ({ url, method }) =>
      url.endsWith(`/actions/runs/${APPROVAL_RUN_ID}/approvals`) && method === "GET",
    () => githubResponse(value),
  );
}

function exactPrGateCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    name: "E2E / PR Gate Coordination",
    head_sha: HEAD_SHA,
    external_id: prGateExternalId(42, HEAD_SHA, BASE_SHA),
    status: "in_progress",
    conclusion: null,
    app: { id: 15368 },
    output: { title: "E2E reviewer authorization required to run E2E" },
    ...overrides,
  };
}

describe("PR E2E protected internal approval", () => {
  it("lets a configured reviewer without merge rights dispatch the exact internal plan", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-reviewer-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          approvalRunRoute(),
          approvalHistoryRoute([
            {
              state: "approved",
              comment: "Reviewed the exact internal PR and base SHAs.",
              environments: [{ name: "approve-credentialed-e2e-for-internal-pr" }],
              user: { login: "e2e-reviewer" },
            },
          ]),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "test/e2e/risk-signal-reporter.ts" }]),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: 1, check_runs: [exactPrGateCheck()] }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/git/ref/heads/main"),
            () =>
              githubResponse({
                ref: "refs/heads/main",
                object: { type: "commit", sha: WORKFLOW_SHA },
              }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            (request) =>
              githubResponse({
                ...exactPrGateCheck(),
                ...((request.body ?? {}) as Record<string, unknown>),
              }),
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
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => {
              const dispatch = requests.find((request) => request.url.endsWith("/dispatches"));
              const inputs = (dispatch?.body as { inputs?: Record<string, string> } | undefined)
                ?.inputs;
              const correlationId = inputs?.correlation_id ?? "missing";
              return githubResponse({
                id: 23,
                name: `E2E PR #42 (${correlationId})`,
                path: ".github/workflows/e2e.yaml",
                workflow_id: 7,
                event: "workflow_dispatch",
                head_sha: WORKFLOW_SHA,
                status: "queued",
                conclusion: null,
                display_title: `E2E PR #42 (${correlationId})`,
                html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
              });
            },
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(
        startApprovedControlPlanePrGate(approvedControlPlaneCommand(workDir)),
      ).resolves.toBeUndefined();

      expect(requests.some((request) => request.url.includes("/collaborators/"))).toBe(false);
      expect(requests.find((request) => request.url.endsWith("/dispatches"))?.body).toMatchObject({
        ref: "main",
        inputs: {
          pr_number: "42",
          checkout_sha: HEAD_SHA,
          base_sha: BASE_SHA,
          workflow_sha: WORKFLOW_SHA,
        },
      });
      const authorization = requests.find(
        (request) =>
          request.url.endsWith("/check-runs/17") &&
          (request.body as { output?: { title?: string } } | undefined)?.output?.title ===
            "E2E execution authorized by @e2e-reviewer",
      );
      expect(authorization?.body).toMatchObject({
        status: "in_progress",
        output: {
          summary: expect.stringContaining("Reviewed the exact internal PR and base SHAs."),
        },
      });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("dispatched=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the environment did not record an approval", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-no-review-"));
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter([approvalRunRoute(), approvalHistoryRoute([])], requests),
    );

    try {
      await expect(
        startApprovedControlPlanePrGate(approvedControlPlaneCommand(workDir)),
      ).rejects.toThrow(
        /No required-reviewer approval was recorded for approve-credentialed-e2e-for-internal-pr/u,
      );
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

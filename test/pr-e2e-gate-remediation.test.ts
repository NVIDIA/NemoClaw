// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRiskPlan } from "../tools/advisors/risk-plan.mts";
import {
  finishPrGate,
  type PrGateState,
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

const FAILED_HEAD_SHA = "a".repeat(40);
const FIXED_HEAD_SHA = "e".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "d".repeat(40);
const CORRELATION_ID = "12345678-1234-4123-8123-123456789abc";

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

function pullRequest(headSha: string, changedFiles = 1): PullRequest {
  return {
    number: 42,
    state: "open",
    changed_files: changedFiles,
    head: {
      ref: "feature/pr-e2e-remediation",
      sha: headSha,
      repo: { full_name: "NVIDIA/NemoClaw" },
    },
    base: {
      sha: BASE_SHA,
      repo: { full_name: "NVIDIA/NemoClaw" },
    },
  };
}

function pullRequestListItem(pull: PullRequest): Omit<PullRequest, "changed_files"> {
  const { changed_files: _changedFiles, ...item } = pull;
  return item;
}

function failedGateState(): PrGateState {
  const plan = buildRiskPlan({
    headSha: FAILED_HEAD_SHA,
    changedFiles: ["src/lib/onboard.ts"],
  });
  return {
    version: 4,
    commitSha: FAILED_HEAD_SHA,
    baseSha: BASE_SHA,
    checkoutRepository: "NVIDIA/NemoClaw",
    workflowSha: WORKFLOW_SHA,
    planHash: plan.planHash,
    correlationId: CORRELATION_ID,
    prNumber: 42,
    expectedJobs: ["onboard-repair", "onboard-resume"],
    expectedTargets: [],
    expectedShards: {
      "onboard-repair": ["default"],
      "onboard-resume": ["default"],
    },
  };
}

function startCommand(workDir: string) {
  const command = parseControllerCommand([
    "--mode",
    "start",
    "--head",
    FIXED_HEAD_SHA,
    "--head-repo",
    "NVIDIA/NemoClaw",
    "--head-branch",
    "feature/pr-e2e-remediation",
    "--workflow-sha",
    WORKFLOW_SHA,
    "--ci-conclusion",
    "success",
    "--ci-display-title",
    `CI PR #42 head ${FIXED_HEAD_SHA} base ${BASE_SHA} gate true`,
    "--ci-run-attempt",
    "1",
    "--ci-run-id",
    "100",
    "--gate-run-id",
    "78",
    "--pr",
    "42",
    "--work-dir",
    workDir,
  ]);
  expect(command.mode).toBe("start");
  return command as Extract<ReturnType<typeof parseControllerCommand>, { mode: "start" }>;
}

describe("PR E2E remediation", () => {
  it("dispatches the complete selected plan after a failed E2E is fixed on a new PR revision", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-remediation-"));
    const outputPath = path.join(workDir, "github-output");
    const statePath = path.join(workDir, "controller-state.json");
    const evidencePath = path.join(workDir, "evidence");
    const failedGate = failedGateState();
    const serializedState = `${JSON.stringify(failedGate, null, 2)}\n`;
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    fs.writeFileSync(statePath, serializedState, { mode: 0o600 });
    fs.mkdirSync(evidencePath);
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);

    let currentPull = pullRequest(FAILED_HEAD_SHA);
    let failedCheck: Record<string, unknown> = {
      id: 17,
      name: "E2E / PR Gate",
      head_sha: FAILED_HEAD_SHA,
      external_id: prGateExternalId(42, FAILED_HEAD_SHA, BASE_SHA),
      status: "in_progress",
      conclusion: null,
      app: { id: 15368 },
      details_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
      output: { title: "Running 2 E2E checks", summary: "The selected plan is running." },
    };
    let fixedCheck: Record<string, unknown> = {
      id: 18,
      name: "E2E / PR Gate",
      head_sha: FIXED_HEAD_SHA,
      external_id: prGateExternalId(42, FIXED_HEAD_SHA, BASE_SHA),
      status: "in_progress",
      conclusion: null,
      app: { id: 15368 },
      output: {
        title: "Waiting for PR CI",
        summary:
          "This PR SHA and base SHA are reserved for deterministic E2E planning after CI completes.",
      },
    };
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () =>
              githubResponse({
                id: 23,
                name: "E2E",
                path: ".github/workflows/e2e.yaml",
                workflow_id: 304268429,
                run_attempt: 1,
                event: "workflow_dispatch",
                head_sha: WORKFLOW_SHA,
                status: "completed",
                conclusion: "failure",
                display_title: `E2E PR #42 (${CORRELATION_ID})`,
                html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
              }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/runs/23/attempts/1/jobs?") && method === "GET",
            () =>
              githubResponse({
                total_count: 1,
                jobs: [
                  {
                    id: 77,
                    name: "Hermes security-posture",
                    conclusion: "failure",
                    steps: [
                      {
                        name: "Run security posture live Vitest test",
                        conclusion: "failure",
                      },
                    ],
                  },
                ],
              }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${FAILED_HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: 1, check_runs: [failedCheck] }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${FIXED_HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: 1, check_runs: [fixedCheck] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.includes("/pulls?state=open&head=") && method === "GET",
            () => githubResponse([pullRequestListItem(currentPull)]),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(currentPull),
          ),
          githubFetchRoute(
            ({ url, method }) => url.includes("/pulls/42/files?") && method === "GET",
            () =>
              githubResponse([
                { filename: ".github/workflows/pr-e2e-gate.yaml" },
                { filename: "test/e2e/risk-signal-reporter.ts" },
              ]),
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
              failedCheck = {
                ...failedCheck,
                ...((request.body ?? {}) as Record<string, unknown>),
              };
              return githubResponse(failedCheck);
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/18") && method === "PATCH",
            (request) => {
              fixedCheck = { ...fixedCheck, ...((request.body ?? {}) as Record<string, unknown>) };
              return githubResponse(fixedCheck);
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/18") && method === "GET",
            () => githubResponse(fixedCheck),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith("/actions/workflows/e2e.yaml/dispatches") && method === "POST",
            () =>
              githubResponse({
                workflow_run_id: 24,
                run_url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/24",
                html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/24",
              }),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(
        finishPrGate({
          statePath,
          stateHash: createHash("sha256").update(serializedState).digest("hex"),
          evidencePath,
          checkRunId: 17,
          childRunId: 23,
          evidenceOutcome: "success",
        }),
      ).resolves.toBeUndefined();
      expect(failedCheck).toMatchObject({
        status: "completed",
        conclusion: "failure",
        output: { title: "Hermes security-posture failed" },
      });

      currentPull = pullRequest(FIXED_HEAD_SHA, 2);
      fs.writeFileSync(outputPath, "", { mode: 0o600 });
      const remediationRequestStart = requests.length;
      await expect(startPrGate(startCommand(workDir))).resolves.toBeUndefined();

      const remediationRequests = requests.slice(remediationRequestStart);
      expect(
        remediationRequests.filter((request) => request.url.endsWith("/dispatches")),
      ).toHaveLength(1);
      expect(
        remediationRequests.find((request) => request.url.endsWith("/dispatches"))?.body,
      ).toMatchObject({
        inputs: {
          jobs: "cloud-inference,cloud-onboard,security-posture",
          targets: "",
          checkout_sha: FIXED_HEAD_SHA,
          base_sha: BASE_SHA,
        },
      });
      expect(fixedCheck).toMatchObject({
        status: "in_progress",
        conclusion: null,
        output: { title: "Running 3 E2E checks" },
      });
      expect(remediationRequests.some((request) => request.url.includes("/collaborators/"))).toBe(
        false,
      );
      const outputs = fs.readFileSync(outputPath, "utf8");
      expect(outputs).toContain("dispatched=true");
      expect(outputs).not.toContain("approval_");
      expect(outputs).not.toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

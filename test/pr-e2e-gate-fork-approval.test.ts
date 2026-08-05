// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approvePrE2E,
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
const CI_RUN_ID = 99;
const CI_RUN_ATTEMPT = 3;
const GATE_RUN_ID = 77;
const DCODE_PATCH = "agents/langchain-deepagents-code/patch-managed-deepagents-code.py";
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
function emptyPrGateCheckRunsRoute() {
  return githubFetchRoute(
    ({ url, method }) => url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
    () => githubResponse({ total_count: 0, check_runs: [] }),
  );
}
function exactPrGateCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    name: "E2E / PR Gate",
    head_sha: HEAD_SHA,
    external_id: prGateExternalId(42, HEAD_SHA, BASE_SHA),
    status: "in_progress",
    conclusion: null,
    output: {
      title: "Waiting for PR CI",
      summary:
        "This PR SHA and base SHA are reserved for deterministic E2E planning after CI completes.",
    },
    app: { id: 15368 },
    ...overrides,
  };
}
function existingPrGateCheckRunsRoute(overrides: Record<string, unknown> = {}) {
  return githubFetchRoute(
    ({ url, method }) => url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
    () => githubResponse({ total_count: 1, check_runs: [exactPrGateCheck(overrides)] }),
  );
}
function prGateMutationResponse(request: RecordedGitHubRequest, id = 17): Response {
  const body = (request.body ?? {}) as Record<string, unknown>;
  return githubResponse(exactPrGateCheck({ id, ...body }));
}

function commitStatusMutationResponse(request: RecordedGitHubRequest): Response {
  return githubResponse(request.body);
}

function mainWorkflowRefRoute(sha = WORKFLOW_SHA) {
  return githubFetchRoute(
    ({ url }) => url.endsWith("/git/ref/heads/main"),
    () =>
      githubResponse({
        ref: "refs/heads/main",
        object: { type: "commit", sha },
      }),
  );
}

function pullRequest(changedFiles = 1): PullRequest {
  return {
    number: 42,
    state: "open",
    changed_files: changedFiles,
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

function forkPullRequest(changedFiles = 1): PullRequest {
  return {
    ...pullRequest(changedFiles),
    head: {
      ref: "feature/pr-e2e-gate",
      sha: HEAD_SHA,
      repo: { full_name: "contributor/NemoClaw" },
    },
  };
}

function pullRequestListItem(pull = pullRequest()): Omit<PullRequest, "changed_files"> {
  const { changed_files: _changedFiles, ...item } = pull;
  return item;
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
    "feature/pr-e2e-gate",
    "--workflow-sha",
    WORKFLOW_SHA,
    "--ci-conclusion",
    "success",
    "--ci-display-title",
    `CI PR #42 head ${HEAD_SHA} base ${BASE_SHA} gate true`,
    "--ci-run-attempt",
    String(CI_RUN_ATTEMPT),
    "--ci-run-id",
    String(CI_RUN_ID),
    "--gate-run-id",
    String(GATE_RUN_ID),
    "--pr",
    "42",
    "--work-dir",
    workDir,
  ]);
  expect(command.mode).toBe("start");
  return command as Extract<ReturnType<typeof parseControllerCommand>, { mode: "start" }>;
}

function approvalCommand(workDir: string) {
  const command = parseControllerCommand([
    "--mode",
    "approve-e2e",
    "--pr",
    "42",
    "--head",
    HEAD_SHA,
    "--base",
    BASE_SHA,
    "--workflow-sha",
    WORKFLOW_SHA,
    "--maintainer",
    "maintainer",
    "--reason",
    "Reviewed credentialed fork execution",
    "--gate-run-id",
    String(GATE_RUN_ID),
    "--workflow-run-attempt",
    "1",
    "--work-dir",
    workDir,
  ]);
  expect(command.mode).toBe("approve-e2e");
  return command as Extract<ReturnType<typeof parseControllerCommand>, { mode: "approve-e2e" }>;
}

function successfulMaintainerForkRoutes(requests: RecordedGitHubRequest[]) {
  let check = exactPrGateCheck({
    output: { title: "Maintainer approval required to run fork E2E" },
  });
  return [
    githubFetchRoute(
      ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
      () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
    ),
    githubFetchRoute(
      ({ url }) => url.endsWith("/pulls/42"),
      () => githubResponse(forkPullRequest()),
    ),
    githubFetchRoute(
      ({ url }) => url.includes("/pulls/42/files?"),
      () => githubResponse([{ filename: "src/lib/onboard.ts" }]),
    ),
    githubFetchRoute(
      ({ url, method }) => url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
      () => githubResponse({ total_count: 1, check_runs: [check] }),
    ),
    mainWorkflowRefRoute(),
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
    githubFetchRoute(
      ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
      () => {
        const dispatch = requests.find((request) => request.url.endsWith("/dispatches"));
        const inputs = (dispatch?.body as { inputs?: Record<string, string> } | undefined)?.inputs;
        const correlationId = inputs?.correlation_id ?? "missing";
        return githubResponse({
          id: 23,
          name: `E2E PR #42 (${correlationId})`,
          path: ".github/workflows/e2e.yaml",
          workflow_id: 7,
          run_attempt: 1,
          event: "workflow_dispatch",
          head_sha: WORKFLOW_SHA,
          status: "queued",
          conclusion: null,
          display_title: `E2E PR #42 (${correlationId})`,
          html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
        });
      },
    ),
  ];
}

function reconciledForkRun(runId: number, correlationId: string) {
  return {
    id: runId,
    name: `E2E PR #42 (${correlationId})`,
    path: ".github/workflows/e2e.yaml",
    workflow_id: 7,
    created_at: "2026-07-26T18:00:01.000Z",
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

describe("PR E2E controller fork credentialed E2E approval safety", () => {
  it("requires the selected DCode target and maintainer approval before a risky fork can run credentialed E2E (#7463)", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-fork-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_WORKFLOW", "E2E / PR Gate Controller");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          emptyPrGateCheckRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
            (request) => prGateMutationResponse(request),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls?state=open&head="),
            () => githubResponse([pullRequestListItem(forkPullRequest())]),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(forkPullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: DCODE_PATCH }]),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            (request) => prGateMutationResponse(request),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith(`/statuses/${HEAD_SHA}`) && method === "POST",
            commitStatusMutationResponse,
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(
        startPrGate({ ...startCommand(workDir), headRepository: "contributor/NemoClaw" }),
      ).resolves.toBeUndefined();
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      const pending = requests.filter((request) => request.url.endsWith("/check-runs/17")).at(-1);
      expect(pending?.body).toMatchObject({
        status: "in_progress",
        output: {
          title: "Maintainer approval required to run fork E2E",
          summary: expect.stringContaining(
            "No selected E2E job or target ran. No repository credential was exposed to fork code.",
          ),
        },
      });
      expect(JSON.stringify(pending?.body)).toContain(
        `[E2E / PR Gate Controller run ${GATE_RUN_ID}](https://github.com/NVIDIA/NemoClaw/actions/runs/${GATE_RUN_ID})`,
      );
      expect(JSON.stringify(pending?.body)).toContain(
        "[E2E / PR Gate Controller](https://github.com/NVIDIA/NemoClaw/actions/workflows/pr-e2e-gate.yaml)",
      );
      expect(JSON.stringify(pending?.body)).toContain("`approve-e2e`");
      expect(JSON.stringify(pending?.body)).toContain("`pr_number=42`");
      expect(JSON.stringify(pending?.body)).toContain(`\`expected_head_sha=${HEAD_SHA}\``);
      expect(JSON.stringify(pending?.body)).toContain(`\`expected_base_sha=${BASE_SHA}\``);
      expect(JSON.stringify(pending?.body)).toContain("specific `review_reason`");
      expect(JSON.stringify(pending?.body)).toContain("Review scope: PR #42");
      expect(JSON.stringify(pending?.body)).toContain("head repository `contributor/NemoClaw`");
      expect(JSON.stringify(pending?.body)).toContain(`head SHA \`${HEAD_SHA}\``);
      expect(JSON.stringify(pending?.body)).toContain(`base SHA \`${BASE_SHA}\``);
      expect(JSON.stringify(pending?.body)).toContain("targets:");
      expect(JSON.stringify(pending?.body)).toContain("deterministic plan");
      expect(JSON.stringify(pending?.body)).toContain(
        "This gate passes only if the dispatched evidence references both SHAs and verifies successfully.",
      );
      const visibleStatus = requests
        .filter((request) => request.url.endsWith(`/statuses/${HEAD_SHA}`))
        .at(-1);
      expect(visibleStatus?.body).toMatchObject({
        state: "pending",
        context: "E2E / PR Gate / Rollup",
        description: "Maintainer approval required to run fork E2E",
      });
      const outputs = fs.readFileSync(outputPath, "utf8");
      expect(outputs).not.toContain("approval_");
      expect(outputs).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "an authorized child that requires reconciliation",
      title: "Authorized E2E run requires reconciliation",
      summary:
        "A credential-bearing child may still be running.\n\n<!-- nemoclaw-pr-e2e-retry:v1:child-cancelled -->",
      currentCiConclusion: "success",
    },
    {
      label: "an unknown failure without a retry category",
      title: "Unknown controller failure",
      summary: "No trusted retry category was recorded.",
      currentCiConclusion: "success",
    },
    {
      label: "an unknown retry category",
      title: "Selected E2E did not pass",
      summary:
        "The selected child did not pass.\n\n<!-- nemoclaw-pr-e2e-retry:v1:product-failure -->",
      currentCiConclusion: "success",
    },
    {
      label: "a retry marker without the versioned summary boundary",
      title: "Selected E2E did not pass",
      summary: "The selected child was cancelled.<!-- nemoclaw-pr-e2e-retry:v1:child-cancelled -->",
      currentCiConclusion: "success",
    },
    {
      label: "a retryable category before trusted CI succeeds",
      title: "PR #42 CI did not pass",
      summary: "The prerequisite CI failed.\n\n<!-- nemoclaw-pr-e2e-retry:v1:prerequisite-ci -->",
      currentCiConclusion: "failure",
    },
  ])("preserves $label instead of reopening the PR/base SHA pair", async ({
    title,
    summary,
    currentCiConclusion,
  }) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-terminal-"));
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    const originalState = {
      status: "completed",
      conclusion: "failure",
      output: { title, summary },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          existingPrGateCheckRunsRoute(originalState),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest()),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(
        startPrGate({ ...startCommand(workDir), ciConclusion: currentCiConclusion }),
      ).rejects.toThrow(/PR gate state for this PR\/base SHA pair is not retryable/u);
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
      expect(originalState).toEqual({
        status: "completed",
        conclusion: "failure",
        output: { title, summary },
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "an older unmarked terminal check",
      checks: [
        exactPrGateCheck({
          status: "completed",
          conclusion: "failure",
          output: { title: "Unknown controller failure", summary: "No retry marker." },
        }),
        exactPrGateCheck({ id: 18 }),
      ],
      expectedError: "history contains a non-retryable older check",
    },
    {
      label: "multiple active current candidates",
      checks: [exactPrGateCheck(), exactPrGateCheck({ id: 18 })],
      expectedError: "Multiple active PR gate checks exist for one PR/base SHA pair",
    },
  ])("fails closed when PR/base SHA history contains $label", async ({ checks, expectedError }) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-history-"));
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: checks.length, check_runs: checks }),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(startPrGate(startCommand(workDir))).rejects.toThrow(expectedError);
      expect(requests.some((request) => request.method === "POST")).toBe(false);
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("passes a no-risk fork without executing fork code", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-fork-docs-"));
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          existingPrGateCheckRunsRoute(),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls?state=open&head="),
            () => githubResponse([pullRequestListItem(forkPullRequest())]),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(forkPullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "docs/get-started/quickstart.mdx" }]),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            (request) => prGateMutationResponse(request),
          ),
        ],
        requests,
      ),
    );

    try {
      await startPrGate({ ...startCommand(workDir), headRepository: "contributor/NemoClaw" });
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      expect(requests.at(-1)?.body).toMatchObject({
        status: "completed",
        conclusion: "success",
        output: { title: "No E2E checks selected" },
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("dispatches the reviewed fork repository and PR commit after maintainer approval", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-fork-approved-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(successfulMaintainerForkRoutes(requests), requests),
    );

    try {
      await expect(
        approvePrE2E({
          ...approvalCommand(workDir),
          reason: "Reviewed the fork PR and selected E2E plan.",
        }),
      ).resolves.toBeUndefined();

      expect(requests.some((request) => request.url.includes("/collaborators/"))).toBe(true);
      expect(requests.find((request) => request.url.endsWith("/dispatches"))?.body).toMatchObject({
        ref: "main",
        inputs: {
          controller_check_id: "17",
          pr_number: "42",
          checkout_repository: "contributor/NemoClaw",
          checkout_sha: HEAD_SHA,
          base_sha: BASE_SHA,
          workflow_sha: WORKFLOW_SHA,
        },
      });
      const authorization = requests.find(
        (request) =>
          request.url.endsWith("/check-runs/17") &&
          (request.body as { output?: { title?: string } } | undefined)?.output?.title ===
            "E2E execution authorized by @maintainer",
      );
      expect(authorization?.body).toMatchObject({
        status: "in_progress",
        output: {
          summary: expect.stringContaining("Reviewed the fork PR and selected E2E plan."),
        },
      });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("dispatched=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("cancels ambiguous fork candidates and does not restore maintainer approval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T18:00:00.000Z"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-fork-ambiguous-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    let check = exactPrGateCheck({
      output: { title: "Maintainer approval required to run fork E2E" },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(forkPullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "src/lib/onboard.ts" }]),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: 1, check_runs: [check] }),
          ),
          mainWorkflowRefRoute(),
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
            () => githubResponse({ message: "dispatch response lost" }, 500),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/workflows/e2e.yaml/runs?") && method === "GET",
            () => {
              const dispatch = requests.find((request) => request.url.endsWith("/dispatches"));
              const correlationId = (
                dispatch?.body as { inputs?: { correlation_id?: string } } | undefined
              )?.inputs?.correlation_id;
              expect(correlationId).toMatch(/^[a-f0-9-]{36}$/u);
              return githubResponse({
                total_count: 2,
                workflow_runs: [
                  reconciledForkRun(23, correlationId!),
                  reconciledForkRun(24, correlationId!),
                ],
              });
            },
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

    try {
      const attempt = approvePrE2E({
        ...approvalCommand(workDir),
        reason: "Reviewed fork code and risk plan.",
      });
      const result = expect(attempt).rejects.toThrow(/multiple correlated runs/u);
      await vi.runAllTimersAsync();
      await result;

      expect(check).toMatchObject({
        status: "completed",
        conclusion: "failure",
        details_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
        output: { title: "Authorized E2E run requires reconciliation" },
      });
      expect(JSON.stringify(check)).not.toContain("nemoclaw-pr-e2e-retry:");
      expect(
        requests.filter((request) => /\/actions\/runs\/(?:23|24)\/cancel$/u.test(request.url)),
      ).toHaveLength(2);
      expect(requests.filter((request) => request.url.endsWith("/dispatches"))).toHaveLength(1);
      expect(
        requests.filter(
          (request) =>
            request.method === "PATCH" &&
            (request.body as { output?: { title?: string } } | undefined)?.output?.title ===
              "Maintainer approval required to run fork E2E",
        ),
      ).toHaveLength(0);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects approve-e2e for internal pull requests before reading changed files or gate state", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-internal-"));
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () =>
              githubResponse({
                role_name: "maintain",
                permission: "write",
                user: { login: "maintainer" },
              }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(pullRequest()),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(approvePrE2E(approvalCommand(workDir))).rejects.toThrow(
        /approve-e2e is only supported for fork pull requests/u,
      );
      expect(requests.some((request) => request.url.includes("/pulls/42/files?"))).toBe(false);
      expect(requests.some((request) => request.url.includes("/check-runs"))).toBe(false);
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("fails authorization closed when child cancellation cannot be confirmed", async () => {
    const workDirs = [
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-cancel-failed-")),
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-cancel-retry-")),
    ];
    const outputPath = path.join(workDirs[0]!, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    let check = exactPrGateCheck({
      output: { title: "Maintainer approval required to run fork E2E" },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(forkPullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "test/e2e/risk-signal-reporter.ts" }]),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: 1, check_runs: [check] }),
          ),
          mainWorkflowRefRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            (request) => {
              const body = request.body as Record<string, unknown>;
              const title = (body.output as { title?: string } | undefined)?.title;
              const updateFails = title === "Running 3 E2E checks";
              check = updateFails ? check : { ...check, ...body };
              return updateFails
                ? githubResponse({ message: "simulated update failure" }, 500)
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
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23/cancel") && method === "POST",
            () => githubResponse({ message: "simulated cancellation failure" }, 500),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(approvePrE2E(approvalCommand(workDirs[0]!))).rejects.toThrow(
        /child cancellation failed/u,
      );
      expect(check).toMatchObject({
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Authorized E2E run requires reconciliation",
          summary: expect.stringContaining("cannot be retried"),
        },
      });
      await expect(approvePrE2E(approvalCommand(workDirs[1]!))).rejects.toThrow(
        /required check is terminal/u,
      );
      expect(requests.filter((request) => request.url.endsWith("/dispatches"))).toHaveLength(1);
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      for (const workDir of workDirs) fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "approval is early",
      check: {
        status: "in_progress",
        conclusion: null,
        output: { title: "Waiting for PR CI" },
      },
      expected: /required check is still preparing.*Wait for the required-check title/u,
    },
    {
      name: "the required check is queued",
      check: {
        status: "queued",
        conclusion: null,
        output: { title: "Maintainer approval required to run fork E2E" },
      },
      expected: /required check is still preparing.*Wait for the required-check title/u,
    },
    {
      name: "runner-loss retry is preparing",
      check: {
        status: "in_progress",
        conclusion: null,
        output: { title: "Preparing one-time hosted-runner-loss retry" },
      },
      expected: /required check is still preparing.*Wait for the required-check title/u,
    },
    {
      name: "E2E authorization is already published",
      check: {
        status: "in_progress",
        conclusion: null,
        output: { title: "E2E execution authorized by @maintainer" },
      },
      expected: /E2E is already executing.*do not launch another approval/u,
    },
    {
      name: "E2E is already running",
      check: {
        status: "in_progress",
        conclusion: null,
        output: { title: "Running 3 E2E checks" },
      },
      expected: /E2E is already executing.*do not launch another approval/u,
    },
    {
      name: "the gate is terminal",
      check: {
        status: "completed",
        conclusion: "failure",
        output: { title: "Maintainer approval required to run fork E2E" },
      },
      expected: /required check is terminal.*do not reuse this approval/u,
    },
    {
      name: "the required-check title is malformed",
      check: {
        status: "in_progress",
        conclusion: null,
        output: { title: "unexpected remote title" },
      },
      expected: /required check is malformed or unknown.*do not retry/u,
    },
    {
      name: "the required-check title is missing",
      check: {
        status: "in_progress",
        conclusion: null,
        output: {},
      },
      expected: /required check is malformed or unknown.*do not retry/u,
    },
    {
      name: "the required-check title is null",
      check: {
        status: "in_progress",
        conclusion: null,
        output: { title: null },
      },
      expected: /required check is malformed or unknown.*do not retry/u,
    },
    {
      name: "the required-check title is not a string",
      check: {
        status: "in_progress",
        conclusion: null,
        output: { title: 7319 },
      },
      expected: /required check is malformed or unknown.*do not retry/u,
    },
  ])("rejects fork authorization when $name", async ({ check, expected }) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-title-"));
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(forkPullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "test/e2e/risk-signal-reporter.ts" }]),
          ),
          existingPrGateCheckRunsRoute(check),
        ],
        requests,
      ),
    );

    try {
      const error = await approvePrE2E(approvalCommand(workDir)).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(expected);
      expect((error as Error).message).toContain("Maintainer approval required to run fork E2E");
      expect((error as Error).message).not.toContain("unexpected remote title");
      expect((error as Error).message).not.toContain("7319");
      expect((error as Error).message).not.toContain("null");
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects fork authorization from a collaborator below maintainer role", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-role-"));
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/contributor/permission"),
            () =>
              githubResponse({
                role_name: "write",
                permission: "write",
                user: { login: "contributor" },
              }),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(
        approvePrE2E({
          ...approvalCommand(workDir),
          maintainer: "contributor",
        }),
      ).rejects.toThrow(/maintainer or administrator/u);
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

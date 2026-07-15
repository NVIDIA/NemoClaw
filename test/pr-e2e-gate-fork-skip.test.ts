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
  recordApprovedForkE2ESkip,
  recordManualForkE2ESkip,
  startControlPlanePrGate,
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
const ADVANCED_WORKFLOW_SHA = "e".repeat(40);
const CI_RUN_ID = 99;
const CI_RUN_ATTEMPT = 3;
const GATE_RUN_ID = 77;
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

function emptyPrGateCheckRunsRoute() {
  return githubFetchRoute(
    ({ url, method }) => url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
    () => githubResponse({ total_count: 0, check_runs: [] }),
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
    ...overrides,
  };
}

function existingPrGateCheckRunsRoute(overrides: Record<string, unknown> = {}) {
  return githubFetchRoute(
    ({ url, method }) => url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
    () => githubResponse({ total_count: 1, check_runs: [exactPrGateCheck(overrides)] }),
  );
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

function compatibleMainComparisonRoute(
  files: Array<{ filename: string; previous_filename?: string }>,
  mainSha = ADVANCED_WORKFLOW_SHA,
) {
  return githubFetchRoute(
    ({ url }) => url.includes(`/compare/${WORKFLOW_SHA}...${mainSha}`),
    () =>
      githubResponse({
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        base_commit: { sha: WORKFLOW_SHA },
        merge_base_commit: { sha: WORKFLOW_SHA },
        head_commit: { sha: mainSha },
        files,
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

function startControlPlaneCommand(workDir: string) {
  const command = parseControllerCommand([
    "--mode",
    "start-control-plane",
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
    "Reviewed exact credentialed control-plane execution",
    "--gate-run-id",
    String(GATE_RUN_ID),
    "--workflow-run-attempt",
    "1",
    "--work-dir",
    workDir,
  ]);
  expect(command.mode).toBe("start-control-plane");
  return command as Extract<
    ReturnType<typeof parseControllerCommand>,
    { mode: "start-control-plane" }
  >;
}

function approvalWorkflowRun(overrides: Record<string, unknown> = {}) {
  return {
    id: APPROVAL_RUN_ID,
    name: "E2E / PR Gate Controller",
    path: ".github/workflows/pr-e2e-gate.yaml",
    event: "workflow_run",
    head_sha: WORKFLOW_SHA,
    head_branch: "main",
    status: "in_progress",
    conclusion: null,
    run_attempt: 1,
    html_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${APPROVAL_RUN_ID}`,
    ...overrides,
  };
}

function approvalReview(comment: string | null = null, overrides: Record<string, unknown> = {}) {
  return {
    state: "approved",
    comment,
    environments: [{ name: "approve-credentialed-e2e-skip-for-fork-pr" }],
    user: { login: "maintainer" },
    ...overrides,
  };
}

function approvedForkSkipCommand() {
  return {
    mode: "record-approved-fork-e2e-skip" as const,
    prNumber: 42,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    workflowSha: WORKFLOW_SHA,
    approvalRunId: APPROVAL_RUN_ID,
    approvalRunAttempt: 1,
  };
}

function approvalRunRoute(value: unknown) {
  return githubFetchRoute(
    ({ url, method }) => url.endsWith(`/actions/runs/${APPROVAL_RUN_ID}`) && method === "GET",
    () => githubResponse(value),
  );
}

function approvalHistoryRoute(value: unknown) {
  return githubFetchRoute(
    ({ url, method }) =>
      url.endsWith(`/actions/runs/${APPROVAL_RUN_ID}/approvals`) && method === "GET",
    () => githubResponse(value),
  );
}

function successfulApprovedForkRoutes(approvals: unknown) {
  return [
    approvalRunRoute(approvalWorkflowRun()),
    approvalHistoryRoute(approvals),
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
      () => githubResponse(forkPullRequest()),
    ),
    githubFetchRoute(
      ({ url }) => url.includes("/pulls/42/files?"),
      () => githubResponse([{ filename: "src/lib/onboard.ts" }]),
    ),
    existingPrGateCheckRunsRoute({
      status: "completed",
      conclusion: "failure",
      output: { title: "Maintainer approval required to skip credentialed E2E" },
    }),
    mainWorkflowRefRoute(),
    githubFetchRoute(
      ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
      () => githubResponse({}),
    ),
  ];
}

describe("PR E2E controller fork credentialed E2E skip approval safety", () => {
  it("plans a risky fork without dispatching secret-bearing E2E", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-fork-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          emptyPrGateCheckRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
            () => githubResponse({ id: 17 }),
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
            () => githubResponse([{ filename: "src/lib/onboard.ts" }]),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            () => githubResponse({}),
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
      const completion = requests
        .filter((request) => request.url.endsWith("/check-runs/17"))
        .at(-1);
      expect(completion?.body).toMatchObject({
        status: "completed",
        conclusion: "failure",
        details_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${GATE_RUN_ID}`,
        output: {
          title: "Maintainer approval required to skip credentialed E2E",
          summary: expect.stringContaining("The selected jobs were not run"),
        },
      });
      expect(JSON.stringify(completion?.body)).toContain("Review deployments");
      expect(JSON.stringify(completion?.body)).toContain(
        `[E2E / PR Gate Controller run ${GATE_RUN_ID}](https://github.com/NVIDIA/NemoClaw/actions/runs/${GATE_RUN_ID})`,
      );
      expect(JSON.stringify(completion?.body)).toContain(
        "approve-credentialed-e2e-skip-for-fork-pr",
      );
      expect(JSON.stringify(completion?.body)).toContain("If Review deployments is absent");
      expect(JSON.stringify(completion?.body)).toContain("approve-fork-e2e-skip");
      expect(fs.readFileSync(outputPath, "utf8")).toContain(
        [
          "fork_skip_mode=record-fork-e2e-skip",
          "fork_skip_pr_number=42",
          `fork_skip_head_sha=${HEAD_SHA}`,
          `fork_skip_base_sha=${BASE_SHA}`,
        ].join("\n"),
      );
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("requires authorization before internal PR code can receive E2E credentials", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-control-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          existingPrGateCheckRunsRoute(),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls?state=open&head="),
            () => githubResponse([pullRequestListItem()]),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "test/e2e/risk-signal-reporter.ts" }]),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            () => githubResponse({}),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(startPrGate(startCommand(workDir))).resolves.toBeUndefined();
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      const completion = requests
        .filter((request) => request.url.endsWith("/check-runs/17"))
        .at(-1);
      expect(completion?.body).toMatchObject({
        status: "in_progress",
        output: {
          title: "Maintainer authorization required to run E2E",
          summary: expect.stringContaining(
            "No selected E2E job ran and no repository secret was exposed",
          ),
        },
      });
      expect(JSON.stringify(completion?.body)).not.toContain("conclusion");
      expect(JSON.stringify(completion?.body)).toContain(
        "run `run-control-plane` with the PR number, exact head and base SHAs",
      );
      expect(fs.readFileSync(outputPath, "utf8")).not.toContain("fork_skip_mode=");
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
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
            () => githubResponse({}),
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
        output: { title: "No E2E jobs selected" },
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "without a comment", comment: null, expectedReason: "approval confirmed" },
    {
      name: "with an optional comment",
      comment: "  Independently\nreviewed without secrets.  ",
      expectedReason: "Reviewer comment: Independently reviewed without secrets.",
    },
    {
      name: "with an overlong optional comment",
      comment: "x".repeat(1000),
      expectedReason: `Reviewer comment: ${"x".repeat(100)}`,
    },
  ])("records a validated environment approval $name", async ({ comment, expectedReason }) => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(successfulApprovedForkRoutes([approvalReview(comment)]), requests),
    );

    await expect(recordApprovedForkE2ESkip(approvedForkSkipCommand())).resolves.toBeUndefined();

    const completion = requests.filter((request) => request.method === "PATCH").at(-1);
    expect(completion?.body).toMatchObject({
      status: "completed",
      conclusion: "success",
      details_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${APPROVAL_RUN_ID}`,
      output: {
        title: "Credentialed E2E skipped for fork PR — approved by @maintainer",
        summary: expect.stringContaining(
          "**Outcome: APPROVED SKIP — credentialed E2E did not run.**",
        ),
      },
    });
    const summary = JSON.stringify(completion?.body);
    expect(summary).toContain("Validated environment approval run");
    expect(summary).toContain(expectedReason);
    expect(summary).not.toContain("not validated by this controller");
    expect(summary.length).toBeLessThan(2000);
  });

  it("explains how to recover when the approval environment is not protected", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [approvalRunRoute(approvalWorkflowRun()), approvalHistoryRoute([])],
        requests,
      ),
    );

    await expect(recordApprovedForkE2ESkip(approvedForkSkipCommand())).rejects.toThrow(
      /No required-reviewer approval was recorded.*Review deployments was absent.*missing or unprotected.*trigger fresh PR CI.*approve-fork-e2e-skip/u,
    );
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it.each([
    { name: "a malformed history object", approvals: {} },
    {
      name: "a malformed review",
      approvals: [approvalReview(null, { comment: 42 })],
    },
    {
      name: "the wrong environment",
      approvals: [approvalReview(null, { environments: [{ name: "production" }] })],
    },
    {
      name: "a rejected review",
      approvals: [approvalReview(null, { state: "rejected" })],
    },
    {
      name: "an approval spanning multiple environments",
      approvals: [
        approvalReview(null, {
          environments: [
            { name: "approve-credentialed-e2e-skip-for-fork-pr" },
            { name: "production" },
          ],
        }),
      ],
    },
    {
      name: "ambiguous matching approvals",
      approvals: [approvalReview(), approvalReview("second approval")],
    },
  ])("fails closed for $name", async ({ approvals }) => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [approvalRunRoute(approvalWorkflowRun()), approvalHistoryRoute(approvals)],
        requests,
      ),
    );

    await expect(recordApprovedForkE2ESkip(approvedForkSkipCommand())).rejects.toThrow();
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it.each([
    { name: "wrong run id", overrides: { id: APPROVAL_RUN_ID + 1 } },
    { name: "wrong workflow name", overrides: { name: "Other workflow" } },
    { name: "wrong event", overrides: { event: "workflow_dispatch" } },
    {
      name: "untrusted workflow path suffix",
      overrides: { path: ".github/workflows/pr-e2e-gate.yaml@refs/heads/main" },
    },
    { name: "wrong head branch", overrides: { head_branch: "feature" } },
    { name: "wrong workflow SHA", overrides: { head_sha: ADVANCED_WORKFLOW_SHA } },
    { name: "completed run", overrides: { status: "completed", conclusion: "success" } },
    { name: "second run attempt", overrides: { run_attempt: 2 } },
    {
      name: "noncanonical URL",
      overrides: {
        html_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${APPROVAL_RUN_ID}/`,
      },
    },
  ])("rejects approval from a $name", async ({ overrides }) => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter([approvalRunRoute(approvalWorkflowRun(overrides))], requests),
    );

    await expect(recordApprovedForkE2ESkip(approvedForkSkipCommand())).rejects.toThrow(
      /trusted first-attempt gate run/u,
    );
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("parses only first-attempt protected-environment resolutions", () => {
    const args = [
      "--mode",
      "record-approved-fork-e2e-skip",
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
    ];

    expect(parseControllerCommand(args)).toEqual(approvedForkSkipCommand());
    expect(() => parseControllerCommand([...args.slice(0, -1), "2"])).toThrow(/must be exactly 1/u);
  });

  it("rejects a command for a rerun before reading GitHub approval state", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(createGitHubFetchRouter([], requests));

    await expect(
      recordApprovedForkE2ESkip({ ...approvedForkSkipCommand(), approvalRunAttempt: 2 }),
    ).rejects.toThrow(/must be exactly 1/u);
    expect(requests).toHaveLength(0);
  });

  it("records an approved credentialed E2E skip for the reviewed head/base after a compatible main advance", async () => {
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
            () => githubResponse(forkPullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "src/lib/onboard.ts" }]),
          ),
          existingPrGateCheckRunsRoute({
            status: "completed",
            conclusion: "failure",
            output: { title: "Maintainer approval required to skip credentialed E2E" },
          }),
          mainWorkflowRefRoute(ADVANCED_WORKFLOW_SHA),
          compatibleMainComparisonRoute([{ filename: "docs/get-started/quickstart.mdx" }]),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            () => githubResponse({}),
          ),
        ],
        requests,
      ),
    );

    await recordManualForkE2ESkip({
      mode: "record-fork-e2e-skip",
      prNumber: 42,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      workflowSha: WORKFLOW_SHA,
      maintainer: "maintainer",
      reason: "The fork cannot safely receive credential-bearing test secrets.",
    });

    const completion = requests.at(-1);
    expect(completion?.body).toMatchObject({
      status: "completed",
      conclusion: "success",
      output: {
        title: "Credentialed E2E skipped for fork PR — approved by @maintainer",
        summary: expect.stringContaining(
          "**Outcome: APPROVED SKIP — credentialed E2E did not run.**",
        ),
      },
    });
    expect(JSON.stringify(completion?.body)).toContain("Selected jobs not run");
    expect(JSON.stringify(completion?.body)).toContain(
      "Approval source: manual fallback; no supporting Actions run was supplied.",
    );
    expect(JSON.stringify(completion?.body)).not.toContain("tests passed");
  });

  it("dispatches an authorized exact-SHA control-plane run without clearing the gate", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-authorized-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
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
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "test/e2e/risk-signal-reporter.ts" }]),
          ),
          existingPrGateCheckRunsRoute({
            status: "in_progress",
            conclusion: null,
            output: { title: "Maintainer authorization required to run E2E" },
          }),
          mainWorkflowRefRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            () => githubResponse({}),
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
        startControlPlanePrGate(startControlPlaneCommand(workDir)),
      ).resolves.toBeUndefined();

      const dispatch = requests.find((request) => request.url.endsWith("/dispatches"));
      expect(dispatch?.body).toMatchObject({
        ref: "main",
        inputs: {
          jobs: "cloud-onboard,credential-sanitization,security-posture",
          pr_number: "42",
          checkout_sha: HEAD_SHA,
          base_sha: BASE_SHA,
          workflow_sha: WORKFLOW_SHA,
        },
      });
      const checkUpdates = requests.filter(
        (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
      );
      expect(checkUpdates).toHaveLength(2);
      expect(checkUpdates[0]?.body).toMatchObject({
        status: "in_progress",
        output: { title: "E2E execution authorized by @maintainer" },
      });
      expect(checkUpdates[1]?.body).toMatchObject({
        status: "in_progress",
        output: { title: "Running 3 E2E jobs" },
      });
      expect(
        checkUpdates.some(
          (request) =>
            (request.body as { conclusion?: unknown } | undefined)?.conclusion === "success",
        ),
      ).toBe(false);
      const outputs = fs.readFileSync(outputPath, "utf8");
      expect(outputs).toContain("dispatched=true");
      expect(outputs).not.toContain("finalized=true");
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
      output: { title: "Maintainer authorization required to run E2E" },
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
            () => githubResponse(pullRequest()),
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
              const updateFails = title === "Running 3 E2E jobs";
              check = updateFails ? check : { ...check, ...body };
              return updateFails
                ? githubResponse({ message: "simulated update failure" }, 500)
                : githubResponse({});
            },
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
      await expect(startControlPlanePrGate(startControlPlaneCommand(workDirs[0]!))).rejects.toThrow(
        /child cancellation failed/u,
      );
      expect(check).toMatchObject({
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Authorized E2E run requires reconciliation",
          summary: expect.stringContaining("this exact-diff authorization cannot be retried"),
        },
      });
      await expect(startControlPlanePrGate(startControlPlaneCommand(workDirs[1]!))).rejects.toThrow(
        /matching pending control-plane authorization state/u,
      );
      expect(requests.filter((request) => request.url.endsWith("/dispatches"))).toHaveLength(1);
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      for (const workDir of workDirs) fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects a credentialed E2E skip from a collaborator below maintainer role", async () => {
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

    await expect(
      recordManualForkE2ESkip({
        mode: "record-fork-e2e-skip",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        maintainer: "contributor",
        reason: "A write-role collaborator tried to record a credentialed E2E skip.",
      }),
    ).rejects.toThrow(/maintainer or administrator/u);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("rejects control-plane authorization from a collaborator below maintainer role", async () => {
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
        startControlPlanePrGate({
          ...startControlPlaneCommand(workDir),
          maintainer: "contributor",
        }),
      ).rejects.toThrow(/maintainer or administrator/u);
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects control-plane authorization for a fork pull request", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-fork-"));
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
        ],
        requests,
      ),
    );

    try {
      await expect(startControlPlanePrGate(startControlPlaneCommand(workDir))).rejects.toThrow(
        /requires an internal pull request/u,
      );
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects a fork credentialed E2E skip for an internal pull request", async () => {
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
            () => githubResponse(pullRequest()),
          ),
        ],
        requests,
      ),
    );

    const common = {
      prNumber: 42,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      workflowSha: WORKFLOW_SHA,
      maintainer: "maintainer",
      reason: "The resolver operation must match the pull request origin.",
    };
    await expect(
      recordManualForkE2ESkip({ mode: "record-fork-e2e-skip", ...common }),
    ).rejects.toThrow(/credentialed E2E skips require a fork pull request/u);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("rejects control-plane authorization when the gate is already completed", async () => {
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
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "test/e2e/risk-signal-reporter.ts" }]),
          ),
          existingPrGateCheckRunsRoute({
            status: "completed",
            conclusion: "failure",
            output: { title: "Maintainer authorization required to run E2E" },
          }),
        ],
        requests,
      ),
    );

    try {
      await expect(startControlPlanePrGate(startControlPlaneCommand(workDir))).rejects.toThrow(
        /matching pending control-plane authorization state/u,
      );
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("restores a retryable authorization state after an incompatible main advance", async () => {
    const workDirs = [
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-main-")),
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-main-retry-")),
    ];
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    let checkTitle = "Maintainer authorization required to run E2E";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
          ),
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
            () =>
              githubResponse({
                total_count: 1,
                check_runs: [
                  exactPrGateCheck({
                    status: "in_progress",
                    conclusion: null,
                    output: { title: checkTitle },
                  }),
                ],
              }),
          ),
          mainWorkflowRefRoute(ADVANCED_WORKFLOW_SHA),
          compatibleMainComparisonRoute([{ filename: ".github/workflows/e2e.yaml" }]),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            (request) => {
              const body = request.body as { output?: { title?: string } } | undefined;
              checkTitle = body?.output?.title ?? checkTitle;
              return githubResponse({});
            },
          ),
        ],
        requests,
      ),
    );

    try {
      for (const workDir of workDirs) {
        await expect(startControlPlanePrGate(startControlPlaneCommand(workDir))).rejects.toThrow(
          /main advanced through trusted E2E control-plane changes/u,
        );
      }
      const restoredAuthorizations = requests.filter(
        (request) =>
          request.url.endsWith("/check-runs/17") &&
          request.method === "PATCH" &&
          (request.body as { output?: { title?: string } } | undefined)?.output?.title ===
            "Maintainer authorization required to run E2E",
      );
      expect(restoredAuthorizations).toHaveLength(2);
      expect(restoredAuthorizations[0]?.body).toMatchObject({
        status: "in_progress",
        output: {
          title: "Maintainer authorization required to run E2E",
          summary: expect.stringContaining("launch a fresh first-attempt `run-control-plane`"),
        },
      });
      expect(JSON.stringify(restoredAuthorizations[0]?.body)).not.toContain("conclusion");
      expect(checkTitle).toBe("Maintainer authorization required to run E2E");
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
    } finally {
      for (const workDir of workDirs) fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects control-plane authorization when the internal head changes during review", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-head-"));
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    let pullReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => {
              pullReads += 1;
              return githubResponse(
                pullReads === 1
                  ? pullRequest()
                  : {
                      ...pullRequest(),
                      head: { ...pullRequest().head, sha: "c".repeat(40) },
                    },
              );
            },
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "test/e2e/risk-signal-reporter.ts" }]),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(startControlPlanePrGate(startControlPlaneCommand(workDir))).rejects.toThrow(
        /Superseded by PR update/u,
      );
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects a stale fork credentialed E2E skip before changing the gate", async () => {
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
            () =>
              githubResponse({
                ...forkPullRequest(),
                head: { ...forkPullRequest().head, sha: "c".repeat(40) },
              }),
          ),
        ],
        requests,
      ),
    );

    await expect(
      recordManualForkE2ESkip({
        mode: "record-fork-e2e-skip",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        maintainer: "maintainer",
        reason: "The reviewed revision has since changed upstream.",
      }),
    ).rejects.toThrow(/no longer matches/u);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("rejects a fork credentialed E2E skip after the pull request is retargeted", async () => {
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
            () =>
              githubResponse({
                ...forkPullRequest(),
                base: { ...forkPullRequest().base, sha: "f".repeat(40) },
              }),
          ),
        ],
        requests,
      ),
    );

    await expect(
      recordManualForkE2ESkip({
        mode: "record-fork-e2e-skip",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        maintainer: "maintainer",
        reason: "The reviewed base revision has since changed upstream.",
      }),
    ).rejects.toThrow(/no longer matches the reviewed exact head and base SHAs/u);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("rejects control-plane authorization when the base changes before dispatch", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-base-"));
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    let pullReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => {
              pullReads += 1;
              return githubResponse(
                pullReads < 3
                  ? pullRequest()
                  : {
                      ...pullRequest(),
                      base: { ...pullRequest().base, sha: "f".repeat(40) },
                    },
              );
            },
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "test/e2e/risk-signal-reporter.ts" }]),
          ),
          existingPrGateCheckRunsRoute({
            status: "in_progress",
            conclusion: null,
            output: { title: "Maintainer authorization required to run E2E" },
          }),
          mainWorkflowRefRoute(),
        ],
        requests,
      ),
    );

    try {
      await expect(startControlPlanePrGate(startControlPlaneCommand(workDir))).rejects.toThrow(
        /Superseded by PR update/u,
      );
      expect(pullReads).toBe(3);
      expect(requests.some((request) => request.method === "PATCH")).toBe(true);
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

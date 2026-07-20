// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRiskPlan,
  PR_E2E_TYPED_TARGET_IDS,
  riskPlanRequiredJobIds,
  riskPlanRequiredTargetIds,
} from "../tools/advisors/risk-plan.mts";
import {
  assertCorrelatedWorkflowRun,
  classifyPrGateEvidence,
  dispatchPrGate,
  expectedSignalShards,
  finishPrGate,
  type PrGateState,
  type PullRequest,
  parseControllerCommand,
  prGateExternalId,
  pullChangedFiles,
  seedPrGate,
  startPrGate,
  validatePrGateState,
  validateRiskPlan,
  validateSignal,
  validateWorkflowDispatchDetails,
} from "../tools/e2e/pr-e2e-gate.mts";
import type { E2eRiskSignal } from "../tools/e2e/risk-signal.ts";
import { focusedE2eJobsForChangedFiles } from "../tools/e2e/workflow-boundary.mts";
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
const CORRELATION_ID = "12345678-1234-4123-8123-123456789abc";
const DCODE_TARGET = PR_E2E_TYPED_TARGET_IDS[0];
const DCODE_CHECK =
  "test/e2e/e2e-cloud-experimental/checks/07-deepagents-code-headless-inference.sh";
const BROAD_FILES = [
  "src/lib/onboard.ts",
  "src/lib/actions/upgrade-sandboxes.ts",
  "src/lib/actions/sandbox/agents/apply.ts",
  "src/lib/messaging/applier/agent-config.ts",
  "src/lib/inference/health.ts",
  "install.sh",
  "src/lib/credentials/provider-list.ts",
] as const;
const BROAD_JOBS = [
  "cloud-onboard",
  "credential-sanitization",
  "security-posture",
  "channels-add-remove",
  "channels-stop-start",
  "full-e2e",
  "hermes-e2e",
  "inference-routing",
  "network-policy",
  "onboard-repair",
  "onboard-resume",
  "state-backup-restore",
  "upgrade-stale-sandbox",
] as const;

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

function prGateMutationResponse(request: RecordedGitHubRequest, id = 17): Response {
  const body = (request.body ?? {}) as Record<string, unknown>;
  return githubResponse(exactPrGateCheck({ id, ...body }));
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function pullRequestDetailRoute(pull = pullRequest()) {
  return githubFetchRoute(
    ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
    () => githubResponse(pull),
  );
}

function pullRequestListItem(pull = pullRequest()): Omit<PullRequest, "changed_files"> {
  const { changed_files: _changedFiles, ...item } = pull;
  return item;
}

function state(): PrGateState {
  const plan = buildRiskPlan({ headSha: HEAD_SHA, changedFiles: ["src/lib/onboard.ts"] });
  return {
    version: 3,
    commitSha: HEAD_SHA,
    baseSha: BASE_SHA,
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

function startCommand(workDir: string, prNumber = "42") {
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
    prNumber,
    "--work-dir",
    workDir,
  ]);
  expect(command.mode).toBe("start");
  return command as Extract<ReturnType<typeof parseControllerCommand>, { mode: "start" }>;
}

function signal(
  gate: PrGateState,
  jobId: string,
  shardId = "default",
  overrides: Partial<E2eRiskSignal> = {},
): E2eRiskSignal {
  return {
    version: 1,
    jobId,
    shardId,
    expectedSha: gate.commitSha,
    testedSha: gate.commitSha,
    planHash: gate.planHash,
    correlationId: gate.correlationId,
    passed: 1,
    failed: 0,
    skipped: 0,
    pending: 0,
    unhandledErrors: 0,
    runReason: "passed",
    ...overrides,
  };
}

function workflowRun(gate: PrGateState, overrides: Record<string, unknown> = {}) {
  return {
    id: 23,
    name: "E2E",
    path: ".github/workflows/e2e.yaml",
    workflow_id: 304268429,
    event: "workflow_dispatch",
    head_sha: gate.workflowSha,
    status: "completed",
    conclusion: "success",
    display_title: `E2E PR #${gate.prNumber} (${gate.correlationId})`,
    html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
    ...overrides,
  };
}

describe("PR E2E controller", () => {
  it("explains the accepted evidence URL when a manual fork skip uses another GitHub URL", () => {
    expect(() =>
      parseControllerCommand([
        "--mode",
        "record-fork-e2e-skip",
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
        "Reviewed exact fork revision",
        "--evidence-url",
        "https://github.com/NVIDIA/NemoClaw/pull/42#issuecomment-1",
      ]),
    ).toThrow(
      "Evidence URL must be an Actions run URL such as https://github.com/NVIDIA/NemoClaw/actions/runs/123. PR, issue, comment, job, and external URLs are not accepted. Leave the field blank if no run exists.",
    );
  });

  it("validates the risk plan and bounded state", () => {
    const plan = buildRiskPlan({ headSha: HEAD_SHA, changedFiles: ["src/lib/onboard.ts"] });
    const allowed = new Set(riskPlanRequiredJobIds(plan));
    const gate = state();

    expect(validateRiskPlan(plan, allowed)).toEqual(plan);
    expect(() => validateRiskPlan({ ...plan, version: 1 }, allowed)).toThrow(
      /unsupported risk-plan version/u,
    );
    expect(() => validateRiskPlan({ ...plan, planHash: "b".repeat(64) }, allowed)).toThrow(
      /hash and inputs/u,
    );
    expect(() => validateRiskPlan(plan, new Set())).toThrow(/unknown E2E job/u);
    const focusedFiles = ["test/e2e/live/token-rotation.test.ts"];
    const focusedPlan = buildRiskPlan({
      headSha: HEAD_SHA,
      changedFiles: focusedFiles,
      focusedE2eJobs: focusedE2eJobsForChangedFiles(focusedFiles),
    });
    expect(validateRiskPlan(focusedPlan, new Set(riskPlanRequiredJobIds(focusedPlan)))).toEqual(
      focusedPlan,
    );
    expect(riskPlanRequiredJobIds(focusedPlan)).toEqual([
      "cloud-onboard",
      "credential-sanitization",
      "security-posture",
      "token-rotation",
    ]);
    const targetPlan = buildRiskPlan({ headSha: HEAD_SHA, changedFiles: [DCODE_CHECK] });
    expect(validateRiskPlan(targetPlan, new Set(riskPlanRequiredJobIds(targetPlan)))).toEqual(
      targetPlan,
    );
    expect(riskPlanRequiredTargetIds(targetPlan)).toEqual([DCODE_TARGET]);
    expect(validatePrGateState(gate)).toEqual(gate);
    expect(() => validatePrGateState({ ...gate, prNumber: 0 })).toThrow(/PR number/u);
    expect(() => validatePrGateState({ ...gate, expectedShards: {} })).toThrow(/shard selections/u);
    expect(() => validatePrGateState({ ...gate, expectedTargets: ["unknown-target"] })).toThrow(
      /State targets/u,
    );
  });

  it("paginates canonical pull request files and includes both names for renames", async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      filename: `src/file-${index}.ts`,
      ...(index === 0 ? { previous_filename: "src/old-name.ts" } : {}),
    }));
    const pageTwo = [{ filename: "src/file-100.ts" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter([
        githubFetchRoute(
          ({ url }) => url.endsWith("page=1"),
          () => githubResponse(pageOne),
        ),
        githubFetchRoute(
          ({ url }) => url.endsWith("page=2"),
          () => githubResponse(pageTwo),
        ),
      ]),
    );

    const files = await pullChangedFiles("NVIDIA/NemoClaw", pullRequest(101), "token");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(files).toHaveLength(102);
    expect(files.slice(0, 3)).toEqual(["src/old-name.ts", "src/file-0.ts", "src/file-1.ts"]);
    await expect(pullChangedFiles("NVIDIA/NemoClaw", pullRequest(3001), "token")).rejects.toThrow(
      /between 0 and 3000/u,
    );
  });

  it("fails closed for missing, duplicate, skipped, or failing evidence", () => {
    const gate = state();
    const complete = [...gate.expectedJobs, ...gate.expectedTargets].map((job) =>
      signal(gate, job),
    );
    const classify = (signals: E2eRiskSignal[], workflowConclusion: string | null = "success") =>
      classifyPrGateEvidence({
        workflowConclusion,
        expectedJobs: gate.expectedJobs,
        expectedTargets: gate.expectedTargets,
        expectedShards: gate.expectedShards,
        signals,
      });
    const spoofedOptionalSkip = {
      ...signal(gate, "onboard-repair", "default", { skipped: 1 }),
      optionalSkipped: 1,
    };

    expect(classify(complete).conclusion).toBe("success");
    expect(classify([], "cancelled").conclusion).toBe("failure");
    expect(classify(complete.slice(0, 1)).title).toBe("Evidence is missing");
    expect(classify([...complete, complete[0]!]).title).toBe("Duplicate evidence");
    expect(
      classify([signal(gate, "onboard-repair", "default", { skipped: 1 }), complete[1]!]).title,
    ).toBe("Evidence is incomplete");
    expect(classify([spoofedOptionalSkip, complete[1]!]).title).toBe("Evidence is incomplete");
    expect(
      classify([
        signal(gate, "onboard-repair", "default", { failed: 1, runReason: "failed" }),
        complete[1]!,
      ]).title,
    ).toBe("Tests failed");
  });

  it("binds every signal to the revision, plan, correlation, job, and shard", () => {
    const gate = state();
    const valid = signal(gate, "onboard-repair");
    expect(validateSignal(valid, gate)).toEqual(valid);
    expect(() => validateSignal({ ...valid, testedSha: BASE_SHA }, gate)).toThrow(/tested SHA/u);
    expect(() => validateSignal({ ...valid, planHash: "c".repeat(64) }, gate)).toThrow(
      /plan hash/u,
    );
    expect(() =>
      validateSignal({ ...valid, correlationId: CORRELATION_ID.replace(/.$/u, "d") }, gate),
    ).toThrow(/correlation/u);
    expect(() => validateSignal({ ...valid, jobId: "other" }, gate)).toThrow(/unexpected/u);
  });

  it("dispatches selected jobs and the allowlisted target with exact bound metadata (#7031)", async () => {
    const jobs = ["onboard-repair", "onboard-resume", "full-e2e", "hermes-e2e"];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter([
        githubFetchRoute(
          ({ url }) => url.endsWith("/git/ref/heads/main"),
          () =>
            githubResponse({
              ref: "refs/heads/main",
              object: { type: "commit", sha: WORKFLOW_SHA },
            }),
        ),
        githubFetchRoute(
          ({ url }) => url.endsWith("/actions/workflows/e2e.yaml/dispatches"),
          () =>
            githubResponse({
              workflow_run_id: 23,
              run_url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/23",
              html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
            }),
        ),
      ]),
    );

    await expect(
      dispatchPrGate({
        repository: "NVIDIA/NemoClaw",
        token: "token",
        jobs,
        targets: [DCODE_TARGET],
        prNumber: 42,
        commitSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        planHash: "c".repeat(64),
        correlationId: CORRELATION_ID,
      }),
    ).resolves.toEqual({ runId: 23, workflowSha: WORKFLOW_SHA });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("git/ref/heads/main");
    const request = fetchMock.mock.calls[1]!;
    expect(String(request[0])).toContain("actions/workflows/e2e.yaml/dispatches");
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      ref: "main",
      inputs: {
        jobs: jobs.join(","),
        targets: DCODE_TARGET,
        pr_number: "42",
        checkout_sha: HEAD_SHA,
        base_sha: BASE_SHA,
        workflow_sha: WORKFLOW_SHA,
        plan_hash: "c".repeat(64),
        correlation_id: CORRELATION_ID,
      },
      return_run_details: true,
    });
    expect(() =>
      validateWorkflowDispatchDetails(
        {
          workflow_run_id: 23,
          run_url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/24",
          html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
        },
        "NVIDIA/NemoClaw",
      ),
    ).toThrow(/mismatched workflow dispatch URLs/u);
  });

  it("dispatches from a safe descendant of the triggering workflow commit", async () => {
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/git/ref/heads/main"),
            () =>
              githubResponse({
                ref: "refs/heads/main",
                object: { type: "commit", sha: ADVANCED_WORKFLOW_SHA },
              }),
          ),
          githubFetchRoute(
            ({ url }) => url.includes(`/compare/${WORKFLOW_SHA}...${ADVANCED_WORKFLOW_SHA}`),
            () =>
              githubResponse({
                status: "ahead",
                ahead_by: 1,
                behind_by: 0,
                base_commit: { sha: WORKFLOW_SHA },
                merge_base_commit: { sha: WORKFLOW_SHA },
                head_commit: { sha: ADVANCED_WORKFLOW_SHA },
                files: [{ filename: "docs/quickstart.mdx" }],
              }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/actions/workflows/e2e.yaml/dispatches"),
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
        token: "token",
        jobs: ["onboard-repair"],
        prNumber: 42,
        commitSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        planHash: "c".repeat(64),
        correlationId: CORRELATION_ID,
      }),
    ).resolves.toEqual({ runId: 23, workflowSha: ADVANCED_WORKFLOW_SHA });
    const dispatch = requests.find((request) => request.url.endsWith("/dispatches"));
    expect(dispatch?.body).toMatchObject({
      inputs: { workflow_sha: ADVANCED_WORKFLOW_SHA },
    });
    expect(requests.filter((request) => request.url.endsWith("/git/ref/heads/main"))).toHaveLength(
      2,
    );
  });

  it.each([
    {
      label: "a current control-plane path",
      files: [{ filename: ".github/workflows/e2e.yaml" }],
    },
    {
      label: "a renamed control-plane path",
      files: [
        {
          filename: "docs/pr-gate-controller.mdx",
          previous_filename: "tools/e2e/pr-e2e-gate.mts",
        },
      ],
    },
  ])("refuses a main advance through $label", async ({ files }) => {
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/git/ref/heads/main"),
            () =>
              githubResponse({
                ref: "refs/heads/main",
                object: { type: "commit", sha: ADVANCED_WORKFLOW_SHA },
              }),
          ),
          githubFetchRoute(
            ({ url }) => url.includes(`/compare/${WORKFLOW_SHA}...${ADVANCED_WORKFLOW_SHA}`),
            () =>
              githubResponse({
                status: "ahead",
                ahead_by: 1,
                behind_by: 0,
                base_commit: { sha: WORKFLOW_SHA },
                merge_base_commit: { sha: WORKFLOW_SHA },
                head_commit: { sha: ADVANCED_WORKFLOW_SHA },
                files,
              }),
          ),
        ],
        requests,
      ),
    );

    await expect(
      dispatchPrGate({
        repository: "NVIDIA/NemoClaw",
        token: "token",
        jobs: ["onboard-repair"],
        prNumber: 42,
        commitSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        planHash: "c".repeat(64),
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toThrow(/trusted E2E control-plane changes/u);
    expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
  });

  it.each([
    {
      label: "diverged history",
      comparison: {
        status: "diverged",
        ahead_by: 1,
        behind_by: 1,
        base_commit: { sha: WORKFLOW_SHA },
        merge_base_commit: { sha: WORKFLOW_SHA },
        head_commit: { sha: ADVANCED_WORKFLOW_SHA },
        files: [{ filename: "docs/quickstart.mdx" }],
      },
      error: /not a validated descendant/u,
    },
    {
      label: "a comparison at the 300-file response limit",
      comparison: {
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        base_commit: { sha: WORKFLOW_SHA },
        merge_base_commit: { sha: WORKFLOW_SHA },
        head_commit: { sha: ADVANCED_WORKFLOW_SHA },
        files: Array.from({ length: 300 }, (_, index) => ({
          filename: `docs/generated-${index}.mdx`,
        })),
      },
      error: /too many files to validate completely/u,
    },
  ])("fails closed for $label", async ({ comparison, error }) => {
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/git/ref/heads/main"),
            () =>
              githubResponse({
                ref: "refs/heads/main",
                object: { type: "commit", sha: ADVANCED_WORKFLOW_SHA },
              }),
          ),
          githubFetchRoute(
            ({ url }) => url.includes(`/compare/${WORKFLOW_SHA}...${ADVANCED_WORKFLOW_SHA}`),
            () => githubResponse(comparison),
          ),
        ],
        requests,
      ),
    );

    await expect(
      dispatchPrGate({
        repository: "NVIDIA/NemoClaw",
        token: "token",
        jobs: ["onboard-repair"],
        prNumber: 42,
        commitSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        planHash: "c".repeat(64),
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toThrow(error);
    expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
  });

  it("fails closed when main changes again during compatibility validation", async () => {
    const secondAdvance = "f".repeat(40);
    let mainReads = 0;
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/git/ref/heads/main"),
            () => {
              mainReads += 1;
              return githubResponse({
                ref: "refs/heads/main",
                object: {
                  type: "commit",
                  sha: mainReads === 1 ? ADVANCED_WORKFLOW_SHA : secondAdvance,
                },
              });
            },
          ),
          githubFetchRoute(
            ({ url }) => url.includes(`/compare/${WORKFLOW_SHA}...${ADVANCED_WORKFLOW_SHA}`),
            () =>
              githubResponse({
                status: "ahead",
                ahead_by: 1,
                behind_by: 0,
                base_commit: { sha: WORKFLOW_SHA },
                merge_base_commit: { sha: WORKFLOW_SHA },
                head_commit: { sha: ADVANCED_WORKFLOW_SHA },
                files: [{ filename: "docs/quickstart.mdx" }],
              }),
          ),
        ],
        requests,
      ),
    );

    await expect(
      dispatchPrGate({
        repository: "NVIDIA/NemoClaw",
        token: "token",
        jobs: ["onboard-repair"],
        prNumber: 42,
        commitSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        planHash: "c".repeat(64),
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toThrow(/main changed again/u);
    expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
  });

  it("uses one child title for dispatch correlation and verification", () => {
    const gate = state();
    const child = workflowRun(gate);
    const identity = {
      childRunId: 23,
      correlationId: gate.correlationId,
      prNumber: gate.prNumber,
      repository: "NVIDIA/NemoClaw",
      workflowSha: gate.workflowSha,
    };

    expect(() => assertCorrelatedWorkflowRun(child, identity)).not.toThrow();
    expect(() =>
      assertCorrelatedWorkflowRun({ ...child, display_title: "E2E unrelated" }, identity),
    ).toThrow(/display_title/u);
  });

  it("seeds one idempotent exact-diff gate", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter([pullRequestDetailRoute(), existingPrGateCheckRunsRoute()], requests),
    );

    await expect(seedPrGate(42, HEAD_SHA, BASE_SHA)).resolves.toBe(17);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.method).toBe("GET");
    expect(requests[1]?.url).toContain(`/commits/${HEAD_SHA}/check-runs?`);
  });

  it("closes a stale retarget check before reusing the original base check", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const otherBaseSha = "c".repeat(40);
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          pullRequestDetailRoute(),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () =>
              githubResponse({
                total_count: 2,
                check_runs: [
                  exactPrGateCheck(),
                  exactPrGateCheck({
                    id: 18,
                    external_id: prGateExternalId(42, HEAD_SHA, otherBaseSha),
                  }),
                ],
              }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/18") && method === "PATCH",
            (request) => prGateMutationResponse(request, 18),
          ),
        ],
        requests,
      ),
    );

    await expect(seedPrGate(42, HEAD_SHA, BASE_SHA)).resolves.toBe(17);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toMatchObject({
      method: "PATCH",
      body: {
        status: "completed",
        conclusion: "failure",
        output: { title: "PR base changed" },
      },
    });
    expect(requests.some((request) => request.url.endsWith("/check-runs"))).toBe(false);
  });

  it("rejects a seeded identity claimed by another GitHub App", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter([
        pullRequestDetailRoute(),
        existingPrGateCheckRunsRoute({ app: { id: 999 } }),
      ]),
    );

    await expect(seedPrGate(42, HEAD_SHA, BASE_SHA)).rejects.toThrow(/unexpected GitHub App/u);
  });

  it("rejects an out-of-order seed before mutating the live base check", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          pullRequestDetailRoute({
            ...pullRequest(),
            base: { ...pullRequest().base, sha: "c".repeat(40) },
          }),
        ],
        requests,
      ),
    );

    await expect(seedPrGate(42, HEAD_SHA, BASE_SHA)).rejects.toThrow(/Superseded by PR update/u);
    expect(requests).toHaveLength(1);
    expect(requests.some((request) => request.url.includes("/check-runs"))).toBe(false);
  });

  it("rejects an event PR number that does not match the trusted CI run title", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-pr-identity-"));
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
            (request) => prGateMutationResponse(request),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls?state=open&head="),
            () => githubResponse([pullRequestListItem()]),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(pullRequest()),
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
      await expect(startPrGate(startCommand(workDir, "43"))).rejects.toThrow(
        /CI run identity does not match the triggering workflow run/u,
      );
      expect(requests).toHaveLength(0);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("ignores stale failed-CI evidence before mutating the live base check", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-stale-ci-"));
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
          pullRequestDetailRoute({
            ...pullRequest(),
            base: { ...pullRequest().base, sha: "c".repeat(40) },
          }),
        ],
        requests,
      ),
    );

    try {
      await expect(
        startPrGate({ ...startCommand(workDir), ciConclusion: "failure" }),
      ).resolves.toBeUndefined();
      expect(requests).toHaveLength(2);
      expect(requests.filter((request) => request.url.includes("/check-runs?"))).toHaveLength(1);
      expect(requests.some((request) => request.url.endsWith("/check-runs"))).toBe(false);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("dispatched=false\nfinalized=true\n");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("closes a superseded exact-diff check without failing the controller", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-superseded-"));
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
          pullRequestDetailRoute({
            ...pullRequest(),
            head: { ...pullRequest().head, sha: "c".repeat(40) },
          }),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            (request) => prGateMutationResponse(request),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(startPrGate(startCommand(workDir))).resolves.toBeUndefined();
      expect(requests).toHaveLength(3);
      expect(requests.some((request) => request.url.endsWith("/check-runs"))).toBe(false);
      const completion = requests.find((request) => request.method === "PATCH");
      expect(completion?.body).toMatchObject({
        status: "completed",
        conclusion: "cancelled",
        output: {
          title: "Superseded by PR update",
          summary: expect.stringContaining(
            "moved from head `aaaaaaa` on base `bbbbbbb` to head `ccccccc` on base `bbbbbbb`",
          ),
        },
      });
      expect(fs.readFileSync(outputPath, "utf8")).toBe(
        "check_id=17\ndispatched=false\nfinalized=true\n",
      );
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("does not reopen a completed check when a superseded CI event arrives", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-completed-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          existingPrGateCheckRunsRoute({ status: "completed", conclusion: "success" }),
          pullRequestDetailRoute({
            ...pullRequest(),
            head: { ...pullRequest().head, sha: "c".repeat(40) },
          }),
        ],
        requests,
      ),
    );

    try {
      await expect(startPrGate(startCommand(workDir))).resolves.toBeUndefined();
      expect(requests).toHaveLength(2);
      expect(requests.some((request) => request.url.endsWith("/check-runs"))).toBe(false);
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("dispatched=false\nfinalized=true\n");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("links the pull request and failed CI jobs when prerequisite CI blocks E2E", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-ci-failure-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          pullRequestDetailRoute(),
          emptyPrGateCheckRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
            (request) => prGateMutationResponse(request),
          ),
          githubFetchRoute(
            ({ url }) =>
              url.includes(`/actions/runs/${CI_RUN_ID}/attempts/${CI_RUN_ATTEMPT}/jobs?`) &&
              new URL(url).searchParams.get("page") === "1",
            () =>
              githubResponse({
                total_count: 101,
                jobs: [
                  {
                    id: 101,
                    name: "cli-test-shards (6)",
                    conclusion: "failure",
                    steps: [{ name: "Run CLI coverage shard", conclusion: "failure" }],
                  },
                  {
                    id: 102,
                    name: "cli-tests",
                    conclusion: "failure",
                    steps: [{ name: "Verify CLI shards completed", conclusion: "failure" }],
                  },
                  {
                    id: 103,
                    name: "static-checks",
                    conclusion: "success",
                    steps: [{ name: "Run checks", conclusion: "success" }],
                  },
                  {
                    id: 104,
                    name: "unsafe]\n::error::<tag>&",
                    conclusion: "failure",
                    steps: [{ name: "bad` step\n::warning::", conclusion: "failure" }],
                  },
                  ...Array.from({ length: 96 }, (_, index) => ({
                    id: 200 + index,
                    name: `passing-job-${index}`,
                    conclusion: "success",
                    steps: [],
                  })),
                ],
              }),
          ),
          githubFetchRoute(
            ({ url }) =>
              url.includes(`/actions/runs/${CI_RUN_ID}/attempts/${CI_RUN_ATTEMPT}/jobs?`) &&
              new URL(url).searchParams.get("page") === "2",
            () =>
              githubResponse({
                total_count: 101,
                jobs: [
                  {
                    id: 105,
                    name: "late-failure",
                    conclusion: "failure",
                    steps: [{ name: "Run late check", conclusion: "failure" }],
                  },
                ],
              }),
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
      await expect(
        startPrGate({ ...startCommand(workDir), ciConclusion: "failure" }),
      ).resolves.toBeUndefined();

      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      expect(requests.filter((request) => request.url.endsWith("/pulls/42"))).toHaveLength(1);
      expect(requests.some((request) => request.url.includes("/pulls?"))).toBe(false);
      const finalUpdate = requests
        .filter((request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH")
        .at(-1);
      expect(finalUpdate?.body).toMatchObject({
        status: "completed",
        conclusion: "failure",
        details_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${CI_RUN_ID}/attempts/${CI_RUN_ATTEMPT}`,
        output: {
          title: "PR #42 CI did not pass",
        },
      });
      const summary = (finalUpdate?.body as { output?: { summary?: string } } | undefined)?.output
        ?.summary;
      expect(summary).toContain("[PR #42](https://github.com/NVIDIA/NemoClaw/pull/42)");
      expect(summary).toContain(
        `[CI / Pull Request attempt ${CI_RUN_ATTEMPT}](https://github.com/NVIDIA/NemoClaw/actions/runs/${CI_RUN_ID}/attempts/${CI_RUN_ATTEMPT})`,
      );
      expect(summary).toContain(
        `[cli-test-shards (6)](https://github.com/NVIDIA/NemoClaw/actions/runs/${CI_RUN_ID}/job/101)`,
      );
      expect(summary).toContain("failed step: `Run CLI coverage shard`");
      expect(summary).toContain(
        `[cli-tests](https://github.com/NVIDIA/NemoClaw/actions/runs/${CI_RUN_ID}/job/102)`,
      );
      expect(summary).toContain("<!-- nemoclaw-pr-e2e-retry:v1:prerequisite-ci -->");
      expect(summary).toContain(
        `[unsafe\\] ::error::&lt;tag&gt;&amp;](https://github.com/NVIDIA/NemoClaw/actions/runs/${CI_RUN_ID}/job/104)`,
      );
      expect(summary).toContain(
        `[late-failure](https://github.com/NVIDIA/NemoClaw/actions/runs/${CI_RUN_ID}/job/105)`,
      );
      expect(summary).toContain("failed step: `bad' step ::warning::`");
      expect(summary).not.toContain("\n::error::");
      expect(summary).not.toContain("\n::warning::");
      expect(summary).not.toContain("static-checks");
      expect(summary).not.toContain("The job listing was truncated");
      expect(
        requests.filter((request) =>
          request.url.includes(`/actions/runs/${CI_RUN_ID}/attempts/${CI_RUN_ATTEMPT}/jobs?`),
        ),
      ).toHaveLength(2);
      const outputs = fs.readFileSync(outputPath, "utf8");
      expect(outputs).toContain("dispatched=false");
      expect(outputs).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("preserves the known CI failure when job details cannot be loaded", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-ci-fallback-"));
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
            ({ url }) => url.includes("/pulls?state=open&head="),
            () => githubResponse([pullRequestListItem()]),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(pullRequest()),
          ),
          emptyPrGateCheckRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
            (request) => prGateMutationResponse(request),
          ),
          githubFetchRoute(
            ({ url }) =>
              url.includes(`/actions/runs/${CI_RUN_ID}/attempts/${CI_RUN_ATTEMPT}/jobs?`),
            () => githubResponse({ message: "temporary failure" }, 503),
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
      await expect(
        startPrGate({
          ...startCommand(workDir),
          ciConclusion: "failure",
          prNumber: undefined,
        }),
      ).resolves.toBeUndefined();

      expect(requests.filter((request) => request.url.endsWith("/pulls/42"))).toHaveLength(1);
      expect(requests.some((request) => request.url.includes("/pulls?"))).toBe(false);
      const finalUpdate = requests
        .filter((request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH")
        .at(-1);
      expect(finalUpdate?.body).toMatchObject({
        status: "completed",
        conclusion: "failure",
        details_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${CI_RUN_ID}/attempts/${CI_RUN_ATTEMPT}`,
        output: {
          title: "PR #42 CI did not pass",
          summary: expect.stringContaining("Job details could not be loaded"),
        },
      });
      const summary = (finalUpdate?.body as { output?: { summary?: string } } | undefined)?.output
        ?.summary;
      expect(summary).toContain("[PR #42](https://github.com/NVIDIA/NemoClaw/pull/42)");
      const outputs = fs.readFileSync(outputPath, "utf8");
      expect(outputs).toContain("dispatched=false");
      expect(outputs).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("automatically dispatches controller-only changes through the normal evidence path", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-controller-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const controllerFiles = [".github/workflows/pr-e2e-gate.yaml", "tools/e2e/pr-e2e-gate.mts"];
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          existingPrGateCheckRunsRoute(),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls?state=open&head="),
            () => githubResponse([pullRequestListItem(pullRequest(controllerFiles.length))]),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse(controllerFiles.map((filename) => ({ filename }))),
          ),
          pullRequestDetailRoute(pullRequest(controllerFiles.length)),
          githubFetchRoute(
            ({ url }) => url.endsWith("/git/ref/heads/main"),
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
              githubResponse({
                workflow_run_id: 23,
                run_url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/23",
                html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
              }),
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
      await startPrGate(startCommand(workDir));

      const dispatch = requests.find((request) => request.url.endsWith("/dispatches"));
      expect(dispatch?.body).toMatchObject({
        inputs: {
          jobs: "cloud-onboard,credential-sanitization,security-posture",
          checkout_sha: HEAD_SHA,
          base_sha: BASE_SHA,
        },
      });
      const outputs = fs.readFileSync(outputPath, "utf8");
      expect(outputs).toContain("dispatched=true");
      expect(outputs).not.toContain("fork_skip_mode=");
      expect(outputs).not.toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("completes the check when all evidence passes", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-lifecycle-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    let gate: PrGateState | undefined;
    let checkListCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => {
              checkListCalls += 1;
              return checkListCalls <= 2
                ? githubResponse({ total_count: 0, check_runs: [] })
                : githubResponse({ total_count: 1, check_runs: [exactPrGateCheck()] });
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
            (request) => prGateMutationResponse(request),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls?state=open&head="),
            () => githubResponse([pullRequestListItem(pullRequest(BROAD_FILES.length))]),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse(BROAD_FILES.map((filename) => ({ filename }))),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(pullRequest(BROAD_FILES.length)),
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
            ({ url }) => url.endsWith("/actions/workflows/e2e.yaml/dispatches"),
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
              expect(gate).toBeDefined();
              return githubResponse(workflowRun(gate!));
            },
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
      const command = startCommand(workDir);
      await startPrGate(command);
      gate = validatePrGateState(JSON.parse(fs.readFileSync(command.statePath, "utf8")));
      for (const job of [...gate.expectedJobs, ...gate.expectedTargets]) {
        for (const shard of gate.expectedShards[job]!) {
          const directory = path.join(command.evidencePath, `${job}-${shard}`);
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(
            path.join(directory, "risk-signal.json"),
            `${JSON.stringify(signal(gate, job, shard))}\n`,
          );
        }
      }
      const outputs = Object.fromEntries(
        fs
          .readFileSync(outputPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=", 2)),
      );
      await finishPrGate({
        statePath: command.statePath,
        stateHash: outputs.state_hash!,
        evidencePath: command.evidencePath,
        checkRunId: Number(outputs.check_id),
        childRunId: Number(outputs.run_id),
        evidenceOutcome: "success",
      });

      expect(gate.expectedJobs).toEqual(BROAD_JOBS);
      expect(gate.expectedTargets).toEqual([]);
      expect(requests.filter((request) => request.url.includes("/pulls?"))).toHaveLength(1);
      // Finalization brackets evidence parsing with exact-diff reads so a PR update cannot
      // turn stale evidence into a current-revision result.
      expect(requests.filter((request) => request.url.endsWith("/pulls/42"))).toHaveLength(4);
      const checkCreation = requests.find(
        (request) => request.url.endsWith("/check-runs") && request.method === "POST",
      );
      expect(checkCreation?.body).toMatchObject({
        name: "E2E / PR Gate Coordination",
        head_sha: HEAD_SHA,
        external_id: prGateExternalId(42, HEAD_SHA, BASE_SHA),
        status: "in_progress",
        output: {
          title: "Waiting for PR CI",
          summary: expect.stringContaining("exact PR head and base revision"),
        },
      });
      const dispatch = requests.find((request) => request.url.endsWith("/dispatches"));
      expect(dispatch?.body).toMatchObject({
        inputs: {
          jobs: BROAD_JOBS.join(","),
          targets: "",
          pr_number: "42",
          checkout_sha: HEAD_SHA,
          base_sha: BASE_SHA,
          plan_hash: gate.planHash,
          correlation_id: gate.correlationId,
        },
      });
      const checkUpdates = requests.filter(
        (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
      );
      expect(checkUpdates).toHaveLength(3);
      expect(checkUpdates[0]?.body).toMatchObject({
        status: "in_progress",
        output: {
          title: "Evaluating PR commit",
          summary: expect.stringContaining("deterministic E2E jobs"),
        },
      });
      expect(checkUpdates[1]?.body).toMatchObject({
        status: "in_progress",
        output: {
          title: "Running 13 E2E checks",
          summary: expect.stringContaining("upgrade-stale-sandbox"),
        },
      });
      expect(checkUpdates[2]?.body).toMatchObject({
        status: "completed",
        conclusion: "success",
        output: {
          title: "All selected E2E checks passed",
          summary: "Every expected E2E check shard passed with no skips or pending tests.",
        },
      });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("fails without dispatch when the pull request changes during planning", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-race-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    let detailCalls = 0;
    const updatedPull = {
      ...pullRequest(),
      base: { ...pullRequest().base, sha: "c".repeat(40) },
    };
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
            () => githubResponse([pullRequestListItem(updatedPull)]),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "src/lib/onboard.ts" }]),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => {
              detailCalls += 1;
              return githubResponse(detailCalls === 1 ? pullRequest() : updatedPull);
            },
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
      await expect(startPrGate(startCommand(workDir))).rejects.toThrow(
        /PR changed during preparation/u,
      );
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      expect(requests.some((request) => request.url.endsWith("/git/ref/heads/main"))).toBe(false);
      const finalUpdate = requests
        .filter((request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH")
        .at(-1);
      expect(finalUpdate?.body).toMatchObject({ status: "completed", conclusion: "failure" });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

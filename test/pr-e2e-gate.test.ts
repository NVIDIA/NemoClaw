// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRiskPlan, riskPlanRequiredJobIds } from "../tools/advisors/risk-plan.mts";
import {
  abandonPrGate,
  assertCorrelatedWorkflowRun,
  cancelPrGate,
  classifyPrGateEvidence,
  controllerErrorAnnotationTitle,
  dispatchPrGate,
  expectedSignalShards,
  findSignalFiles,
  finishPrGate,
  PrerequisiteCiError,
  type PrGateState,
  type PullRequest,
  parseControllerCommand,
  pullChangedFiles,
  startPrGate,
  validatePrGateState,
  validateRiskPlan,
  validateSignal,
  validateWorkflowDispatchDetails,
} from "../tools/e2e/pr-e2e-gate.mts";
import type { E2eRiskSignal } from "../tools/e2e/risk-signal.ts";
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
const CORRELATION_ID = "12345678-1234-4123-8123-123456789abc";
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

function pullRequestListItem(pull = pullRequest()): Omit<PullRequest, "changed_files"> {
  const { changed_files: _changedFiles, ...item } = pull;
  return item;
}

function state(): PrGateState {
  const plan = buildRiskPlan({ headSha: HEAD_SHA, changedFiles: ["src/lib/onboard.ts"] });
  return {
    version: 1,
    commitSha: HEAD_SHA,
    workflowSha: WORKFLOW_SHA,
    planHash: plan.planHash,
    correlationId: CORRELATION_ID,
    prNumber: 42,
    expectedJobs: ["onboard-repair", "onboard-resume"],
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
    "--ci-run-attempt",
    String(CI_RUN_ATTEMPT),
    "--ci-run-id",
    String(CI_RUN_ID),
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
  it("parses one lifecycle command set inside a private workspace", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-"));
    try {
      expect(
        parseControllerCommand([
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
          "--ci-run-attempt",
          String(CI_RUN_ATTEMPT),
          "--ci-run-id",
          String(CI_RUN_ID),
          "--pr",
          "42",
          "--work-dir",
          workDir,
        ]),
      ).toMatchObject({
        mode: "start",
        ciRunAttempt: CI_RUN_ATTEMPT,
        ciRunId: CI_RUN_ID,
        prNumber: 42,
        planPath: path.join(workDir, "risk-plan.json"),
        statePath: path.join(workDir, "controller-state.json"),
        evidencePath: path.join(workDir, "evidence"),
      });
      expect(parseControllerCommand(["--mode", "cancel", "--pr", "42"])).toEqual({
        mode: "cancel",
        prNumber: 42,
      });
      expect(
        parseControllerCommand(["--mode", "abandon", "--check-id", "17", "--run-id", "23"]),
      ).toEqual({ mode: "abandon", checkRunId: 17, childRunId: 23 });
      expect(() =>
        parseControllerCommand(["--mode", "cancel", "--pr", "9007199254740992"]),
      ).toThrow(/safe integer range/u);
      expect(startCommand(workDir, "").prNumber).toBeUndefined();

      fs.chmodSync(workDir, 0o755);
      expect(() => parseControllerCommand(["--mode", "finish", "--work-dir", workDir])).toThrow(
        /owned private absolute directory/u,
      );
    } finally {
      fs.chmodSync(workDir, 0o700);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("distinguishes prerequisite CI failures from controller failures in annotations", () => {
    expect(controllerErrorAnnotationTitle(new PrerequisiteCiError("CI failed"))).toBe(
      "PR CI did not pass",
    );
    expect(controllerErrorAnnotationTitle(new Error("controller failed"))).toBe(
      "Controller failed",
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
    expect(validatePrGateState(gate)).toEqual(gate);
    expect(() => validatePrGateState({ ...gate, prNumber: 0 })).toThrow(/PR number/u);
    expect(() => validatePrGateState({ ...gate, expectedShards: {} })).toThrow(/shard jobs/u);
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
    const complete = gate.expectedJobs.map((job) => signal(gate, job));
    const classify = (signals: E2eRiskSignal[], workflowConclusion: string | null = "success") =>
      classifyPrGateEvidence({
        workflowConclusion,
        expectedJobs: gate.expectedJobs,
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

  it("derives shard policy from the checked-in workflow", () => {
    expect(expectedSignalShards(["onboard-repair", "onboard-resume"])).toEqual({
      "onboard-repair": ["default"],
      "onboard-resume": ["default"],
    });
    expect(expectedSignalShards(["docs-validation"])).toEqual({
      "docs-validation": ["default"],
    });
    const broadPlan = buildRiskPlan({ headSha: HEAD_SHA, changedFiles: BROAD_FILES });
    const broadShards = expectedSignalShards(riskPlanRequiredJobIds(broadPlan));
    expect(Object.keys(broadShards)).toHaveLength(13);
    expect(Object.values(broadShards).flat()).toHaveLength(15);
    expect(() => expectedSignalShards(["not-a-workflow-job"])).toThrow(/does not define/u);
  });

  it("dispatches every selected job through the five-field child protocol", async () => {
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
        prNumber: 42,
        commitSha: HEAD_SHA,
        workflowSha: WORKFLOW_SHA,
        planHash: "c".repeat(64),
        correlationId: CORRELATION_ID,
      }),
    ).resolves.toBe(23);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("git/ref/heads/main");
    const request = fetchMock.mock.calls[1]!;
    expect(String(request[0])).toContain("actions/workflows/e2e.yaml/dispatches");
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      ref: "main",
      inputs: {
        jobs: jobs.join(","),
        pr_number: "42",
        checkout_sha: HEAD_SHA,
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

  it("refuses dispatch after main advances", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      githubResponse({
        ref: "refs/heads/main",
        object: { type: "commit", sha: BASE_SHA },
      }),
    );

    await expect(
      dispatchPrGate({
        repository: "NVIDIA/NemoClaw",
        token: "token",
        jobs: ["onboard-repair"],
        prNumber: 42,
        commitSha: HEAD_SHA,
        workflowSha: WORKFLOW_SHA,
        planHash: "c".repeat(64),
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toThrow(/main no longer points/u);
    expect(fetchMock).toHaveBeenCalledOnce();
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

  it("rejects fork branches before making API requests", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-fork-"));
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    try {
      await expect(
        startPrGate({ ...startCommand(workDir), headRepository: "contributor/NemoClaw" }),
      ).rejects.toThrow(/PR branch must be in the base repository/u);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects a pull request that does not match the triggering workflow run", async () => {
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
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
            () => githubResponse({ id: 17 }),
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
            () => githubResponse({}),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(startPrGate(startCommand(workDir, "43"))).rejects.toThrow(
        /PR identity does not match the triggering workflow run/u,
      );
      expect(requests.some((request) => request.url.includes("/files?"))).toBe(false);
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      const finalUpdate = requests.find(
        (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
      );
      expect(finalUpdate?.body).toMatchObject({ status: "completed", conclusion: "failure" });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
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
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
            () => githubResponse({ id: 17 }),
          ),
          githubFetchRoute(
            ({ url }) =>
              url.includes(`/actions/runs/${CI_RUN_ID}/attempts/${CI_RUN_ATTEMPT}/jobs?`),
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
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            () => githubResponse({}),
          ),
        ],
        requests,
      ),
    );

    try {
      let rejection: unknown;
      try {
        await startPrGate({ ...startCommand(workDir), ciConclusion: "failure" });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(PrerequisiteCiError);
      const rejectionMessage = (rejection as Error).message;
      expect(rejectionMessage).toContain("PR #42: https://github.com/NVIDIA/NemoClaw/pull/42");
      expect(rejectionMessage).toContain(
        `CI run attempt ${CI_RUN_ATTEMPT}: https://github.com/NVIDIA/NemoClaw/actions/runs/${CI_RUN_ID}/attempts/${CI_RUN_ATTEMPT}`,
      );
      expect(rejectionMessage).toContain("cli-test-shards (6) (Run CLI coverage shard)");
      expect(rejectionMessage).toContain("job listing truncated");

      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      expect(requests.some((request) => request.url.includes("/pulls"))).toBe(false);
      const finalUpdate = requests.find(
        (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
      );
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
      expect(summary).toContain(
        `[unsafe\\] ::error::&lt;tag&gt;&amp;](https://github.com/NVIDIA/NemoClaw/actions/runs/${CI_RUN_ID}/job/104)`,
      );
      expect(summary).toContain("failed step: `bad' step ::warning::`");
      expect(summary).not.toContain("\n::error::");
      expect(summary).not.toContain("\n::warning::");
      expect(summary).not.toContain("static-checks");
      expect(summary).toContain("The job listing was truncated");
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
            ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
            () => githubResponse({ id: 17 }),
          ),
          githubFetchRoute(
            ({ url }) =>
              url.includes(`/actions/runs/${CI_RUN_ID}/attempts/${CI_RUN_ATTEMPT}/jobs?`),
            () => githubResponse({ message: "temporary failure" }, 503),
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
        startPrGate({
          ...startCommand(workDir),
          ciConclusion: "failure",
          prNumber: undefined,
        }),
      ).rejects.toThrow(
        new RegExp(
          `CI run attempt ${CI_RUN_ATTEMPT}: https://github\\.com/NVIDIA/NemoClaw/actions/runs/${CI_RUN_ID}/attempts/${CI_RUN_ATTEMPT}`,
          "u",
        ),
      );

      expect(requests.some((request) => request.url.includes("/pulls"))).toBe(false);
      const finalUpdate = requests.find(
        (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
      );
      expect(finalUpdate?.body).toMatchObject({
        status: "completed",
        conclusion: "failure",
        details_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${CI_RUN_ID}/attempts/${CI_RUN_ATTEMPT}`,
        output: {
          title: "PR CI did not pass",
          summary: expect.stringContaining("Job details could not be loaded"),
        },
      });
      const summary = (finalUpdate?.body as { output?: { summary?: string } } | undefined)?.output
        ?.summary;
      expect(summary).toContain("The triggering PR was not present in the workflow event");
      expect(summary).not.toContain("/pull/");
      const outputs = fs.readFileSync(outputPath, "utf8");
      expect(outputs).toContain("dispatched=false");
      expect(outputs).toContain("finalized=true");
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
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
            () => githubResponse({ id: 17 }),
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
            () => githubResponse({}),
          ),
        ],
        requests,
      ),
    );

    try {
      const command = startCommand(workDir);
      await startPrGate(command);
      gate = validatePrGateState(JSON.parse(fs.readFileSync(command.statePath, "utf8")));
      for (const job of gate.expectedJobs) {
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
      });

      expect(gate.expectedJobs).toEqual(BROAD_JOBS);
      expect(requests.filter((request) => request.url.includes("/pulls?"))).toHaveLength(2);
      expect(requests.filter((request) => request.url.endsWith("/pulls/42"))).toHaveLength(2);
      const checkCreation = requests.find(
        (request) => request.url.endsWith("/check-runs") && request.method === "POST",
      );
      expect(checkCreation?.body).toMatchObject({
        name: "E2E / PR Gate",
        head_sha: HEAD_SHA,
        status: "in_progress",
        output: {
          title: "Evaluating PR commit",
          summary: "Validating the PR and selecting E2E jobs.",
        },
      });
      const dispatch = requests.find((request) => request.url.endsWith("/dispatches"));
      expect(dispatch?.body).toMatchObject({
        inputs: {
          jobs: BROAD_JOBS.join(","),
          pr_number: "42",
          checkout_sha: HEAD_SHA,
          plan_hash: gate.planHash,
          correlation_id: gate.correlationId,
        },
      });
      const checkUpdates = requests.filter(
        (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
      );
      expect(checkUpdates).toHaveLength(2);
      expect(checkUpdates[0]?.body).toMatchObject({
        status: "in_progress",
        output: {
          title: "Running 13 E2E jobs",
          summary: expect.stringContaining("upgrade-stale-sandbox"),
        },
      });
      expect(checkUpdates[1]?.body).toMatchObject({
        status: "completed",
        conclusion: "success",
        output: {
          title: "All selected jobs passed",
          summary: "Every expected job shard passed with no skips or pending tests.",
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
    let listCalls = 0;
    let detailCalls = 0;
    const updatedPull = {
      ...pullRequest(),
      base: { ...pullRequest().base, sha: "c".repeat(40) },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
            () => githubResponse({ id: 17 }),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls?state=open&head="),
            () => {
              listCalls += 1;
              return githubResponse([
                pullRequestListItem(listCalls === 1 ? pullRequest() : updatedPull),
              ]);
            },
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
            () => githubResponse({}),
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
      const finalUpdate = requests.find(
        (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
      );
      expect(finalUpdate?.body).toMatchObject({ status: "completed", conclusion: "failure" });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("cancels the child and closes the check when startup fails after dispatch", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-start-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    let checkPatches = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
            () => githubResponse({ id: 17 }),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls?state=open&head="),
            () => githubResponse([pullRequestListItem()]),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "src/lib/onboard.ts" }]),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(pullRequest()),
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
            ({ url, method }) => url.endsWith("/actions/runs/23/cancel") && method === "POST",
            () => githubResponse(undefined, 202),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            () => {
              checkPatches += 1;
              return checkPatches === 1
                ? githubResponse({ message: "simulated update failure" }, 500)
                : githubResponse({});
            },
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(startPrGate(startCommand(workDir))).rejects.toThrow(/simulated update failure/u);
      expect(requests.some((request) => request.url.endsWith("/actions/runs/23/cancel"))).toBe(
        true,
      );
      const checkUpdates = requests.filter((request) => request.url.endsWith("/check-runs/17"));
      expect(checkUpdates).toHaveLength(2);
      expect(checkUpdates[1]?.body).toMatchObject({
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Run could not start",
          summary: expect.stringContaining("The controller could not complete the check."),
        },
      });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "missing evidence",
      status: "completed",
      expectCancellation: false,
      expectedTitle: "Evidence is missing",
      expectedError: /Missing signals: onboard-repair:default, onboard-resume:default/u,
    },
    {
      label: "an unfinished child",
      status: "in_progress",
      expectCancellation: true,
      expectedTitle: "E2E run did not succeed",
      expectedError: /The run concluded unfinished \(in_progress\)/u,
    },
  ])("closes the check as failure for $label", async ({
    status,
    expectCancellation,
    expectedTitle,
    expectedError,
  }) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-finish-"));
    const outputPath = path.join(workDir, "github-output");
    const statePath = path.join(workDir, "controller-state.json");
    const evidencePath = path.join(workDir, "evidence");
    const gate = state();
    const serializedState = `${JSON.stringify(gate, null, 2)}\n`;
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    fs.writeFileSync(statePath, serializedState, { mode: 0o600 });
    fs.mkdirSync(evidencePath);
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => githubResponse(workflowRun(gate, { status, conclusion: "success" })),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23/cancel") && method === "POST",
            () => githubResponse(undefined, 202),
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
        finishPrGate({
          statePath,
          stateHash: sha256(serializedState),
          evidencePath,
          checkRunId: 17,
          childRunId: 23,
        }),
      ).rejects.toThrow(expectedError);
      expect(requests.some((request) => request.url.endsWith("/actions/runs/23/cancel"))).toBe(
        expectCancellation,
      );
      const completion = requests.find((request) => request.url.endsWith("/check-runs/17"));
      expect(completion?.body).toMatchObject({
        status: "completed",
        conclusion: "failure",
        output: { title: expectedTitle },
      });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("queries active statuses without traversing completed run history", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const gate = state();
    const requests: RecordedGitHubRequest[] = [];
    const fullCompletedPage = Array.from({ length: 100 }, (_, index) =>
      workflowRun(gate, { id: 1_000 + index }),
    );
    const fullUnrelatedQueuedPage = Array.from({ length: 100 }, (_, index) =>
      workflowRun(
        { ...gate, prNumber: 420 },
        { id: 2_000 + index, status: "queued", conclusion: null },
      ),
    );
    const runsByQuery = new Map([
      ["missing:1", fullCompletedPage],
      ["queued:1", fullUnrelatedQueuedPage],
      [
        "queued:2",
        [
          workflowRun(gate, { status: "queued", conclusion: null }),
          workflowRun(gate, { id: 24, status: "completed" }),
          workflowRun(gate, {
            id: 25,
            status: "queued",
            conclusion: null,
            display_title: "E2E manual",
          }),
          workflowRun({ ...gate, prNumber: 420 }, { id: 26, status: "queued", conclusion: null }),
        ],
      ],
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.includes("/actions/workflows/e2e.yaml/runs?"),
            ({ url }) => {
              const query = new URL(url);
              const status = query.searchParams.get("status");
              const page = query.searchParams.get("page");
              return githubResponse({
                workflow_runs: runsByQuery.get(`${status ?? "missing"}:${page}`) ?? [],
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

    await expect(cancelPrGate(42)).resolves.toBe(1);
    const listQueries = requests
      .filter((request) => request.url.includes("/actions/workflows/e2e.yaml/runs?"))
      .map((request) => {
        const query = new URL(request.url);
        return `${query.searchParams.get("status")}:${query.searchParams.get("page")}`;
      });
    expect(listQueries).toEqual([
      "requested:1",
      "waiting:1",
      "pending:1",
      "queued:1",
      "queued:2",
      "in_progress:1",
    ]);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/cancel")),
    ).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/26/cancel"))).toBe(
      false,
    );
  });

  it("cancels a run once as it advances between active-status responses", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const gate = state();
    const runsByStatus = new Map([
      ["requested", [workflowRun(gate, { status: "queued", conclusion: null })]],
      ["queued", [workflowRun(gate, { status: "in_progress", conclusion: null })]],
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter([
        githubFetchRoute(
          ({ url }) => url.includes("/actions/workflows/e2e.yaml/runs?"),
          ({ url }) =>
            githubResponse({
              workflow_runs: runsByStatus.get(new URL(url).searchParams.get("status") ?? "") ?? [],
            }),
        ),
        githubFetchRoute(
          ({ url, method }) => url.endsWith("/actions/runs/23/cancel") && method === "POST",
          () => githubResponse(undefined, 202),
        ),
      ]),
    );

    await expect(cancelPrGate(42)).resolves.toBe(1);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/actions/runs/23/cancel")),
    ).toHaveLength(1);
  });

  it("fails before cancellation when an active-status search reaches its result limit", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const gate = state();
    const requests: RecordedGitHubRequest[] = [];
    const fullActivePage = Array.from({ length: 100 }, (_, index) =>
      workflowRun(gate, { id: 3_000 + index, status: "in_progress", conclusion: null }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.includes("/actions/workflows/e2e.yaml/runs?"),
            ({ url }) =>
              githubResponse({
                workflow_runs:
                  new URL(url).searchParams.get("status") === "in_progress" ? fullActivePage : [],
              }),
          ),
        ],
        requests,
      ),
    );

    await expect(cancelPrGate(42)).rejects.toThrow(
      "in_progress run listing exceeded its page limit",
    );
    expect(requests.some((request) => request.url.endsWith("/cancel"))).toBe(false);
  });

  it("cancels a known child and closes an abandoned check as failure", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-abandon-"));
    const outputPath = path.join(directory, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23/cancel") && method === "POST",
            () => githubResponse(undefined, 202),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            () => githubResponse(undefined),
          ),
        ],
        requests,
      ),
    );

    try {
      await abandonPrGate(17, 23);
      expect(requests.map((request) => request.url)).toEqual([
        "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/23/cancel",
        "https://api.github.com/repos/NVIDIA/NemoClaw/check-runs/17",
      ]);
      expect(requests[1]?.body).toMatchObject({
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Controller stopped early",
          summary: "The controller stopped before it could complete the check.",
        },
      });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds recursive signal discovery and rejects symlinks", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-evidence-"));
    try {
      const first = path.join(directory, "first");
      fs.mkdirSync(first);
      fs.writeFileSync(path.join(first, "risk-signal.json"), "{}\n");
      expect(findSignalFiles(directory, { maxDepth: 2, maxEntries: 3, maxSignalFiles: 1 })).toEqual(
        [path.join(first, "risk-signal.json")],
      );

      const second = path.join(directory, "second");
      fs.mkdirSync(second);
      fs.writeFileSync(path.join(second, "risk-signal.json"), "{}\n");
      expect(() =>
        findSignalFiles(directory, { maxDepth: 2, maxEntries: 8, maxSignalFiles: 1 }),
      ).toThrow(/signal-file limit/u);

      fs.rmSync(second, { recursive: true });
      fs.symlinkSync(first, path.join(directory, "linked"));
      expect(() =>
        findSignalFiles(directory, { maxDepth: 2, maxEntries: 8, maxSignalFiles: 2 }),
      ).toThrow(/symlinks/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

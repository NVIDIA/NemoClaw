// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRiskPlan, riskPlanRequiredJobIds } from "../tools/advisors/risk-plan.mts";
import {
  abandonRequiredLive,
  assertCorrelatedWorkflowRun,
  cancelRequiredLive,
  classifyRequiredLiveEvidence,
  dispatchRequiredLive,
  expectedSignalShards,
  findSignalFiles,
  finishRequiredLive,
  type PullRequest,
  parseControllerCommand,
  pullChangedFiles,
  type RequiredLiveState,
  startRequiredLive,
  validateRequiredLiveState,
  validateRiskPlan,
  validateSignal,
  validateWorkflowDispatchDetails,
} from "../tools/e2e/required-live.mts";
import type { E2eRiskSignal } from "../tools/e2e/risk-signal.ts";
import {
  createGitHubFetchRouter,
  githubFetchRoute,
  type RecordedGitHubRequest,
} from "./support/github-fetch-router.ts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "d".repeat(40);
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
      ref: "feature/required-live",
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

function state(): RequiredLiveState {
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

function startCommand(workDir: string) {
  const command = parseControllerCommand([
    "--mode",
    "start",
    "--head",
    HEAD_SHA,
    "--head-repo",
    "NVIDIA/NemoClaw",
    "--head-branch",
    "feature/required-live",
    "--workflow-sha",
    WORKFLOW_SHA,
    "--ci-conclusion",
    "success",
    "--work-dir",
    workDir,
  ]);
  expect(command.mode).toBe("start");
  return command as Extract<ReturnType<typeof parseControllerCommand>, { mode: "start" }>;
}

function signal(
  gate: RequiredLiveState,
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

function workflowRun(gate: RequiredLiveState, overrides: Record<string, unknown> = {}) {
  return {
    id: 23,
    name: "E2E",
    path: ".github/workflows/e2e.yaml",
    workflow_id: 304268429,
    event: "workflow_dispatch",
    head_sha: gate.workflowSha,
    status: "completed",
    conclusion: "success",
    display_title: `E2E PR #${gate.prNumber} required live ${gate.correlationId}`,
    html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
    ...overrides,
  };
}

describe("required live E2E controller", () => {
  it("parses one lifecycle command set inside a private workspace", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-required-live-"));
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
          "feature/required-live",
          "--workflow-sha",
          WORKFLOW_SHA,
          "--ci-conclusion",
          "success",
          "--work-dir",
          workDir,
        ]),
      ).toMatchObject({
        mode: "start",
        planPath: path.join(workDir, "required-live-plan.json"),
        statePath: path.join(workDir, "required-live-state.json"),
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

      fs.chmodSync(workDir, 0o755);
      expect(() => parseControllerCommand(["--mode", "finish", "--work-dir", workDir])).toThrow(
        /owned private absolute directory/u,
      );
    } finally {
      fs.chmodSync(workDir, 0o700);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("accepts only the current deterministic plan and bounded state", () => {
    const plan = buildRiskPlan({ headSha: HEAD_SHA, changedFiles: ["src/lib/onboard.ts"] });
    const allowed = new Set(riskPlanRequiredJobIds(plan));
    const gate = state();

    expect(validateRiskPlan(plan, allowed)).toEqual(plan);
    expect(() => validateRiskPlan({ ...plan, version: 1 }, allowed)).toThrow(
      /unsupported risk-plan version/u,
    );
    expect(() => validateRiskPlan({ ...plan, planHash: "b".repeat(64) }, allowed)).toThrow(
      /deterministic hash/u,
    );
    expect(() => validateRiskPlan(plan, new Set())).toThrow(/unknown E2E job/u);
    expect(validateRequiredLiveState(gate)).toEqual(gate);
    expect(() => validateRequiredLiveState({ ...gate, prNumber: 0 })).toThrow(/PR number/u);
    expect(() => validateRequiredLiveState({ ...gate, expectedShards: {} })).toThrow(/shard jobs/u);
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
      classifyRequiredLiveEvidence({
        workflowConclusion,
        expectedJobs: gate.expectedJobs,
        expectedShards: gate.expectedShards,
        signals,
      });

    expect(classify(complete).conclusion).toBe("success");
    expect(classify([], "cancelled").conclusion).toBe("failure");
    expect(classify(complete.slice(0, 1)).title).toMatch(/missing evidence/u);
    expect(classify([...complete, complete[0]!]).title).toMatch(/duplicate evidence/u);
    expect(
      classify([signal(gate, "onboard-repair", "default", { skipped: 1 }), complete[1]!]).title,
    ).toMatch(/incomplete evidence/u);
    expect(
      classify([
        signal(gate, "onboard-repair", "default", { failed: 1, runReason: "failed" }),
        complete[1]!,
      ]).title,
    ).toMatch(/test failures/u);
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
      dispatchRequiredLive({
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

  it("refuses dispatch when main moved past the trusted workflow revision", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      githubResponse({
        ref: "refs/heads/main",
        object: { type: "commit", sha: BASE_SHA },
      }),
    );

    await expect(
      dispatchRequiredLive({
        repository: "NVIDIA/NemoClaw",
        token: "token",
        jobs: ["onboard-repair"],
        prNumber: 42,
        commitSha: HEAD_SHA,
        workflowSha: WORKFLOW_SHA,
        planHash: "c".repeat(64),
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toThrow(/no longer the current main revision/u);
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

  it("runs the dispatch-to-evidence lifecycle and completes one successful check", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-required-live-lifecycle-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    let gate: RequiredLiveState | undefined;
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
      await startRequiredLive(command);
      gate = validateRequiredLiveState(JSON.parse(fs.readFileSync(command.statePath, "utf8")));
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
      await finishRequiredLive({
        statePath: command.statePath,
        stateHash: outputs.state_hash!,
        evidencePath: command.evidencePath,
        checkRunId: Number(outputs.check_id),
        childRunId: Number(outputs.run_id),
      });

      expect(gate.expectedJobs).toEqual(BROAD_JOBS);
      expect(requests.filter((request) => request.url.includes("/pulls?"))).toHaveLength(2);
      expect(requests.filter((request) => request.url.endsWith("/pulls/42"))).toHaveLength(2);
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
          title: "Running 13 required live E2E jobs",
          summary: expect.stringContaining("upgrade-stale-sandbox"),
        },
      });
      expect(checkUpdates[1]?.body).toMatchObject({
        status: "completed",
        conclusion: "success",
        output: { title: "Required live E2E passed" },
      });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("fails without dispatch when the pull request changes during planning", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-required-live-race-"));
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
      await expect(startRequiredLive(startCommand(workDir))).rejects.toThrow(
        /changed while required live E2E was being prepared/u,
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
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-required-live-start-"));
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
      await expect(startRequiredLive(startCommand(workDir))).rejects.toThrow(
        /simulated update failure/u,
      );
      expect(requests.some((request) => request.url.endsWith("/actions/runs/23/cancel"))).toBe(
        true,
      );
      const checkUpdates = requests.filter((request) => request.url.endsWith("/check-runs/17"));
      expect(checkUpdates).toHaveLength(2);
      expect(checkUpdates[1]?.body).toMatchObject({ status: "completed", conclusion: "failure" });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "missing evidence", status: "completed", expectCancellation: false },
    { label: "an unfinished child", status: "in_progress", expectCancellation: true },
  ])("closes the check as failure for $label", async ({ status, expectCancellation }) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-required-live-finish-"));
    const outputPath = path.join(workDir, "github-output");
    const statePath = path.join(workDir, "required-live-state.json");
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
        finishRequiredLive({
          statePath,
          stateHash: sha256(serializedState),
          evidencePath,
          checkRunId: 17,
          childRunId: 23,
        }),
      ).rejects.toThrow();
      expect(requests.some((request) => request.url.endsWith("/actions/runs/23/cancel"))).toBe(
        expectCancellation,
      );
      const completion = requests.find((request) => request.url.endsWith("/check-runs/17"));
      expect(completion?.body).toMatchObject({ status: "completed", conclusion: "failure" });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("cancels only active child runs for the pull request", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const gate = state();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter([
        githubFetchRoute(
          ({ url }) => url.includes("/actions/workflows/e2e.yaml/runs?"),
          () =>
            githubResponse({
              workflow_runs: [
                workflowRun(gate, { status: "in_progress" }),
                workflowRun(gate, { id: 24, status: "completed" }),
                workflowRun(gate, { id: 25, status: "queued", display_title: "E2E manual" }),
              ],
            }),
        ),
        githubFetchRoute(
          ({ url, method }) => url.endsWith("/actions/runs/23/cancel") && method === "POST",
          () => githubResponse(undefined, 202),
        ),
      ]),
    );

    await expect(cancelRequiredLive(42)).resolves.toBe(1);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/cancel")),
    ).toHaveLength(1);
  });

  it("cancels a known child and closes an abandoned check as failure", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-required-live-abandon-"));
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
      await abandonRequiredLive(17, 23);
      expect(requests.map((request) => request.url)).toEqual([
        "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/23/cancel",
        "https://api.github.com/repos/NVIDIA/NemoClaw/check-runs/17",
      ]);
      expect(requests[1]?.body).toMatchObject({ status: "completed", conclusion: "failure" });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds recursive signal discovery and rejects symlinks", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-required-live-evidence-"));
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

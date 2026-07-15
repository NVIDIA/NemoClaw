// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRiskPlan } from "../tools/advisors/risk-plan.mts";
import {
  abandonPrGate,
  cancelPrGate,
  findSignalFiles,
  finishPrGate,
  type PrGateState,
  type PullRequest,
  parseControllerCommand,
  prGateExternalId,
  startPrGate,
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
const GATE_RUN_ID = 77;
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
    version: 2,
    commitSha: HEAD_SHA,
    baseSha: BASE_SHA,
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

function writePassingEvidence(evidencePath: string, gate: PrGateState): void {
  for (const job of gate.expectedJobs) {
    for (const shard of gate.expectedShards[job]!) {
      const directory = path.join(evidencePath, `${job}-${shard}`);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, "risk-signal.json"),
        `${JSON.stringify(signal(gate, job, shard))}\n`,
      );
    }
  }
}

function writeMalformedEvidence(evidencePath: string, _gate: PrGateState): void {
  const directory = path.join(evidencePath, "malformed");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "risk-signal.json"), "{not-json\n");
}

async function expectHandledFinalization(
  finalization: Promise<void>,
  _expectedSummary: string,
): Promise<void> {
  await expect(finalization).resolves.toBeUndefined();
}

async function expectControllerFailureFinalization(
  finalization: Promise<void>,
  expectedSummary: string,
): Promise<void> {
  await expect(finalization).rejects.toThrow(expectedSummary);
}

function expectSelectedRunLink(body: unknown): void {
  expect(JSON.stringify(body)).toContain(
    `[Selected E2E run 23](https://github.com/NVIDIA/NemoClaw/actions/runs/23)`,
  );
}

function expectControllerDetailsLink(body: unknown): void {
  expect(body).toMatchObject({
    details_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
  });
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

describe("PR E2E controller lifecycle", () => {
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
          emptyPrGateCheckRunsRoute(),
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
              return checkPatches === 2
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
      expect(checkUpdates).toHaveLength(3);
      expect(checkUpdates[2]?.body).toMatchObject({
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
      label: "the pull request base changes after dispatch",
      currentPull: {
        ...pullRequest(),
        base: { ...pullRequest().base, sha: "c".repeat(40) },
      },
      writeEvidence: writeMalformedEvidence,
      expectedLivePullReads: 1,
      expectedTitle: "Superseded by PR update",
      expectedSummary:
        "moved from head `aaaaaaa` on base `bbbbbbb` to head `aaaaaaa` on base `ccccccc`",
    },
    {
      label: "the pull request closes after dispatch",
      currentPull: { ...pullRequest(), state: "closed" },
      writeEvidence: writeMalformedEvidence,
      expectedLivePullReads: 1,
      expectedTitle: "PR closed — gate no longer applies",
      expectedSummary: "closed before this gate completed",
    },
    {
      label: "the pull request closes after its fork repository is deleted",
      currentPull: {
        ...pullRequest(),
        state: "closed",
        head: { ...pullRequest().head, repo: null },
      },
      writeEvidence: writeMalformedEvidence,
      expectedLivePullReads: 1,
      expectedTitle: "PR closed — gate no longer applies",
      expectedSummary: "closed before this gate completed",
    },
    {
      label: "the pull request changes while passing evidence is parsed",
      firstFinalizationPull: pullRequest(),
      currentPull: {
        ...pullRequest(),
        head: { ...pullRequest().head, sha: "c".repeat(40) },
      },
      writeEvidence: writePassingEvidence,
      expectedLivePullReads: 2,
      expectedTitle: "Superseded by PR update",
      expectedSummary:
        "moved from head `aaaaaaa` on base `bbbbbbb` to head `ccccccc` on base `bbbbbbb`",
    },
  ])("records an obsolete exact-diff outcome without failing the controller when $label", async ({
    currentPull,
    firstFinalizationPull = currentPull,
    writeEvidence,
    expectedLivePullReads,
    expectedTitle,
    expectedSummary,
  }) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-retarget-"));
    const outputPath = path.join(workDir, "github-output");
    const statePath = path.join(workDir, "controller-state.json");
    const evidencePath = path.join(workDir, "evidence");
    const gate = state();
    const serializedState = `${JSON.stringify(gate, null, 2)}\n`;
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    fs.writeFileSync(statePath, serializedState, { mode: 0o600 });
    fs.mkdirSync(evidencePath);
    writeEvidence(evidencePath, gate);
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    let livePullReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => githubResponse(workflowRun(gate)),
          ),
          existingPrGateCheckRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(livePullReads++ === 0 ? firstFinalizationPull : currentPull),
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
          evidenceOutcome: "success",
        }),
      ).resolves.toBeUndefined();
      expect(
        requests.some(
          (request) => request.url.includes("/commits/") && request.url.includes("/check-runs?"),
        ),
      ).toBe(true);
      const completion = requests.find(
        (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
      );
      expect(completion?.body).toMatchObject({
        status: "completed",
        conclusion: "cancelled",
        details_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
        output: {
          title: expectedTitle,
          summary: expect.stringContaining(expectedSummary),
        },
      });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
      expect(livePullReads).toBe(expectedLivePullReads);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "missing evidence",
      status: "completed",
      conclusion: "success",
      jobs: [],
      evidenceOutcome: "success" as const,
      assertFinalization: expectHandledFinalization,
      assertCompletionLink: expectSelectedRunLink,
      expectCancellation: false,
      expectedTitle: "Evidence is missing",
      expectedSummary: "Missing signals: onboard-repair:default, onboard-resume:default",
    },
    {
      label: "an unfinished child",
      status: "in_progress",
      conclusion: "success",
      jobs: [],
      evidenceOutcome: "success" as const,
      assertFinalization: expectHandledFinalization,
      assertCompletionLink: expectSelectedRunLink,
      expectCancellation: true,
      expectedTitle: "Selected E2E did not pass",
      expectedSummary: "concluded `unfinished (in_progress)`",
    },
    {
      label: "a failed child job",
      status: "completed",
      conclusion: "failure",
      jobs: [
        {
          id: 77,
          name: "Hermes security-posture",
          conclusion: "failure",
          steps: [{ name: "Run security posture live Vitest test", conclusion: "failure" }],
        },
      ],
      evidenceOutcome: "success" as const,
      assertFinalization: expectHandledFinalization,
      assertCompletionLink: expectSelectedRunLink,
      expectCancellation: false,
      expectedTitle: "Hermes security-posture failed",
      expectedSummary:
        "[Hermes security-posture](https://github.com/NVIDIA/NemoClaw/actions/runs/23/job/77) — failed step: `Run security posture live Vitest test`",
    },
    {
      label: "a failed child whose job details are unavailable",
      status: "completed",
      conclusion: "failure",
      jobs: null,
      evidenceOutcome: "success" as const,
      assertFinalization: expectHandledFinalization,
      assertCompletionLink: expectSelectedRunLink,
      expectCancellation: false,
      expectedTitle: "Selected E2E did not pass",
      expectedSummary: "Job details could not be loaded",
    },
    {
      label: "the evidence download fails after a successful child",
      status: "completed",
      conclusion: "success",
      jobs: [],
      evidenceOutcome: "failure" as const,
      assertFinalization: expectControllerFailureFinalization,
      assertCompletionLink: expectControllerDetailsLink,
      expectCancellation: false,
      expectedTitle: "Evidence could not be verified",
      expectedSummary: "Evidence download did not complete (outcome: failure)",
    },
    {
      label: "the evidence download is cancelled after a successful child",
      status: "completed",
      conclusion: "success",
      jobs: [],
      evidenceOutcome: "cancelled" as const,
      assertFinalization: expectControllerFailureFinalization,
      assertCompletionLink: expectControllerDetailsLink,
      expectCancellation: false,
      expectedTitle: "Evidence could not be verified",
      expectedSummary: "Evidence download did not complete (outcome: cancelled)",
    },
    {
      label: "the evidence download is skipped after a successful child",
      status: "completed",
      conclusion: "success",
      jobs: [],
      evidenceOutcome: "skipped" as const,
      assertFinalization: expectControllerFailureFinalization,
      assertCompletionLink: expectControllerDetailsLink,
      expectCancellation: false,
      expectedTitle: "Evidence could not be verified",
      expectedSummary: "Evidence download did not complete (outcome: skipped)",
    },
  ])("records the expected check and controller outcomes when $label", async ({
    status,
    conclusion,
    jobs,
    evidenceOutcome,
    assertFinalization,
    assertCompletionLink,
    expectCancellation,
    expectedTitle,
    expectedSummary,
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
            () => githubResponse(workflowRun(gate, { status, conclusion })),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23/cancel") && method === "POST",
            () => githubResponse(undefined, 202),
          ),
          githubFetchRoute(
            ({ url, method }) => url.includes("/actions/runs/23/jobs?") && method === "GET",
            () =>
              jobs === null
                ? githubResponse({ message: "temporary failure" }, 503)
                : githubResponse({ total_count: jobs.length, jobs }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest()),
          ),
          existingPrGateCheckRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            () => githubResponse({}),
          ),
        ],
        requests,
      ),
    );

    try {
      const finalization = finishPrGate({
        statePath,
        stateHash: sha256(serializedState),
        evidencePath,
        checkRunId: 17,
        childRunId: 23,
        evidenceOutcome,
      });
      await assertFinalization(finalization, expectedSummary);
      expect(requests.some((request) => request.url.endsWith("/actions/runs/23/cancel"))).toBe(
        expectCancellation,
      );
      const completion = requests.find((request) => request.url.endsWith("/check-runs/17"));
      expect(completion?.body).toMatchObject({
        status: "completed",
        conclusion: "failure",
        output: {
          title: expectedTitle,
          summary: expect.stringContaining(expectedSummary),
        },
      });
      assertCompletionLink(completion?.body);
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

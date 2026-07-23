// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finishPrGate,
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

function state(): PrGateState {
  return {
    version: 3,
    commitSha: HEAD_SHA,
    baseSha: BASE_SHA,
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

function checkRun(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: "E2E / PR Gate Coordination",
    head_sha: HEAD_SHA,
    external_id: prGateExternalId(42, HEAD_SHA, BASE_SHA),
    status: "completed",
    conclusion: "failure",
    details_url: ORIGINAL_RUN_URL,
    output: {
      title: "Hermes security-posture failed",
      summary: `GitHub-hosted runner disappeared.\n\n${RETRY_MARKER}`,
    },
    app: { id: 15368 },
    ...overrides,
  };
}

function workflowRun(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function hostedRunnerLossJob() {
  return {
    id: 89_074_697_099,
    name: "Hermes security-posture",
    status: "completed",
    conclusion: "failure",
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
      },
      { name: "Upload security posture artifacts", status: "completed", conclusion: "skipped" },
      { name: "Clean up Docker auth", status: "completed", conclusion: "skipped" },
      { name: "Complete job", status: "completed", conclusion: "success" },
    ],
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

function mutationResponse(request: RecordedGitHubRequest, id = 18): Response {
  return githubResponse(
    checkRun(id, {
      status: "in_progress",
      conclusion: null,
      details_url: null,
      ...(request.body as Record<string, unknown> | undefined),
    }),
  );
}

function setup(): {
  workDir: string;
  outputPath: string;
  statePath: string;
  retryStatePath: string;
  serializedState: string;
  command: Parameters<typeof retryRunnerLossPrGate>[0];
} {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runner-loss-retry-"));
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
    statePath,
    retryStatePath,
    serializedState,
    command: {
      mode: "retry-runner-loss",
      checkRunId: 17,
      childRunId: 23,
      workflowRunAttempt: 1,
      stateHash: sha256(serializedState),
      statePath,
      retryStatePath,
    },
  };
}

function retryRoutes(
  requests: RecordedGitHubRequest[],
  options: {
    histories?: unknown[][];
    jobs?: unknown[];
    jobPages?: Array<{ total_count: number; jobs: unknown[] }>;
    createRetryStateDirectory?: string;
  } = {},
) {
  let historyRead = 0;
  const defaultHistories = [
    [checkRun(17)],
    [checkRun(17), checkRun(18, { status: "in_progress", conclusion: null, details_url: null })],
    [checkRun(17), checkRun(18, { status: "in_progress", conclusion: null, details_url: null })],
  ];
  return createGitHubFetchRouter(
    [
      githubFetchRoute(
        ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
        () => githubResponse(workflowRun()),
      ),
      githubFetchRoute(
        ({ url, method }) => url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
        () => {
          const histories = options.histories ?? defaultHistories;
          const checks = histories[Math.min(historyRead, histories.length - 1)] ?? [];
          historyRead += 1;
          return githubResponse({ total_count: checks.length, check_runs: checks });
        },
      ),
      githubFetchRoute(
        ({ url, method }) => url.includes("/actions/runs/23/attempts/1/jobs?") && method === "GET",
        (request) => {
          if (options.jobPages) {
            const page = Number(new URL(request.url).searchParams.get("page"));
            return githubResponse(options.jobPages[page - 1]);
          }
          const jobs = options.jobs ?? [hostedRunnerLossJob()];
          return githubResponse({ total_count: jobs.length, jobs });
        },
      ),
      githubFetchRoute(
        ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
        () => githubResponse(pullRequest()),
      ),
      githubFetchRoute(
        ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
        (request) => mutationResponse(request),
      ),
      githubFetchRoute(
        ({ url, method }) => url.endsWith("/check-runs/18") && method === "PATCH",
        (request) => mutationResponse(request),
      ),
      githubFetchRoute(
        ({ url, method }) => url.endsWith("/git/ref/heads/main") && method === "GET",
        () =>
          githubResponse({ ref: "refs/heads/main", object: { type: "commit", sha: WORKFLOW_SHA } }),
      ),
      githubFetchRoute(
        ({ url, method }) =>
          url.endsWith("/actions/workflows/e2e.yaml/dispatches") && method === "POST",
        () => {
          if (options.createRetryStateDirectory) {
            fs.mkdirSync(options.createRetryStateDirectory);
          }
          return githubResponse({
            workflow_run_id: 24,
            run_url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/24",
            html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/24",
          });
        },
      ),
      githubFetchRoute(
        ({ url, method }) => url.endsWith("/actions/runs/24/cancel") && method === "POST",
        () => githubResponse(undefined, 202),
      ),
    ],
    requests,
  );
}

describe("PR E2E one-time hosted-runner-loss retry", () => {
  it("rejects a direct retry call from a controller workflow rerun", async () => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(retryRoutes(requests));

    try {
      await expect(
        retryRunnerLossPrGate({ ...context.command, workflowRunAttempt: 2 }),
      ).rejects.toThrow(/first controller workflow run attempt/u);
      expect(requests).toHaveLength(0);
    } finally {
      fs.rmSync(context.workDir, { recursive: true, force: true });
    }
  });

  it("dispatches the same plan once with fresh state and an independently bound check", async () => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(retryRoutes(requests));

    try {
      await expect(retryRunnerLossPrGate(context.command)).resolves.toBeUndefined();
      const dispatch = requests.find((request) => request.url.endsWith("/dispatches"));
      expect(dispatch?.body).toMatchObject({
        ref: "main",
        inputs: {
          jobs: "onboard-repair,onboard-resume",
          targets: "",
          pr_number: "42",
          checkout_sha: HEAD_SHA,
          base_sha: BASE_SHA,
          workflow_sha: WORKFLOW_SHA,
          plan_hash: "c".repeat(64),
        },
      });
      const correlationId = (dispatch?.body as { inputs?: { correlation_id?: string } }).inputs
        ?.correlation_id;
      expect(correlationId).toMatch(/^[a-f0-9-]{36}$/u);
      expect(correlationId).not.toBe(ORIGINAL_CORRELATION_ID);

      const retryState = JSON.parse(fs.readFileSync(context.retryStatePath, "utf8"));
      expect(retryState).toEqual({ ...state(), correlationId });
      expect(fs.readFileSync(context.statePath, "utf8")).toBe(context.serializedState);
      expect(fs.readFileSync(context.outputPath, "utf8")).toMatch(
        /^check_id=18\nrun_id=24\nstate_hash=[a-f0-9]{64}\ndispatched=true\n$/u,
      );
      expect(
        requests.filter(
          (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
        ),
      ).toHaveLength(0);
      expect(
        requests.filter((request) => request.url.includes(`/commits/${HEAD_SHA}/check-runs?`)),
      ).toHaveLength(3);
      expect(
        requests.some((request) => request.url.includes("/actions/runs/23/attempts/1/jobs?")),
      ).toBe(true);
      expect(requests.some((request) => request.url.includes("/actions/runs/23/jobs?"))).toBe(
        false,
      );
      expect(
        new Set(
          requests
            .filter((request) => request.url.endsWith("/check-runs/18"))
            .map((request) => (request.body as { output?: { title?: string } }).output?.title),
        ),
      ).toEqual(new Set(["Preparing one-time hosted-runner-loss retry", "Running 2 E2E checks"]));
    } finally {
      fs.rmSync(context.workDir, { recursive: true, force: true });
    }
  });

  it("rejects child reruns and mixed non-passing jobs before creating a retry check", async () => {
    for (const scenario of ["child-rerun", "mixed-jobs"] as const) {
      const context = setup();
      const requests: RecordedGitHubRequest[] = [];
      const routes = retryRoutes(requests, {
        jobs:
          scenario === "mixed-jobs"
            ? [
                hostedRunnerLossJob(),
                { id: 2, name: "other", status: "completed", conclusion: "cancelled", steps: [] },
              ]
            : undefined,
      });
      if (scenario === "child-rerun") {
        vi.spyOn(globalThis, "fetch").mockImplementation(
          createGitHubFetchRouter(
            [
              githubFetchRoute(
                ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
                () => githubResponse(workflowRun({ run_attempt: 2 })),
              ),
            ],
            requests,
          ),
        );
      } else {
        vi.spyOn(globalThis, "fetch").mockImplementation(routes);
      }

      try {
        await expect(retryRunnerLossPrGate(context.command)).rejects.toThrow(
          scenario === "child-rerun" ? /run_attempt/u : /not authorized/u,
        );
        expect(requests.some((request) => request.method === "POST")).toBe(false);
      } finally {
        fs.rmSync(context.workDir, { recursive: true, force: true });
        vi.restoreAllMocks();
      }
    }
  });

  it("does not consume a second retry for the same PR/base SHA pair", async () => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      retryRoutes(requests, {
        histories: [
          [
            checkRun(16, {
              details_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/22",
            }),
            checkRun(17),
          ],
        ],
      }),
    );

    try {
      await expect(retryRunnerLossPrGate(context.command)).rejects.toThrow(/already consumed/u);
      expect(requests.some((request) => request.method === "POST")).toBe(false);
    } finally {
      fs.rmSync(context.workDir, { recursive: true, force: true });
    }
  });

  it("rejects overlapping workflow-job pages before creating a retry check", async () => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...hostedRunnerLossJob(),
      id: index + 1,
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(
      retryRoutes(requests, {
        jobPages: [
          { total_count: 101, jobs: firstPage },
          { total_count: 101, jobs: [{ ...hostedRunnerLossJob(), id: 100 }] },
        ],
      }),
    );

    try {
      await expect(retryRunnerLossPrGate(context.command)).rejects.toThrow(
        /duplicate workflow job IDs/u,
      );
      expect(requests.some((request) => request.method === "POST")).toBe(false);
    } finally {
      fs.rmSync(context.workDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "marker",
      source: checkRun(17, {
        output: {
          title: "PR prerequisite CI did not pass",
          summary: "Prerequisite CI failed.\n\n<!-- nemoclaw-pr-e2e-retry:v1:prerequisite-ci -->",
        },
      }),
    },
    {
      name: "run URL",
      source: checkRun(17, {
        details_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/999",
      }),
    },
  ])("fails closed when the source $name changes immediately before dispatch", async ({
    source,
  }) => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    const retryCheck = checkRun(18, {
      status: "in_progress",
      conclusion: null,
      details_url: null,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      retryRoutes(requests, {
        histories: [[checkRun(17)], [checkRun(17), retryCheck], [source, retryCheck]],
      }),
    );

    try {
      await expect(retryRunnerLossPrGate(context.command)).rejects.toThrow(
        /lost the current PR gate check/u,
      );
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      expect(
        requests.filter(
          (request) =>
            request.url.endsWith("/check-runs/18") &&
            request.method === "PATCH" &&
            (request.body as { status?: string }).status === "completed",
        ),
      ).toHaveLength(1);
      expect(
        requests.filter(
          (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
        ),
      ).toHaveLength(0);
    } finally {
      fs.rmSync(context.workDir, { recursive: true, force: true });
    }
  });

  it("cancels a dispatched retry whose isolated state cannot be written", async () => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      retryRoutes(requests, { createRetryStateDirectory: context.retryStatePath }),
    );

    try {
      await expect(retryRunnerLossPrGate(context.command)).rejects.toThrow(
        /retry child cancellation requested/u,
      );
      expect(
        requests.filter(
          (request) => request.url.endsWith("/actions/runs/24/cancel") && request.method === "POST",
        ),
      ).toHaveLength(1);
      const retryCompletion = requests.find(
        (request) =>
          request.url.endsWith("/check-runs/18") &&
          request.method === "PATCH" &&
          (request.body as { status?: string }).status === "completed",
      );
      expect(retryCompletion?.body).toMatchObject({
        status: "completed",
        conclusion: "failure",
        output: { title: "Runner-loss retry could not start" },
      });
      expect(
        requests.filter(
          (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
        ),
      ).toHaveLength(0);
    } finally {
      fs.rmSync(context.workDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "loses another hosted runner", conclusion: "failure", evidenceOutcome: "skipped" },
    { label: "cannot download evidence", conclusion: "success", evidenceOutcome: "failure" },
  ] as const)("terminalizes attempt 2 when it $label", async ({ conclusion, evidenceOutcome }) => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    const retryCorrelationId = "87654321-4321-4123-8123-cba987654321";
    const retryState = { ...state(), correlationId: retryCorrelationId };
    const retryStateContents = `${JSON.stringify(retryState, null, 2)}\n`;
    fs.writeFileSync(context.retryStatePath, retryStateContents, { mode: 0o600 });
    const currentCheck = checkRun(18, {
      status: "in_progress",
      conclusion: null,
      details_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/24",
      output: { title: "Running 2 E2E checks", summary: "Attempt 2 is running." },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/24") && method === "GET",
            () =>
              githubResponse(
                workflowRun({
                  id: 24,
                  conclusion,
                  display_title: `E2E PR #42 (${retryCorrelationId})`,
                  html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/24",
                }),
              ),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: 2, check_runs: [checkRun(17), currentCheck] }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/runs/24/attempts/1/jobs?") && method === "GET",
            () => githubResponse({ total_count: 1, jobs: [hostedRunnerLossJob()] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/18") && method === "PATCH",
            (request) => mutationResponse(request),
          ),
        ],
        requests,
      ),
    );

    try {
      const finalization = finishPrGate({
        statePath: context.retryStatePath,
        stateHash: sha256(retryStateContents),
        evidencePath: context.workDir,
        checkRunId: 18,
        childRunId: 24,
        evidenceOutcome,
      });
      if (conclusion === "success") {
        await expect(finalization).rejects.toThrow(/Evidence download did not complete/u);
      } else {
        await expect(finalization).resolves.toBeUndefined();
      }
      const completion = requests.find(
        (request) =>
          request.url.endsWith("/check-runs/18") &&
          request.method === "PATCH" &&
          (request.body as { status?: string }).status === "completed",
      );
      const summary = (completion?.body as { output?: { summary?: string } }).output?.summary;
      expect(completion?.body).toMatchObject({ status: "completed", conclusion: "failure" });
      expect(summary).toContain(`[attempt 1](${ORIGINAL_RUN_URL})`);
      expect(summary).toContain("[attempt 2](https://github.com/NVIDIA/NemoClaw/actions/runs/24)");
      expect(summary).not.toContain("nemoclaw-pr-e2e-retry:v1:");
      expect(fs.readFileSync(context.outputPath, "utf8")).not.toContain(
        "runner_loss_retry_authorized=true",
      );
    } finally {
      fs.rmSync(context.workDir, { recursive: true, force: true });
    }
  });

  it("fails closed when retry authorization cannot be written to controller output", async () => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    fs.rmSync(context.outputPath);
    fs.mkdirSync(context.outputPath);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
            () => githubResponse(workflowRun()),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () =>
              githubResponse({
                total_count: 1,
                check_runs: [checkRun(17, { status: "in_progress", conclusion: null })],
              }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/runs/23/attempts/1/jobs?") && method === "GET",
            () => githubResponse({ total_count: 1, jobs: [hostedRunnerLossJob()] }),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            (request) => mutationResponse(request, 17),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(
        finishPrGate({
          statePath: context.statePath,
          stateHash: sha256(context.serializedState),
          evidencePath: context.workDir,
          checkRunId: 17,
          childRunId: 23,
          evidenceOutcome: "skipped",
        }),
      ).rejects.toThrow();
      const completions = requests.filter(
        (request) =>
          request.url.endsWith("/check-runs/17") &&
          request.method === "PATCH" &&
          (request.body as { status?: string }).status === "completed",
      );
      expect(completions).toHaveLength(1);
      expect(completions[0]?.body).toMatchObject({
        conclusion: "failure",
        output: { title: "Evidence could not be verified" },
      });
      expect(JSON.stringify(completions[0]?.body)).not.toContain("nemoclaw-pr-e2e-retry:v1:");
    } finally {
      fs.rmSync(context.workDir, { recursive: true, force: true });
    }
  });
});

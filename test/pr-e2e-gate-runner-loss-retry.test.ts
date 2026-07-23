// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abandonRunnerLossRetrySource,
  finishPrGate,
  type PrGateState,
  prGateExternalId,
  privateControllerPaths,
  retryRunnerLossPrGate,
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
const ORIGINAL_CORRELATION_ID = "12345678-1234-4123-8123-123456789abc";
const ORIGINAL_RUN_URL = "https://github.com/NVIDIA/NemoClaw/actions/runs/23";
const RETRY_MARKER = "<!-- nemoclaw-pr-e2e-retry:v1:child-cancelled -->";
const JOB_LOG_DOWNLOAD_URL =
  "https://productionresultssa0.blob.core.windows.net/actions-results/job-89074697099.txt?sp=r&sig=signed";
const JOB_LOG_ETAG = '"hosted-runner-log"';
const JOB_LOG_RANGE_BYTES = 64 * 1024;
const RUNNER_SHUTDOWN_MESSAGE =
  "The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.";

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

function hostedRunnerLossJob(runId = 23) {
  const id = 89_074_697_099;
  return {
    id,
    run_id: runId,
    run_attempt: 1,
    head_sha: WORKFLOW_SHA,
    run_url: `https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/${runId}`,
    url: `https://api.github.com/repos/NVIDIA/NemoClaw/actions/jobs/${id}`,
    html_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}/job/${id}`,
    check_run_url: `https://api.github.com/repos/NVIDIA/NemoClaw/check-runs/${id}`,
    name: "Hermes security-posture",
    status: "completed",
    conclusion: "failure",
    started_at: "2026-07-23T07:26:56Z",
    completed_at: "2026-07-23T07:32:54Z",
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
        started_at: "2026-07-23T07:27:43Z",
        completed_at: "2026-07-23T07:32:49Z",
      },
      { name: "Upload security posture artifacts", status: "completed", conclusion: "skipped" },
      { name: "Clean up Docker auth", status: "completed", conclusion: "skipped" },
      { name: "Complete job", status: "completed", conclusion: "success" },
    ],
  };
}

function runnerLossAnnotation() {
  return {
    path: ".github",
    blob_href: `https://github.com/NVIDIA/NemoClaw/blob/${WORKFLOW_SHA}/.github`,
    start_line: 1,
    start_column: null,
    end_line: 1,
    end_column: null,
    annotation_level: "failure",
    title: "",
    message:
      "The hosted runner lost communication with the server. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.",
    raw_details: "",
  };
}

function genericCancellationAnnotation() {
  return {
    ...runnerLossAnnotation(),
    start_line: 34,
    end_line: 34,
    message: "The operation was canceled.",
  };
}

function runnerShutdownJobLog() {
  return [
    "x".repeat(JOB_LOG_RANGE_BYTES),
    `2026-07-23T07:32:47.0261924Z ##[error]${RUNNER_SHUTDOWN_MESSAGE}`,
    "2026-07-23T07:32:49.9360750Z ##[error]The operation was canceled.",
    "2026-07-23T07:32:50.0577487Z Cleaning up orphan processes",
    "",
  ].join("\n");
}

type JobLogFixture = {
  body?: string;
  downloadUrl?: string;
  metadataHeaders?: Record<string, string>;
  rangeHeaders?: Record<string, string>;
  redirectStatus?: number;
};

function jobLogRoutes(options: JobLogFixture = {}) {
  const body = options.body ?? runnerShutdownJobLog();
  const bytes = new TextEncoder().encode(body);
  const rangeStart = Math.max(0, bytes.byteLength - JOB_LOG_RANGE_BYTES);
  const rangeEnd = bytes.byteLength - 1;
  const range = bytes.slice(rangeStart);
  const downloadUrl = options.downloadUrl ?? JOB_LOG_DOWNLOAD_URL;
  return [
    githubFetchRoute(
      ({ url, method }) =>
        url.endsWith(`/actions/jobs/${hostedRunnerLossJob().id}/logs`) && method === "GET",
      () =>
        new Response(null, {
          status: options.redirectStatus ?? 302,
          headers: { location: downloadUrl },
        }),
    ),
    githubFetchRoute(
      ({ url, method }) => url === JOB_LOG_DOWNLOAD_URL && method === "HEAD",
      () =>
        new Response(null, {
          status: 200,
          headers: {
            "content-length": String(bytes.byteLength),
            "content-type": "text/plain",
            etag: JOB_LOG_ETAG,
            ...options.metadataHeaders,
          },
        }),
    ),
    githubFetchRoute(
      ({ url, method }) => url === JOB_LOG_DOWNLOAD_URL && method === "GET",
      () =>
        new Response(range, {
          status: 206,
          headers: {
            "content-length": String(range.byteLength),
            "content-range": `bytes ${rangeStart}-${rangeEnd}/${bytes.byteLength}`,
            "content-type": "text/plain",
            etag: JOB_LOG_ETAG,
            ...options.rangeHeaders,
          },
        }),
    ),
  ];
}

function authenticatedShutdownOptions(jobLog: JobLogFixture = {}) {
  const annotations = [genericCancellationAnnotation()];
  return {
    annotationPages: [annotations, annotations],
    jobLog,
  };
}

function workflowJobCheckRun(job: ReturnType<typeof hostedRunnerLossJob>) {
  const annotationsUrl = `${job.check_run_url}/annotations`;
  return {
    id: job.id,
    name: job.name,
    head_sha: job.head_sha,
    url: job.check_run_url,
    html_url: job.html_url,
    details_url: job.html_url,
    status: "completed",
    conclusion: "failure",
    app: { id: 15368 },
    output: { annotations_count: 1, annotations_url: annotationsUrl },
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
    workflow?: unknown;
    jobCheck?: unknown;
    annotationPages?: unknown[][];
    jobLog?: JobLogFixture;
    createRetryStateDirectory?: string;
  } = {},
) {
  let historyRead = 0;
  let annotationRead = 0;
  const defaultHistories = [
    [checkRun(17)],
    [checkRun(17), checkRun(18, { status: "in_progress", conclusion: null, details_url: null })],
    [checkRun(17), checkRun(18, { status: "in_progress", conclusion: null, details_url: null })],
  ];
  return createGitHubFetchRouter(
    [
      githubFetchRoute(
        ({ url, method }) => url.endsWith("/actions/runs/23") && method === "GET",
        () => githubResponse(options.workflow ?? workflowRun()),
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
          const page = Number(new URL(request.url).searchParams.get("page"));
          const jobs = options.jobs ?? [hostedRunnerLossJob()];
          const response =
            options.jobPages === undefined
              ? { total_count: jobs.length, jobs }
              : options.jobPages[page - 1];
          return githubResponse(response);
        },
      ),
      githubFetchRoute(
        ({ url, method }) =>
          url.endsWith(`/check-runs/${hostedRunnerLossJob().id}`) && method === "GET",
        () => githubResponse(options.jobCheck ?? workflowJobCheckRun(hostedRunnerLossJob())),
      ),
      githubFetchRoute(
        ({ url, method }) =>
          url.includes(`/check-runs/${hostedRunnerLossJob().id}/annotations?`) && method === "GET",
        () => {
          const annotations = options.annotationPages?.[annotationRead] ?? [runnerLossAnnotation()];
          annotationRead += 1;
          return githubResponse(annotations);
        },
      ),
      ...jobLogRoutes(options.jobLog),
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
          options.createRetryStateDirectory && fs.mkdirSync(options.createRetryStateDirectory);
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

  it("rejects direct retry cleanup from a controller workflow rerun", async () => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(retryRoutes(requests));

    try {
      await expect(abandonRunnerLossRetrySource(17, 23, 2)).rejects.toThrow(
        /first controller workflow run attempt/u,
      );
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

  it("dispatches once for an authenticated hosted-runner shutdown log", async () => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(retryRoutes(requests, authenticatedShutdownOptions()));

    try {
      await expect(retryRunnerLossPrGate(context.command)).resolves.toBeUndefined();
      expect(requests.filter((request) => request.url.endsWith("/dispatches"))).toHaveLength(1);
      expect(requests.filter((request) => request.url.endsWith("/actions/runs/23"))).toHaveLength(
        3,
      );

      const calls = fetchSpy.mock.calls.map(([input, init]) => ({
        url: input instanceof Request ? input.url : String(input),
        init,
      }));
      const apiLogCalls = calls.filter((call) =>
        call.url.endsWith(`/actions/jobs/${hostedRunnerLossJob().id}/logs`),
      );
      const metadataCalls = calls.filter(
        (call) => call.url === JOB_LOG_DOWNLOAD_URL && call.init?.method === "HEAD",
      );
      const rangeCalls = calls.filter(
        (call) => call.url === JOB_LOG_DOWNLOAD_URL && call.init?.method === undefined,
      );
      expect(apiLogCalls).toHaveLength(2);
      expect(metadataCalls).toHaveLength(2);
      expect(rangeCalls).toHaveLength(2);
      expect(apiLogCalls[0]?.init).toMatchObject({
        redirect: "manual",
        headers: { Authorization: "Bearer token" },
      });
      expect(metadataCalls[0]?.init).toMatchObject({
        method: "HEAD",
        redirect: "error",
        headers: { "Accept-Encoding": "identity" },
      });
      const totalBytes = new TextEncoder().encode(runnerShutdownJobLog()).byteLength;
      expect(rangeCalls[0]?.init).toMatchObject({
        redirect: "error",
        headers: {
          "If-Match": JOB_LOG_ETAG,
          Range: `bytes=${totalBytes - JOB_LOG_RANGE_BYTES}-${totalBytes - 1}`,
        },
      });
      for (const call of [...metadataCalls, ...rangeCalls]) {
        expect(call.init?.headers).not.toHaveProperty("Authorization");
      }
    } finally {
      fs.rmSync(context.workDir, { recursive: true, force: true });
    }
  });

  it("closes the reserved retry check for child reruns and mixed non-passing jobs", async () => {
    for (const scenario of ["child-rerun", "mixed-jobs"] as const) {
      const context = setup();
      const requests: RecordedGitHubRequest[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(
        retryRoutes(requests, {
          workflow: scenario === "child-rerun" ? workflowRun({ run_attempt: 2 }) : undefined,
          jobs:
            scenario === "mixed-jobs"
              ? [
                  hostedRunnerLossJob(),
                  { id: 2, name: "other", status: "completed", conclusion: "cancelled", steps: [] },
                ]
              : undefined,
        }),
      );

      try {
        await expect(retryRunnerLossPrGate(context.command)).rejects.toThrow(
          scenario === "child-rerun" ? /run_attempt/u : /not authorized/u,
        );
        expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
        expect(
          requests.some(
            (request) =>
              request.url.endsWith("/check-runs/18") &&
              request.method === "PATCH" &&
              (request.body as { status?: string }).status === "completed",
          ),
        ).toBe(true);
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

  it("closes the reserved retry check when workflow-job pages overlap", async () => {
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
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      expect(
        requests.some(
          (request) =>
            request.url.endsWith("/check-runs/18") &&
            request.method === "PATCH" &&
            (request.body as { status?: string }).status === "completed",
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(context.workDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "job run ID mismatch",
      options: () => ({ jobs: [{ ...hostedRunnerLossJob(), run_id: 24 }] }),
      error: /job identity/u,
    },
    {
      label: "job run-attempt mismatch",
      options: () => ({ jobs: [{ ...hostedRunnerLossJob(), run_attempt: 2 }] }),
      error: /job identity/u,
    },
    {
      label: "job check URL mismatch",
      options: () => ({
        jobs: [{ ...hostedRunnerLossJob(), check_run_url: "https://api.github.com/check-runs/1" }],
      }),
      error: /job identity/u,
    },
    {
      label: "check-run app mismatch",
      options: () => ({
        jobCheck: { ...workflowJobCheckRun(hostedRunnerLossJob()), app: { id: 7 } },
      }),
      error: /check run does not match/u,
    },
    {
      label: "check-run head mismatch",
      options: () => ({
        jobCheck: {
          ...workflowJobCheckRun(hostedRunnerLossJob()),
          head_sha: "e".repeat(40),
        },
      }),
      error: /check run does not match/u,
    },
    {
      label: "incomplete annotation page",
      options: () => {
        const check = workflowJobCheckRun(hostedRunnerLossJob());
        return {
          jobCheck: { ...check, output: { ...check.output, annotations_count: 2 } },
          annotationPages: [[runnerLossAnnotation()]],
        };
      },
      error: /annotation listing is incomplete/u,
    },
    {
      label: "an annotation count above the runner-loss evidence limit",
      options: () => {
        const check = workflowJobCheckRun(hostedRunnerLossJob());
        return {
          jobCheck: { ...check, output: { ...check.output, annotations_count: 21 } },
        };
      },
      error: /annotation count exceeds/u,
    },
    {
      label: "an oversized annotation field",
      options: () => ({
        annotationPages: [
          [
            {
              ...runnerLossAnnotation(),
              message: "x".repeat(16 * 1024 + 1),
            },
          ],
        ],
      }),
      error: /invalid workflow job annotation/u,
    },
    {
      label: "oversized aggregate annotation evidence",
      options: () => {
        const check = workflowJobCheckRun(hostedRunnerLossJob());
        const notices = Array.from({ length: 19 }, (_, index) => ({
          ...runnerLossAnnotation(),
          start_line: index + 2,
          end_line: index + 2,
          annotation_level: "notice",
          message: `notice-${index}-${"x".repeat(4 * 1024)}`,
        }));
        return {
          jobCheck: { ...check, output: { ...check.output, annotations_count: 20 } },
          annotationPages: [[runnerLossAnnotation(), ...notices]],
        };
      },
      error: /annotation evidence exceeds/u,
    },
    {
      label: "a second generic-cancellation failure annotation",
      options: () => {
        const check = workflowJobCheckRun(hostedRunnerLossJob());
        return {
          jobCheck: { ...check, output: { ...check.output, annotations_count: 2 } },
          annotationPages: [
            [
              runnerLossAnnotation(),
              { ...runnerLossAnnotation(), message: "The operation was canceled." },
            ],
          ],
        };
      },
      error: /not authorized/u,
    },
    {
      label: "an untrusted job-log redirect",
      options: () =>
        authenticatedShutdownOptions({
          downloadUrl: "https://example.com/actions-results/job.txt?sig=untrusted",
        }),
      error: /not authorized/u,
    },
    {
      label: "a weak job-log metadata ETag",
      options: () =>
        authenticatedShutdownOptions({ metadataHeaders: { etag: 'W/"hosted-runner-log"' } }),
      error: /not authorized/u,
    },
    {
      label: "a mismatched authenticated job-log range",
      options: () =>
        authenticatedShutdownOptions({
          rangeHeaders: { "content-range": "bytes 0-1/2" },
        }),
      error: /not authorized/u,
    },
    {
      label: "a completed-step marker after the shutdown tail",
      options: () =>
        authenticatedShutdownOptions({
          body: `${runnerShutdownJobLog()}2026-07-23T07:32:51.0000000Z ##[end-action id=__self.__run;outcome=cancelled;conclusion=cancelled;duration_ms=1]\n`,
        }),
      error: /not authorized/u,
    },
    {
      label: "shutdown evidence that changes before dispatch",
      options: () => ({
        ...authenticatedShutdownOptions(),
        annotationPages: [
          [genericCancellationAnnotation()],
          [
            {
              ...genericCancellationAnnotation(),
              start_line: 35,
              end_line: 35,
            },
          ],
        ],
      }),
      error: /evidence changed/u,
    },
  ])("fails closed after reservation for $label", async ({ options, error }) => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(retryRoutes(requests, options()));

    try {
      await expect(retryRunnerLossPrGate(context.command)).rejects.toThrow(error);
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      expect(
        requests.some(
          (request) =>
            request.url.endsWith("/check-runs/18") &&
            request.method === "PATCH" &&
            (request.body as { status?: string }).status === "completed",
        ),
      ).toBe(true);
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

  it("does not let a fresh CI event claim an active runner-loss retry check", async () => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () =>
              githubResponse({
                total_count: 1,
                check_runs: [
                  checkRun(18, {
                    status: "in_progress",
                    conclusion: null,
                    output: { title: "Running 2 E2E checks", summary: "Attempt 2 is running." },
                  }),
                ],
              }),
          ),
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
        startPrGate({
          mode: "start",
          headSha: HEAD_SHA,
          headRepository: "NVIDIA/NemoClaw",
          headBranch: "feature/pr-e2e-gate",
          workflowSha: WORKFLOW_SHA,
          ciConclusion: "success",
          ciDisplayTitle: `CI PR #42 head ${HEAD_SHA} base ${BASE_SHA} gate true`,
          ciRunId: 99,
          ciRunAttempt: 1,
          gateRunId: 77,
          prNumber: 42,
          ...privateControllerPaths(context.workDir),
        }),
      ).rejects.toThrow(/not retryable/u);
      expect(requests).toHaveLength(2);
      expect(requests.some((request) => request.method === "POST")).toBe(false);
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
      expect(fs.readFileSync(context.outputPath, "utf8")).toBe("");
    } finally {
      fs.rmSync(context.workDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "before reservation", replacement: false },
    { label: "after a create response is lost", replacement: true },
  ])("terminalizes retry setup $label with older retryable history", async ({ replacement }) => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    const older = checkRun(16, {
      details_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/22",
      output: {
        title: "PR prerequisite CI did not pass",
        summary: "Prerequisite CI failed.\n\n<!-- nemoclaw-pr-e2e-retry:v1:prerequisite-ci -->",
      },
    });
    const source = checkRun(17);
    const reserved = checkRun(18, {
      status: "in_progress",
      conclusion: null,
      details_url: null,
      output: {
        title: "Waiting for PR CI",
        summary:
          "This PR SHA and base SHA are reserved for deterministic E2E planning after CI completes.",
      },
    });
    const history = replacement ? [older, source, reserved] : [older, source];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => githubResponse(source),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: history.length, check_runs: history }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith(`/check-runs/${replacement ? 18 : 17}`) && method === "PATCH",
            (request) => mutationResponse(request, replacement ? 18 : 17),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(abandonRunnerLossRetrySource(17, 23, 1)).resolves.toBeUndefined();
      const completion = requests.find((request) => request.method === "PATCH");
      expect(completion?.url).toMatch(new RegExp(`/check-runs/${replacement ? 18 : 17}$`, "u"));
      expect(completion?.body).toMatchObject({
        status: "completed",
        conclusion: "failure",
        output: { title: "Runner-loss retry could not start" },
      });
      expect(JSON.stringify(completion?.body)).not.toContain("nemoclaw-pr-e2e-retry:v1:");
      expect(fs.readFileSync(context.outputPath, "utf8")).toBe("finalized=true\n");
    } finally {
      fs.rmSync(context.workDir, { recursive: true, force: true });
    }
  });

  it("rejects an ambiguous retry replacement without mutating either check", async () => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    const source = checkRun(17);
    const ambiguous = checkRun(18, {
      status: "in_progress",
      conclusion: null,
      details_url: null,
      output: { title: "Unexpected owner", summary: "Not a canonical reservation." },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "GET",
            () => githubResponse(source),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: 2, check_runs: [source, ambiguous] }),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(abandonRunnerLossRetrySource(17, 23, 1)).rejects.toThrow(/ambiguous/u);
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
    } finally {
      fs.rmSync(context.workDir, { recursive: true, force: true });
    }
  });

  it("writes the retry authorization marker for an authenticated shutdown log", async () => {
    const context = setup();
    const requests: RecordedGitHubRequest[] = [];
    const currentCheck = checkRun(17, {
      status: "in_progress",
      conclusion: null,
      output: { title: "Running 2 E2E checks", summary: "Attempt 1 is running." },
    });
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
            () => githubResponse({ total_count: 1, check_runs: [currentCheck] }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes("/actions/runs/23/attempts/1/jobs?") && method === "GET",
            () => githubResponse({ total_count: 1, jobs: [hostedRunnerLossJob()] }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith(`/check-runs/${hostedRunnerLossJob().id}`) && method === "GET",
            () => githubResponse(workflowJobCheckRun(hostedRunnerLossJob())),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/check-runs/${hostedRunnerLossJob().id}/annotations?`) &&
              method === "GET",
            () => githubResponse([genericCancellationAnnotation()]),
          ),
          ...jobLogRoutes(),
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
      ).resolves.toBeUndefined();
      expect(fs.readFileSync(context.outputPath, "utf8")).toBe(
        "runner_loss_retry_authorized=true\nfinalized=true\n",
      );
      const completion = requests.find(
        (request) =>
          request.url.endsWith("/check-runs/17") &&
          request.method === "PATCH" &&
          (request.body as { status?: string }).status === "completed",
      );
      expect(completion?.body).toMatchObject({ conclusion: "failure" });
      expect(JSON.stringify(completion?.body)).toContain(RETRY_MARKER);
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
            () => githubResponse({ total_count: 1, jobs: [hostedRunnerLossJob(24)] }),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.endsWith(`/check-runs/${hostedRunnerLossJob().id}`) && method === "GET",
            () => githubResponse(workflowJobCheckRun(hostedRunnerLossJob(24))),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/check-runs/${hostedRunnerLossJob().id}/annotations?`) &&
              method === "GET",
            () => githubResponse([runnerLossAnnotation()]),
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
      const expectedFinalization =
        conclusion === "success"
          ? expect(finalization).rejects.toThrow(/Evidence download did not complete/u)
          : expect(finalization).resolves.toBeUndefined();
      await expectedFinalization;
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
            ({ url, method }) =>
              url.endsWith(`/check-runs/${hostedRunnerLossJob().id}`) && method === "GET",
            () => githubResponse(workflowJobCheckRun(hostedRunnerLossJob())),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/check-runs/${hostedRunnerLossJob().id}/annotations?`) &&
              method === "GET",
            () => githubResponse([runnerLossAnnotation()]),
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

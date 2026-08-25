// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverHostedRunnerLoss } from "../../../tools/e2e/hosted-runner-recovery.mts";
import {
  createGitHubFetchRouter,
  githubFetchRoute,
  type RecordedGitHubRequest,
} from "../../support/github-fetch-router.ts";

const REPOSITORY = "NVIDIA/NemoClaw";
const MAIN_SHA = "d".repeat(40);
const SOURCE_RUN_ID = 29_897_237_525;
const JOB_ID = 89_074_697_099;
const RUN_API_URL = `https://api.github.com/repos/${REPOSITORY}/actions/runs/${SOURCE_RUN_ID}`;
const RUN_HTML_URL = `https://github.com/${REPOSITORY}/actions/runs/${SOURCE_RUN_ID}`;
const JOB_API_URL = `https://api.github.com/repos/${REPOSITORY}/actions/jobs/${JOB_ID}`;
const JOB_HTML_URL = `${RUN_HTML_URL}/job/${JOB_ID}`;
const CHECK_URL = `https://api.github.com/repos/${REPOSITORY}/check-runs/${JOB_ID}`;
const INTERNAL_ERROR_MESSAGE =
  "GitHub Actions has encountered an internal error when running your job.";
const RUNNER_LOSS_MESSAGE =
  "The hosted runner lost communication with the server. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function githubResponse(value?: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (value === undefined ? "" : JSON.stringify(value)),
  } as Response;
}

type SourceOverrides = {
  conclusion?: string | null;
  created_at?: string;
  display_title?: string;
  event?: string;
  head_branch?: string;
  head_repository?: { full_name: string };
  head_sha?: string;
  html_url?: string;
  id?: number;
  name?: string;
  path?: string;
  repository?: { full_name: string };
  run_attempt?: number;
  status?: string;
  workflow_id?: number;
};

function sourceRun(overrides: SourceOverrides = {}) {
  const id = overrides.id ?? SOURCE_RUN_ID;
  return {
    id,
    name: "CI / Platform Compatibility",
    path: ".github/workflows/platform-vitest-main.yaml",
    workflow_id: 304_268_429,
    created_at: "2026-07-25T10:00:00Z",
    event: "push",
    head_branch: "main",
    head_sha: MAIN_SHA,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    display_title: "refactor(e2e): consolidate platform evidence",
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${id}`,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function workflowForSource(source: ReturnType<typeof sourceRun>) {
  return {
    id: source.workflow_id,
    name:
      source.path === ".github/workflows/platform-vitest-main.yaml"
        ? "CI / Platform Compatibility"
        : "unknown",
    path: source.path,
    state: "active",
  };
}

function runnerLossAnnotation(message = RUNNER_LOSS_MESSAGE, sha = MAIN_SHA) {
  return {
    path: ".github",
    blob_href: `https://github.com/${REPOSITORY}/blob/${sha}/.github`,
    start_line: 1,
    start_column: null,
    end_line: 1,
    end_column: null,
    annotation_level: "failure",
    title: "",
    message,
    raw_details: "",
  };
}

function hostedRunnerLossJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    run_id: SOURCE_RUN_ID,
    run_attempt: 1,
    head_sha: MAIN_SHA,
    run_url: RUN_API_URL,
    url: JOB_API_URL,
    html_url: JOB_HTML_URL,
    check_run_url: CHECK_URL,
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
      { name: "Run live test", status: "completed", conclusion: "cancelled" },
      { name: "Upload artifacts", status: "completed", conclusion: "skipped" },
      { name: "Complete job", status: "completed", conclusion: "success" },
    ],
    ...overrides,
  };
}

function internalErrorJob(label: "windows-latest" | "macos-26") {
  const runnerId = label === "windows-latest" ? 1_021_277_394 : 1_021_277_395;
  return hostedRunnerLossJob({
    name: `Platform E2E (${label})`,
    conclusion: "cancelled",
    runner_id: runnerId,
    runner_name: `GitHub Actions ${runnerId}`,
    labels: [label],
    steps: [
      { name: "Set up job", status: "completed", conclusion: "success" },
      { name: "Run platform test", status: "in_progress", conclusion: null },
      { name: "Upload artifacts", status: "pending", conclusion: null },
    ],
  });
}

function ordinaryFailureJob() {
  return {
    ...hostedRunnerLossJob(),
    id: JOB_ID + 1,
    url: `https://api.github.com/repos/${REPOSITORY}/actions/jobs/${JOB_ID + 1}`,
    html_url: `${RUN_HTML_URL}/job/${JOB_ID + 1}`,
    check_run_url: `https://api.github.com/repos/${REPOSITORY}/check-runs/${JOB_ID + 1}`,
    name: "ordinary assertion",
    runner_id: null,
    runner_name: null,
    annotations: undefined,
    steps: [{ name: "Run tests", status: "completed", conclusion: "failure" }],
  };
}

function checkRun(job: ReturnType<typeof hostedRunnerLossJob>) {
  return {
    id: job.id,
    name: job.name,
    head_sha: job.head_sha,
    url: job.check_run_url,
    html_url: job.html_url,
    details_url: job.html_url,
    status: "completed",
    conclusion: job.conclusion,
    app: { id: 15368, slug: "github-actions" },
    output: {
      annotations_count: 1,
      annotations_url: `${job.check_run_url}/annotations`,
    },
  };
}

type RouteOptions = {
  annotations?: unknown[][];
  jobListings?: Array<{ total_count: number; jobs: unknown[] }>;
  rerunStatus?: number;
  runListings?: Array<{ total_count: number; workflow_runs: unknown[] }>;
  sources?: unknown[];
  workflows?: unknown[];
};

function setupRoutes(options: RouteOptions = {}) {
  const requests: RecordedGitHubRequest[] = [];
  let sourceRead = 0;
  let jobsRead = 0;
  let annotationRead = 0;
  let runListingRead = 0;
  let workflowRead = 0;
  let lastSource = sourceRun();
  const lastJobs = new Map<number, ReturnType<typeof hostedRunnerLossJob>>();
  const defaultJob = hostedRunnerLossJob();
  const defaultListing = { total_count: 1, jobs: [defaultJob] };
  const sources = options.sources ?? [sourceRun(), sourceRun()];
  const jobListings = options.jobListings ?? [defaultListing, defaultListing];

  vi.stubGlobal(
    "fetch",
    createGitHubFetchRouter(
      [
        githubFetchRoute(
          ({ url, method }) => url.endsWith(`/actions/runs/${SOURCE_RUN_ID}`) && method === "GET",
          () => {
            lastSource = sources[Math.min(sourceRead++, sources.length - 1)] as ReturnType<
              typeof sourceRun
            >;
            return githubResponse(lastSource);
          },
        ),
        githubFetchRoute(
          ({ url, method }) =>
            url.endsWith(`/actions/workflows/${lastSource.workflow_id}`) && method === "GET",
          () => {
            const workflow =
              options.workflows?.[Math.min(workflowRead, (options.workflows?.length ?? 1) - 1)] ??
              workflowForSource(lastSource);
            workflowRead += 1;
            return githubResponse(workflow);
          },
        ),
        githubFetchRoute(
          ({ url, method }) =>
            url.includes(`/actions/workflows/${lastSource.workflow_id}/runs?`) && method === "GET",
          () => {
            const listing = options.runListings
              ? options.runListings[Math.min(runListingRead, options.runListings.length - 1)]
              : { total_count: 1, workflow_runs: [lastSource] };
            runListingRead += 1;
            return githubResponse(listing);
          },
        ),
        githubFetchRoute(
          ({ url, method }) =>
            url.includes(`/actions/runs/${SOURCE_RUN_ID}/attempts/1/jobs?`) && method === "GET",
          (request) => {
            const page = Number(new URL(request.url).searchParams.get("page"));
            const listing =
              page === 1
                ? jobListings[Math.min(jobsRead++, jobListings.length - 1)]
                : { total_count: 0, jobs: [] };
            for (const candidate of listing?.jobs ?? []) {
              const job = candidate as ReturnType<typeof hostedRunnerLossJob>;
              expect(Number.isSafeInteger(job.id)).toBe(true);
              lastJobs.set(job.id, job);
            }
            return githubResponse(listing);
          },
        ),
        githubFetchRoute(
          ({ url, method }) => /\/check-runs\/[1-9][0-9]*$/u.test(url) && method === "GET",
          (request) => {
            const id = Number(request.url.split("/").at(-1));
            const job = lastJobs.get(id);
            expect(job, `missing job fixture for check ${id}`).toBeDefined();
            return githubResponse(checkRun(job!));
          },
        ),
        githubFetchRoute(
          ({ url, method }) => url.includes("/annotations?") && method === "GET",
          (request) => {
            const id = Number(/\/check-runs\/([1-9][0-9]*)\/annotations/u.exec(request.url)?.[1]);
            const job = lastJobs.get(id);
            expect(job, `missing job fixture for annotations ${id}`).toBeDefined();
            const defaultAnnotation =
              job!.conclusion === "cancelled"
                ? runnerLossAnnotation(INTERNAL_ERROR_MESSAGE, job!.head_sha)
                : runnerLossAnnotation(RUNNER_LOSS_MESSAGE, job!.head_sha);
            const annotations = options.annotations?.[
              Math.min(annotationRead, (options.annotations?.length ?? 1) - 1)
            ] ?? [defaultAnnotation];
            annotationRead += 1;
            return githubResponse(annotations);
          },
        ),
        githubFetchRoute(
          ({ url, method }) =>
            url.endsWith(`/actions/runs/${SOURCE_RUN_ID}/rerun`) && method === "POST",
          () =>
            options.rerunStatus && options.rerunStatus !== 201
              ? githubResponse({ message: "rerun unavailable" }, options.rerunStatus)
              : githubResponse(undefined, 201),
        ),
      ],
      requests,
    ),
  );
  return requests;
}

function recoveryRequest() {
  return {
    repository: REPOSITORY,
    token: "token",
    controllerRunAttempt: 1,
    sourceRunId: SOURCE_RUN_ID,
  };
}

function mutationRequests(requests: RecordedGitHubRequest[]) {
  return requests.filter((request) => request.method !== "GET");
}

describe("hosted-runner recovery controller", () => {
  it.each([
    {
      label: "platform Ubuntu main push",
      source: sourceRun(),
      job: hostedRunnerLossJob(),
    },
    {
      label: "platform Windows main push",
      source: sourceRun(),
      job: internalErrorJob("windows-latest"),
    },
    {
      label: "platform macOS main push",
      source: sourceRun(),
      job: internalErrorJob("macos-26"),
    },
  ])("requests one full rerun for exact $label runner loss (#7140)", async ({ source, job }) => {
    const listing = { total_count: 1, jobs: [job] };
    const requests = setupRoutes({
      sources: [source, source],
      jobListings: [listing, listing],
    });

    await expect(recoverHostedRunnerLoss(recoveryRequest())).resolves.toEqual({
      action: "rerun-requested",
      reason: "exact hosted-runner-loss evidence remained stable across both reads",
    });
    expect(mutationRequests(requests)).toEqual([
      {
        method: "POST",
        url: `${RUN_API_URL}/rerun`,
      },
    ]);
    expect(requests.some((request) => request.url.endsWith("/rerun-failed-jobs"))).toBe(false);
  });

  it("requests a rerun when GitHub returns null annotation title and raw details (#7140)", async () => {
    const annotation = { ...runnerLossAnnotation(), title: null, raw_details: null };
    const requests = setupRoutes({ annotations: [[annotation], [annotation]] });

    await expect(recoverHostedRunnerLoss(recoveryRequest())).resolves.toMatchObject({
      action: "rerun-requested",
    });
    expect(mutationRequests(requests)).toHaveLength(1);
  });

  it.each([
    ["a non-string title", { title: 7 }],
    ["non-string raw details", { raw_details: false }],
    ["an oversized title", { title: "x".repeat(16 * 1024 + 1) }],
    ["oversized raw details", { raw_details: "x".repeat(16 * 1024 + 1) }],
  ])("rejects an annotation with $label (#7140)", async (_label, override) => {
    const requests = setupRoutes({
      annotations: [[{ ...runnerLossAnnotation(), ...override }]],
    });

    await expect(recoverHostedRunnerLoss(recoveryRequest())).rejects.toThrow(
      /invalid workflow job annotation/u,
    );
    expect(mutationRequests(requests)).toEqual([]);
  });

  it.each([
    {
      label: "platform on a self-hosted runner",
      source: sourceRun(),
      job: hostedRunnerLossJob({ labels: ["self-hosted"] }),
    },
    {
      label: "platform on an unapproved runner",
      source: sourceRun(),
      job: hostedRunnerLossJob({ labels: ["ubuntu-24.04"] }),
    },
    {
      label: "platform with multiple runner labels",
      source: sourceRun(),
      job: hostedRunnerLossJob({ labels: ["ubuntu-latest", "self-hosted"] }),
    },
  ])("does not broaden allowed runner labels for $label (#7140)", async ({ source, job }) => {
    const listing = { total_count: 1, jobs: [job] };
    const requests = setupRoutes({
      sources: [source],
      jobListings: [listing],
    });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).resolves.toMatchObject({
      action: "ignored",
    });
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("reruns the latest eligible source even after main advances (#7140)", async () => {
    const olderSha = "c".repeat(40);
    const source = sourceRun({ head_sha: olderSha });
    const job = hostedRunnerLossJob({ head_sha: olderSha });
    const requests = setupRoutes({
      sources: [source],
      jobListings: [{ total_count: 1, jobs: [job] }],
    });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).resolves.toMatchObject({
      action: "rerun-requested",
    });
    expect(mutationRequests(requests)).toHaveLength(1);
    expect(requests.some((request) => request.url.includes("/git/ref/heads/main"))).toBe(false);
  });

  it("ignores a manually dispatched platform run (#7140)", async () => {
    const requests = setupRoutes({ sources: [sourceRun({ event: "workflow_dispatch" })] });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).resolves.toMatchObject({
      action: "ignored",
    });
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("does not rerun when a newer eligible main run exists (#7140)", async () => {
    const source = sourceRun();
    const newer = sourceRun({
      id: SOURCE_RUN_ID + 100,
      created_at: "2026-07-25T11:00:00Z",
      head_sha: "e".repeat(40),
      conclusion: "success",
    });
    const requests = setupRoutes({
      sources: [source],
      runListings: [{ total_count: 2, workflow_runs: [newer, source] }],
    });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).resolves.toMatchObject({
      action: "ignored",
    });
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("ignores a newer manual run when selecting the latest eligible main push (#7140)", async () => {
    const source = sourceRun();
    const newerManualRun = sourceRun({
      id: SOURCE_RUN_ID + 100,
      created_at: "2026-07-25T11:00:00Z",
      event: "workflow_dispatch",
      head_sha: "e".repeat(40),
      conclusion: "success",
      display_title: "Manual platform evidence",
    });
    const requests = setupRoutes({
      sources: [source],
      runListings: [{ total_count: 2, workflow_runs: [newerManualRun, source] }],
    });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).resolves.toMatchObject({
      action: "rerun-requested",
    });
    expect(mutationRequests(requests)).toHaveLength(1);
  });

  it.each([
    {
      label: "incomplete listing",
      listing: { total_count: 2, workflow_runs: [sourceRun()] },
      message: /listing was incomplete/u,
    },
    {
      label: "duplicate run IDs",
      listing: { total_count: 2, workflow_runs: [sourceRun(), sourceRun()] },
      message: /duplicate workflow run IDs/u,
    },
    {
      label: "source run absent",
      listing: {
        total_count: 1,
        workflow_runs: [
          sourceRun({
            id: SOURCE_RUN_ID + 100,
            created_at: "2026-07-25T11:00:00Z",
          }),
        ],
      },
      message: /source run was not found/u,
    },
    {
      label: "ambiguous ordering",
      listing: {
        total_count: 2,
        workflow_runs: [
          sourceRun({
            id: SOURCE_RUN_ID - 100,
            created_at: "2026-07-25T09:00:00Z",
          }),
          sourceRun(),
        ],
      },
      message: /ambiguously ordered/u,
    },
  ])("rejects an unsafe latest-run $label (#7140)", async ({ listing, message }) => {
    const requests = setupRoutes({ runListings: [listing] });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).rejects.toThrow(message);
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("rejects mixed runner loss and ordinary failure evidence (#7140)", async () => {
    const jobs = [hostedRunnerLossJob(), ordinaryFailureJob()];
    const requests = setupRoutes({
      jobListings: [{ total_count: jobs.length, jobs }],
    });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).resolves.toMatchObject({
      action: "ignored",
    });
    expect(mutationRequests(requests)).toEqual([]);
  });

  it.each([
    {
      label: "zero jobs",
      listing: { total_count: 0, jobs: [] },
    },
    {
      label: "incomplete listing",
      listing: { total_count: 2, jobs: [hostedRunnerLossJob()] },
    },
  ])("never reruns with $label (#7140)", async ({ listing }) => {
    const requests = setupRoutes({ jobListings: [listing] });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).resolves.toMatchObject({
      action: "ignored",
    });
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("never reruns a listing with duplicate job IDs (#7140)", async () => {
    const requests = setupRoutes({
      jobListings: [
        {
          total_count: 2,
          jobs: [hostedRunnerLossJob(), hostedRunnerLossJob({ name: "duplicate" })],
        },
      ],
    });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).rejects.toThrow(
      /duplicate workflow job IDs/u,
    );
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("rejects source evidence that changes on the confirmation read (#7140)", async () => {
    const requests = setupRoutes({
      sources: [sourceRun(), sourceRun({ display_title: "changed commit title" })],
    });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).rejects.toThrow(
      /evidence changed during runner-loss evidence collection/u,
    );
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("rejects latest-run evidence that changes after job collection (#7140)", async () => {
    const source = sourceRun();
    const olderManualRun = sourceRun({
      id: SOURCE_RUN_ID - 100,
      created_at: "2026-07-25T09:00:00Z",
      event: "workflow_dispatch",
      conclusion: "success",
      display_title: "Manual platform evidence",
    });
    const baseline = { total_count: 1, workflow_runs: [source] };
    const changed = { total_count: 2, workflow_runs: [source, olderManualRun] };
    const requests = setupRoutes({
      sources: [source],
      runListings: [baseline, changed],
    });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).rejects.toThrow(
      /evidence changed during runner-loss evidence collection/u,
    );
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("rejects latest-run evidence that changes between snapshots (#7140)", async () => {
    const source = sourceRun();
    const olderManualRun = sourceRun({
      id: SOURCE_RUN_ID - 100,
      created_at: "2026-07-25T09:00:00Z",
      event: "workflow_dispatch",
      conclusion: "success",
      display_title: "Manual platform evidence",
    });
    const baseline = { total_count: 1, workflow_runs: [source] };
    const changed = { total_count: 2, workflow_runs: [source, olderManualRun] };
    const requests = setupRoutes({
      sources: [source],
      runListings: [baseline, baseline, changed, changed],
    });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).rejects.toThrow(
      /evidence changed before rerun/u,
    );
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("rejects job evidence that changes on the confirmation read (#7140)", async () => {
    const firstJob = hostedRunnerLossJob();
    const secondJob = hostedRunnerLossJob({ name: "Hermes security-posture changed" });
    const requests = setupRoutes({
      jobListings: [
        { total_count: 1, jobs: [firstJob] },
        { total_count: 1, jobs: [secondJob] },
      ],
    });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).rejects.toThrow(
      /evidence changed before rerun/u,
    );
    expect(mutationRequests(requests)).toEqual([]);
  });

  it.each([
    ["name", { ...workflowForSource(sourceRun()), name: "Platform workflow renamed" }],
    ["path", { ...workflowForSource(sourceRun()), path: ".github/workflows/other.yaml" }],
    ["state", { ...workflowForSource(sourceRun()), state: "disabled_manually" }],
  ])("ignores source workflow metadata with the wrong %s (#7140)", async (_field, workflow) => {
    const requests = setupRoutes({ workflows: [workflow] });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).resolves.toMatchObject({
      action: "ignored",
    });
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("never mutates from controller attempt two (#7140)", async () => {
    const requests = setupRoutes();
    await expect(
      recoverHostedRunnerLoss({ ...recoveryRequest(), controllerRunAttempt: 2 }),
    ).resolves.toMatchObject({ action: "ignored" });
    expect(requests).toEqual([]);
  });

  it("never mutates source attempt two (#7140)", async () => {
    const requests = setupRoutes({
      sources: [sourceRun({ run_attempt: 2 })],
    });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).resolves.toMatchObject({
      action: "ignored",
    });
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("never repeats an ambiguous rerun mutation (#7140)", async () => {
    const requests = setupRoutes({ rerunStatus: 500 });
    await expect(recoverHostedRunnerLoss(recoveryRequest())).rejects.toThrow(
      /actions\/runs\/29897237525\/rerun failed: 500/u,
    );
    expect(mutationRequests(requests)).toHaveLength(1);
  });
});

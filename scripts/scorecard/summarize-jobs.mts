// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type ApiJob = {
  completed_at?: string | null;
  conclusion?: string | null;
  created_at?: string | null;
  html_url?: string | null;
  labels?: string[] | null;
  name: string;
  run_attempt?: number | null;
  started_at?: string | null;
  status?: string | null;
};

type NeedResult = { result?: string };

type FailedJob = { name: string; url: string | null };

type CountedResult = "cancelled" | "failure" | "skipped" | "success";

export type JobTimingRow = {
  executionMs: number | null;
  name: string;
  outcome: CountedResult;
  queueMs: number | null;
  runnerClass: "larger" | "standard" | "unknown";
};

export type JobSummary = {
  cancelled: number;
  failedJobs: FailedJob[];
  failure: number;
  ran: number;
  skipped: number;
  success: number;
  timingRows: JobTimingRow[];
  total: number;
};

export type SummarizeJobsInput = {
  apiJobs: ApiJob[] | null;
  explicitOnlyJobNames: string[];
  explicitlySelected: string[];
  metaJobNames: string[];
  needs: Record<string, NeedResult>;
};

export type WorkflowRunJobsDeps = {
  context: {
    repo: { owner: string; repo: string };
    runId: number;
  };
  core: { warning: (message: string) => void };
  github: {
    paginate: (method: unknown, parameters: Record<string, unknown>) => Promise<ApiJob[]>;
    rest: { actions: { listJobsForWorkflowRun: unknown } };
  };
};

function isSelectiveDispatch(eventName: string, rawJobs = "", rawTargets = ""): boolean {
  return eventName === "workflow_dispatch" && (rawJobs.trim() !== "" || rawTargets.trim() !== "");
}

function classifyApiJob(job: ApiJob): CountedResult {
  if (job.conclusion === "success") return "success";
  if (job.conclusion === "failure") return "failure";
  if (job.conclusion === "cancelled") return "cancelled";
  if (job.conclusion === "skipped" || job.status !== "completed") return "skipped";
  return "failure";
}

function classifyNeed(value: NeedResult): CountedResult {
  if (value.result === "success") return "success";
  if (value.result === "failure") return "failure";
  if (value.result === "cancelled") return "cancelled";
  if (value.result === "skipped") return "skipped";
  return "failure";
}

function countResults(
  results: CountedResult[],
): Omit<JobSummary, "failedJobs" | "ran" | "timingRows" | "total"> {
  return {
    cancelled: results.filter((result) => result === "cancelled").length,
    failure: results.filter((result) => result === "failure").length,
    skipped: results.filter((result) => result === "skipped").length,
    success: results.filter((result) => result === "success").length,
  };
}

function elapsedMs(
  start: string | null | undefined,
  finish: string | null | undefined,
): number | null {
  if (!start || !finish) return null;
  const startMs = Date.parse(start);
  const finishMs = Date.parse(finish);
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs < startMs) return null;
  return finishMs - startMs;
}

function normalizeRunnerClass(
  labels: string[] | null | undefined,
): JobTimingRow["runnerClass"] {
  if (!labels || labels.length === 0) return "unknown";
  const normalized = new Set(labels.map((label) => label.toLowerCase()));
  if (normalized.has("self-hosted")) return "unknown";
  if (normalized.has("ubuntu-latest")) return "standard";
  return "larger";
}

function summarizeJobTimings(jobs: ApiJob[]): JobTimingRow[] {
  return jobs
    .map(
      (job): JobTimingRow => ({
        executionMs: elapsedMs(job.started_at, job.completed_at),
        name: job.name,
        outcome: classifyApiJob(job),
        queueMs: elapsedMs(job.created_at, job.started_at),
        runnerClass: normalizeRunnerClass(job.labels),
      }),
    )
    .filter((row) => row.executionMs !== null || row.queueMs !== null)
    .sort(
      (left, right) =>
        (right.executionMs ?? 0) +
          (right.queueMs ?? 0) -
          ((left.executionMs ?? 0) + (left.queueMs ?? 0)) || left.name.localeCompare(right.name),
    )
    .slice(0, 10);
}

function preferCandidate(candidate: ApiJob, existing: ApiJob | undefined): boolean {
  if (!existing) return true;
  const candidateAttempt = candidate.run_attempt ?? 0;
  const existingAttempt = existing.run_attempt ?? 0;
  if (candidateAttempt !== existingAttempt) return candidateAttempt > existingAttempt;
  return (candidate.completed_at ?? "") > (existing.completed_at ?? "");
}

function normalizeApiJobs(apiJobs: ApiJob[]): ApiJob[] {
  const dedupedByName = new Map<string, ApiJob>();
  for (const job of apiJobs) {
    const name = job.name.replace(/ \/ [^/]+$/u, "");
    const candidate = { ...job, name };
    if (preferCandidate(candidate, dedupedByName.get(name))) {
      dedupedByName.set(name, candidate);
    }
  }
  return [...dedupedByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function loadWorkflowRunJobs({
  context,
  core,
  github,
}: WorkflowRunJobsDeps): Promise<ApiJob[] | null> {
  try {
    return await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      run_id: context.runId,
      per_page: 100,
    });
  } catch (error) {
    const status =
      error !== null && typeof error === "object" && "status" in error
        ? String(error.status)
        : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    core.warning(
      `Could not fetch jobs from API (status ${status}); falling back to needs context. Reason: ${message.slice(0, 200)}`,
    );
    return null;
  }
}

function summarizeJobs(input: SummarizeJobsInput): JobSummary {
  const metaJobs = new Set(input.metaJobNames);
  const explicitOnly = new Set(input.explicitOnlyJobNames);
  const selected = new Set(input.explicitlySelected);

  if (input.apiJobs !== null) {
    const eligibleJobs = input.apiJobs.filter((job) => {
      const name = job.name.replace(/ \/ [^/]+$/u, "");
      return !metaJobs.has(name) && (!explicitOnly.has(name) || selected.has(name));
    });
    const jobs = normalizeApiJobs(eligibleJobs);
    const classified = jobs.map((job) => ({ job, result: classifyApiJob(job) }));
    const counts = countResults(classified.map(({ result }) => result));
    return {
      ...counts,
      failedJobs: classified
        .filter(({ result }) => result === "failure")
        .map(({ job }) => ({ name: job.name, url: job.html_url ?? null })),
      ran: jobs.length - counts.skipped,
      timingRows: summarizeJobTimings(eligibleJobs),
      total: jobs.length,
    };
  }

  const entries = Object.entries(input.needs)
    .filter(([name]) => !metaJobs.has(name))
    .filter(([name]) => !explicitOnly.has(name) || selected.has(name))
    .sort(([left], [right]) => left.localeCompare(right));
  const classified = entries.map(([name, value]) => ({ name, result: classifyNeed(value) }));
  const counts = countResults(classified.map(({ result }) => result));
  return {
    ...counts,
    failedJobs: classified
      .filter(({ result }) => result === "failure")
      .map(({ name }) => ({ name, url: null })),
    ran: entries.length - counts.skipped,
    timingRows: [],
    total: entries.length,
  };
}

export { isSelectiveDispatch, loadWorkflowRunJobs, summarizeJobs };

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type ApiJob = {
  completed_at?: string | null;
  conclusion?: string | null;
  created_at?: string | null;
  html_url?: string | null;
  id?: number | null;
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

function normalizeRunnerClass(labels: string[] | null | undefined): JobTimingRow["runnerClass"] {
  if (!labels || labels.length === 0) return "unknown";
  const normalized = new Set(labels.map((label) => label.toLowerCase()));
  if (normalized.has("self-hosted")) return "unknown";
  if (normalized.has("ubuntu-latest")) return "standard";
  return "larger";
}

type JobExecutionTiming = {
  createdMs: number | null;
  executionFingerprint: string;
  executionMs: number;
  job: ApiJob;
  queueMs: number | null;
};

function executionFingerprint(job: ApiJob): string | null {
  if (!job.started_at || !job.completed_at || !job.conclusion) return null;
  const startedMs = Date.parse(job.started_at);
  const completedMs = Date.parse(job.completed_at);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
    return null;
  }
  return JSON.stringify([startedMs, completedMs, job.conclusion]);
}

function jobExecutionTiming(job: ApiJob): JobExecutionTiming | null {
  const fingerprint = executionFingerprint(job);
  if (!fingerprint || !job.started_at || !job.completed_at) return null;
  const createdMs = job.created_at ? Date.parse(job.created_at) : Number.NaN;
  const startedMs = Date.parse(job.started_at);
  const completedMs = Date.parse(job.completed_at);
  const hasCoherentQueue = Number.isFinite(createdMs) && createdMs <= startedMs;
  return {
    createdMs: hasCoherentQueue ? createdMs : null,
    executionFingerprint: fingerprint,
    executionMs: completedMs - startedMs,
    job,
    queueMs: hasCoherentQueue ? startedMs - createdMs : null,
  };
}

function timingExecutionKey(name: string, executionFingerprint: string): string {
  return JSON.stringify([name, executionFingerprint]);
}

function preferTimingRepresentative(
  candidate: JobExecutionTiming,
  existing: JobExecutionTiming | undefined,
): boolean {
  if (!existing) return true;
  const candidateIsCoherent = candidate.queueMs !== null;
  const existingIsCoherent = existing.queueMs !== null;
  if (candidateIsCoherent !== existingIsCoherent) return candidateIsCoherent;
  const candidateAttempt = candidate.job.run_attempt ?? 0;
  const existingAttempt = existing.job.run_attempt ?? 0;
  if (candidateAttempt !== existingAttempt) return candidateAttempt < existingAttempt;
  const candidateCreatedMs = candidate.createdMs ?? Number.POSITIVE_INFINITY;
  const existingCreatedMs = existing.createdMs ?? Number.POSITIVE_INFINITY;
  if (candidateCreatedMs !== existingCreatedMs) return candidateCreatedMs < existingCreatedMs;
  return (candidate.job.id ?? 0) < (existing.job.id ?? 0);
}

function summarizeJobTimings(jobs: ApiJob[]): JobTimingRow[] {
  const latestByName = new Map<string, ApiJob>();
  const timingByExecution = new Map<string, JobExecutionTiming>();
  for (const job of jobs) {
    if (preferCandidate(job, latestByName.get(job.name))) {
      latestByName.set(job.name, job);
    }
    const timing = jobExecutionTiming(job);
    if (!timing) continue;
    const key = timingExecutionKey(job.name, timing.executionFingerprint);
    if (preferTimingRepresentative(timing, timingByExecution.get(key))) {
      timingByExecution.set(key, timing);
    }
  }

  return [...latestByName.values()]
    .flatMap((job): JobTimingRow[] => {
      const fingerprint = executionFingerprint(job);
      if (!fingerprint) return [];
      const timing = timingByExecution.get(timingExecutionKey(job.name, fingerprint));
      if (!timing) return [];
      return [
        {
          executionMs: timing.executionMs,
          name: timing.job.name,
          outcome: classifyApiJob(timing.job),
          queueMs: timing.queueMs,
          runnerClass: normalizeRunnerClass(timing.job.labels),
        },
      ];
    })
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
      filter: "all",
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

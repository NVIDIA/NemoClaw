// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type ApiJob = {
  completed_at?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
  name: string;
  run_attempt?: number | null;
  status?: string | null;
};

type NeedResult = { result?: string };

type FailedJob = { name: string; url: string | null };

export type JobSummary = {
  cancelled: number;
  failedJobs: FailedJob[];
  failure: number;
  ran: number;
  skipped: number;
  success: number;
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

type CountedResult = "cancelled" | "failure" | "skipped" | "success";

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

function countResults(results: CountedResult[]): Omit<JobSummary, "failedJobs" | "ran" | "total"> {
  return {
    cancelled: results.filter((result) => result === "cancelled").length,
    failure: results.filter((result) => result === "failure").length,
    skipped: results.filter((result) => result === "skipped").length,
    success: results.filter((result) => result === "success").length,
  };
}

function preferCandidate(candidate: ApiJob, existing: ApiJob | undefined): boolean {
  if (!existing) return true;
  const candidateAttempt = candidate.run_attempt ?? 0;
  const existingAttempt = existing.run_attempt ?? 0;
  if (candidateAttempt !== existingAttempt) return candidateAttempt > existingAttempt;
  return (candidate.completed_at ?? "") > (existing.completed_at ?? "");
}

function normalizeApiJobs(
  apiJobs: ApiJob[],
  metaJobs: Set<string>,
  explicitOnly: Set<string>,
  selected: Set<string>,
): ApiJob[] {
  const dedupedByName = new Map<string, ApiJob>();
  for (const job of apiJobs) {
    const name = job.name.replace(/ \/ [^/]+$/u, "");
    if (metaJobs.has(name)) continue;
    if (explicitOnly.has(name) && !selected.has(name)) continue;
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
    const jobs = normalizeApiJobs(input.apiJobs, metaJobs, explicitOnly, selected);
    const classified = jobs.map((job) => ({ job, result: classifyApiJob(job) }));
    const counts = countResults(classified.map(({ result }) => result));
    return {
      ...counts,
      failedJobs: classified
        .filter(({ result }) => result === "failure")
        .map(({ job }) => ({ name: job.name, url: job.html_url ?? null })),
      ran: jobs.length - counts.skipped,
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
    total: entries.length,
  };
}

module.exports = { isSelectiveDispatch, loadWorkflowRunJobs, summarizeJobs };

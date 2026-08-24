/**
 * Read one GitHub Actions run and return bounded, normalized run and job metadata.
 */
export default async function github_actions_run_summary(input: {
  workdir: string;
  repository: string;
  runId: Integer;
}): Promise<{
  run: {
    id: Integer;
    attempt: Integer;
    workflowName: string;
    event: string;
    status: string;
    conclusion: string | null;
    headSha: string;
    createdAt: string;
    updatedAt: string;
    url: string;
  };
  jobs: Array<{
    id: Integer;
    name: string;
    status: string;
    conclusion: string | null;
    startedAt: string;
    completedAt: string;
    url: string;
    failedStep: string | null;
  }>;
}> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository))
    throw new Error("repository must have owner/name form");
  if (!Number.isSafeInteger(input.runId) || input.runId < 1)
    throw new Error("runId must be a positive integer");
  const result = await tools.run_github_cli({
    workdir: input.workdir,
    args: [
      "run",
      "view",
      String(input.runId),
      "--repo",
      input.repository,
      "--json",
      "databaseId,attempt,workflowName,event,status,conclusion,headSha,createdAt,updatedAt,url,jobs",
    ],
    timeoutMs: 120000,
  });
  const value = JSON.parse(result.stdout);
  if (!Array.isArray(value.jobs) || value.jobs.length > 1000)
    throw new Error("GitHub Actions run returned an invalid or oversized job list");
  const jobs = value.jobs.map((job) => {
    if (!Array.isArray(job.steps) || job.steps.length > 1000)
      throw new Error("GitHub Actions run returned an invalid or oversized step list");
    return {
      id: job.databaseId,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion ?? null,
      startedAt: job.startedAt ?? "",
      completedAt: job.completedAt ?? "",
      url: job.url,
      failedStep: job.steps.find((step) => step.conclusion === "failure")?.name ?? null,
    };
  });
  return {
    run: {
      id: value.databaseId,
      attempt: value.attempt,
      workflowName: value.workflowName,
      event: value.event,
      status: value.status,
      conclusion: value.conclusion ?? null,
      headSha: value.headSha,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      url: value.url,
    },
    jobs,
  };
}

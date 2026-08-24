/**
 * Compare two GitHub Actions runs by exact job name and conclusion.
 */
export default async function github_actions_run_diff(input: {
  workdir: string;
  repository: string;
  earlierRunId: Integer;
  recentRunId: Integer;
}): Promise<{
  earlier: { id: Integer; headSha: string; url: string };
  recent: { id: Integer; headSha: string; url: string };
  newlyFailing: Array<{
    name: string;
    earlierConclusion: string | null;
    recentConclusion: string | null;
    recentJobId: Integer;
    url: string;
  }>;
  newlyPassing: Array<{
    name: string;
    earlierConclusion: string | null;
    recentConclusion: string | null;
    recentJobId: Integer;
    url: string;
  }>;
  persistentFailures: Array<{ name: string; recentJobId: Integer; url: string }>;
  added: Array<{ name: string; conclusion: string | null; recentJobId: Integer; url: string }>;
  removed: Array<{ name: string; conclusion: string | null; earlierJobId: Integer; url: string }>;
}> {
  const earlier = await tools.github_actions_run_summary({
    workdir: input.workdir,
    repository: input.repository,
    runId: input.earlierRunId,
  });
  const recent = await tools.github_actions_run_summary({
    workdir: input.workdir,
    repository: input.repository,
    runId: input.recentRunId,
  });
  const earlierByName = new Map(earlier.jobs.map((job) => [job.name, job]));
  const recentByName = new Map(recent.jobs.map((job) => [job.name, job]));
  const isFailure = (value: string | null) =>
    value === "failure" ||
    value === "cancelled" ||
    value === "timed_out" ||
    value === "action_required";
  const isPassing = (value: string | null) =>
    value === "success" || value === "neutral" || value === "skipped";
  const newlyFailing = [];
  const newlyPassing = [];
  const persistentFailures = [];
  const added = [];
  const removed = [];
  for (const job of recent.jobs) {
    const prior = earlierByName.get(job.name);
    if (!prior) {
      added.push({ name: job.name, conclusion: job.conclusion, recentJobId: job.id, url: job.url });
    } else if (!isFailure(prior.conclusion) && isFailure(job.conclusion)) {
      newlyFailing.push({
        name: job.name,
        earlierConclusion: prior.conclusion,
        recentConclusion: job.conclusion,
        recentJobId: job.id,
        url: job.url,
      });
    } else if (isFailure(prior.conclusion) && isPassing(job.conclusion)) {
      newlyPassing.push({
        name: job.name,
        earlierConclusion: prior.conclusion,
        recentConclusion: job.conclusion,
        recentJobId: job.id,
        url: job.url,
      });
    } else if (isFailure(prior.conclusion) && isFailure(job.conclusion)) {
      persistentFailures.push({ name: job.name, recentJobId: job.id, url: job.url });
    }
  }
  for (const job of earlier.jobs) {
    if (!recentByName.has(job.name))
      removed.push({
        name: job.name,
        conclusion: job.conclusion,
        earlierJobId: job.id,
        url: job.url,
      });
  }
  return {
    earlier: { id: earlier.run.id, headSha: earlier.run.headSha, url: earlier.run.url },
    recent: { id: recent.run.id, headSha: recent.run.headSha, url: recent.run.url },
    newlyFailing,
    newlyPassing,
    persistentFailures,
    added,
    removed,
  };
}

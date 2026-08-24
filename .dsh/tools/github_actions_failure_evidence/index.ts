/**
 * Extract bounded, redacted failure evidence from one GitHub Actions job log.
 */
export default async function github_actions_failure_evidence(input: {
  workdir: string;
  repository: string;
  runId: Integer;
  jobId: Integer;
  contextLines?: Integer;
  maximumLines?: Integer;
}): Promise<{
  runId: Integer;
  jobId: Integer;
  signatureLines: string[];
  matchedLines: Integer;
  truncated: boolean;
  truncationReasons: string[];
}> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository))
    throw new Error("repository must have owner/name form");
  if (!Number.isSafeInteger(input.runId) || input.runId < 1)
    throw new Error("runId must be a positive integer");
  if (!Number.isSafeInteger(input.jobId) || input.jobId < 1)
    throw new Error("jobId must be a positive integer");
  const contextLines = Math.max(0, Math.min(input.contextLines ?? 2, 10));
  const maximumLines = Math.max(1, Math.min(input.maximumLines ?? 120, 300));
  const summary = await tools.github_actions_run_summary({
    workdir: input.workdir,
    repository: input.repository,
    runId: input.runId,
  });
  if (summary.run.id !== input.runId || !summary.jobs.some((job) => job.id === input.jobId))
    throw new Error("jobId does not belong to runId");
  const evidence = await tools.inspect_gh_job_log({
    workdir: input.workdir,
    jobId: input.jobId,
    repo: input.repository,
    pattern:
      "##\\[error\\]|\\b(?:AssertionError|Error:|ERROR:|failed|failure|timed out|timeout|Deleting|failedStage=)\\b",
    contextLines,
    maxLines: maximumLines,
    clipMode: "head",
  });
  if (evidence.code !== 0)
    throw new Error("GitHub Actions job log inspection failed: " + evidence.stderr);
  return {
    runId: input.runId,
    jobId: input.jobId,
    signatureLines: evidence.stdout.split("\n").filter((line) => line.length > 0),
    matchedLines: evidence.matchedLines,
    truncated: evidence.truncated,
    truncationReasons: evidence.truncationReasons,
  };
}

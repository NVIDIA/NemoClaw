/**
 * Inspect failed pull request checks with bounded output.
 */
export default async function inspect_failed_pr_checks(input: {
  workdir: string;
  repo?: string;
  limit?: Integer;
  number: Integer;
}): Promise<{
  repo: string;
  kind: string;
  truncated: boolean;
  items: {
    name: string;
    state: string;
    bucket: string;
    link: string;
  }[];
  summary: {
    number: Integer;
    totalChecks: Integer;
    failedChecks: Integer;
  };
  truncationNotice: string | null;
  returnedItems: Integer;
  omittedItems: Integer;
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw",
    limit = input.limit ?? 20;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    !Number.isSafeInteger(input.number) ||
    input.number <= 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new Error("Invalid input");
  const r = await tools.run_github_cli({
    workdir: input.workdir,
    args: [
      "pr",
      "checks",
      String(input.number),
      "--repo",
      repo,
      "--json",
      "name,state,bucket,link",
    ],
    acceptedExitCodes: [0, 8],
  });
  const all = JSON.parse(r.stdout || "[]"),
    failed = all.filter((c) =>
      ["fail", "failure", "cancelled", "timed_out", "action_required"].includes(
        String(c.state).toLowerCase(),
      ),
    );
  return {
    repo,
    kind: "failed-checks",
    truncated: failed.length > limit,
    truncationNotice:
      failed.length > limit
        ? "TRUNCATED OUTPUT: additional failed checks were omitted; do not assume this list is complete."
        : null,
    returnedItems: Math.min(failed.length, limit),
    omittedItems: Math.max(0, failed.length - limit),
    items: failed.slice(0, limit),
    summary: { number: input.number, totalChecks: all.length, failedChecks: failed.length },
  };
}

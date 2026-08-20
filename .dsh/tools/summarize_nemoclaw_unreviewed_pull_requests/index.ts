/**
 * List bounded open NemoClaw pull requests without a review decision.
 */
export default async function summarize_nemoclaw_unreviewed_pull_requests(input: {
  workdir: string;
  repo?: string;
  limit?: Integer;
}): Promise<{
  repo: string;
  kind: string;
  truncated: boolean;
  items: Open<{}>[];
  summary: Open<{}>;
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw",
    limit = input.limit ?? 50;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Invalid input");
  const r = await tools.bash({
    command:
      "gh pr list --repo " +
      repo +
      " --state open --limit " +
      (limit + 1) +
      " --json number,title,url,author,isDraft,reviewDecision,updatedAt",
    workdir: input.workdir,
    description: "List unreviewed NemoClaw pull requests",
  });
  if (r.kind !== "foreground" || r.exitCode !== 0) throw new Error("Could not list pull requests");
  const all = JSON.parse(r.stdout.text),
    items = all.filter((p) => !p.reviewDecision).slice(0, limit);
  return {
    repo,
    kind: "unreviewed-pull-requests",
    truncated: all.length > limit,
    items,
    summary: { count: items.length },
  };
}

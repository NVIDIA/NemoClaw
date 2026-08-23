/**
 * List bounded open NemoClaw pull requests with changes requested.
 */
export default async function summarize_changes_requested_pull_requests(input: {
  workdir: string;
  repo?: string;
  limit?: Integer;
}): Promise<{
  repo: string;
  kind: string;
  truncated: boolean;
  items: {
    number: Integer;
    title: string;
    url: string;
    author: {
      id: string;
      is_bot: boolean;
      login: string;
      name: string;
    } | null;
    isDraft: boolean;
    reviewDecision: string;
    updatedAt: string;
  }[];
  summary: { count: Integer };
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw",
    limit = input.limit ?? 50;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Invalid input");
  const r = await tools.run_github_cli({
    workdir: input.workdir,
    args: [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      "review:changes-requested",
      "--limit",
      String(limit + 1),
      "--json",
      "number,title,url,author,isDraft,reviewDecision,updatedAt",
    ],
  });
  let all;
  try {
    all = JSON.parse(r.stdout);
  } catch {
    throw new Error("GitHub returned malformed pull request data");
  }
  if (!Array.isArray(all)) throw new Error("GitHub pull request data must be an array");
  const items = all.slice(0, limit);
  return {
    repo,
    kind: "changes-requested-pull-requests",
    truncated: all.length > limit,
    items,
    summary: { count: items.length },
  };
}

/**
 * List NemoClaw issues by GitHub search query, author, and labels.
 */
export default async function find_nemoclaw_issues(input: {
  workdir: string;
  repo?: string;
  state?: "open" | "closed" | "all";
  search?: string;
  author?: string;
  labels?: string[];
  limit?: Integer;
}): Promise<{
  repo: string;
  state: string;
  search: string | null;
  author: string | null;
  labels: string[];
  limit: Integer;
  count: Integer;
  issues: {
    number: Integer;
    title: string;
    url: string;
    state: string;
    labels: string[];
    assignees: string[];
    author: string | null;
    updatedAt: string;
  }[];
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  const state = input.state ?? "open";
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  const labels = [...new Set((input.labels ?? []).map((x) => x.trim()).filter(Boolean))];
  const search = input.search?.trim() ?? "";
  const author = input.author?.trim() ?? "";
  const args = [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    state,
    "--limit",
    String(limit),
    "--json",
    "number,title,url,state,labels,assignees,author,updatedAt",
  ];
  if (search) args.push("--search", search);
  if (author) args.push("--author", author);
  for (const label of labels) args.push("--label", label);
  const result = await tools.run_github_cli({ workdir: input.workdir, args, timeoutMs: 60000 });
  const rows = JSON.parse(result.stdout || "[]");
  return {
    repo,
    state,
    search: search || null,
    author: author || null,
    labels,
    limit,
    count: rows.length,
    issues: rows.map((row) => ({
      number: row.number,
      title: row.title,
      url: row.url,
      state: row.state,
      labels: (row.labels ?? []).map((x) => x.name),
      assignees: (row.assignees ?? []).map((x) => x.login),
      author: row.author?.login ?? null,
      updatedAt: row.updatedAt,
    })),
  };
}

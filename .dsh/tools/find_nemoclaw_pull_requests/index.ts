/**
 * List NemoClaw pull requests with draft selection, commit identity, source details, and bounded completeness evidence.
 */
export default async function find_nemoclaw_pull_requests(input: {
  workdir: string;
  repo?: string;
  state?: "open" | "closed" | "merged" | "all";
  draft?: "include" | "exclude" | "only";
  author?: string;
  search?: string;
  touches?: string[];
  limit?: Integer;
  retry5xx?: Integer;
}): Promise<{
  repo: string;
  requestedState: string;
  draft: string;
  author: string | null;
  search: string | null;
  touches: string[];
  limit: Integer;
  attempts: { attempt: Integer; code: Integer }[];
  completeness: {
    complete: boolean;
    limitReached: boolean;
    rowsRequested: Integer;
    rowsReceived: Integer;
  };
  count: Integer;
  pullRequests: {
    number: Integer;
    title: string;
    url: string;
    state: string;
    isDraft: boolean;
    author: string | null;
    headRefName: string;
    headRefOid: string;
    baseRefName: string;
    baseRefOid: string;
    headRepository: string | null;
    headRepositoryOwner: string | null;
    maintainerCanModify: boolean;
    updatedAt: string;
    touchedFiles: string[];
  }[];
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.length > 200)
    throw new Error("repo must be owner/name and contain 200 or fewer characters");
  const requestedState = input.state ?? "open";
  const state = requestedState === "merged" ? "closed" : requestedState;
  const draft = input.draft ?? "include";
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  const rowsRequested = Math.min(501, limit + 1);
  const retry5xx = Math.max(0, Math.min(input.retry5xx ?? 4, 8));
  const touches = [...new Set((input.touches ?? []).map((value) => value.trim()).filter(Boolean))];
  const author = input.author?.trim() ?? "";
  const parts = [];
  if (requestedState === "merged") parts.push("is:merged");
  if (draft === "exclude") parts.push("draft:false");
  if (draft === "only") parts.push("draft:true");
  if (input.search?.trim()) parts.push(input.search.trim());
  const search = parts.join(" ");
  const fields = [
    "number",
    "title",
    "url",
    "state",
    "isDraft",
    "author",
    "headRefName",
    "headRefOid",
    "baseRefName",
    "baseRefOid",
    "headRepository",
    "headRepositoryOwner",
    "maintainerCanModify",
    "updatedAt",
    ...(touches.length ? ["files"] : []),
  ];
  const args = [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    state,
    "--limit",
    String(rowsRequested),
    "--json",
    fields.join(","),
  ];
  if (author) args.push("--author", author);
  if (search) args.push("--search", search);
  const attempts = [];
  let result;
  for (let attempt = 1; attempt <= retry5xx + 1; attempt++) {
    result = await tools.run_github_cli({
      workdir: input.workdir,
      args,
      acceptedExitCodes: [0, 1],
      timeoutMs: 120000,
    });
    attempts.push({ attempt, code: result.code });
    if (result.code === 0) break;
    const detail = result.stdout + "\n" + result.stderr;
    if (
      /authentication|authorization|forbidden|permission|resource not accessible|HTTP 40[13]|SSO/i.test(
        detail,
      )
    )
      throw new Error(
        "GitHub access failed while listing pull requests; stop and restore repository access before continuing",
      );
    if (!/HTTP 5\d\d|server|service|temporar/i.test(detail) || attempt > retry5xx)
      throw new Error("GitHub did not list pull requests after " + attempt + " attempt(s)");
  }
  const rows = JSON.parse(result.stdout || "[]");
  const limitReached = rows.length > limit;
  const selected = rows.slice(0, limit);
  const normalized = selected
    .map((row) => {
      const files = (row.files ?? []).map((entry) => entry.path);
      const touchedFiles = touches.length ? files.filter((path) => touches.includes(path)) : [];
      return {
        number: row.number,
        title: row.title,
        url: row.url,
        state: row.state,
        isDraft: row.isDraft,
        author: row.author?.login ?? null,
        headRefName: row.headRefName,
        headRefOid: row.headRefOid,
        baseRefName: row.baseRefName,
        baseRefOid: row.baseRefOid,
        headRepository: row.headRepository?.nameWithOwner ?? null,
        headRepositoryOwner: row.headRepositoryOwner?.login ?? null,
        maintainerCanModify: Boolean(row.maintainerCanModify),
        updatedAt: row.updatedAt,
        touchedFiles,
      };
    })
    .filter((row) => !touches.length || row.touchedFiles.length > 0)
    .sort((left, right) => left.number - right.number);
  return {
    repo,
    requestedState,
    draft,
    author: author || null,
    search: search || null,
    touches,
    limit,
    attempts,
    completeness: {
      complete: !limitReached,
      limitReached,
      rowsRequested,
      rowsReceived: rows.length,
    },
    count: normalized.length,
    pullRequests: normalized,
  };
}

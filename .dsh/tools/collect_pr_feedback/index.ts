/**
 * Collect a bounded GitHub pull request snapshot with status, checks, reviews, inline comments, and discussion comments for review follow-up.
 */
export default async function collect_pr_feedback(input: {
  repository: string;
  pullNumber: Integer;
  workdir: string;
  bodyLimit?: Integer;
}): Promise<{
  pull: {
    url: string;
    state: string;
    headRefOid: string;
    baseRefOid: string;
    mergeStateStatus: string;
    reviewDecision: string;
  };
  checks: { name: string; state: string; bucket: string; link: string }[];
  reviews: { id: Integer; user: string; state: string; commitId: string; body: string }[];
  inlineComments: {
    id: Integer;
    user: string;
    path: string;
    line: Integer | null;
    body: string;
    url: string;
  }[];
  discussionComments: { id: Integer; user: string; body: string; url: string }[];
  truncation: { reviews: boolean; inlineComments: boolean; discussionComments: boolean };
}> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
    throw new Error("Invalid repository");
  if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber <= 0)
    throw new Error("Invalid pull number");
  const bodyLimit = input.bodyLimit ?? 2000;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 100 || bodyLimit > 10000)
    throw new Error("bodyLimit must be between 100 and 10000");
  const repo = input.repository;
  const pr = input.pullNumber;
  const run = async (args: string[], allowed: Integer[] = [0]): Promise<string> => {
    const result = await tools.run_github_cli({
      workdir: input.workdir,
      args,
      acceptedExitCodes: allowed,
    });
    return result.stdout.trim();
  };
  const collectProjectedPages = async (
    path: string,
    projection: string,
  ): Promise<{ items: Open<{}>[]; truncated: boolean }> => {
    const items: Open<{}>[] = [];
    const pageSize = 10;
    const pageLimit = 10;
    for (let page = 1; page <= pageLimit; page += 1) {
      const text = await run([
        "api",
        "--include",
        "repos/" + repo + "/" + path + "?per_page=" + pageSize + "&page=" + page,
        "--jq",
        projection,
      ]);
      const separator = text.match(/\r?\n\r?\n/u);
      if (!separator || separator.index === undefined)
        throw new Error("GitHub REST projection response omitted headers");
      const headers = text.slice(0, separator.index);
      const body = text.slice(separator.index + separator[0].length);
      const values = body ? JSON.parse(body) : [];
      if (
        !Array.isArray(values) ||
        values.some((item) => item === null || typeof item !== "object" || Array.isArray(item))
      )
        throw new Error("GitHub REST projection must be an array of objects");
      items.push(...values);
      if (items.length > 100) throw new Error("GitHub REST projection exceeded 100 items");
      const hasNext = /^link:.*rel="next"/imu.test(headers);
      if (!hasNext) return { items, truncated: false };
      if (page === pageLimit) return { items, truncated: true };
    }
    throw new Error("GitHub REST projection did not terminate");
  };
  const slice = "[:" + bodyLimit + "]";
  const [pullText, checksText, reviewsPage, inlinePage, discussionPage] = await Promise.all([
    run([
      "pr",
      "view",
      String(pr),
      "--repo",
      repo,
      "--json",
      "url,state,headRefOid,baseRefOid,mergeStateStatus,reviewDecision",
    ]),
    run(["pr", "checks", String(pr), "--repo", repo, "--json", "name,state,bucket,link"], [0, 8]),
    collectProjectedPages(
      "pulls/" + pr + "/reviews",
      'map({id,user:(.user.login // ""),state:(.state // ""),commitId:(.commit_id // ""),body:((.body // "")' +
        slice +
        ")})",
    ),
    collectProjectedPages(
      "pulls/" + pr + "/comments",
      'map({id,user:(.user.login // ""),path:(.path // ""),line:(if (.line|type)=="number" then .line else null end),body:((.body // "")' +
        slice +
        '),url:(.html_url // "")})',
    ),
    collectProjectedPages(
      "issues/" + pr + "/comments",
      'map({id,user:(.user.login // ""),body:((.body // "")' + slice + '),url:(.html_url // "")})',
    ),
  ]);
  const pull = pullText ? JSON.parse(pullText) : {};
  const checks = checksText ? JSON.parse(checksText) : [];
  return {
    pull: {
      url: pull.url ?? "",
      state: pull.state ?? "",
      headRefOid: pull.headRefOid ?? "",
      baseRefOid: pull.baseRefOid ?? "",
      mergeStateStatus: pull.mergeStateStatus ?? "",
      reviewDecision: pull.reviewDecision ?? "",
    },
    checks: checks.map((item: Open<{}>) => ({
      name: String(item.name ?? ""),
      state: String(item.state ?? ""),
      bucket: String(item.bucket ?? ""),
      link: String(item.link ?? ""),
    })),
    reviews: reviewsPage.items.map((item) => ({
      id: item.id as Integer,
      user: String(item.user ?? ""),
      state: String(item.state ?? ""),
      commitId: String(item.commitId ?? ""),
      body: String(item.body ?? ""),
    })),
    inlineComments: inlinePage.items.map((item) => ({
      id: item.id as Integer,
      user: String(item.user ?? ""),
      path: String(item.path ?? ""),
      line: Number.isInteger(item.line) ? (item.line as Integer) : null,
      body: String(item.body ?? ""),
      url: String(item.url ?? ""),
    })),
    discussionComments: discussionPage.items.map((item) => ({
      id: item.id as Integer,
      user: String(item.user ?? ""),
      body: String(item.body ?? ""),
      url: String(item.url ?? ""),
    })),
    truncation: {
      reviews: reviewsPage.truncated,
      inlineComments: inlinePage.truncated,
      discussionComments: discussionPage.truncated,
    },
  };
}

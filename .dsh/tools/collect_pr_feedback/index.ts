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
  const run = async (args, allowed = [0]) => {
    const result = await tools.run_github_cli({
      workdir: input.workdir,
      args,
      acceptedExitCodes: allowed,
    });
    return result.stdout.trim();
  };
  const collectPages = async (path, projection, _description, _jqProjection) => {
    const page = await tools.read_github_pages({
      workdir: input.workdir,
      repository: repo,
      path,
      pageSize: 10,
      pageLimit: 10,
    });
    return { items: page.items.map(projection), pages: page.pagesRead, truncated: page.truncated };
  };
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
    collectPages(
      "pulls/" + pr + "/reviews",
      (item) => ({
        id: item.id,
        user: item.user?.login ?? "",
        state: item.state ?? "",
        commitId: item.commit_id ?? "",
        body: String(item.body ?? "").slice(0, bodyLimit),
      }),
      "Collect submitted pull request reviews",
      'map({id,user:{login:.user.login},state,commit_id,body:((.body // "")[:' + bodyLimit + "])})",
    ),
    collectPages(
      "pulls/" + pr + "/comments",
      (item) => ({
        id: item.id,
        user: item.user?.login ?? "",
        path: item.path ?? "",
        line: Number.isInteger(item.line) ? item.line : null,
        body: String(item.body ?? "").slice(0, bodyLimit),
        url: item.html_url ?? "",
      }),
      "Collect inline pull request comments",
      'map({id,user:{login:.user.login},path,line,body:((.body // "")[:' +
        bodyLimit +
        "]),html_url})",
    ),
    collectPages(
      "issues/" + pr + "/comments",
      (item) => ({
        id: item.id,
        user: item.user?.login ?? "",
        body: String(item.body ?? "").slice(0, bodyLimit),
        url: item.html_url ?? "",
      }),
      "Collect pull request discussion comments",
      'map({id,user:{login:.user.login},body:((.body // "")[:' + bodyLimit + "]),html_url})",
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
    checks: checks.map((item) => ({
      name: item.name ?? "",
      state: item.state ?? "",
      bucket: item.bucket ?? "",
      link: item.link ?? "",
    })),
    reviews: reviewsPage.items,
    inlineComments: inlinePage.items,
    discussionComments: discussionPage.items,
    truncation: {
      reviews: reviewsPage.truncated,
      inlineComments: inlinePage.truncated,
      discussionComments: discussionPage.truncated,
    },
  };
}

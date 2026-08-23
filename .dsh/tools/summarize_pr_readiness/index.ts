/**
 * Summarize bounded pull request status, checks, reviews, comments, and unresolved review comments.
 */
export default async function summarize_pr_readiness(input: {
  number: Integer;
  repo?: string;
  workdir: string;
  includeComments?: boolean;
  includeReviewContext?: boolean;
}): Promise<{
  repo: string;
  number: Integer;
  pull: {
    url: string;
    state: string;
    headRefOid: string;
    mergeStateStatus: string;
    reviewDecision: string;
  };
  failedChecks: { name: string; state: string; link: string }[];
  pendingChecks: string[];
  latestReviews: { user: string; state: string }[];
  unresolvedComments: {
    user: string | null;
    path: string;
    line: Integer | null;
    body: string;
    url: string;
  }[];
  recentComments: { user: string; body: string; url: string }[];
  context: {
    changedFiles: Integer;
    additions: Integer;
    deletions: Integer;
    body: string;
    files: { path: string; additions: Integer; deletions: Integer }[];
    commits: { oid: string; messageHeadline: string; authoredDate: string }[];
  } | null;
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    !Number.isSafeInteger(input.number) ||
    input.number <= 0
  )
    throw new Error("Invalid pull request");
  const s = await tools.collect_pr_feedback({
    repository: repo,
    pullNumber: input.number,
    workdir: input.workdir,
    bodyLimit: 4000,
  });
  if (s.truncation.reviews || (input.includeComments && s.truncation.discussionComments))
    throw new Error("Pull request readiness requires a complete bounded feedback snapshot");
  const threadSnapshot = await tools.read_nemoclaw_review_threads({
    workdir: input.workdir,
    number: input.number,
    repository: repo,
    expectedHeadSha: s.pull.headRefOid,
    pageLimit: 20,
  });
  if (!threadSnapshot.complete)
    throw new Error("Pull request readiness requires complete bounded review threads");
  const fail = new Set(["FAILURE", "FAIL", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]),
    pending = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);
  const latest = new Map();
  for (const r of s.reviews) latest.set(r.user, { user: r.user, state: r.state });
  let context = null;
  if (input.includeReviewContext) {
    const r = await tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "pr",
        "view",
        String(input.number),
        "--repo",
        repo,
        "--json",
        "changedFiles,additions,deletions,body,files,commits",
      ],
    });
    const x = JSON.parse(r.stdout);
    const files = x.files ?? [],
      commits = x.commits ?? [];
    if (
      !Number.isSafeInteger(x.changedFiles) ||
      !Number.isSafeInteger(x.additions) ||
      !Number.isSafeInteger(x.deletions) ||
      !Array.isArray(files) ||
      !Array.isArray(commits)
    )
      throw new Error("Pull request review context did not match the expected contract");
    context = {
      changedFiles: x.changedFiles,
      additions: x.additions,
      deletions: x.deletions,
      body: String(x.body ?? "").slice(0, 12000),
      files: files.slice(0, 100).map((file) => {
        if (
          typeof file?.path !== "string" ||
          !Number.isSafeInteger(file.additions) ||
          !Number.isSafeInteger(file.deletions)
        )
          throw new Error("Pull request file did not match the expected contract");
        return { path: file.path, additions: file.additions, deletions: file.deletions };
      }),
      commits: commits.slice(-20).map((commit) => {
        if (
          typeof commit?.oid !== "string" ||
          typeof commit.messageHeadline !== "string" ||
          typeof commit.authoredDate !== "string"
        )
          throw new Error("Pull request commit did not match the expected contract");
        return {
          oid: commit.oid,
          messageHeadline: commit.messageHeadline,
          authoredDate: commit.authoredDate,
        };
      }),
    };
  }
  const unresolvedComments = threadSnapshot.threads
    .filter((thread) => !thread.isResolved)
    .flatMap((thread) => thread.comments);
  if (unresolvedComments.length > 2000)
    throw new Error("Pull request readiness supports at most 2000 unresolved review comments");
  const unresolved = unresolvedComments.map((comment) => ({
    user: comment.author,
    path: comment.path,
    line: comment.line,
    body: comment.body,
    url: comment.url,
  }));
  const discussion = input.includeComments
    ? s.discussionComments.slice(-8).map((c) => ({ user: c.user, body: c.body, url: c.url }))
    : [];
  return {
    repo,
    number: input.number,
    pull: {
      url: s.pull.url,
      state: s.pull.state,
      headRefOid: s.pull.headRefOid,
      mergeStateStatus: s.pull.mergeStateStatus,
      reviewDecision: s.pull.reviewDecision,
    },
    failedChecks: s.checks
      .filter((c) => fail.has(c.state.toUpperCase()))
      .slice(0, 100)
      .map((c) => ({ name: c.name, state: c.state, link: c.link })),
    pendingChecks: s.checks
      .filter((c) => pending.has(c.state.toUpperCase()))
      .slice(0, 100)
      .map((c) => c.name),
    latestReviews: [...latest.values()].slice(0, 50),
    unresolvedComments: unresolved,
    recentComments: discussion,
    context,
  };
}

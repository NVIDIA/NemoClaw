/**
 * Reply to one review comment and resolve its thread only while the latest PR commit equals the expected commit.
 */
export default async function reply_and_resolve_pr_review_thread(input: {
  number: Integer;
  commentId: Integer;
  body: string;
  expectedHeadSha: string;
  repo?: string;
  workdir: string;
  apply: boolean;
}): Promise<{
  applied: boolean;
  mutated: boolean;
  repo: string;
  number: Integer;
  prUrl: string;
  headSha: string;
  commentId: Integer;
  threadId: string;
  alreadyResolved: boolean;
  pagesRead: Integer;
  wouldReply: boolean;
  wouldResolve: boolean;
  replyUrl: string | null;
  resolved: boolean;
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.length > 200)
    throw new Error("repo must be owner/name and contain 200 or fewer characters");
  if (!Number.isSafeInteger(input.number) || input.number <= 0)
    throw new Error("number must be a positive integer");
  if (!Number.isSafeInteger(input.commentId) || input.commentId <= 0)
    throw new Error("commentId must be a positive integer");
  if (typeof input.body !== "string" || !input.body.trim())
    throw new Error("reply body is required");
  if (input.body.length > 65536)
    throw new Error("reply body must contain 65536 or fewer characters");
  if (!/^[0-9a-f]{40}$/.test(input.expectedHeadSha))
    throw new Error("expectedHeadSha must be a lowercase 40-character commit SHA");
  const requireExpectedCommit = async () => {
    const pr = await tools.read_nemoclaw_pr({
      workdir: input.workdir,
      number: input.number,
      repository: repo,
    });
    if (pr.state !== "OPEN")
      throw new Error(
        "PR #" +
          input.number +
          " is " +
          String(pr.state).toLowerCase() +
          "; review thread updates require an open PR",
      );
    if (pr.headRefOid !== input.expectedHeadSha)
      throw new Error(
        "PR #" +
          input.number +
          " commit changed: expected " +
          input.expectedHeadSha +
          ", found " +
          pr.headRefOid,
      );
    return pr;
  };
  const pr = await requireExpectedCommit();
  const threadSnapshot = await tools.read_nemoclaw_review_threads({
    workdir: input.workdir,
    number: input.number,
    repository: repo,
    expectedHeadSha: input.expectedHeadSha,
    pageLimit: 10,
  });
  if (!threadSnapshot.complete)
    throw new Error("Review threads exceeded 10 bounded pages for PR #" + input.number);
  const thread = threadSnapshot.threads.find((candidate) =>
    candidate.comments.some((comment) => comment.databaseId === input.commentId),
  );
  if (!thread)
    throw new Error(
      "Review comment " +
        input.commentId +
        " was not found in " +
        threadSnapshot.pagesRead +
        " complete bounded thread page(s) for PR #" +
        input.number,
    );
  const base = {
    repo,
    number: input.number,
    prUrl: pr.url ?? "",
    headSha: pr.headRefOid ?? "",
    commentId: input.commentId,
    threadId: thread.id,
    alreadyResolved: Boolean(thread.isResolved),
    pagesRead: threadSnapshot.pagesRead,
  };
  if (!input.apply || thread.isResolved)
    return {
      applied: input.apply,
      mutated: false,
      ...base,
      wouldReply: !input.apply && !thread.isResolved,
      wouldResolve: !input.apply && !thread.isResolved,
      replyUrl: null,
      resolved: Boolean(thread.isResolved),
    };
  await requireExpectedCommit();
  const replyResult = await tools.run_github_cli({
    workdir: input.workdir,
    args: [
      "api",
      "--method",
      "POST",
      "repos/" + repo + "/pulls/" + input.number + "/comments/" + input.commentId + "/replies",
      "-f",
      "body=" + input.body,
    ],
    apply: true,
  });
  const replyJson = JSON.parse(replyResult.stdout);
  await requireExpectedCommit();
  const mutation =
    "mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}";
  const resolveResult = await tools.run_github_cli({
    workdir: input.workdir,
    args: ["api", "graphql", "-f", "query=" + mutation, "-f", "threadId=" + thread.id],
    apply: true,
  });
  const resolvedThread = JSON.parse(resolveResult.stdout).data?.resolveReviewThread?.thread;
  if (!resolvedThread?.isResolved)
    throw new Error("GitHub accepted the reply but did not resolve review thread " + thread.id);
  return {
    applied: true,
    mutated: true,
    ...base,
    wouldReply: false,
    wouldResolve: false,
    replyUrl: replyJson.html_url ?? null,
    resolved: true,
  };
}

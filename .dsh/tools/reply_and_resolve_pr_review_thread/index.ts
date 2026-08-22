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
  replyCommentId: Integer | null;
  replyUrl: string | null;
  resolutionError: string | null;
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
      replyCommentId: null,
      replyUrl: null,
      resolutionError: null,
      resolved: Boolean(thread.isResolved),
    };
  const viewerResult = await tools.run_github_cli({
    workdir: input.workdir,
    args: ["api", "user", "--jq", ".login"],
  });
  const viewerLogin = viewerResult.stdout.trim();
  if (!/^[A-Za-z0-9-]{1,39}$/u.test(viewerLogin))
    throw new Error("GitHub did not return a valid authenticated user login");
  await requireExpectedCommit();
  const existingReply = thread.comments.findLast(
    (comment) =>
      comment.databaseId !== input.commentId &&
      comment.author === viewerLogin &&
      comment.body === input.body,
  );
  let replyCommentId = existingReply?.databaseId ?? null;
  let replyUrl = existingReply?.url ?? null;
  if (!existingReply) {
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
    if (!Number.isSafeInteger(replyJson.id) || typeof replyJson.html_url !== "string")
      throw new Error("GitHub accepted the reply but returned an invalid reply identity");
    replyCommentId = replyJson.id;
    replyUrl = replyJson.html_url;
  }
  try {
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
      throw new Error("GitHub did not resolve review thread " + thread.id);
    return {
      applied: true,
      mutated: true,
      ...base,
      wouldReply: false,
      wouldResolve: false,
      replyCommentId,
      replyUrl,
      resolutionError: null,
      resolved: true,
    };
  } catch (error) {
    const resolutionError = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    try {
      const after = await tools.read_nemoclaw_review_threads({
        workdir: input.workdir,
        number: input.number,
        repository: repo,
        expectedHeadSha: input.expectedHeadSha,
        pageLimit: 10,
      });
      if (!after.complete)
        throw new Error("Review threads exceeded 10 bounded pages for PR #" + input.number);
      const currentThread = after.threads.find((candidate) => candidate.id === thread.id);
      if (!currentThread)
        throw new Error("Review thread " + thread.id + " was not found after the reply");
      const reconciledReply = currentThread.comments.findLast(
        (comment) =>
          comment.databaseId !== input.commentId &&
          comment.author === viewerLogin &&
          comment.body === input.body,
      );
      replyCommentId = reconciledReply?.databaseId ?? replyCommentId;
      replyUrl = reconciledReply?.url ?? replyUrl;
      return {
        applied: true,
        mutated: true,
        ...base,
        wouldReply: false,
        wouldResolve: !currentThread.isResolved,
        replyCommentId,
        replyUrl,
        resolutionError: currentThread.isResolved ? null : resolutionError,
        resolved: currentThread.isResolved,
      };
    } catch (reconciliationError) {
      const detail = (
        reconciliationError instanceof Error
          ? reconciliationError.message
          : String(reconciliationError)
      ).slice(0, 2000);
      return {
        applied: true,
        mutated: true,
        ...base,
        wouldReply: false,
        wouldResolve: true,
        replyCommentId,
        replyUrl,
        resolutionError: resolutionError + "; reconciliation failed: " + detail,
        resolved: false,
      };
    }
  }
}

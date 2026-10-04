/**
 * Collect a bounded pull request snapshot of checks, reviews, inline comments, and discussion comments.
 */
export default async function collect_nemoclaw_pr_review_cycle(input: {
  workdir: string;
  repo?: string;
  limit?: Integer;
  number: Integer;
}): Promise<{
  repo: string;
  kind: string;
  truncated: boolean;
  items: {
    type: "review" | "inline-comment" | "discussion-comment";
    id: Integer;
    user: string;
    state?: string;
    commitId?: string;
    path?: string;
    line?: Integer | null;
    body: string;
    url?: string;
  }[];
  summary: {
    number: Integer;
    pull: {
      url: string;
      state: string;
      headRefOid: string;
      baseRefOid: string;
      mergeStateStatus: string;
      reviewDecision: string;
    };
    checks: {
      name: string;
      state: string;
      bucket: string;
      link: string;
    }[];
  };
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw",
    limit = input.limit ?? 100;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    !Number.isSafeInteger(input.number) ||
    input.number <= 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("Invalid input");
  const s = await tools.collect_pr_feedback({
    repository: repo,
    pullNumber: input.number,
    workdir: input.workdir,
    bodyLimit: 2000,
  });
  if (Object.values(s.truncation).some(Boolean))
    throw new Error("Pull request review cycle exceeded the bounded feedback snapshot");
  const items = [
    ...s.reviews.slice(0, limit).map((x) => ({ type: "review", ...x })),
    ...s.inlineComments.slice(0, limit).map((x) => ({ type: "inline-comment", ...x })),
    ...s.discussionComments.slice(0, limit).map((x) => ({ type: "discussion-comment", ...x })),
  ];
  return {
    repo,
    kind: "review-cycle",
    truncated:
      s.checks.length > limit ||
      s.reviews.length > limit ||
      s.inlineComments.length > limit ||
      s.discussionComments.length > limit,
    items,
    summary: { number: input.number, pull: s.pull, checks: s.checks.slice(0, limit) },
  };
}

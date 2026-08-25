/**
 * Dismiss bounded CHANGES_REQUESTED reviews only at expected pull request heads, or preview all writes when apply is false.
 */
export default async function dismiss_nemoclaw_pr_reviews(input: {
  repo?: string;
  workdir: string;
  apply: boolean;
  items: { number: Integer; reviewId: Integer; expectedHeadSha: string; message: string }[];
}): Promise<{
  applied: boolean;
  mutated: boolean;
  repo: string;
  count: Integer;
  dismissed: Integer;
  alreadyDismissed: Integer;
  reviews: {
    number: Integer;
    reviewId: Integer;
    action: string;
    prUrl: string;
    headSha: string;
    reviewUrl: string;
    author: string;
    reviewedCommit: string;
    message: string;
  }[];
  reviewDecisions: { number: Integer; url: string; headRefOid: string; reviewDecision: string }[];
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.length > 200)
    throw new Error("repo must be owner/name and contain 200 or fewer characters");
  if (!Array.isArray(input.items) || input.items.length === 0)
    throw new Error("items must contain at least one review dismissal");
  if (input.items.length > 25) throw new Error("items must contain 25 or fewer review dismissals");
  const keys = new Set();
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.number) || item.number <= 0)
      throw new Error("each PR number must be a positive integer");
    if (!Number.isSafeInteger(item.reviewId) || item.reviewId <= 0)
      throw new Error("each reviewId must be a positive integer");
    if (!/^[0-9a-f]{40}$/.test(item.expectedHeadSha))
      throw new Error("each expectedHeadSha must be a lowercase 40-character commit SHA");
    if (typeof item.message !== "string" || !item.message.trim())
      throw new Error("each dismissal message is required");
    if (item.message.trim().length > 1000)
      throw new Error("each dismissal message must contain 1000 or fewer characters");
    const key = item.number + ":" + item.reviewId;
    if (keys.has(key))
      throw new Error("review " + item.reviewId + " appears more than once for PR #" + item.number);
    keys.add(key);
  }
  const readItem = async (item) => {
    const [pr, reviewResult] = await Promise.all([
      tools.read_nemoclaw_pr({
        workdir: input.workdir,
        number: item.number,
        repository: repo,
      }),
      tools.run_github_cli({
        workdir: input.workdir,
        args: ["api", "repos/" + repo + "/pulls/" + item.number + "/reviews/" + item.reviewId],
      }),
    ]);
    const rawReview = JSON.parse(reviewResult.stdout);
    const review = {
      id: rawReview.id,
      state: rawReview.state,
      author: rawReview.user?.login ?? "",
      submittedAt: rawReview.submitted_at ?? null,
      reviewedCommit: rawReview.commit_id ?? "",
      url: rawReview.html_url ?? "",
    };
    if (pr.state !== "OPEN")
      throw new Error(
        "PR #" +
          item.number +
          " is " +
          String(pr.state).toLowerCase() +
          "; review dismissal requires an open PR",
      );
    if (pr.headRefOid !== item.expectedHeadSha)
      throw new Error(
        "PR #" +
          item.number +
          " commit changed: expected " +
          item.expectedHeadSha +
          ", found " +
          pr.headRefOid,
      );
    if (review.state !== "CHANGES_REQUESTED" && review.state !== "DISMISSED")
      throw new Error(
        "Review " +
          item.reviewId +
          " on PR #" +
          item.number +
          " is " +
          review.state +
          "; expected CHANGES_REQUESTED or DISMISSED",
      );
    return { item, pr, review, alreadyDismissed: review.state === "DISMISSED" };
  };
  const preflight = [];
  for (let offset = 0; offset < input.items.length; offset += 8)
    preflight.push(...(await Promise.all(input.items.slice(offset, offset + 8).map(readItem))));
  const shape = (entry, action) => ({
    number: entry.item.number,
    reviewId: entry.item.reviewId,
    action,
    prUrl: entry.pr.url ?? "",
    headSha: entry.pr.headRefOid ?? "",
    reviewUrl: entry.review.url ?? "",
    author: entry.review.author ?? "",
    reviewedCommit: entry.review.reviewedCommit ?? "",
    message: entry.item.message.trim(),
  });
  if (!input.apply) {
    const reviews = preflight.map((entry) =>
      shape(entry, entry.alreadyDismissed ? "already-dismissed" : "would-dismiss"),
    );
    return {
      applied: false,
      mutated: false,
      repo,
      count: reviews.length,
      dismissed: 0,
      alreadyDismissed: reviews.filter((x) => x.action === "already-dismissed").length,
      reviews,
      reviewDecisions: [],
    };
  }
  const reviews = [];
  for (const original of preflight) {
    const current = await readItem(original.item);
    if (current.alreadyDismissed) {
      reviews.push(shape(current, "already-dismissed"));
      continue;
    }
    const text = (
      await tools.run_github_cli({
        workdir: input.workdir,
        args: [
          "api",
          "--method",
          "PUT",
          "repos/" +
            repo +
            "/pulls/" +
            current.item.number +
            "/reviews/" +
            current.item.reviewId +
            "/dismissals",
          "-f",
          "message=" + current.item.message.trim(),
          "--jq",
          "{id,state,author:.user.login,url:.html_url}",
        ],
        apply: true,
      })
    ).stdout;
    const dismissed = JSON.parse(text);
    if (dismissed.state !== "DISMISSED")
      throw new Error(
        "GitHub returned " +
          dismissed.state +
          " after dismissing review " +
          current.item.reviewId +
          " on PR #" +
          current.item.number,
      );
    current.review = {
      ...current.review,
      state: dismissed.state,
      author: dismissed.author ?? current.review.author,
      url: dismissed.url ?? current.review.url,
    };
    reviews.push(shape(current, "dismissed"));
  }
  const numbers = [...new Set(input.items.map((item) => item.number))];
  const reviewDecisions = await Promise.all(
    numbers.map((number) =>
      tools.read_nemoclaw_pr({ workdir: input.workdir, number, repository: repo }),
    ),
  );
  return {
    applied: true,
    mutated: reviews.some((x) => x.action === "dismissed"),
    repo,
    count: reviews.length,
    dismissed: reviews.filter((x) => x.action === "dismissed").length,
    alreadyDismissed: reviews.filter((x) => x.action === "already-dismissed").length,
    reviews,
    reviewDecisions,
  };
}

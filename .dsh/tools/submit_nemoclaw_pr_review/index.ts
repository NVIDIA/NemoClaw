/**
 * Submit a NemoClaw pull request review only while the latest PR commit equals the expected commit.
 */
export default async function submit_nemoclaw_pr_review(input: {
  number: Integer;
  event: "approve" | "request-changes" | "comment";
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
  title: string;
  prUrl: string;
  headSha: string;
  event: string;
  reviewer: string;
  review: null | { id: Integer; state: string; commitId: string; submittedAt: string; url: string };
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.length > 200)
    throw new Error("repo must be owner/name and contain 200 or fewer characters");
  if (!Number.isSafeInteger(input.number) || input.number <= 0)
    throw new Error("number must be a positive integer");
  if (!["approve", "request-changes", "comment"].includes(input.event))
    throw new Error("event must be approve, request-changes, or comment");
  if (typeof input.body !== "string" || !input.body.trim())
    throw new Error("review body is required");
  if (input.body.length > 65536)
    throw new Error("review body must contain 65536 or fewer characters");
  if (!/^[0-9a-f]{40}$/.test(input.expectedHeadSha))
    throw new Error("expectedHeadSha must be a lowercase 40-character commit SHA");
  const [canonicalPr, detailResult, viewerResult] = await Promise.all([
    tools.read_nemoclaw_pr({ workdir: input.workdir, number: input.number, repository: repo }),
    tools.run_github_cli({
      workdir: input.workdir,
      args: ["pr", "view", String(input.number), "--repo", repo, "--json", "title"],
    }),
    tools.run_github_cli({ workdir: input.workdir, args: ["api", "user", "--jq", ".login"] }),
  ]);
  const detail = JSON.parse(detailResult.stdout);
  const headSha = canonicalPr.headRefOid;
  const reviewer = viewerResult.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(headSha))
    throw new Error("PR #" + input.number + " returned an invalid commit SHA");
  if (headSha !== input.expectedHeadSha)
    throw new Error(
      "PR #" +
        input.number +
        " commit changed: expected " +
        input.expectedHeadSha +
        ", found " +
        headSha,
    );
  if (!input.apply)
    return {
      applied: false,
      mutated: false,
      repo,
      number: input.number,
      title: detail.title ?? "",
      prUrl: canonicalPr.url ?? "",
      headSha,
      event: input.event,
      reviewer,
      review: null,
    };
  const apiEvent =
    input.event === "approve"
      ? "APPROVE"
      : input.event === "request-changes"
        ? "REQUEST_CHANGES"
        : "COMMENT";
  const created = await tools.run_github_cli({
    workdir: input.workdir,
    args: [
      "api",
      "--method",
      "POST",
      "repos/" + repo + "/pulls/" + input.number + "/reviews",
      "-f",
      "commit_id=" + input.expectedHeadSha,
      "-f",
      "event=" + apiEvent,
      "-f",
      "body=" + input.body,
    ],
    apply: true,
  });
  const review = JSON.parse(created.stdout);
  if (!Number.isSafeInteger(review.id) || review.commit_id !== input.expectedHeadSha)
    throw new Error("GitHub review response did not match the expected commit");
  return {
    applied: true,
    mutated: true,
    repo,
    number: input.number,
    title: detail.title ?? "",
    prUrl: canonicalPr.url ?? "",
    headSha,
    event: input.event,
    reviewer,
    review: {
      id: review.id,
      state: review.state ?? "",
      commitId: review.commit_id,
      submittedAt: review.submitted_at ?? "",
      url: review.html_url ?? "",
    },
  };
}

/**
 * Plan or submit guarded final reviews from exact-commit cached recommendations.
 */
export default async function finalize_nemoclaw_cached_reviews(input: {
  workdir: string;
  cacheRoot: string;
  numbers: Integer[];
  repository?: string;
  concurrency?: Integer;
  apply?: boolean;
}): Promise<{
  applied: boolean;
  mode: "dry-run" | "read-only" | "apply" | "blocked";
  plan: string[];
  notes: string[];
  resultJson: string;
}> {
  const repo = input.repository ?? "NVIDIA/NemoClaw";
  if (typeof input.workdir !== "string" || !input.workdir.trim())
    throw new Error("workdir is required");
  if (
    !Array.isArray(input.numbers) ||
    input.numbers.length === 0 ||
    input.numbers.length > 100 ||
    input.numbers.some((number) => !Number.isSafeInteger(number) || number < 1)
  )
    throw new Error("numbers must contain 1 to 100 positive integers");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error("repository must be owner/name");
  const numbers = [...new Set(input.numbers)];
  const concurrency = input.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("concurrency must be from 1 through 8");
  if (
    typeof input.cacheRoot !== "string" ||
    !input.cacheRoot.startsWith("/") ||
    input.cacheRoot === "/" ||
    input.cacheRoot.length > 4096 ||
    /[\r\n\0]/.test(input.cacheRoot)
  )
    throw new Error("cacheRoot must be a safe absolute path other than /");
  const jobRoot = input.cacheRoot;
  const viewPr = async (number) => {
    const result = await tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "pr",
        "view",
        String(number),
        "--repo",
        repo,
        "--json",
        "number,title,url,state,isDraft,author,headRefOid,mergeable,mergeStateStatus,reviews",
      ],
      timeoutMs: 60000,
    });
    return JSON.parse(result.stdout);
  };
  const readRecommendation = async (number, sha) => {
    try {
      const value = await tools.read({
        file_path: jobRoot + "/" + number + "/" + sha + "/recommendation.json",
        offset: 1,
        limit: 2000,
      });
      return JSON.parse(value.lines.map((line) => line.text).join("\n"));
    } catch {
      return null;
    }
  };
  const requiredChecks = async (number, headSha) => {
    const summary = await tools.summarize_nemoclaw_required_checks({
      workdir: input.workdir,
      repo,
      number,
      limit: 100,
    });
    if (summary.summary?.protectionReadable !== true)
      return {
        headSha,
        requiredPass: false,
        pendingRequired: [],
        missingRequired: [
          { name: "required-check-configuration", reason: "Branch protection was unreadable" },
        ],
        failedRequired: [],
        summary,
      };
    const required = summary.items ?? [];
    const pendingStates = new Set([
      "PENDING",
      "QUEUED",
      "IN_PROGRESS",
      "WAITING",
      "REQUESTED",
      "EXPECTED",
    ]);
    const passStates = new Set(["SUCCESS", "NEUTRAL"]);
    const pendingRequired = [];
    const missingRequired = [];
    const failedRequired = [];
    for (const entry of required) {
      const matches = entry.matches ?? [];
      if (!matches.length) {
        missingRequired.push({ name: entry.name });
        continue;
      }
      const current = matches[0];
      const state = String(current.state ?? current.bucket ?? "").toUpperCase();
      if (pendingStates.has(state)) pendingRequired.push({ name: entry.name, state });
      else if (!passStates.has(state))
        failedRequired.push({ name: entry.name, conclusion: state, link: current.link ?? null });
    }
    return {
      headSha,
      requiredPass: !pendingRequired.length && !missingRequired.length && !failedRequired.length,
      pendingRequired,
      missingRequired,
      failedRequired,
      summary,
    };
  };
  const plan = numbers.map(
    (number) =>
      "Read PR #" +
      number +
      " and its exact-head cached recommendation; reject closed, draft, active/decisive maintainer review, stale identity, incomplete required checks, or unmergeable approval; submit only with apply:true",
  );
  const results = new Array(numbers.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, numbers.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= numbers.length) return;
        const number = numbers[index];
        try {
          const pr = await viewPr(number);
          if (pr.state !== "OPEN") {
            results[index] = { number, status: "NOT_OPEN" };
            continue;
          }
          if (pr.isDraft) {
            results[index] = { number, url: pr.url, status: "DRAFT" };
            continue;
          }
          const maintainer = (pr.reviews ?? []).filter(
            (review) =>
              review.author?.login &&
              review.author.login !== pr.author?.login &&
              ["OWNER", "MEMBER", "COLLABORATOR"].includes(review.authorAssociation ?? ""),
          );
          const pending = maintainer.filter((review) => review.state === "PENDING");
          const decisive = maintainer.filter((review) =>
            ["APPROVED", "CHANGES_REQUESTED"].includes(review.state ?? ""),
          );
          if (pending.length) {
            results[index] = {
              number,
              url: pr.url,
              commit: pr.headRefOid,
              status: "REVIEW_IN_PROGRESS",
              reviewers: pending.map((review) => review.author?.login),
            };
            continue;
          }
          if (decisive.length) {
            results[index] = {
              number,
              url: pr.url,
              commit: pr.headRefOid,
              status: "ALREADY_DECIDED",
              reviews: decisive.map((review) => ({
                author: review.author?.login,
                state: review.state,
                commit: review.commit?.oid ?? null,
              })),
            };
            continue;
          }
          const stored = await readRecommendation(number, pr.headRefOid);
          if (!stored?.recommendation || stored.reviewedSha !== pr.headRefOid) {
            results[index] = {
              number,
              url: pr.url,
              commit: pr.headRefOid,
              status: "NO_CURRENT_RECOMMENDATION",
            };
            continue;
          }
          const recommendation = stored.recommendation;
          if (
            recommendation.pr !== number ||
            recommendation.expectedCommit !== pr.headRefOid ||
            recommendation.observedCommit !== pr.headRefOid
          ) {
            results[index] = {
              number,
              url: pr.url,
              commit: pr.headRefOid,
              status: "INVALID_RECOMMENDATION_IDENTITY",
            };
            continue;
          }
          if (recommendation.result === "PRODUCT_DECISION_HUMAN_REQUIRED") {
            results[index] = {
              number,
              url: pr.url,
              commit: pr.headRefOid,
              status: "PRODUCT_DECISION_HUMAN_REQUIRED",
              recommendation,
            };
            continue;
          }
          if (recommendation.result === "REQUEST_CHANGES") {
            const latest = await viewPr(number);
            if (
              latest.state !== "OPEN" ||
              latest.isDraft ||
              latest.headRefOid !== pr.headRefOid ||
              latest.reviews?.some(
                (review) =>
                  review.author?.login &&
                  review.author.login !== latest.author?.login &&
                  ["OWNER", "MEMBER", "COLLABORATOR"].includes(review.authorAssociation ?? "") &&
                  ["PENDING", "APPROVED", "CHANGES_REQUESTED"].includes(review.state ?? ""),
              )
            ) {
              results[index] = {
                number,
                url: latest.url,
                commit: latest.headRefOid,
                status: "STALE",
                recommendation,
              };
              continue;
            }
            if (input.apply !== true)
              results[index] = {
                number,
                url: pr.url,
                commit: pr.headRefOid,
                status: "REQUEST_CHANGES_DRY_RUN",
                recommendation,
              };
            else {
              const review = await tools.submit_nemoclaw_pr_review({
                number,
                event: "request-changes",
                body: recommendation.reviewBody?.trim() || recommendation.summary,
                expectedHeadSha: pr.headRefOid,
                repo,
                workdir: input.workdir,
                apply: true,
              });
              results[index] = {
                number,
                url: pr.url,
                commit: pr.headRefOid,
                status: "REQUEST_CHANGES",
                recommendation,
                review,
              };
            }
            continue;
          }
          if (recommendation.result !== "APPROVE") {
            results[index] = {
              number,
              url: pr.url,
              commit: pr.headRefOid,
              status: "RECOMMENDATION_NOT_FINAL",
              recommendation,
            };
            continue;
          }
          const gates = await requiredChecks(number, pr.headRefOid);
          if (gates.pendingRequired.length) {
            results[index] = {
              number,
              url: pr.url,
              commit: pr.headRefOid,
              status: "APPROVAL_WAITING_FOR_REQUIRED_CHECKS",
              gateDisposition: "PENDING",
              recommendation,
              pendingRequired: gates.pendingRequired,
            };
            continue;
          }
          if (gates.missingRequired.length) {
            results[index] = {
              number,
              url: pr.url,
              commit: pr.headRefOid,
              status: "APPROVAL_WAITING_FOR_REQUIRED_CHECKS",
              gateDisposition: "MISSING",
              recommendation,
              missingRequired: gates.missingRequired,
            };
            continue;
          }
          if (!gates.requiredPass) {
            const skippedOnly =
              gates.failedRequired.length > 0 &&
              gates.failedRequired.every((entry) => entry.conclusion === "SKIPPED");
            results[index] = {
              number,
              url: pr.url,
              commit: pr.headRefOid,
              status: skippedOnly
                ? "APPROVAL_BLOCKED_BY_SKIPPED_REQUIRED_CHECK"
                : "APPROVAL_BLOCKED_BY_FAILED_REQUIRED_CHECK",
              recommendation,
              failedRequired: gates.failedRequired,
            };
            continue;
          }
          const latest = await viewPr(number);
          const active = latest.reviews?.some(
            (review) =>
              review.author?.login &&
              review.author.login !== latest.author?.login &&
              ["OWNER", "MEMBER", "COLLABORATOR"].includes(review.authorAssociation ?? "") &&
              ["PENDING", "APPROVED", "CHANGES_REQUESTED"].includes(review.state ?? ""),
          );
          if (
            latest.state !== "OPEN" ||
            latest.isDraft ||
            latest.headRefOid !== pr.headRefOid ||
            active
          ) {
            results[index] = {
              number,
              url: latest.url,
              commit: latest.headRefOid,
              status: "STALE",
              recommendation,
            };
            continue;
          }
          if (latest.mergeable !== "MERGEABLE") {
            results[index] = {
              number,
              url: latest.url,
              commit: latest.headRefOid,
              status: "APPROVAL_WAITING_FOR_MERGEABILITY",
              mergeable: latest.mergeable,
              mergeStateStatus: latest.mergeStateStatus,
              recommendation,
            };
            continue;
          }
          if (input.apply !== true)
            results[index] = {
              number,
              url: pr.url,
              commit: pr.headRefOid,
              status: "APPROVE_DRY_RUN",
              recommendation,
              gates,
            };
          else {
            const review = await tools.submit_nemoclaw_pr_review({
              number,
              event: "approve",
              body: recommendation.reviewBody?.trim() || recommendation.summary,
              expectedHeadSha: pr.headRefOid,
              repo,
              workdir: input.workdir,
              apply: true,
            });
            results[index] = {
              number,
              url: pr.url,
              commit: pr.headRefOid,
              status: "APPROVE",
              recommendation,
              gates,
              review,
            };
          }
        } catch (error) {
          results[index] = {
            number,
            status: "OPERATIONAL_FAILURE",
            error: String(error?.message ?? error),
          };
        }
      }
    }),
  );
  const payload = {
    repo,
    requested: numbers.length,
    concurrency,
    dryRun: input.apply !== true,
    results,
    humanDecisions: results.filter((entry) => entry?.status === "PRODUCT_DECISION_HUMAN_REQUIRED"),
  };
  return {
    applied:
      input.apply === true &&
      results.some((entry) => entry?.status === "APPROVE" || entry?.status === "REQUEST_CHANGES"),
    mode: input.apply === true ? "apply" : "dry-run",
    plan,
    notes: [
      input.apply === true
        ? "Review writes remained exact-head guarded."
        : "No GitHub review, cache, branch, session, index, commit, or push mutation was performed.",
    ],
    resultJson: JSON.stringify(payload),
  };
}

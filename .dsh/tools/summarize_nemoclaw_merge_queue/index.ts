/**
 * Summarize open NemoClaw pull requests and exclude candidates that lack required-check, review, or merge data. Return closed readiness rows for the NemoClaw merge queue.
 */
export default async function summarize_nemoclaw_merge_queue(input: {
  workdir: string;
  repo?: string;
  limit?: Integer;
  base?: string;
  includeStacked?: boolean;
  enrichLimit?: Integer;
}): Promise<{
  checkedAt: string;
  repo: string;
  filters: { limit: Integer; base: string | null; includeStacked: boolean; enrichLimit: Integer };
  counts: {
    approvedGreen: Integer;
    enriched: Integer;
    unenriched: Integer;
    strictReady: Integer;
    directNearMisses: Integer;
    stackedReady: Integer;
    stackedNearMisses: Integer;
    reviewQueue: Integer;
  };
  strictReady: {
    number: Integer;
    title: string;
    author: string | null;
    base: string;
    head: string;
    mergeable: string;
    reviewDecision: string;
    updatedAt: string;
    url: string;
    headSha: string;
    mergeableState: string;
    checksExitCode: Integer;
    failedChecks: string[];
    pendingChecks: string[];
    unresolvedThreadCount: Integer;
    threadsTruncated: boolean;
    advisor: string | null;
    advisorCurrent: boolean;
    advisorFindings: string | null;
    enrichmentError: string | null;
  }[];
  directNearMisses: {
    number: Integer;
    title: string;
    author: string | null;
    base: string;
    head: string;
    mergeable: string;
    reviewDecision: string;
    updatedAt: string;
    url: string;
    headSha: string;
    mergeableState: string;
    checksExitCode: Integer;
    failedChecks: string[];
    pendingChecks: string[];
    unresolvedThreadCount: Integer;
    threadsTruncated: boolean;
    advisor: string | null;
    advisorCurrent: boolean;
    advisorFindings: string | null;
    enrichmentError: string | null;
  }[];
  stackedReady: {
    number: Integer;
    title: string;
    author: string | null;
    base: string;
    head: string;
    mergeable: string;
    reviewDecision: string;
    updatedAt: string;
    url: string;
    headSha: string;
    mergeableState: string;
    checksExitCode: Integer;
    failedChecks: string[];
    pendingChecks: string[];
    unresolvedThreadCount: Integer;
    threadsTruncated: boolean;
    advisor: string | null;
    advisorCurrent: boolean;
    advisorFindings: string | null;
    enrichmentError: string | null;
  }[];
  stackedNearMisses: {
    number: Integer;
    title: string;
    author: string | null;
    base: string;
    head: string;
    mergeable: string;
    reviewDecision: string;
    updatedAt: string;
    url: string;
    headSha: string;
    mergeableState: string;
    checksExitCode: Integer;
    failedChecks: string[];
    pendingChecks: string[];
    unresolvedThreadCount: Integer;
    threadsTruncated: boolean;
    advisor: string | null;
    advisorCurrent: boolean;
    advisorFindings: string | null;
    enrichmentError: string | null;
  }[];
  unenriched: {
    number: Integer;
    title: string;
    author: string | null;
    base: string;
    head: string;
    mergeable: string;
    reviewDecision: string;
    updatedAt: string;
    url: string;
    readiness: "not-inspected";
  }[];
  reviewQueue: {
    number: Integer;
    title: string;
    author: string | null;
    base: string;
    head: string;
    mergeable: string;
    reviewDecision: string;
    updatedAt: string;
    url: string;
  }[];
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  const limit = Math.max(1, Math.min(100, input.limit ?? 50)),
    base = input.base,
    includeStacked = input.includeStacked ?? true,
    enrichLimit = Math.max(0, Math.min(50, input.enrichLimit ?? 25));
  if (base !== undefined && (base.length < 1 || base.length > 255))
    throw new Error("base must contain 1 to 255 characters");
  const run = async (args, _label, allowed = [0]) => {
    const result = await tools.run_github_cli({
      workdir: input.workdir,
      args,
      acceptedExitCodes: allowed,
      timeoutMs: 60000,
    });
    return result.stdout;
  };
  const list = async (search) =>
    JSON.parse(
      await run(
        [
          "pr",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--limit",
          String(limit),
          "--search",
          search,
          "--json",
          "number,title,author,url,mergeable,reviewDecision,updatedAt,headRefName,baseRefName",
        ],
        "List merge queue pull requests",
      ),
    ).map((p) => ({
      number: p.number,
      title: p.title ?? "",
      author: p.author?.login ?? null,
      base: p.baseRefName ?? "",
      head: p.headRefName ?? "",
      mergeable: p.mergeable ?? "UNKNOWN",
      reviewDecision: p.reviewDecision || "REVIEW_REQUIRED",
      updatedAt: p.updatedAt ?? "",
      url: p.url ?? "",
    }));
  const search = (x) => x.filter(Boolean).join(" "),
    [a, g] = await Promise.all([
      list(
        search(["review:approved", "status:success", "draft:false", base ? "base:" + base : ""]),
      ),
      list(search(["status:success", "draft:false", base ? "base:" + base : ""])),
    ]);
  const match = (p) => (base ? p.base === base : includeStacked || p.base === "main"),
    approvedGreen = a.filter(match),
    green = g.filter(match),
    approved = new Set(approvedGreen.map((p) => p.number)),
    reviewQueue = green.filter((p) => !approved.has(p.number)),
    enriched = [];
  for (const c of approvedGreen.slice(0, enrichLimit)) {
    try {
      const [detail, checks, threads, comments] = await Promise.all([
        run(["api", "repos/" + repo + "/pulls/" + c.number], "Read pull request merge state"),
        run(
          ["pr", "checks", String(c.number), "--repo", repo, "--json", "name,state,bucket"],
          "Read pull request checks",
          [0, 8],
        ),
        run(
          [
            "api",
            "graphql",
            "-f",
            "owner=" + repo.split("/")[0],
            "-f",
            "repo=" + repo.split("/")[1],
            "-F",
            "number=" + c.number,
            "-f",
            "query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid reviewThreads(first:100){nodes{isResolved}pageInfo{hasNextPage}}}}}",
          ],
          "Read pull request review threads",
        ),
        tools.read_github_pages({
          workdir: input.workdir,
          repository: repo,
          path: "issues/" + c.number + "/comments?sort=created&direction=asc",
          pageSize: 100,
          pageLimit: 20,
        }),
      ]);
      if (comments.truncated)
        throw new Error("Pull request advisor comments exceeded the bounded pagination limit");
      const d = JSON.parse(detail),
        cs = JSON.parse(checks || "[]"),
        pr = JSON.parse(threads).data?.repository?.pullRequest,
        body = String(
          [...comments.items]
            .reverse()
            .find((x) => String(x.body ?? "").includes("nemoclaw-pr-review-advisor"))?.body ?? "",
        ),
        head = pr?.headRefOid ?? d.head?.sha ?? "",
        advisorHead = body.match(/head_sha: ([0-9a-f]{40,64})/)?.[1] ?? null,
        failed = cs.filter((x) => x.bucket === "fail").map((x) => x.name ?? "unnamed check"),
        pending = cs.filter((x) => x.bucket === "pending").map((x) => x.name ?? "unnamed check");
      enriched.push({
        ...c,
        headSha: head,
        mergeable:
          d.mergeable === true ? "MERGEABLE" : d.mergeable === false ? "CONFLICTING" : "UNKNOWN",
        mergeableState: d.mergeable_state ?? "unknown",
        checksExitCode: failed.length ? 1 : pending.length ? 8 : 0,
        failedChecks: failed.slice(0, 100),
        pendingChecks: pending.slice(0, 100),
        unresolvedThreadCount: (pr?.reviewThreads?.nodes ?? []).filter((x) => !x.isResolved).length,
        threadsTruncated: Boolean(pr?.reviewThreads?.pageInfo?.hasNextPage),
        advisor: body.match(/recommendation: ([^;\n]+)/)?.[1]?.trim() ?? null,
        advisorCurrent: Boolean(advisorHead && advisorHead === head),
        advisorFindings: body.match(/\*\*Findings:\*\*[^\n]*/)?.[0] ?? null,
        enrichmentError: null,
      });
    } catch (e) {
      const projected = await tools.project_diagnostic_text({
        lines: [String(e?.message ?? e)],
        clipMode: "head",
        maxLines: 1,
        maxCharacters: 1000,
        maxLineCharacters: 1000,
      });
      enriched.push({
        ...c,
        headSha: "",
        mergeableState: "unknown",
        checksExitCode: 1,
        failedChecks: [],
        pendingChecks: [],
        unresolvedThreadCount: 0,
        threadsTruncated: false,
        advisor: null,
        advisorCurrent: false,
        advisorFindings: null,
        enrichmentError: projected.text,
      });
    }
  }
  const ids = new Set(enriched.map((p) => p.number)),
    unenriched = approvedGreen
      .filter((p) => !ids.has(p.number))
      .map((p) => ({ ...p, readiness: "not-inspected" })),
    ready = (p) =>
      !p.enrichmentError &&
      p.mergeable === "MERGEABLE" &&
      p.checksExitCode === 0 &&
      p.failedChecks.length === 0 &&
      p.pendingChecks.length === 0 &&
      p.unresolvedThreadCount === 0 &&
      !p.threadsTruncated &&
      p.advisorCurrent &&
      p.advisor === "merge_as_is",
    strictReady = enriched.filter((p) => p.base === "main" && ready(p)),
    directNearMisses = enriched.filter((p) => p.base === "main" && !ready(p)),
    stackedReady = enriched.filter((p) => p.base !== "main" && ready(p)),
    stackedNearMisses = enriched.filter((p) => p.base !== "main" && !ready(p));
  return {
    checkedAt: new Date().toISOString(),
    repo,
    filters: { limit, base: base ?? null, includeStacked, enrichLimit },
    counts: {
      approvedGreen: approvedGreen.length,
      enriched: enriched.length,
      unenriched: unenriched.length,
      strictReady: strictReady.length,
      directNearMisses: directNearMisses.length,
      stackedReady: stackedReady.length,
      stackedNearMisses: stackedNearMisses.length,
      reviewQueue: reviewQueue.length,
    },
    strictReady,
    directNearMisses,
    stackedReady,
    stackedNearMisses,
    unenriched,
    reviewQueue: reviewQueue.slice(0, 15),
  };
}

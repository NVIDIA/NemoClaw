/**
 * Check exact-commit NemoClaw merge conditions and merge one pull request only when apply is true.
 */
export default async function merge_nemoclaw_pull_request(input: {
  workdir: string;
  repo?: string;
  number: Integer;
  expectedHeadSha: string;
  expectedBaseRef: string;
  method: "merge" | "squash" | "rebase";
  apply: boolean;
}): Promise<{
  apply: boolean;
  mutated: boolean;
  repo: string;
  number: Integer;
  url: string | null;
  disposition: "would-merge" | "merged" | "stale" | "blocked" | "not-merged" | "inconclusive";
  expectedHeadSha: string;
  observedHeadSha: string | null;
  expectedBaseRef: string;
  observedBaseRef: string | null;
  method: string;
  mergeCommit: string | null;
  blockers: string[];
  checks: Open<{}>;
  detail: string | null;
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.length > 200)
    throw new Error("repo must be owner/name and contain 200 or fewer characters");
  if (!Number.isSafeInteger(input.number) || input.number <= 0)
    throw new Error("number must be a positive integer");
  if (!/^[0-9a-f]{40}$/.test(input.expectedHeadSha))
    throw new Error("expectedHeadSha must be a complete lowercase commit SHA");
  if (!/^[A-Za-z0-9._/-]+$/.test(input.expectedBaseRef) || input.expectedBaseRef.length > 255)
    throw new Error("expectedBaseRef contains an unsupported branch name");
  const readPr = async () =>
    tools.read_nemoclaw_pr({
      workdir: input.workdir,
      number: input.number,
      repository: repo,
    });
  const readThreads = async () => {
    const [owner, name] = repo.split("/");
    const query =
      "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}";
    let cursor = null,
      pages = 0,
      unresolved = 0,
      total = 0;
    do {
      const args = [
        "api",
        "graphql",
        "-f",
        "owner=" + owner,
        "-f",
        "name=" + name,
        "-F",
        "number=" + input.number,
        "-f",
        "query=" + query,
      ];
      if (cursor) args.push("-f", "cursor=" + cursor);
      const result = await tools.run_github_cli({ workdir: input.workdir, args });
      const connection = JSON.parse(result.stdout).data?.repository?.pullRequest?.reviewThreads;
      if (!connection || !Array.isArray(connection.nodes))
        throw new Error("GitHub returned no review thread connection for PR #" + input.number);
      pages += 1;
      total += connection.nodes.length;
      unresolved += connection.nodes.filter((thread) => !thread.isResolved).length;
      cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
      if (pages >= 100 && cursor) throw new Error("Pull request review threads exceeded 100 pages");
    } while (cursor);
    return { pages, total, unresolved, complete: true };
  };
  const pr = await readPr();
  const observedHeadSha = pr.headRefOid;
  const observedBaseRef = pr.baseRefName;
  const [baseResult, rulesResult, checksResult, threads] = await Promise.all([
    tools.run_github_cli({ workdir: input.workdir, args: ["api", "repos/" + repo] }),
    tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "api",
        "repos/" + repo + "/rules/branches/" + encodeURIComponent(input.expectedBaseRef),
      ],
    }),
    tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "pr",
        "checks",
        String(input.number),
        "--repo",
        repo,
        "--json",
        "name,state,bucket,link",
      ],
      acceptedExitCodes: [0, 8],
    }),
    readThreads(),
  ]);
  const settings = JSON.parse(baseResult.stdout),
    rules = JSON.parse(rulesResult.stdout),
    allChecks = JSON.parse(checksResult.stdout || "[]");
  const requiredNames = [
    ...new Set(
      rules
        .filter((rule) => rule.type === "required_status_checks")
        .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
        .map((entry) => entry.context)
        .filter(Boolean),
    ),
  ];
  const requiredChecks = requiredNames.map((name) => ({
    name,
    matches: allChecks.filter((entry) => entry.name === name),
  }));
  const blockers = [];
  if (pr.state !== "OPEN") blockers.push("PR is not open");
  if (pr.isDraft) blockers.push("PR is a draft");
  if (observedHeadSha !== input.expectedHeadSha) blockers.push("latest PR commit changed");
  if (observedBaseRef !== input.expectedBaseRef) blockers.push("base branch changed");
  if (pr.mergeable !== "MERGEABLE") blockers.push("GitHub does not report MERGEABLE");
  const methodAllowed =
    input.method === "merge"
      ? settings.allow_merge_commit
      : input.method === "squash"
        ? settings.allow_squash_merge
        : settings.allow_rebase_merge;
  if (!methodAllowed) blockers.push("repository does not permit the selected merge method");
  const acceptedCheckStates = new Set(["SUCCESS", "NEUTRAL"]);
  for (const check of requiredChecks) {
    if (check.matches.length === 0) blockers.push("required check is missing: " + check.name);
    else if (
      !check.matches.some(
        (entry) =>
          acceptedCheckStates.has(String(entry.state).toUpperCase()) ||
          String(entry.bucket).toLowerCase() === "pass",
      )
    )
      blockers.push("required check is not passing: " + check.name);
  }
  if (pr.reviewDecision !== "APPROVED") blockers.push("GitHub review decision is not APPROVED");
  if (threads.unresolved > 0) blockers.push("unresolved review threads remain");
  const checks = {
    state: pr.state,
    isDraft: Boolean(pr.isDraft),
    mergeable: pr.mergeable ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? null,
    reviewDecision: pr.reviewDecision ?? "",
    requiredChecks,
    selectedMethodPermitted: Boolean(methodAllowed),
    reviewThreads: threads,
    effectiveRuleCount: rules.length,
  };
  const base = {
    apply: input.apply,
    mutated: false,
    repo,
    number: input.number,
    url: pr.url ?? null,
    expectedHeadSha: input.expectedHeadSha,
    observedHeadSha,
    expectedBaseRef: input.expectedBaseRef,
    observedBaseRef,
    method: input.method,
    mergeCommit: null,
    blockers,
    checks,
    detail: null,
  };
  if (observedHeadSha !== input.expectedHeadSha || observedBaseRef !== input.expectedBaseRef)
    return { ...base, disposition: "stale" };
  if (blockers.length) return { ...base, disposition: "blocked" };
  if (!input.apply) return { ...base, disposition: "would-merge" };
  const flag =
    input.method === "merge" ? "--merge" : input.method === "squash" ? "--squash" : "--rebase";
  const mergeResult = await tools.run_github_cli({
    workdir: input.workdir,
    args: [
      "pr",
      "merge",
      String(input.number),
      "--repo",
      repo,
      flag,
      "--match-head-commit",
      input.expectedHeadSha,
    ],
    acceptedExitCodes: [0, 1],
    apply: true,
  });
  const mergeSucceeded = mergeResult.code === 0;
  let after;
  try {
    after = await readPr();
  } catch (error) {
    return {
      ...base,
      disposition: "inconclusive",
      detail: mergeResult.stderr || mergeResult.stdout || String(error?.message ?? error),
    };
  }
  const afterHead = after.headRefOid ?? null;
  let mergeCommit = null;
  if (after.state === "MERGED") {
    const merged = await tools.run_github_cli({
      workdir: input.workdir,
      args: ["api", "repos/" + repo + "/pulls/" + input.number],
    });
    mergeCommit = JSON.parse(merged.stdout).merge_commit_sha ?? null;
  }
  if (after.state === "MERGED")
    return {
      ...base,
      mutated: mergeSucceeded,
      observedHeadSha: afterHead,
      observedBaseRef: after.baseRefName ?? null,
      mergeCommit,
      blockers: [],
      disposition: "merged",
      detail: mergeSucceeded ? null : mergeResult.stderr || mergeResult.stdout,
    };
  if (afterHead !== input.expectedHeadSha || after.baseRefName !== input.expectedBaseRef)
    return {
      ...base,
      observedHeadSha: afterHead,
      observedBaseRef: after.baseRefName ?? null,
      disposition: "stale",
      detail: mergeResult.stderr || mergeResult.stdout || null,
    };
  if (!mergeSucceeded)
    return { ...base, disposition: "not-merged", detail: mergeResult.stderr || mergeResult.stdout };
  return {
    ...base,
    disposition: "inconclusive",
    detail: "GitHub accepted the merge command but the PR remains open at the expected commit",
  };
}

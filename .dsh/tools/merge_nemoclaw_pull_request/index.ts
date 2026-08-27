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
  disposition: "would-merge" | "merged" | "stale" | "blocked" | "not-merged" | "inconclusive";
  expectedHeadSha: string;
  observedHeadSha: string | null;
  expectedBaseRef: string;
  observedBaseRef: string | null;
  method: "merge" | "squash" | "rebase";
  mergeCommit: string | null;
  blockers: string[];
  checks: {
    state: string;
    isDraft: boolean;
    mergeable: string | null;
    mergeStateStatus: string | null;
    reviewDecision: string;
    requiredChecks: {
      name: string;
      matches: { name: string; state: string; bucket: string }[];
    }[];
    selectedMethodPermitted: boolean;
    reviewThreads: { pages: Integer; total: Integer; unresolved: Integer; complete: boolean };
    effectiveRuleCount: Integer;
  };
  detail: string | null;
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.length > 200)
    throw new Error("repo must be owner/name and contain 200 or fewer characters");
  if (!Number.isSafeInteger(input.number) || input.number <= 0)
    throw new Error("number must be a positive integer");
  if (!/^[0-9a-f]{40}$/.test(input.expectedHeadSha))
    throw new Error("expectedHeadSha must be a complete lowercase commit SHA");
  if (typeof input.expectedBaseRef !== "string" || input.expectedBaseRef.length > 255)
    throw new Error("expectedBaseRef contains an unsupported branch name");
  const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const branchCheck = await tools.bash({
    command: "git check-ref-format --branch " + quote(input.expectedBaseRef),
    workdir: input.workdir,
    description: "Validate expected base branch",
    timeoutMs: 30000,
  });
  if (branchCheck.kind !== "foreground" || branchCheck.exitCode !== 0)
    throw new Error("expectedBaseRef contains an unsupported branch name");
  const diagnostic = async (lines, sourceTruncated = false) =>
    (
      await tools.project_diagnostic_text({
        lines,
        maxLines: 20,
        maxCharacters: 4000,
        sourceTruncated,
      })
    ).text;
  const github = async (options) => {
    try {
      return await tools.run_github_cli(options);
    } catch (error) {
      const detail = await diagnostic([String(error?.message ?? error)]);
      throw new Error(detail || "GitHub operation failed");
    }
  };
  const readPr = async () => {
    try {
      return await tools.read_nemoclaw_pr({
        workdir: input.workdir,
        number: input.number,
        repository: repo,
      });
    } catch (error) {
      const detail = await diagnostic([String(error?.message ?? error)]);
      throw new Error(detail || "Could not read pull request");
    }
  };
  const pr = await readPr();
  const observedHeadSha = pr.headRefOid;
  const readThreads = async () => {
    const result = await tools.read_nemoclaw_review_threads({
      workdir: input.workdir,
      number: input.number,
      repository: repo,
      expectedHeadSha: observedHeadSha,
      pageLimit: 20,
    });
    return {
      pages: result.pagesRead,
      total: result.total,
      unresolved: result.unresolved,
      complete: result.complete,
    };
  };
  const observedBaseRef = pr.baseRefName;
  const [baseResult, rulesResult, checksResult, threads] = await Promise.all([
    github({
      workdir: input.workdir,
      args: [
        "api",
        "repos/" + repo,
        "--jq",
        "{allow_merge_commit, allow_squash_merge, allow_rebase_merge}",
      ],
    }),
    github({
      workdir: input.workdir,
      args: [
        "api",
        "repos/" + repo + "/rules/branches/" + encodeURIComponent(input.expectedBaseRef),
      ],
    }),
    github({
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
    matches: allChecks
      .filter((entry) => entry.name === name)
      .map((entry) => ({
        name: String(entry.name ?? ""),
        state: String(entry.state ?? ""),
        bucket: String(entry.bucket ?? ""),
      })),
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
  if (!threads.complete) blockers.push("review thread pagination is incomplete");
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
  const mergeResult = await github({
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
      detail: await diagnostic([
        mergeResult.stderr || mergeResult.stdout || String(error?.message ?? error),
      ]),
    };
  }
  const afterHead = after.headRefOid ?? null;
  let mergeCommit = null;
  if (after.state === "MERGED") {
    const merged = await github({
      workdir: input.workdir,
      args: ["api", "repos/" + repo + "/pulls/" + input.number, "--jq", "{merge_commit_sha}"],
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
      detail: mergeSucceeded ? null : await diagnostic([mergeResult.stderr || mergeResult.stdout]),
    };
  if (afterHead !== input.expectedHeadSha || after.baseRefName !== input.expectedBaseRef)
    return {
      ...base,
      observedHeadSha: afterHead,
      observedBaseRef: after.baseRefName ?? null,
      disposition: "stale",
      detail:
        mergeResult.stderr || mergeResult.stdout
          ? await diagnostic([mergeResult.stderr || mergeResult.stdout])
          : null,
    };
  if (!mergeSucceeded)
    return {
      ...base,
      disposition: "not-merged",
      detail: await diagnostic([mergeResult.stderr || mergeResult.stdout]),
    };
  return {
    ...base,
    disposition: "inconclusive",
    detail: "GitHub accepted the merge command but the PR remains open at the expected commit",
  };
}

/**
 * Analyze one pull request from the earliest observable branch push through merge, separate approval delay from machine-controlled time, and test the latest revision against a target. Uses bounded authenticated GitHub reads; branch-push time falls back to commit time when no push workflow run is retained.
 */
export default async function analyze_pr_value_stream(input: {
  workdir: string;
  number: Integer;
  repository?: string;
  targetMinutes?: number;
  maxRunPages?: Integer;
  maxCheckPages?: Integer;
}): Promise<{
  measuredAt: string;
  repository: string;
  number: Integer;
  url: string;
  state: string;
  headSha: string;
  targetMinutes: number;
  events: {
    firstBranchPush: { at: string; source: string; confidence: string };
    pullRequestOpened: string;
    latestRevisionObserved: { at: string; source: string };
    firstFinalHeadApproval: string | null;
    automationSettled: string | null;
    merged: string | null;
  };
  elapsed: {
    observedTotalSeconds: number | null;
    branchPushToOpenSeconds: number;
    openToLatestRevisionSeconds: number;
    latestRevisionAutomationSeconds: number | null;
    approvalDelaySeconds: number | null;
    mergeLagAfterReadySeconds: number | null;
    approvalDiscountedSeconds: number | null;
  };
  target: {
    status: string;
    theoreticalFastestSeconds: number | null;
    marginSeconds: number | null;
    definition: string;
  };
  automation: {
    readinessBasis: string;
    checksConsidered: Integer;
    firstCheckCreatedAt: string | null;
    triggerDelaySeconds: number | null;
    longestRunnerQueue: { name: string; seconds: number } | null;
    longestChecks: { name: string; workflow: string; seconds: number; completedAt: string }[];
    lastCheck: { name: string; workflow: string; completedAt: string } | null;
  };
  bottlenecks: { name: string; seconds: number; owner: string }[];
  revisions: Integer;
  caveats: string[];
}> {
  if (!Number.isSafeInteger(input.number) || input.number < 1)
    throw new Error("number must be a positive integer");
  const repository = input.repository ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error("repository must be owner/name");
  const targetMinutes = input.targetMinutes ?? 10;
  if (!Number.isFinite(targetMinutes) || targetMinutes <= 0 || targetMinutes > 1440)
    throw new Error("targetMinutes must be greater than 0 and at most 1440");
  const maxRunPages = input.maxRunPages ?? 3;
  const maxCheckPages = input.maxCheckPages ?? 3;
  if (!Number.isSafeInteger(maxRunPages) || maxRunPages < 1 || maxRunPages > 10)
    throw new Error("maxRunPages must be an integer from 1 through 10");
  if (!Number.isSafeInteger(maxCheckPages) || maxCheckPages < 1 || maxCheckPages > 10)
    throw new Error("maxCheckPages must be an integer from 1 through 10");
  const parseTime = (value: unknown, label: string): number => {
    if (typeof value !== "string") throw new Error(label + " was not a timestamp");
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new Error(label + " was not a valid timestamp");
    return time;
  };
  const iso = (time: number): string => new Date(time).toISOString();
  const seconds = (start: number, end: number): number =>
    Math.max(0, Math.round((end - start) / 1000));
  const pullResult = await tools.run_github_cli({
    workdir: input.workdir,
    args: [
      "pr",
      "view",
      String(input.number),
      "--repo",
      repository,
      "--json",
      "number,url,state,isDraft,createdAt,mergedAt,headRefName,headRefOid,commits,reviews",
    ],
  });
  const pull = JSON.parse(pullResult.stdout);
  if (
    pull === null ||
    typeof pull !== "object" ||
    pull.number !== input.number ||
    typeof pull.url !== "string" ||
    typeof pull.state !== "string" ||
    typeof pull.headRefName !== "string" ||
    !/^[0-9a-f]{40,64}$/u.test(pull.headRefOid) ||
    !Array.isArray(pull.commits) ||
    !Array.isArray(pull.reviews)
  )
    throw new Error("GitHub pull request response did not match the value-stream contract");
  if (pull.commits.length < 1 || pull.commits.length > 250)
    throw new Error("value-stream analysis requires between 1 and 250 pull request commits");
  const opened = parseTime(pull.createdAt, "createdAt");
  const merged = pull.mergedAt === null ? null : parseTime(pull.mergedAt, "mergedAt");
  const commits = pull.commits.map((commit: any) => {
    if (!/^[0-9a-f]{40,64}$/u.test(commit?.oid))
      throw new Error("pull request commit had an invalid object ID");
    return {
      oid: commit.oid as string,
      committed: parseTime(commit.committedDate, "commit committedDate"),
    };
  });
  const commitIds = new Set(commits.map((commit: any) => commit.oid));
  const branch = encodeURIComponent(pull.headRefName);
  const runs: any[] = [];
  for (let page = 1; page <= maxRunPages; page += 1) {
    const result = await tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "api",
        "repos/" + repository + "/actions/runs?branch=" + branch + "&per_page=100&page=" + page,
        "--jq",
        "[.workflow_runs[] | {id,event,head_sha,created_at,run_started_at,updated_at,status,conclusion,name}]",
      ],
    });
    const pageRuns = JSON.parse(result.stdout);
    if (!Array.isArray(pageRuns)) throw new Error("GitHub workflow runs response was not an array");
    runs.push(...pageRuns);
    if (pageRuns.length < 100) break;
    if (page === maxRunPages)
      throw new Error("workflow run history exceeded maxRunPages; increase the bounded limit");
  }
  const relevantRuns = runs.filter(
    (run: any) => commitIds.has(run?.head_sha) && Number.isFinite(Date.parse(run?.created_at)),
  );
  const pushRuns = relevantRuns.filter((run: any) => run.event === "push");
  const earliest = (values: any[]): any | null =>
    values
      .slice()
      .sort((a: any, b: any) => Date.parse(a.created_at) - Date.parse(b.created_at))[0] ?? null;
  const firstPushRun = earliest(pushRuns);
  const firstAnyRun = earliest(relevantRuns);
  const firstCommit = commits.slice().sort((a: any, b: any) => a.committed - b.committed)[0];
  const firstSignal = firstPushRun ?? firstAnyRun;
  const firstPush = firstSignal
    ? parseTime(firstSignal.created_at, "first branch workflow run")
    : firstCommit.committed;
  const firstPushSource = firstPushRun
    ? "push workflow run"
    : firstAnyRun
      ? "earliest branch workflow run"
      : "first commit committedDate fallback";
  const firstPushConfidence = firstPushRun ? "high" : firstAnyRun ? "medium" : "low";
  const headRuns = relevantRuns.filter((run: any) => run.head_sha === pull.headRefOid);
  const headPush = earliest(headRuns.filter((run: any) => run.event === "push"));
  const headAny = earliest(headRuns);
  const finalCommit =
    commits.find((commit: any) => commit.oid === pull.headRefOid) ?? commits[commits.length - 1];
  const headSignal = headPush ?? headAny;
  const headObserved = headSignal
    ? parseTime(headSignal.created_at, "latest revision workflow run")
    : finalCommit.committed;
  const headSource = headPush
    ? "push workflow run"
    : headAny
      ? "earliest exact-head workflow run"
      : "head commit committedDate fallback";
  const checks: any[] = [];
  for (let page = 1; page <= maxCheckPages; page += 1) {
    const result = await tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "api",
        "repos/" +
          repository +
          "/commits/" +
          pull.headRefOid +
          "/check-runs?per_page=100&page=" +
          page,
        "--jq",
        "[.check_runs[] | {id,name,status,conclusion,created_at,started_at,completed_at,html_url,app:{slug:.app.slug}}]",
      ],
    });
    const pageChecks = JSON.parse(result.stdout);
    if (!Array.isArray(pageChecks)) throw new Error("GitHub check runs response was not an array");
    checks.push(...pageChecks);
    if (pageChecks.length < 100) break;
    if (page === maxCheckPages)
      throw new Error("check run history exceeded maxCheckPages; increase the bounded limit");
  }
  let requiredNames = new Set<string>();
  let readinessBasis = "all successful exact-head check runs observed before merge";
  try {
    const configured = await tools.summarize_nemoclaw_required_checks({
      workdir: input.workdir,
      repo: repository,
      number: input.number,
      limit: 100,
    });
    if (configured.summary.protectionReadable && configured.items.length > 0) {
      requiredNames = new Set(
        configured.items.flatMap((item: any) => item.matches.map((match: any) => match.name)),
      );
      if (requiredNames.size > 0)
        readinessBasis = "required checks reported by current base-branch protection";
    }
  } catch {
    readinessBasis =
      "all successful exact-head check runs observed before merge; required-check configuration was unavailable";
  }
  const terminalLimit = merged ?? Date.now();
  const successful = checks.filter((check: any) => {
    const completed = Date.parse(check?.completed_at);
    const conclusion = String(check?.conclusion ?? "").toUpperCase();
    const selected = requiredNames.size === 0 || requiredNames.has(check?.name);
    return (
      selected &&
      conclusion === "SUCCESS" &&
      Number.isFinite(completed) &&
      completed >= headObserved &&
      completed <= terminalLimit
    );
  });
  successful.sort((a: any, b: any) => Date.parse(a.completed_at) - Date.parse(b.completed_at));
  const automationSettled =
    successful.length > 0
      ? parseTime(successful[successful.length - 1].completed_at, "last check completedAt")
      : null;
  const finalApprovals = pull.reviews.filter(
    (review: any) =>
      review?.state === "APPROVED" &&
      review?.commit?.oid === pull.headRefOid &&
      Number.isFinite(Date.parse(review?.submittedAt)),
  );
  finalApprovals.sort((a: any, b: any) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  const approval =
    finalApprovals.length > 0
      ? parseTime(finalApprovals[0].submittedAt, "approval submittedAt")
      : null;
  const machineReady = automationSettled;
  const ready =
    machineReady === null
      ? approval
      : approval === null
        ? machineReady
        : Math.max(machineReady, approval);
  const mergeLag = merged !== null && ready !== null ? seconds(ready, merged) : null;
  const approvalDelay =
    machineReady !== null && approval !== null
      ? seconds(machineReady, Math.max(machineReady, approval))
      : null;
  const observedTotal = merged === null ? null : seconds(firstPush, merged);
  const discounted =
    merged !== null && machineReady !== null && ready !== null
      ? seconds(firstPush, machineReady) + seconds(ready, merged)
      : null;
  const latestAutomation = machineReady === null ? null : seconds(headObserved, machineReady);
  const theoretical = latestAutomation === null ? null : latestAutomation + (mergeLag ?? 0);
  const targetSeconds = Math.round(targetMinutes * 60);
  const targetStatus =
    theoretical === null
      ? "not-measurable"
      : theoretical <= targetSeconds
        ? "within-target"
        : "over-target";
  const checkRows = successful.map((check: any) => {
    const started = parseTime(check.started_at, "check startedAt");
    const created = started;
    const completed = parseTime(check.completed_at, "check completedAt");
    return {
      name: String(check.name).slice(0, 200),
      workflow: String(check.app?.slug ?? "").slice(0, 100),
      created,
      started,
      completed,
      duration: seconds(started, completed),
      queue: seconds(created, started),
    };
  });
  const firstCheckCreated =
    checkRows.length > 0 ? Math.min(...checkRows.map((row: any) => row.created)) : null;
  const longestQueue =
    checkRows
      .slice()
      .sort((a: any, b: any) => b.queue - a.queue || a.name.localeCompare(b.name))[0] ?? null;
  const longestChecks = checkRows
    .slice()
    .sort((a: any, b: any) => b.duration - a.duration || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((row: any) => ({
      name: row.name,
      workflow: row.workflow,
      seconds: row.duration,
      completedAt: iso(row.completed),
    }));
  const last = checkRows.slice().sort((a: any, b: any) => b.completed - a.completed)[0] ?? null;
  const bottlenecks: { name: string; seconds: number; owner: string }[] = [];
  bottlenecks.push({
    name: "branch push to pull request open",
    seconds: seconds(firstPush, Math.max(firstPush, opened)),
    owner: "contributor process",
  });
  bottlenecks.push({
    name: "pull request open to latest revision",
    seconds: seconds(opened, Math.max(opened, headObserved)),
    owner: "change iteration",
  });
  if (firstCheckCreated !== null)
    bottlenecks.push({
      name: "latest revision to first selected check",
      seconds: seconds(headObserved, firstCheckCreated),
      owner: "GitHub automation",
    });

  if (longestChecks.length > 0)
    bottlenecks.push({
      name: "longest selected check execution",
      seconds: longestChecks[0].seconds,
      owner: "check implementation",
    });
  if (approvalDelay !== null)
    bottlenecks.push({
      name: "approval delay after automation",
      seconds: approvalDelay,
      owner: "human approval",
    });
  if (mergeLag !== null)
    bottlenecks.push({ name: "ready to merge", seconds: mergeLag, owner: "merge process" });
  bottlenecks.sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
  const caveats = [
    "GitHub does not expose a canonical branch-created timestamp. The first branch push is the earliest retained push workflow run for a PR commit, with explicit lower-confidence fallbacks.",
    "The theoretical fastest value reuses the latest revision's observed automation span and observed merge lag. It assumes one push, an immediately opened PR, passing checks, and immediate approval.",
    "Approval delay is a counterfactual attribution, not a causal trace. Approval-triggered automation remains machine time.",
    "The check-runs API does not expose runner assignment time. Trigger delay ends at the first selected check start, and runner queue is not estimated from check timestamps.",
    readinessBasis.startsWith("required checks")
      ? "Required checks reflect current base-branch protection and may differ from the rules active when an older PR merged."
      : "Required-check configuration was not available, so successful exact-head checks are an upper-bound proxy for automation readiness.",
  ];
  if (pull.isDraft)
    caveats.push(
      "The pull request is or was returned as draft; draft waiting is not separately observable in this bounded snapshot.",
    );
  if (merged === null)
    caveats.push(
      "The pull request has not merged, so total lead time, merge lag, and approval-discounted lead time are incomplete.",
    );
  if (automationSettled === null)
    caveats.push("No selected successful exact-head check completed in the measured window.");
  return {
    measuredAt: new Date().toISOString(),
    repository,
    number: input.number,
    url: pull.url,
    state: pull.state,
    headSha: pull.headRefOid,
    targetMinutes,
    events: {
      firstBranchPush: {
        at: iso(firstPush),
        source: firstPushSource,
        confidence: firstPushConfidence,
      },
      pullRequestOpened: iso(opened),
      latestRevisionObserved: { at: iso(headObserved), source: headSource },
      firstFinalHeadApproval: approval === null ? null : iso(approval),
      automationSettled: automationSettled === null ? null : iso(automationSettled),
      merged: merged === null ? null : iso(merged),
    },
    elapsed: {
      observedTotalSeconds: observedTotal,
      branchPushToOpenSeconds: seconds(firstPush, Math.max(firstPush, opened)),
      openToLatestRevisionSeconds: seconds(opened, Math.max(opened, headObserved)),
      latestRevisionAutomationSeconds: latestAutomation,
      approvalDelaySeconds: approvalDelay,
      mergeLagAfterReadySeconds: mergeLag,
      approvalDiscountedSeconds: discounted,
    },
    target: {
      status: targetStatus,
      theoreticalFastestSeconds: theoretical,
      marginSeconds: theoretical === null ? null : targetSeconds - theoretical,
      definition:
        "latest revision observed to selected automation settled, plus observed ready-to-merge lag; PR opening and approval are immediate",
    },
    automation: {
      readinessBasis,
      checksConsidered: checkRows.length,
      firstCheckCreatedAt: firstCheckCreated === null ? null : iso(firstCheckCreated),
      triggerDelaySeconds:
        firstCheckCreated === null ? null : seconds(headObserved, firstCheckCreated),
      longestRunnerQueue: null,
      longestChecks,
      lastCheck:
        last === null
          ? null
          : { name: last.name, workflow: last.workflow, completedAt: iso(last.completed) },
    },
    bottlenecks,
    revisions: commits.length,
    caveats,
  };
}

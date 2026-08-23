/**
 * Approve action-required fork workflow runs only when each commit-bound reviewed scope lists every changed file.
 */
export default async function approve_nemoclaw_fork_workflow_runs(input: {
  items: { number: Integer; expectedHeadSha: string; reviewedFiles: string[] }[];
  repo?: string;
  workflowNames?: string[];
  workdir: string;
  apply: boolean;
}): Promise<{
  apply: boolean;
  mutated: boolean;
  repo: string;
  requestedPrs: Integer;
  actionRequiredRuns: Integer;
  approvedRuns: Integer;
  prs: {
    number: Integer;
    url: string;
    headSha: string;
    maintainerCanModify: boolean;
    workflowFiles: string[];
    runs: { id: Integer; workflow: string; url: string; action: string }[];
  }[];
  approvals: {
    number: Integer;
    headSha: string;
    runId: Integer;
    workflow: string;
    url: string;
    action: string;
  }[];
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.length > 200)
    throw new Error("repo must be owner/name and contain 200 or fewer characters");
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 10)
    throw new Error("items must contain 1 to 10 PRs");
  const seen = new Set();
  for (const item of input.items) {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new Error("each item must be a reviewed PR scope");
    if (!Number.isSafeInteger(item.number) || item.number <= 0)
      throw new Error("each PR number must be a positive integer");
    if (!/^[0-9a-f]{40}$/.test(item.expectedHeadSha))
      throw new Error("each expectedHeadSha must be a lowercase 40-character SHA");
    if (!Array.isArray(item.reviewedFiles) || item.reviewedFiles.length > 2000)
      throw new Error("each reviewedFiles scope must contain 2000 or fewer paths");
    const reviewedPaths = new Set();
    for (const path of item.reviewedFiles) {
      if (typeof path !== "string" || !path || path.length > 4096)
        throw new Error("each reviewed file path must contain 1 to 4096 characters");
      if (reviewedPaths.has(path))
        throw new Error(`reviewed file ${path} appears more than once for PR #${item.number}`);
      reviewedPaths.add(path);
    }
    if (seen.has(item.number)) throw new Error(`PR #${item.number} appears more than once`);
    seen.add(item.number);
  }
  let workflowNames = null;
  if (input.workflowNames !== undefined) {
    if (!Array.isArray(input.workflowNames)) throw new Error("workflowNames must be an array");
    if (input.workflowNames.length > 100)
      throw new Error("workflowNames must contain 100 or fewer names");
    workflowNames = [
      ...new Set(
        input.workflowNames
          .map((x) => {
            if (typeof x !== "string" || x.length > 200)
              throw new Error("each workflow name must contain 200 or fewer characters");
            return x.trim();
          })
          .filter(Boolean),
      ),
    ];
    if (!workflowNames.length)
      throw new Error("workflowNames must contain a non-empty name when provided");
  }
  const readPrFiles = async (number) => {
    const result = await tools.read_github_pages({
      workdir: input.workdir,
      repository: repo,
      path: `pulls/${number}/files`,
      pageSize: 100,
      pageLimit: 20,
    });
    if (result.truncated)
      throw new Error(
        `PR #${number} has more than 2000 files; refusing an incomplete review scope`,
      );
    const files = result.items.map((file) => file.filename);
    if (
      files.some((path) => typeof path !== "string" || !path || path.length > 4096) ||
      new Set(files).size !== files.length
    )
      throw new Error(`PR #${number} file response contains an invalid or duplicate path`);
    return files;
  };
  const readPr = async (item) => {
    const detailsResult = await tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "pr",
        "view",
        String(item.number),
        "--repo",
        repo,
        "--json",
        "number,isCrossRepository,maintainerCanModify,changedFiles",
      ],
      timeoutMs: 30000,
    });
    const details = JSON.parse(detailsResult.stdout);
    if (
      details === null ||
      typeof details !== "object" ||
      Array.isArray(details) ||
      details.number !== item.number ||
      details.isCrossRepository !== true ||
      typeof details.maintainerCanModify !== "boolean" ||
      !Number.isSafeInteger(details.changedFiles) ||
      details.changedFiles < 0 ||
      details.changedFiles > 2000
    )
      throw new Error(`PR #${item.number} fork details did not match the approval contract`);
    const files = await readPrFiles(item.number);
    if (files.length !== details.changedFiles)
      throw new Error(
        `PR #${item.number} file list is incomplete: expected ${details.changedFiles}, read ${files.length}`,
      );
    const reviewedFiles = new Set(item.reviewedFiles);
    if (
      item.reviewedFiles.length !== files.length ||
      files.some((path) => !reviewedFiles.has(path))
    )
      throw new Error(
        `PR #${item.number} reviewedFiles must exactly match all changed files at ${item.expectedHeadSha}`,
      );
    const pr = await tools.read_nemoclaw_pr({
      workdir: input.workdir,
      number: item.number,
      repository: repo,
    });
    if (pr.state !== "OPEN")
      throw new Error(`PR #${item.number} is ${pr.state}; workflow approval requires an open PR`);
    if (pr.isDraft)
      throw new Error(`PR #${item.number} is a draft; workflow approval requires a reviewable PR`);
    if (pr.headRefOid !== item.expectedHeadSha)
      throw new Error(
        `PR #${item.number} commit changed: expected ${item.expectedHeadSha}, found ${pr.headRefOid}`,
      );
    const workflowFiles = files.filter((path) => path.startsWith(".github/workflows/"));
    return { item, pr: { ...pr, ...details }, workflowFiles };
  };
  const plans = [];
  for (const item of input.items) {
    const current = await readPr(item);
    const listed = await tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "run",
        "list",
        "--repo",
        repo,
        "--commit",
        item.expectedHeadSha,
        "--limit",
        "100",
        "--json",
        "databaseId,workflowName,event,status,conclusion,url,headSha",
      ],
      timeoutMs: 30000,
    });
    const listedRuns = JSON.parse(listed.stdout);
    if (
      !Array.isArray(listedRuns) ||
      listedRuns.length > 100 ||
      listedRuns.some(
        (run) =>
          run === null ||
          typeof run !== "object" ||
          Array.isArray(run) ||
          !Number.isSafeInteger(run.databaseId) ||
          run.databaseId <= 0 ||
          typeof run.workflowName !== "string" ||
          !run.workflowName ||
          run.workflowName.length > 200 ||
          typeof run.event !== "string" ||
          run.event.length > 64 ||
          typeof run.status !== "string" ||
          run.status.length > 64 ||
          typeof run.conclusion !== "string" ||
          run.conclusion.length > 64 ||
          run.url !== `https://github.com/${repo}/actions/runs/${run.databaseId}` ||
          !/^[0-9a-f]{40}$/.test(run.headSha),
      ) ||
      new Set(listedRuns.map((run) => run.databaseId)).size !== listedRuns.length
    )
      throw new Error(`PR #${item.number} workflow run list did not match the approval contract`);
    let runs = listedRuns.filter(
      (run) =>
        run.event === "pull_request" &&
        run.headSha === item.expectedHeadSha &&
        run.status === "completed" &&
        run.conclusion === "action_required",
    );
    if (workflowNames) runs = runs.filter((run) => workflowNames.includes(run.workflowName));
    if (runs.length > 50)
      throw new Error(`PR #${item.number} has more than 50 action-required runs`);
    plans.push({ ...current, runs });
  }
  const prs = plans.map((plan) => ({
    number: plan.item.number,
    url: plan.pr.url,
    headSha: plan.pr.headRefOid,
    maintainerCanModify: plan.pr.maintainerCanModify === true,
    workflowFiles: plan.workflowFiles,
    runs: plan.runs.map((run) => ({
      id: run.databaseId,
      workflow: run.workflowName,
      url: run.url,
      action: input.apply ? "approve" : "would-approve",
    })),
  }));
  const actionRequiredRuns = plans.reduce((n, p) => n + p.runs.length, 0);
  if (!input.apply)
    return {
      apply: false,
      mutated: false,
      repo,
      requestedPrs: plans.length,
      actionRequiredRuns,
      approvedRuns: 0,
      prs,
      approvals: [],
    };
  const approvals = [];
  for (const plan of plans) {
    for (const run of plan.runs) {
      await readPr(plan.item);
      await tools.run_github_cli({
        workdir: input.workdir,
        args: ["api", `repos/${repo}/actions/runs/${run.databaseId}/approve`, "--method", "POST"],
        timeoutMs: 30000,
        apply: true,
      });
      approvals.push({
        number: plan.item.number,
        headSha: plan.item.expectedHeadSha,
        runId: run.databaseId,
        workflow: run.workflowName,
        url: run.url,
        action: "approved",
      });
    }
  }
  return {
    apply: true,
    mutated: approvals.length > 0,
    repo,
    requestedPrs: plans.length,
    actionRequiredRuns,
    approvedRuns: approvals.length,
    prs,
    approvals,
  };
}

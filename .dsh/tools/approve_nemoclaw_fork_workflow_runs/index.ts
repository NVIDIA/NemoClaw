// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const authPattern =
  /authentication|authorization|forbidden|permission|resource not accessible|HTTP 40[13]|SSO/i;
const runGh = async (args, description) => {
  const result = await tools.bash({
    command: "gh " + args.map(quote).join(" "),
    workdir: input.workdir,
    description,
    timeoutMs: 30000,
  });
  if (result.kind !== "foreground") throw new Error("Unexpected background result");
  return { code: result.exitCode ?? -1, stdout: result.stdout.text, stderr: result.stderr.text };
};
const requireRead = (result, operation) => {
  if (result.code === 0) return;
  const detail = (result.stdout + "\n" + result.stderr).trim();
  if (authPattern.test(detail))
    throw new Error(
      `GitHub access failed while ${operation}; stop and restore repository access before continuing.\n${detail}`,
    );
  throw new Error(`GitHub did not complete ${operation}.\n${detail}`);
};
const repo = input.repo ?? "NVIDIA/NemoClaw";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 10)
  throw new Error("items must contain 1 to 10 PRs");
const seen = new Set();
for (const item of input.items) {
  if (!Number.isSafeInteger(item.number) || item.number <= 0)
    throw new Error("each PR number must be a positive integer");
  if (!/^[0-9a-f]{40}$/.test(item.expectedHeadSha))
    throw new Error("each expectedHeadSha must be a lowercase 40-character SHA");
  if (seen.has(item.number)) throw new Error(`PR #${item.number} appears more than once`);
  seen.add(item.number);
}
let workflowNames = null;
if (input.workflowNames) {
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
const allowWorkflowChanges = input.allowWorkflowChanges === true;
const readPrFiles = async (number) => {
  const files = [];
  for (let page = 1; page <= 31; page += 1) {
    const result = await runGh(
      [
        "api",
        `repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
        "--method",
        "GET",
        "--jq",
        ".[].filename",
      ],
      "Read fork pull request files",
    );
    requireRead(result, `reading files for PR #${number}`);
    const pageFiles = result.stdout.split("\n").filter(Boolean);
    if (page === 31 && pageFiles.length)
      throw new Error(
        `PR #${number} has more than 3000 files; refusing an incomplete safety check`,
      );
    files.push(...pageFiles);
    if (pageFiles.length < 100) return files;
  }
  throw new Error(`PR #${number} file pagination did not complete`);
};
const readPr = async (item) => {
  const result = await runGh(
    [
      "pr",
      "view",
      String(item.number),
      "--repo",
      repo,
      "--json",
      "number,title,url,state,isDraft,headRefOid,isCrossRepository,maintainerCanModify,changedFiles",
    ],
    "Read fork pull request state",
  );
  requireRead(result, `reading PR #${item.number}`);
  const pr = JSON.parse(result.stdout);
  if (pr.state !== "OPEN")
    throw new Error(`PR #${item.number} is ${pr.state}; workflow approval requires an open PR`);
  if (pr.isDraft)
    throw new Error(`PR #${item.number} is a draft; workflow approval requires a reviewable PR`);
  if (pr.headRefOid !== item.expectedHeadSha)
    throw new Error(
      `PR #${item.number} commit changed: expected ${item.expectedHeadSha}, found ${pr.headRefOid}`,
    );
  if (pr.isCrossRepository !== true)
    throw new Error(`PR #${item.number} is not a cross-repository fork PR`);
  const files = await readPrFiles(item.number);
  if (files.length !== pr.changedFiles)
    throw new Error(
      `PR #${item.number} file list is incomplete: expected ${pr.changedFiles}, read ${files.length}`,
    );
  const workflowFiles = files.filter((path) => path.startsWith(".github/workflows/"));
  if (workflowFiles.length && !allowWorkflowChanges)
    throw new Error(
      `PR #${item.number} changes workflow files; set allowWorkflowChanges=true only after reviewing them: ${workflowFiles.join(", ")}`,
    );
  return { item, pr, workflowFiles };
};
const plans = [];
for (const item of input.items) {
  const current = await readPr(item);
  const listed = await runGh(
    [
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
    "List action-required workflow runs",
  );
  requireRead(listed, `listing workflow runs for PR #${item.number}`);
  let runs = JSON.parse(listed.stdout).filter(
    (run) =>
      run.event === "pull_request" &&
      run.headSha === item.expectedHeadSha &&
      run.status === "completed" &&
      run.conclusion === "action_required",
  );
  if (workflowNames) runs = runs.filter((run) => workflowNames.includes(run.workflowName));
  if (runs.length > 50) throw new Error(`PR #${item.number} has more than 50 action-required runs`);
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
    const approved = await runGh(
      ["api", `repos/${repo}/actions/runs/${run.databaseId}/approve`, "--method", "POST"],
      "Approve guarded workflow run",
    );
    requireRead(approved, `approving workflow ${run.databaseId} for PR #${plan.item.number}`);
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

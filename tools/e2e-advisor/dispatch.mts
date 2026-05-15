// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TARGET_WORKFLOW = "nightly-e2e.yaml";
const DEFAULT_DISPATCH_REF = "main";
const DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS = "OWNER,MEMBER";

type StringMap = Record<string, string | undefined>;

type PullRequestPayload = {
  number?: number;
  author_association?: string;
  draft?: boolean;
  user?: { login?: string };
  head?: {
    ref?: string;
    sha?: string;
    repo?: { full_name?: string };
  };
  base?: { ref?: string };
};

type GitHubEventPayload = {
  event_name?: string;
  pull_request?: PullRequestPayload;
};

type TestRecommendation = {
  id?: string;
  job?: string;
  workflow?: string;
};

type AdvisorResult = {
  confidence?: string;
  requiredTests?: TestRecommendation[];
};

type DispatchInputs = {
  jobs: string;
  target_ref: string;
  pr_number: string;
  advisor_dispatch_id?: string;
};

type DispatchPlan = {
  status: "skipped" | "ready" | "dispatched" | "failed";
  reason: string;
  repository?: string;
  workflow: string;
  ref?: string;
  inputs?: DispatchInputs;
  jobs?: string[];
  ignoredJobs?: string[];
  recommendedJobs?: string[];
  dispatchableJobCount?: number;
  prNumber?: number;
  targetRef?: string;
  advisorDispatchId?: string;
  runId?: number;
  runUrl?: string;
  authorAssociation?: string;
  authorLogin?: string;
  allowedAuthorAssociations?: string[];
  allowedByAuthorAllowlist?: boolean;
};

type ParsedArgs = {
  result?: string;
  workflowPath?: string;
  workflow?: string;
  outDir?: string;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.outDir || "artifacts/e2e-advisor";
  const resultPath = args.result || path.join(outDir, "e2e-advisor-final-result.json");
  const workflowPath = args.workflowPath || ".github/workflows/nightly-e2e.yaml";
  const targetWorkflow = args.workflow || DEFAULT_TARGET_WORKFLOW;
  const outputPath = path.join(outDir, "e2e-advisor-dispatch-result.json");
  const summaryPath = path.join(outDir, "e2e-advisor-dispatch-summary.md");

  fs.mkdirSync(outDir, { recursive: true });

  let output: DispatchPlan;
  try {
    const result = readJson<AdvisorResult>(resultPath);
    const workflowText = fs.readFileSync(path.resolve(workflowPath), "utf8");
    const event = readJsonIfExists<GitHubEventPayload>(process.env.GITHUB_EVENT_PATH) || {};
    const plan = planAutoDispatch({
      result,
      workflowText,
      targetWorkflow,
      event,
      env: process.env,
    });

    if (plan.status !== "ready") {
      output = plan;
    } else {
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      if (!token || !plan.inputs || !plan.ref) {
        output = { ...plan, status: "skipped", reason: "GH_TOKEN/GITHUB_TOKEN was not available" };
      } else {
        await dispatchWorkflow({
          repo: plan.repository || "",
          workflow: plan.workflow,
          ref: plan.ref,
          inputs: plan.inputs,
          token,
        });
        let run: { id: number; url: string } | undefined;
        try {
          run = await findDispatchedWorkflowRun({
            repo: plan.repository || "",
            workflow: plan.workflow,
            ref: plan.ref,
            advisorDispatchId: plan.advisorDispatchId || "",
            token,
          });
        } catch (error: unknown) {
          console.warn(`Could not look up dispatched nightly run: ${error instanceof Error ? error.message : String(error)}`);
        }
        output = {
          ...plan,
          status: "dispatched",
          reason: `Dispatched ${plan.workflow} for ${plan.jobs?.length || 0} required E2E job(s)`,
          runId: run?.id,
          runUrl: run?.url,
        };
      }
    }
  } catch (error: unknown) {
    // Do not write exception details to artifacts. This catch can include
    // network-layer failures from the GitHub API dispatch path, and those
    // messages are not needed in uploaded advisor artifacts.
    console.error(`E2E advisor dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    output = {
      status: "failed",
      reason: "E2E advisor dispatch failed; see workflow logs for details",
      workflow: targetWorkflow,
    };
  }

  const summary = renderDispatchSummary(output);
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  fs.writeFileSync(summaryPath, summary);
  console.log(summary);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        parsed[key] = undefined;
        continue;
      }
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")) as T;
}

function readJsonIfExists<T>(filePath: string | undefined): T | undefined {
  if (!filePath) return undefined;
  const resolved = path.resolve(filePath);
  return fs.existsSync(resolved) ? readJson<T>(resolved) : undefined;
}

export function planAutoDispatch({
  result,
  workflowText,
  targetWorkflow = DEFAULT_TARGET_WORKFLOW,
  event = {},
  env = {},
}: {
  result: AdvisorResult;
  workflowText: string;
  targetWorkflow?: string;
  event?: GitHubEventPayload;
  env?: StringMap;
}): DispatchPlan {
  const repository = env.GITHUB_REPOSITORY || "";
  const allowedRepository = env.E2E_ADVISOR_AUTO_DISPATCH_REPOSITORY || "NVIDIA/NemoClaw";
  const eventName = env.GITHUB_EVENT_NAME || event.event_name || "";
  const pr = event.pull_request;

  const base = {
    status: "skipped" as const,
    workflow: targetWorkflow,
    repository,
  };

  if (env.E2E_ADVISOR_AUTO_DISPATCH === "0") {
    return { ...base, reason: "E2E_ADVISOR_AUTO_DISPATCH=0" };
  }
  if (eventName !== "pull_request") {
    return { ...base, reason: `event ${eventName || "<unknown>"} is not pull_request` };
  }
  if (repository !== allowedRepository) {
    return { ...base, reason: `repository ${repository || "<unknown>"} is not ${allowedRepository}` };
  }
  if (!pr) {
    return { ...base, reason: "pull_request payload was not available" };
  }
  if (pr.head?.repo?.full_name !== repository) {
    return {
      ...base,
      reason: `PR head repo ${pr.head?.repo?.full_name || "<unknown>"} is not ${repository}`,
      prNumber: pr.number,
    };
  }
  if (pr.draft) {
    return {
      ...base,
      reason: "PR is a draft",
      prNumber: pr.number,
    };
  }

  const authorAssociation = pr.author_association || "";
  const authorLogin = pr.user?.login || "";
  const allowedAssociations = parseCsv(env.E2E_ADVISOR_AUTO_DISPATCH_AUTHOR_ASSOCIATIONS || DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS);
  const allowedAuthorLogins = parseCsv(env.E2E_ADVISOR_AUTO_DISPATCH_ALLOWED_AUTHORS).map(normalizeLogin);
  const allowedByAssociation = allowedAssociations.includes(authorAssociation);
  const allowedByAuthorAllowlist = Boolean(authorLogin && allowedAuthorLogins.includes(normalizeLogin(authorLogin)));
  if (!allowedByAssociation && !allowedByAuthorAllowlist) {
    return {
      ...base,
      reason: `PR author association ${authorAssociation || "<unknown>"} is not allowed and PR author ${authorLogin || "<unknown>"} is not allowlisted`,
      prNumber: pr.number,
      authorAssociation,
      authorLogin,
      allowedAuthorAssociations: allowedAssociations,
    };
  }

  if (result.confidence === "low" && env.E2E_ADVISOR_AUTO_DISPATCH_LOW_CONFIDENCE !== "1") {
    return {
      ...base,
      reason: "advisor confidence was low",
      prNumber: pr.number,
      authorAssociation,
      authorLogin,
      allowedByAuthorAllowlist,
    };
  }

  const requiredTests = Array.isArray(result.requiredTests) ? result.requiredTests : [];
  if (requiredTests.length === 0) {
    return {
      ...base,
      reason: "advisor did not require any E2E jobs",
      prNumber: pr.number,
      authorAssociation,
      authorLogin,
      allowedByAuthorAllowlist,
    };
  }

  const dispatchableJobs = extractDispatchableJobs(workflowText);
  const recommendedJobs = collectRecommendedJobs(result, targetWorkflow);
  const jobs = unique(recommendedJobs.filter((job) => dispatchableJobs.includes(job)));
  const ignoredJobs = unique(recommendedJobs.filter((job) => !dispatchableJobs.includes(job)));

  if (jobs.length === 0) {
    return {
      ...base,
      reason: "no required advisor recommendations matched dispatchable jobs in the target workflow",
      prNumber: pr.number,
      authorAssociation,
      authorLogin,
      allowedByAuthorAllowlist,
      dispatchableJobCount: dispatchableJobs.length,
      recommendedJobs,
      ignoredJobs,
    };
  }

  const maxJobs = Number.parseInt(env.E2E_ADVISOR_AUTO_DISPATCH_MAX_JOBS || "0", 10);
  if (Number.isFinite(maxJobs) && maxJobs > 0 && jobs.length > maxJobs) {
    return {
      ...base,
      reason: `advisor recommended ${jobs.length} dispatchable jobs, above E2E_ADVISOR_AUTO_DISPATCH_MAX_JOBS=${maxJobs}`,
      prNumber: pr.number,
      authorAssociation,
      authorLogin,
      allowedByAuthorAllowlist,
      jobs,
      ignoredJobs,
    };
  }

  const targetRef = pr.head?.sha || pr.head?.ref || "";
  const dispatchRef = env.E2E_ADVISOR_AUTO_DISPATCH_REF || pr.base?.ref || DEFAULT_DISPATCH_REF;
  const advisorDispatchId = buildAdvisorDispatchId(pr.number, env);
  const inputs = {
    jobs: jobs.join(","),
    target_ref: targetRef,
    pr_number: String(pr.number || ""),
    advisor_dispatch_id: advisorDispatchId,
  };

  return {
    status: "ready",
    reason: "eligible for automatic E2E dispatch",
    repository,
    workflow: targetWorkflow,
    ref: dispatchRef,
    inputs,
    jobs,
    ignoredJobs,
    dispatchableJobCount: dispatchableJobs.length,
    prNumber: pr.number,
    targetRef,
    advisorDispatchId,
    authorAssociation,
    authorLogin,
    allowedAuthorAssociations: allowedAssociations,
    allowedByAuthorAllowlist,
  };
}

export function extractDispatchableJobs(workflowText: string): string[] {
  const jobsBlockStart = workflowText.search(/^jobs:\s*$/m);
  if (jobsBlockStart === -1) return [];

  const lines = workflowText.slice(jobsBlockStart).split(/\r?\n/);
  const jobs: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (!match) continue;

    const job = match[1];
    const bodyLines: string[] = [];
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[bodyIndex])) break;
      bodyLines.push(lines[bodyIndex]);
    }
    const body = bodyLines.join("\n");
    if (body.includes("inputs.jobs") && body.includes(`,${job},`)) {
      jobs.push(job);
    }
  }
  return jobs.sort();
}

export function collectRecommendedJobs(result: AdvisorResult, targetWorkflow = DEFAULT_TARGET_WORKFLOW): string[] {
  const requiredTests = Array.isArray(result.requiredTests) ? result.requiredTests : [];
  const jobs: string[] = [];
  for (const test of requiredTests) {
    const workflow = typeof test.workflow === "string" ? path.basename(test.workflow.trim()) : "";
    const workflowMatches = !workflow || workflow === targetWorkflow || workflow === path.basename(targetWorkflow);
    if (!workflowMatches) continue;
    if (typeof test.job === "string" && test.job.trim()) jobs.push(test.job.trim());
    if (typeof test.id === "string" && test.id.trim()) jobs.push(test.id.trim());
  }
  return unique(jobs);
}

function parseCsv(value: string | undefined): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function buildAdvisorDispatchId(prNumber: number | undefined, env: StringMap): string {
  const runId = env.GITHUB_RUN_ID || "local";
  const attempt = env.GITHUB_RUN_ATTEMPT ? `-${env.GITHUB_RUN_ATTEMPT}` : "";
  return `advisor-${prNumber || "unknown"}-${runId}${attempt}`;
}

async function dispatchWorkflow({
  repo,
  workflow,
  ref,
  inputs,
  token,
}: {
  repo: string;
  workflow: string;
  ref: string;
  inputs: DispatchInputs;
  token: string;
}): Promise<void> {
  const safeRepo = validateRepository(repo);
  const safeWorkflow = validateWorkflowFile(workflow);
  const safeRef = validateGitRef(ref);
  const safeInputs = validateDispatchInputs(inputs);
  const dispatchUrl = `https://api.github.com/repos/${safeRepo}/actions/workflows/${encodeURIComponent(safeWorkflow)}/dispatches`;

  // lgtm[js/file-access-to-http] The request body is constructed only after
  // same-repository/OWNER-or-MEMBER gating and strict validation of the target
  // workflow, ref, PR number, and comma-separated E2E job names.
  const response = await fetch(dispatchUrl, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "nemoclaw-e2e-advisor-dispatcher",
    },
    body: JSON.stringify({ ref: safeRef, inputs: safeInputs }),
  });

  if (!response.ok) {
    // Do not include the response body in thrown errors. GitHub API error text
    // is network-controlled and this script records failures to artifact files.
    throw new Error(`GitHub workflow dispatch failed with HTTP ${response.status}`);
  }
}

type WorkflowRunSearchResult = {
  workflow_runs?: Array<{
    id?: number;
    html_url?: string;
    display_title?: string;
    event?: string;
  }>;
};

async function findDispatchedWorkflowRun({
  repo,
  workflow,
  ref,
  advisorDispatchId,
  token,
}: {
  repo: string;
  workflow: string;
  ref: string;
  advisorDispatchId: string;
  token: string;
}): Promise<{ id: number; url: string } | undefined> {
  if (!advisorDispatchId) return undefined;

  const safeRepo = validateRepository(repo);
  const safeWorkflow = validateWorkflowFile(workflow);
  const safeRef = validateGitRef(ref);
  const params = new URLSearchParams({
    event: "workflow_dispatch",
    branch: safeRef,
    per_page: "20",
  });
  const runsUrl = `https://api.github.com/repos/${safeRepo}/actions/workflows/${encodeURIComponent(safeWorkflow)}/runs?${params}`;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt > 0) await delay(2000);
    const response = await fetch(runsUrl, {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "nemoclaw-e2e-advisor-dispatcher",
      },
    });
    if (!response.ok) {
      console.warn(`Could not look up dispatched nightly run: GitHub API HTTP ${response.status}`);
      return undefined;
    }

    const data = await response.json() as WorkflowRunSearchResult;
    const match = data.workflow_runs?.find(
      (run) => run.event === "workflow_dispatch" && run.display_title?.includes(advisorDispatchId),
    );
    if (match?.id && match.html_url) return { id: match.id, url: match.html_url };
  }

  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateRepository(repo: string): string {
  if (repo !== "NVIDIA/NemoClaw") {
    throw new Error("Refusing to dispatch outside NVIDIA/NemoClaw");
  }
  return repo;
}

function validateWorkflowFile(workflow: string): string {
  if (workflow !== DEFAULT_TARGET_WORKFLOW) {
    throw new Error(`Refusing to dispatch unexpected workflow: ${workflow}`);
  }
  return workflow;
}

export function validateGitRef(ref: string): string {
  return validateSafeRef(ref, "Refusing to dispatch an unsafe workflow ref");
}

export function validateDispatchInputs(inputs: DispatchInputs): DispatchInputs {
  const jobs = inputs.jobs.split(",").filter(Boolean);
  if (jobs.length === 0 || jobs.some((job) => !/^[A-Za-z0-9_-]+$/.test(job))) {
    throw new Error("Refusing to dispatch unsafe E2E job input");
  }
  validateSafeRef(inputs.target_ref, "Refusing to dispatch unsafe target_ref input");
  if (!/^\d+$/.test(inputs.pr_number)) {
    throw new Error("Refusing to dispatch unsafe pr_number input");
  }
  const advisorDispatchId = inputs.advisor_dispatch_id;
  if (advisorDispatchId !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(advisorDispatchId)) {
    throw new Error("Refusing to dispatch unsafe advisor_dispatch_id input");
  }
  return {
    jobs: jobs.join(","),
    target_ref: inputs.target_ref,
    pr_number: inputs.pr_number,
    ...(advisorDispatchId ? { advisor_dispatch_id: advisorDispatchId } : {}),
  };
}

function validateSafeRef(ref: string, message: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref)) {
    throw new Error(message);
  }
  if (ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock")) {
    throw new Error(message);
  }
  return ref;
}

function renderDispatchSummary(result: DispatchPlan): string {
  const lines = ["# E2E Advisor Auto-dispatch", ""];
  lines.push(`Status: **${result.status || "unknown"}**`);
  if (result.reason) lines.push(`Reason: ${result.reason}`);
  if (result.workflow) lines.push(`Workflow: \`${result.workflow}\``);
  if (result.ref) lines.push(`Dispatch ref: \`${result.ref}\``);
  if (result.targetRef) lines.push(`Target ref: \`${result.targetRef}\``);
  if (result.advisorDispatchId) lines.push(`Trace ID: \`${result.advisorDispatchId}\``);
  if (result.runUrl) lines.push(`Nightly run: ${result.runUrl}`);
  if (Array.isArray(result.jobs) && result.jobs.length > 0) {
    lines.push(`Jobs: ${result.jobs.map((job) => `\`${job}\``).join(", ")}`);
  }
  if (Array.isArray(result.ignoredJobs) && result.ignoredJobs.length > 0) {
    lines.push(`Ignored recommendations: ${result.ignoredJobs.map((job) => `\`${job}\``).join(", ")}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

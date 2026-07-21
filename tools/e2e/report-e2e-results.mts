// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ReportApiJob = {
  completed_at?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
  id?: number;
  name?: string;
  started_at?: string | null;
  status?: string;
};

export type ReportNeedResult = { result?: string };

export type ReportNeeds = Record<string, ReportNeedResult>;

export type ReportEnv = {
  EXPLICIT_ONLY_JOBS?: string;
  JOBS?: string;
  JOB_PR_NUMBER?: string;
  JOB_TARGETS?: string;
  TEST_MATRIX?: string;
};

export type ReportContext = {
  ref: string;
  repo: { owner: string; repo: string };
  runId: number;
  serverUrl: string;
};

export type ReportCore = {
  info: (message: string) => void;
  setFailed: (message: string) => void;
  warning: (message: string) => void;
};

export type ReportGithub = {
  paginate: (route: unknown, parameters: Record<string, unknown>) => Promise<ReportApiJob[]>;
  rest: {
    actions: { listJobsForWorkflowRun: unknown };
    issues: {
      createComment: (input: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<unknown>;
    };
    pulls: {
      get: (input: {
        owner: string;
        repo: string;
        pull_number: number;
      }) => Promise<{ data: { state?: string } }>;
      list: (input: {
        owner: string;
        repo: string;
        head: string;
        state: string;
      }) => Promise<{ data: Array<{ number: number }> }>;
    };
  };
};

export type ReportRenderResult = { body: string; warnings: string[]; fatal?: string };

type WallClockRange = { startedAt: number; completedAt: number };

type ReportEntry = { result?: string; jobUrl?: string; wallClockRange?: WallClockRange };

const TERMINAL_CONCLUSIONS = ["success", "failure", "cancelled", "skipped"];
const PASSING_JOB_CONCLUSIONS = ["success", "skipped", "neutral"];

export async function resolveReportPr(input: {
  github: ReportGithub;
  context: ReportContext;
  core: ReportCore;
  env: ReportEnv;
}): Promise<number | undefined> {
  const { github, context, core, env } = input;
  const workflowBranch = context.ref.replace("refs/heads/", "");
  const prNumberInput = env.JOB_PR_NUMBER || "";
  if (prNumberInput) {
    if (!/^[1-9][0-9]*$/.test(prNumberInput)) {
      core.setFailed(
        `Invalid pr_number input: ${prNumberInput}. Use a positive pull request number.`,
      );
      return undefined;
    }
    const prNumber = Number(prNumberInput);
    if (!Number.isSafeInteger(prNumber)) {
      core.setFailed(`Invalid pr_number input: ${prNumberInput}. Use a safe positive integer.`);
      return undefined;
    }
    try {
      const { data: suppliedPr } = await github.rest.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: prNumber,
      });
      if (suppliedPr.state !== "open") {
        core.setFailed(
          `PR #${prNumber} is ${suppliedPr.state}; E2E reports only comment on open PRs.`,
        );
        return undefined;
      }
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        core.setFailed(
          `pr_number ${prNumber} does not identify a pull request in ${context.repo.owner}/${context.repo.repo}.`,
        );
        return undefined;
      }
      throw error;
    }
    return prNumber;
  }
  const { data: prs } = await github.rest.pulls.list({
    owner: context.repo.owner,
    repo: context.repo.repo,
    head: `${context.repo.owner}:${workflowBranch}`,
    state: "open",
  });
  if (prs.length === 0) {
    core.info(`No open PR found for branch ${workflowBranch} — skipping comment.`);
    return undefined;
  }
  if (prs.length !== 1) {
    core.setFailed(
      `Multiple open PRs found for branch ${workflowBranch}; provide an explicit pr_number.`,
    );
    return undefined;
  }
  return prs[0].number;
}

export async function loadReportJobs(input: {
  github: ReportGithub;
  context: ReportContext;
  core: ReportCore;
}): Promise<{ apiJobs: ReportApiJob[]; loaded: boolean }> {
  const { github, context, core } = input;
  try {
    const apiJobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      run_id: context.runId,
      filter: "latest",
      per_page: 100,
    });
    return { apiJobs, loaded: true };
  } catch (error) {
    core.warning(
      `Could not load per-test results; reporting them as unknown: ${(error as Error).message}`,
    );
    return { apiJobs: [], loaded: false };
  }
}

export function renderE2eReport(input: {
  needs: ReportNeeds;
  env: ReportEnv;
  apiJobs: ReportApiJob[];
  apiJobsLoaded: boolean;
  context: ReportContext;
}): ReportRenderResult {
  const { needs, env, apiJobs, apiJobsLoaded, context } = input;
  const warnings: string[] = [];
  const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  const workflowBranch = context.ref.replace("refs/heads/", "");
  const rawRequestedTargets = env.JOB_TARGETS || "";
  const rawRequestedTestIds = env.JOBS || "";
  const selectorValidationPassed = needs["generate-matrix"]?.result === "success";
  const requestedTargets = selectorValidationPassed ? rawRequestedTargets : "";
  const requestedTestIdsCsv = selectorValidationPassed ? rawRequestedTestIds : "";
  const explicitOnlyReasons: Record<string, { job: string; target: string; reason: string }> = {
    "openshell-gateway-auth-contract": {
      job: "openshell-gateway-auth-contract",
      target: "openshell-gateway-auth-contract",
      reason:
        "default dispatch excludes the resource-heavy OpenShell auth-contract probe unless selected",
    },
    "mcp-bridge-dev": {
      job: "mcp-bridge-dev",
      target: "mcp-bridge-dev",
      reason: "default dispatch excludes moving OpenShell dev artifacts unless explicitly selected",
    },
    "jetson-nvmap-gpu": {
      job: "jetson-nvmap-gpu",
      target: "jetson-nvmap-gpu",
      reason:
        "default dispatch excludes Jetson; explicit dispatch requires allow_jetson_runner_queue=true after confirming an online Jetson runner because queued jobs do not honor timeout-minutes before assignment",
    },
    "sandbox-rlimits-connect": {
      job: "sandbox-rlimits-connect",
      target: "sandbox-rlimits-connect",
      reason: "default dispatch excludes the destructive rlimit fork/connect probe unless selected",
    },
  };
  const explicitOnlySkippedJobs = (env.EXPLICIT_ONLY_JOBS || "")
    .split(",")
    .filter(Boolean)
    .map(
      (job) =>
        explicitOnlyReasons[job] ?? {
          job,
          target: job,
          reason: "default dispatch excludes this explicit-only job unless selected",
        },
    );
  const targetsRejected = Boolean(rawRequestedTargets) && !selectorValidationPassed;
  const testIdsRejected = Boolean(rawRequestedTestIds) && !selectorValidationPassed;

  const requestedTestIds = requestedTestIdsCsv
    .split(",")
    .map((testId) => testId.trim())
    .filter(Boolean);
  const requestedTestIdSet = new Set(requestedTestIds);
  const selectiveDispatch =
    requestedTestIds.length > 0 || Boolean(requestedTargets) || targetsRejected || testIdsRejected;
  const emoji: Record<string, string> = {
    success: "✅",
    failure: "❌",
    cancelled: "⚠️",
    skipped: "⏭️",
  };
  const safeSelector = /^[A-Za-z0-9_-]+$/;
  let testIds: string[];
  try {
    const testMatrix = JSON.parse(env.TEST_MATRIX || "[]");
    if (!Array.isArray(testMatrix)) throw new Error("matrix must be an array");
    testIds = testMatrix.map((row) => {
      if (!row || typeof row !== "object" || !safeSelector.test(row.id || "")) {
        throw new Error("matrix row has an invalid id");
      }
      return row.id;
    });
    if (new Set(testIds).size !== testIds.length) {
      throw new Error("matrix repeats a test id");
    }
  } catch (error) {
    return { body: "", warnings, fatal: `Invalid test matrix: ${(error as Error).message}` };
  }

  const testResults = new Map<string, ReportEntry>();
  const jobLinks = new Map<string, { didNotPass: boolean; url: string }>();
  const wallClockRanges = new Map<string, WallClockRange>();
  const validatedJobUrl = (job: ReportApiJob): string | undefined =>
    Number.isSafeInteger(job.id) && (job.id as number) > 0 ? `${runUrl}/job/${job.id}` : undefined;
  const recordJobLink = (name: string, job: ReportApiJob) => {
    const url = validatedJobUrl(job);
    if (!url) return;
    const didNotPass =
      job.status === "completed" && !PASSING_JOB_CONCLUSIONS.includes(job.conclusion ?? "");
    const current = jobLinks.get(name);
    if (!current || (didNotPass && !current.didNotPass)) {
      jobLinks.set(name, { didNotPass, url });
    }
  };
  const recordWallClockRange = (name: string, job: ReportApiJob) => {
    if (job.conclusion === "skipped") return;
    const startedAt = Date.parse(job.started_at || "");
    const completedAt = Date.parse(job.completed_at || "");
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
      return;
    }
    const current = wallClockRanges.get(name);
    wallClockRanges.set(name, {
      startedAt: current ? Math.min(current.startedAt, startedAt) : startedAt,
      completedAt: current ? Math.max(current.completedAt, completedAt) : completedAt,
    });
  };
  const formatWallClockTime = (range?: WallClockRange): string => {
    if (!range) return "—";
    const totalSeconds = Math.round((range.completedAt - range.startedAt) / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${seconds}s`]
      .filter(Boolean)
      .join(" ");
  };

  const selectedTestIds = new Set(testIds);
  const aggregateJobNames = Object.keys(needs);
  for (const job of apiJobs) {
    const jobName = job.name || "";
    const match = /^Shared E2E \(([A-Za-z0-9_-]+)\)$/.exec(jobName);
    const aggregateJobName = aggregateJobNames.find((name) => jobName.startsWith(`${name} (`));
    const reportEntryName =
      match?.[1] ??
      aggregateJobName ??
      (/^OpenShell gateway upgrade \(.+\)$/.test(jobName) ? "openshell-gateway-upgrade" : jobName);
    recordWallClockRange(reportEntryName, job);
    recordJobLink(reportEntryName, job);
    if (!match || !selectedTestIds.has(match[1])) continue;
    const result =
      job.status === "completed" && TERMINAL_CONCLUSIONS.includes(job.conclusion ?? "")
        ? (job.conclusion as string)
        : "unknown";
    testResults.set(match[1], { jobUrl: validatedJobUrl(job), result });
  }

  const missingTestResults = testIds.filter((id) => !testResults.has(id));
  if (apiJobsLoaded && missingTestResults.length > 0) {
    warnings.push(
      `Missing per-test results for ${missingTestResults.join(", ")}; reporting them as unknown.`,
    );
  }
  const sharedJobAggregateResult = needs["shared-e2e"]?.result;
  const knownTestResults = testIds.map((id) => testResults.get(id)?.result);
  const allTestResultsKnown =
    knownTestResults.length > 0 &&
    knownTestResults.every((result) => result && result !== "unknown");
  const expectedAggregateChildResult =
    sharedJobAggregateResult === "failure"
      ? "failure"
      : sharedJobAggregateResult === "cancelled"
        ? "cancelled"
        : undefined;
  const testAttributionMismatch =
    allTestResultsKnown &&
    expectedAggregateChildResult &&
    !knownTestResults.includes(expectedAggregateChildResult);
  if (testAttributionMismatch) {
    warnings.push(
      `Per-test conclusions (${knownTestResults.join(", ")}) contradict shared E2E job aggregate ${sharedJobAggregateResult}; reporting child attribution as unknown.`,
    );
    for (const id of testIds) {
      testResults.set(id, { ...testResults.get(id), result: "unknown" });
    }
  }

  const allEntries: Array<[string, ReportEntry]> = Object.entries(needs)
    .filter(([name]) => name !== "shared-e2e")
    .map(([name, value]) => [
      name,
      {
        ...value,
        jobUrl: jobLinks.get(name)?.url,
        wallClockRange: wallClockRanges.get(name),
      },
    ]);
  if (needs["shared-e2e"]) {
    allEntries.push(
      ...testIds.map((id): [string, ReportEntry] => [
        id,
        {
          ...(testResults.get(id) ?? { result: "unknown" }),
          jobUrl: testResults.get(id)?.jobUrl ?? jobLinks.get(id)?.url,
          wallClockRange: wallClockRanges.get(id),
        },
      ]),
    );
  }
  allEntries.sort(([a], [b]) => a.localeCompare(b));
  const missingRequestedTestIds = selectorValidationPassed
    ? requestedTestIds.filter((testId) => !allEntries.some(([name]) => name === testId))
    : [];
  const selectedEntries =
    requestedTestIds.length > 0
      ? allEntries.filter(([name]) => requestedTestIdSet.has(name))
      : selectiveDispatch
        ? allEntries.filter(
            ([name, { result }]) => result !== "skipped" && name !== "generate-matrix",
          )
        : allEntries;
  const reportedEntries =
    selectedEntries.length > 0
      ? selectedEntries
      : selectiveDispatch
        ? allEntries.filter(([, { result }]) => result !== "skipped")
        : allEntries;
  const rows = reportedEntries.map(([name, { jobUrl, result, wallClockRange }]) => {
    const label = result === "failure" ? `[${name}](${jobUrl ?? runUrl})` : name;
    return `| ${label} | ${emoji[result ?? ""] || "❓"} ${result} | ${formatWallClockTime(wallClockRange)} |`;
  });
  for (const name of missingRequestedTestIds) {
    rows.push(`| ${name} | ❓ not reported | — |`);
  }

  const ran = reportedEntries.filter(([, v]) => v.result !== "skipped");
  const passed = ran.filter(([, v]) => v.result === "success");
  const failed = ran.filter(([, v]) => v.result === "failure");
  const skipped = reportedEntries.filter(([, v]) => v.result === "skipped");
  const cancelled = ran.filter(([, v]) => v.result === "cancelled");
  const unknown = ran.filter(([, v]) => v.result === "unknown");
  const sharedJobAggregateFailed = sharedJobAggregateResult === "failure";
  const sharedJobAggregateCancelled = sharedJobAggregateResult === "cancelled";
  const passingStatus =
    requestedTestIds.length > 0
      ? "✅ All requested tests passed"
      : selectiveDispatch
        ? "✅ All selected tests passed"
        : "✅ All default tests passed";
  const status =
    failed.length > 0 || missingRequestedTestIds.length > 0 || sharedJobAggregateFailed
      ? "❌ Some tests failed"
      : (cancelled.length > 0 || sharedJobAggregateCancelled) && passed.length === 0
        ? "⚠️ Run cancelled — no signal"
        : cancelled.length > 0 || sharedJobAggregateCancelled
          ? "⚠️ Some tests cancelled — partial pass"
          : unknown.length > 0
            ? "⚠️ Per-test results incomplete"
            : skipped.length > 0 && passed.length === 0
              ? "⚠️ No selected tests ran"
              : passingStatus;

  const lines = [
    `### E2E Target Results — ${status}`,
    "",
    `**Run:** [${context.runId}](${runUrl})`,
    `**Workflow ref:** \`${workflowBranch}\``,
    targetsRejected
      ? "**Requested targets:** _(selector rejected by workflow validation)_"
      : requestedTargets
        ? `**Requested targets:** \`${requestedTargets}\``
        : "**Requested targets:** _(default — all supported)_",
    testIdsRejected
      ? "**Requested test IDs:** _(selector rejected by workflow validation)_"
      : requestedTestIdsCsv
        ? `**Requested test IDs:** \`${requestedTestIdsCsv}\``
        : "**Requested test IDs:** _(default — all default-enabled tests; explicit-only tests `openshell-gateway-auth-contract`, `mcp-bridge-dev`, `hermes-gpu-startup`, `sandbox-rlimits-connect`, and `jetson-nvmap-gpu` are skipped unless selected)_",
    `**Summary:** ${passed.length} passed, ${failed.length} failed, ${cancelled.length} cancelled, ${skipped.length} skipped, ${unknown.length} unknown`,
    "",
    "| Test | Result | Total wall clock time |",
    "|-----|--------|-----------------------|",
    ...rows,
  ];
  if (!selectiveDispatch) {
    const skippedJobHints = explicitOnlySkippedJobs
      .map(
        ({ job, target, reason }) =>
          `\`${job}\` (${reason}; validate with \`jobs=${job}\` or \`targets=${target}\`)`,
      )
      .join(", ");
    lines.push("", `> **Explicit-only jobs skipped:** ${skippedJobHints}.`);
  }
  if (failed.length > 0) {
    const failedLinks = failed
      .map(([name, { jobUrl }]) => `[${name}](${jobUrl ?? runUrl})`)
      .join(", ");
    lines.push(
      "",
      `> **Failed tests:** ${failedLinks}. Check [the workflow run](${runUrl}) for all logs and artifacts.`,
    );
  }
  if (missingRequestedTestIds.length > 0) {
    lines.push(
      "",
      `> **Missing requested test IDs:** ${missingRequestedTestIds.join(", ")}. The reporting workflow needs to include these tests.`,
    );
  }
  if (unknown.length > 0) {
    const unknownNames = unknown.map(([name]) => name).join(", ");
    lines.push(
      "",
      `> **Unknown per-test results:** ${unknownNames}. Shared E2E job aggregate: ${needs["shared-e2e"]?.result ?? "unavailable"}.`,
    );
  }

  return { body: lines.join("\n"), warnings };
}

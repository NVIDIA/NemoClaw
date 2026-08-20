// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
const workflow = input.workflow ?? "e2e.yaml";
const branch = input.branch ?? "main";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
if (!/^[A-Za-z0-9_.\/-]+\.ya?ml$/.test(workflow))
  throw new Error("workflow must be a YAML workflow path or filename");
if (!/^[A-Za-z0-9_.\/-]+$/.test(branch)) throw new Error("branch is invalid");
if (!/^[0-9a-f]{40}$/.test(input.candidateSha))
  throw new Error("candidateSha must be a full lowercase commit SHA");
const runIds = [...new Set(input.runIds)];
if (
  runIds.length === 0 ||
  runIds.length > 20 ||
  runIds.some((id) => !Number.isInteger(id) || id <= 0)
)
  throw new Error("runIds must contain 1 to 20 positive run IDs");
const timeoutMs = Math.max(0, Math.min(1800000, input.timeoutMs ?? 600000));
const intervalMs = Math.max(5000, Math.min(120000, input.intervalMs ?? 30000));
const runLimit = Math.max(runIds.length, Math.min(100, input.runLimit ?? 100));
const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const cut = (value, size) => (typeof value === "string" ? value.slice(0, size) : null);
const redact = (value) =>
  String(value)
    .replace(/(authorization\s*:)[^\r\n]*/gi, "$1 [REDACTED]")
    .replace(/([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)\s*=)\s*[^\s]+/g, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/g, "$1[REDACTED]@")
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "/[HOME]");
const runGh = async (args) => {
  const result = await tools.bash({
    command: "gh " + args.map(quote).join(" "),
    workdir: input.workdir,
    description: "Read bounded GitHub E2E data",
    timeoutMs: 60000,
  });
  if (result.kind !== "foreground") throw new Error("Unexpected background result");
  if (result.exitCode !== 0)
    throw new Error("GitHub E2E run monitoring failed: " + redact(result.stderr.text).slice(-1500));
  try {
    return JSON.parse(result.stdout.text || "null");
  } catch {
    throw new Error("GitHub E2E run monitoring returned an invalid bounded response");
  }
};
const sleep = async () => {
  const result = await tools.bash({
    command: "sleep " + quote(String(intervalMs / 1000)),
    workdir: input.workdir,
    description: "Wait before next E2E poll",
    timeoutMs: intervalMs + 1000,
  });
  if (result.kind !== "foreground" || result.exitCode !== 0)
    throw new Error("E2E polling wait failed");
};
const deadline = Date.now() + timeoutMs;
let polls = 0;
let selected = [];
let reason = null;
while (true) {
  polls += 1;
  const runs = await runGh([
    "run",
    "list",
    "--repo",
    repo,
    "--workflow",
    workflow,
    "--branch",
    branch,
    "--limit",
    String(runLimit),
    "--json",
    "databaseId,displayTitle,headSha,status,conclusion,url",
  ]);
  selected = runIds.map(
    (runId) => runs.find((run) => run.databaseId === runId) ?? { databaseId: runId, missing: true },
  );
  if (selected.some((run) => !run.missing && run.headSha !== input.candidateSha)) {
    reason = "candidate-commit-mismatch";
    break;
  }
  if (selected.every((run) => !run.missing && run.status === "completed")) break;
  if (Date.now() >= deadline) {
    reason = selected.some((run) => run.missing) ? "run-not-in-bounded-list" : "timeout";
    break;
  }
  await sleep();
}
const jobSummaries = [];
if (input.includeJobs !== false) {
  for (const run of selected.filter((item) => !item.missing)) {
    const view = await runGh([
      "run",
      "view",
      String(run.databaseId),
      "--repo",
      repo,
      "--json",
      "status,conclusion,attempt,jobs",
    ]);
    const jobs = Array.isArray(view.jobs) ? view.jobs : [];
    const countMap = new Map();
    for (const job of jobs) {
      const state = job.conclusion || job.status || "unknown";
      countMap.set(state, (countMap.get(state) ?? 0) + 1);
    }
    const counts = [...countMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 30)
      .map(([state, count]) => ({ state: cut(state, 100) ?? "", count }));
    const failures = jobs
      .filter((job) => job.conclusion === "failure")
      .slice(0, 50)
      .map((job) => ({
        name: cut(job.name, 500) ?? "",
        url: cut(job.url, 2000),
        failedSteps: (Array.isArray(job.steps) ? job.steps : [])
          .filter((step) => step.conclusion === "failure")
          .slice(0, 100)
          .map((step) => cut(step.name, 500) ?? ""),
      }));
    const remaining = jobs
      .filter((job) => job.status !== "completed")
      .slice(0, 50)
      .map((job) => ({
        name: cut(job.name, 500) ?? "",
        status: cut(job.status, 100),
        url: cut(job.url, 2000),
      }));
    jobSummaries.push({
      runId: run.databaseId,
      attempt: Number.isInteger(view.attempt) ? view.attempt : null,
      status: cut(view.status, 100),
      conclusion: cut(view.conclusion, 100),
      counts,
      failures,
      remaining,
    });
  }
}
return {
  checkedAt: new Date().toISOString(),
  repo,
  workflow,
  branch,
  candidateSha: input.candidateSha,
  terminal: selected.every((run) => !run.missing && run.status === "completed"),
  reason,
  polls,
  runs: selected.map((run) => ({
    runId: run.databaseId,
    title: cut(run.displayTitle, 500),
    headSha: cut(run.headSha, 40),
    status: cut(run.status, 100),
    conclusion: cut(run.conclusion, 100),
    url: cut(run.url, 2000),
    missing: Boolean(run.missing),
  })),
  jobSummaries,
};

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
if (!Number.isSafeInteger(input.number) || input.number <= 0)
  throw new Error("number must be a positive PR number");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
const maxControllerPages = Math.max(1, Math.min(5, input.maxControllerPages ?? 3));
const q = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const transient =
  /TLS handshake timeout|connection reset|temporar(?:y|ily)|HTTP 50[234]|unexpected EOF|i\/o timeout/i;
const gh = async (args, description, timeoutMs = 30000) => {
  const command = "gh " + args.map(q).join(" ");
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await tools.bash({ command, workdir: input.workdir, description, timeoutMs });
    if (last.kind !== "foreground") throw new Error("Unexpected background result");
    if (last.exitCode === 0) return last.stdout.text;
    const detail = last.stderr.text + "\n" + last.stdout.text;
    if (!transient.test(detail) || attempt === 3)
      throw new Error(`GitHub read failed: ${detail.slice(-1500)}`);
  }
  throw new Error("GitHub read failed");
};
const prRaw = JSON.parse(
  await gh(
    [
      "api",
      `repos/${repo}/pulls/${input.number}`,
      "--jq",
      "{number,title,state,url:.html_url,head:{sha:.head.sha,ref:.head.ref},base:{sha:.base.sha,ref:.base.ref},mergeable_state}",
    ],
    "Read pull request gate identity",
  ),
);
const pr = {
  number: Number(prRaw.number),
  title: String(prRaw.title ?? "").slice(0, 1000),
  state: String(prRaw.state ?? "").slice(0, 100),
  url: String(prRaw.url ?? "").slice(0, 2000),
  head: { sha: String(prRaw.head?.sha ?? ""), ref: String(prRaw.head?.ref ?? "").slice(0, 500) },
  base: { sha: String(prRaw.base?.sha ?? ""), ref: String(prRaw.base?.ref ?? "").slice(0, 500) },
  mergeableState: String(prRaw.mergeable_state ?? "").slice(0, 100),
};
const externalId = `nemoclaw-pr-e2e:v2:${input.number}:${pr.head.sha}:${pr.base.sha}`;
const matches = [];
for (let pageNumber = 1; pageNumber <= 3; pageNumber++) {
  const page = JSON.parse(
    await gh(
      [
        "api",
        `repos/${repo}/commits/${pr.head.sha}/check-runs?filter=all&per_page=100&page=${pageNumber}`,
        "--jq",
        '{count:(.check_runs|length),matches:[.check_runs[]|select(.name == "E2E / PR Gate")|{id,name,status,conclusion,headSha:.head_sha,externalId:.external_id,detailsUrl:.details_url,startedAt:.started_at,completedAt:.completed_at,output:{title:(.output.title // ""),summary:(.output.summary // "")[0:5000]},suiteId:.check_suite.id,app:{id:.app.id,slug:.app.slug}}]}',
      ],
      "Read pull request gate checks",
    ),
  );
  matches.push(...page.matches.slice(0, 100));
  if (page.count < 100) break;
}
const exactChecks = matches
  .filter((item) => item.externalId === externalId)
  .sort((a, b) => Number(b.id) - Number(a.id));
const check = exactChecks[0] ?? null;
let suite = null;
if (check?.suiteId) {
  const suiteRaw = JSON.parse(
    await gh(
      [
        "api",
        `repos/${repo}/check-suites/${check.suiteId}`,
        "--jq",
        "{id,status,conclusion,headSha:.head_sha,headBranch:.head_branch,app:{id:.app.id,slug:.app.slug}}",
      ],
      "Read E2E gate check suite",
    ),
  );
  const siblings = JSON.parse(
    await gh(
      [
        "api",
        `repos/${repo}/check-suites/${check.suiteId}/check-runs?per_page=100`,
        "--jq",
        "[.check_runs[]|{id,name,status,conclusion,detailsUrl:.details_url}][0:100]",
      ],
      "Read E2E gate sibling checks",
    ),
  );
  suite = { ...suiteRaw, checks: siblings };
}
const identity = `PR #${input.number} head ${pr.head.sha} base ${pr.base.sha}`;
const controllerRuns = [];
for (let pageNumber = 1; pageNumber <= maxControllerPages; pageNumber++) {
  const jq = `{count:(.workflow_runs|length),matches:[.workflow_runs[]|select(.display_title|contains(${JSON.stringify(identity)}))|{id:.id,title:.display_title,event,status,conclusion,createdAt:.created_at,updatedAt:.updated_at,url:.html_url}][0:100]}`;
  const page = JSON.parse(
    await gh(
      [
        "api",
        `repos/${repo}/actions/workflows/pr-e2e-gate.yaml/runs?per_page=100&page=${pageNumber}`,
        "--jq",
        jq,
      ],
      "Read E2E gate controller runs",
    ),
  );
  controllerRuns.push(...page.matches);
  if (page.count < 100 || controllerRuns.length) break;
}
controllerRuns.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
const boundedControllerRuns = controllerRuns.slice(0, 10);
const latestController =
  boundedControllerRuns.find(
    (run) => run.event === "workflow_run" && / gate true$/.test(run.title),
  ) ??
  boundedControllerRuns.find((run) => / gate true$/.test(run.title)) ??
  boundedControllerRuns[0] ??
  null;
let controllerFailure = null;
if (latestController?.conclusion === "failure") {
  const failedLog = await gh(
    ["run", "view", String(latestController.id), "--repo", repo, "--log-failed"],
    "Read failed gate controller log",
    60000,
  );
  controllerFailure = {
    runId: Number(latestController.id),
    url: String(latestController.url ?? "").slice(0, 2000),
    relevant: failedLog
      .split(/\r?\n/)
      .filter((line) => /not retryable|Existing PR gate state|error|failed|failure/i.test(line))
      .slice(-30)
      .map((line) => line.slice(0, 4000)),
  };
}
const childRunId = String(check?.output?.summary ?? "").match(/actions\/runs\/(\d+)/)?.[1] ?? null;
let childRun = null;
if (childRunId) {
  const child = JSON.parse(
    await gh(
      [
        "run",
        "view",
        childRunId,
        "--repo",
        repo,
        "--json",
        "status,conclusion,url,createdAt,updatedAt",
      ],
      "Read selected E2E child run",
    ),
  );
  childRun = {
    id: Number(childRunId),
    status: String(child.status ?? ""),
    conclusion: child.conclusion == null ? null : String(child.conclusion),
    url: String(child.url ?? "").slice(0, 2000),
    createdAt: String(child.createdAt ?? ""),
    updatedAt: String(child.updatedAt ?? ""),
  };
}
const failureText = controllerFailure?.relevant?.join("\n") ?? "";
let diagnosis = "gate-not-reported";
let nextAction =
  "Wait for the controller to report the exact PR head and base, then inspect its gate-eligible run.";
if (check?.status === "in_progress" && check.output?.title === "Waiting for PR CI") {
  diagnosis = "waiting-for-prerequisite-ci";
  nextAction = "Inspect the gate-eligible CI / Pull Request run for this PR head and base.";
} else if (check?.status === "in_progress") {
  diagnosis = "gate-in-progress";
  nextAction = childRun
    ? "Wait for the selected child run and evidence reconciliation."
    : "Inspect the gate-eligible controller run.";
} else if (
  check?.conclusion === "success" &&
  /not retryable|Existing PR gate state/i.test(failureText)
) {
  diagnosis = "successful-gate-not-refreshed-after-ci-rerun";
  nextAction =
    "Update the controller to refresh the existing successful check after a successful same-head and same-base CI rerun.";
} else if (check?.conclusion === "success") {
  diagnosis = "gate-passed";
  nextAction =
    suite?.conclusion === "skipped"
      ? "The gate passed, but inspect ruleset reporting because its containing check suite concluded skipped."
      : "No E2E gate action is required.";
} else if (check?.status === "completed") {
  diagnosis = "gate-completed-without-success";
  nextAction = "Inspect the gate summary and retry marker before rerunning CI or E2E.";
}
return {
  checkedAt: new Date().toISOString(),
  repo,
  pr,
  externalId,
  check,
  suite,
  latestController,
  controllerRuns: boundedControllerRuns,
  controllerFailure,
  childRun,
  diagnosis,
  nextAction,
  pagination: {
    maxCheckPages: 3,
    maxControllerPages,
    checksFound: matches.length,
    exactChecksFound: exactChecks.length,
    controllerRunsFound: controllerRuns.length,
    controllerRunsTruncated: controllerRuns.length > boundedControllerRuns.length,
  },
};

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REQUIRED_CHECK_NAMES = [
  "checks",
  "check-hash",
  "changes",
  "commit-lint",
  "dco-check",
  "E2E / PR Gate",
] as const;

type E2eCheckFixture = [number, number, string, string?, string?, string?, string?];
const CUSTOM_RUN_URL = "https://github.com/NVIDIA/NemoClaw/runs/123";
const INCOMPLETE_E2E = ["E2E / PR Gate: latest attempt evidence incomplete"];
const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const E2E_COORDINATION_NAME = "E2E / PR Gate Coordination";
const E2E_COORDINATION_EXTERNAL_ID = `nemoclaw-pr-e2e:v2:42:${HEAD_SHA}:${BASE_SHA}`;
const PR_WORKFLOW_JOB_NAMES = [
  "changes",
  "docs-only-checks",
  "static-checks",
  "build-typecheck",
  "installer-integration",
  "wechat-runtime-audit",
  "reviewed-npm-audit",
  "cli-test-shards",
  "cli-tests",
  "plugin-tests",
  "checks",
];
const REQUIRED_CHECK_RUNS: Record<string, { runId: number; jobId: number; workflowName: string }> =
  {
    checks: { runId: 90, jobId: 1, workflowName: "CI / Pull Request" },
    changes: { runId: 90, jobId: 2, workflowName: "CI / Pull Request" },
    "check-hash": { runId: 91, jobId: 1, workflowName: "Security / Installer Hash Check" },
    "commit-lint": { runId: 92, jobId: 1, workflowName: "CI / Commit Lint" },
    "dco-check": { runId: 93, jobId: 1, workflowName: "CI / DCO Check" },
    "E2E / PR Gate": { runId: 94, jobId: 1, workflowName: "E2E / PR Gate Controller" },
  };

interface ActionJobFixture {
  id: number;
  name: string;
  status?: string;
  conclusion?: string | null;
}

interface ActionRunFixture {
  attempt: number;
  nextAttempt?: number;
  nextCreatedAt?: string;
  nextUpdatedAt?: string;
  nextDisplayTitle?: string;
  nextStatus?: string;
  nextConclusion?: string | null;
  jobs?: ActionJobFixture[];
  jobPages?: ActionJobFixture[][];
  createdAt?: string;
  updatedAt?: string;
  headSha?: string;
  headBranch?: string;
  headRepository?: string;
  pullRequestHeadSha?: string;
  pullRequests?: unknown[];
  baseSha?: string;
  displayTitle?: string;
  event?: string;
  path?: string;
  status?: string;
  conclusion?: string | null;
}

interface ComplianceFixture {
  body: string;
  checkConclusions?: Record<string, string>;
  checkNames?: string[];
  statusChecks?: Array<{
    __typename?: string;
    name?: string;
    context?: string;
    workflowName?: string;
    startedAt?: string;
    completedAt?: string;
    detailsUrl?: string;
    status?: string;
    conclusion?: string;
    state?: string;
  }>;
  commitOutput?: string;
  commitAuthorLogins?: string[];
  contributorCommitPages?: Array<
    Array<{ authors: Array<{ login: string }>; authorCount?: number }>
  >;
  contributorReviewPages?: Array<
    Array<{
      author: { login: string };
      state: string;
      submittedAt?: string | null;
    }>
  >;
  contributorCommitTotalCount?: number;
  contributorReviewTotalCount?: number;
  reviews?: Array<{
    author: { login: string };
    state: string;
    submittedAt?: string | null;
  }>;
  prAuthorLogin?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  currentBaseSha?: string | null;
  verified: boolean;
  reason?: string;
  actionRunAttempts?: Record<string, ActionRunFixture>;
  issueEventPages?: unknown[];
  coordinationCheckPages?: unknown[];
  legacyCoordinationCheckPages?: unknown[];
  finalPr?: Record<string, unknown>;
  finalPrAfterCurrentBase?: Record<string, unknown>;
}

interface ComparatorFixture extends ComplianceFixture {
  headRefOid?: string;
  state?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function successfulRequiredChecksWithoutE2e() {
  return successfulRequiredChecks().filter((check) => check.name !== "E2E / PR Gate");
}

function successfulRequiredChecks() {
  return REQUIRED_CHECK_NAMES.map((name) => requiredCheck(name));
}

function requiredCheck(name: string, conclusion = "SUCCESS") {
  const { runId, jobId, workflowName } = REQUIRED_CHECK_RUNS[name];
  return e2eGateCheck([runId, jobId, conclusion, undefined, undefined, workflowName, name]);
}

function e2eGateCheck(check: E2eCheckFixture, index = 0) {
  const [runId, jobId, conclusion, startedAt, detailsUrl, workflowName, name] = check;
  return {
    __typename: "CheckRun",
    name: name ?? "E2E / PR Gate",
    workflowName: workflowName ?? "E2E / PR Gate Controller",
    detailsUrl:
      detailsUrl ?? `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}/job/${jobId}`,
    startedAt: startedAt ?? `2026-01-01T00:${String(index * 2).padStart(2, "0")}:00Z`,
    status: "COMPLETED",
    conclusion,
  };
}

function e2eJobs(...ids: number[]): ActionJobFixture[] {
  return ids.map((id) => ({ id, name: "E2E / PR Gate" }));
}

const e2eChecks = (...checks: E2eCheckFixture[]): E2eCheckFixture[] => checks;

function exactDiffGateRun(result: string, jobs: ActionJobFixture[], attempt = 1): ActionRunFixture {
  return {
    attempt,
    headSha: HEAD_SHA,
    headBranch: "feature-branch",
    headRepository: "NVIDIA/NemoClaw",
    baseSha: BASE_SHA,
    displayTitle: `E2E Gate PR #42 head ${HEAD_SHA} base ${BASE_SHA} gate true`,
    event: "pull_request_target",
    path: ".github/workflows/pr-e2e-gate.yaml",
    status: "completed",
    conclusion: result,
    jobs,
  };
}

function installerHashRun(
  result: string,
  jobs: ActionJobFixture[],
  gate: boolean,
): ActionRunFixture {
  return {
    ...exactDiffGateRun(result, jobs),
    displayTitle: `Installer Hash PR #42 head ${HEAD_SHA} base ${BASE_SHA} gate ${gate}`,
    event: "pull_request",
    path: ".github/workflows/installer-hash-check.yaml",
  };
}

function prWorkflowRun(result: string, jobs: ActionJobFixture[], gate: boolean): ActionRunFixture {
  return {
    ...exactDiffGateRun(result, jobs),
    displayTitle: `CI PR #42 head ${HEAD_SHA} base ${BASE_SHA} gate ${gate}`,
    event: "pull_request",
    path: ".github/workflows/pr.yaml",
  };
}

function prWorkflowJobs(
  defaultConclusion: string,
  overrides: Record<string, Pick<ActionJobFixture, "status" | "conclusion">> = {},
): ActionJobFixture[] {
  return PR_WORKFLOW_JOB_NAMES.map((name, index) => ({
    id: index + 1,
    name,
    conclusion: defaultConclusion,
    ...overrides[name],
  }));
}

function coordinationCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 8000,
    name: E2E_COORDINATION_NAME,
    head_sha: HEAD_SHA,
    external_id: E2E_COORDINATION_EXTERNAL_ID,
    status: "completed",
    conclusion: "success",
    started_at: "2026-01-01T00:01:30Z",
    completed_at: "2026-01-01T00:02:30Z",
    app: { id: 15368 },
    ...overrides,
  };
}

function e2eRunFixture(
  checks: E2eCheckFixture[],
  actionRunAttempts: Record<string, ActionRunFixture>,
): ComplianceFixture {
  return {
    body: "Signed-off-by: Example User <user@example.com>",
    verified: true,
    statusChecks: [...successfulRequiredChecksWithoutE2e(), ...checks.map(e2eGateCheck)],
    actionRunAttempts,
  };
}

function runGate(fixture: ComplianceFixture) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-gates-compliance-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const ghPath = path.join(bin, "gh");

  const pr = {
    number: 42,
    title: "fix(policy): align maintainer workflow",
    url: "https://github.com/NVIDIA/NemoClaw/pull/42",
    body: fixture.body,
    files: [],
    statusCheckRollup:
      fixture.statusChecks ??
      (fixture.checkNames ?? REQUIRED_CHECK_NAMES).map((name) =>
        requiredCheck(name, fixture.checkConclusions?.[name]),
      ),
    mergeable: fixture.mergeable ?? "MERGEABLE",
    mergeStateStatus: fixture.mergeStateStatus ?? "CLEAN",
    state: "OPEN",
    isDraft: false,
    headRefOid: HEAD_SHA,
    baseRefOid: BASE_SHA,
    headRefName: "feature-branch",
    baseRefName: "main",
    headRepository: { nameWithOwner: "NVIDIA/NemoClaw" },
    author: { login: fixture.prAuthorLogin ?? "contributor" },
  };
  const finalPr = { ...pr, ...fixture.finalPr };
  const finalPrAfterCurrentBase = { ...finalPr, ...fixture.finalPrAfterCurrentBase };
  const contributorCommitPages = (
    fixture.contributorCommitPages ?? [
      [
        {
          authors: (fixture.commitAuthorLogins ?? ["contributor"]).map((login) => ({
            login,
          })),
        },
      ],
    ]
  ).map((page) =>
    page.map((commit) => ({
      ...commit,
      authorCount: commit.authorCount ?? commit.authors.length,
    })),
  );
  const contributorReviewPages = fixture.contributorReviewPages ?? [
    fixture.reviews ?? [
      {
        author: { login: "reviewer" },
        state: "APPROVED",
        submittedAt: "2026-01-01T00:00:00Z",
      },
    ],
  ];
  const contributorCommitOutput = contributorCommitPages
    .map((page) =>
      JSON.stringify({
        nodes: page,
        totalCount: fixture.contributorCommitTotalCount ?? contributorCommitPages.flat().length,
      }),
    )
    .join("\n");
  const contributorReviewOutput = contributorReviewPages
    .map((page) =>
      JSON.stringify({
        nodes: page,
        totalCount: fixture.contributorReviewTotalCount ?? contributorReviewPages.flat().length,
      }),
    )
    .join("\n");
  const commit = {
    sha: "abc123",
    verified: fixture.verified,
    reason: fixture.reason ?? (fixture.verified ? "valid" : "unsigned"),
  };
  const commitOutput = fixture.commitOutput ?? JSON.stringify(commit);
  const currentBaseOutput = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          baseRef:
            fixture.currentBaseSha === null
              ? null
              : { target: { oid: fixture.currentBaseSha ?? BASE_SHA } },
        },
      },
    },
  });
  const issueEventPages = fixture.issueEventPages ?? [[]];
  const coordinationCheckPages = fixture.coordinationCheckPages ?? [
    {
      total_count: 1,
      check_runs: [coordinationCheck()],
    },
  ];
  const legacyCoordinationCheckPages = fixture.legacyCoordinationCheckPages ?? [
    { total_count: 0, check_runs: [] },
  ];
  const actionRunCases = Object.entries({
    "90": prWorkflowRun(
      "success",
      [
        { id: 1, name: "checks" },
        { id: 2, name: "changes" },
      ],
      true,
    ),
    "91": {
      ...installerHashRun("success", [{ id: 1, name: "check-hash" }], true),
    },
    "92": {
      ...exactDiffGateRun("success", [{ id: 1, name: "commit-lint" }]),
      event: "pull_request",
      path: ".github/workflows/commit-lint.yaml",
    },
    "93": {
      ...exactDiffGateRun("success", [{ id: 1, name: "dco-check" }]),
      event: "pull_request",
      path: ".github/workflows/dco-check.yaml",
    },
    "94": exactDiffGateRun("success", [{ id: 1, name: "E2E / PR Gate" }]),
    ...fixture.actionRunAttempts,
  })
    .flatMap(([runId, value]) => {
      const jobPages = (value.jobPages ?? [value.jobs ?? []]).map((page) =>
        page.map((job) => ({
          ...job,
          status: job.status ?? "completed",
          conclusion: job.conclusion === undefined ? "success" : job.conclusion,
        })),
      );
      const jobs = jobPages.flat();
      const runData = {
        run_attempt: value.attempt,
        created_at: value.createdAt ?? "2026-01-01T00:01:00Z",
        updated_at: value.updatedAt ?? "2026-01-01T00:03:00Z",
        event: value.event,
        path: value.path,
        status: value.status,
        conclusion: value.conclusion,
        display_title: value.displayTitle,
        ...(value.headSha ? { head_sha: value.headSha } : {}),
        ...(value.headBranch ? { head_branch: value.headBranch } : {}),
        ...(value.headRepository ? { head_repository: { full_name: value.headRepository } } : {}),
        ...(value.pullRequests !== undefined
          ? { pull_requests: value.pullRequests }
          : value.headSha
            ? {
                pull_requests: value.baseSha
                  ? [
                      {
                        number: 42,
                        head: { sha: value.pullRequestHeadSha ?? value.headSha },
                        base: { sha: value.baseSha },
                      },
                    ]
                  : [],
              }
            : {}),
      };
      const refreshedRunData = {
        ...runData,
        run_attempt: value.nextAttempt ?? value.attempt,
        created_at: value.nextCreatedAt ?? runData.created_at,
        updated_at: value.nextUpdatedAt ?? runData.updated_at,
        display_title: value.nextDisplayTitle ?? runData.display_title,
        status: value.nextStatus ?? runData.status,
        conclusion: value.nextConclusion === undefined ? runData.conclusion : value.nextConclusion,
      };
      const runMarker = path.join(tmp, `action-run-${runId}-seen`);
      return [
        `  "api repos/NVIDIA/NemoClaw/actions/runs/${runId}") if mkdir ${shellSingleQuote(runMarker)} 2>/dev/null; then printf '%s' ${shellSingleQuote(JSON.stringify(runData))}; else printf '%s' ${shellSingleQuote(JSON.stringify(refreshedRunData))}; fi ;;`,
        `  "api --paginate --slurp repos/NVIDIA/NemoClaw/actions/runs/${runId}/attempts/${value.attempt}/jobs?per_page=100") printf '%s' ${shellSingleQuote(
          JSON.stringify(
            jobPages.map((page) => ({
              total_count: jobs.length,
              jobs: page,
            })),
          ),
        )} ;;`,
      ];
    })
    .join("\n");

  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "pr view"*) if mkdir ${shellSingleQuote(path.join(tmp, "pr-view-seen"))} 2>/dev/null; then printf '%s' ${shellSingleQuote(JSON.stringify(pr))}; elif [ -d ${shellSingleQuote(path.join(tmp, "current-base-seen"))} ]; then printf '%s' ${shellSingleQuote(JSON.stringify(finalPrAfterCurrentBase))}; else printf '%s' ${shellSingleQuote(JSON.stringify(finalPr))}; fi ;;
  *"ContributorCommits"*) printf '%s' ${shellSingleQuote(contributorCommitOutput)} ;;
  *"ContributorReviews"*) printf '%s' ${shellSingleQuote(contributorReviewOutput)} ;;
  *"CurrentBaseRef"*) mkdir -p ${shellSingleQuote(path.join(tmp, "current-base-seen"))}; printf '%s' ${shellSingleQuote(currentBaseOutput)} ;;
  "api graphql"*) printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}' ;;
  "api repos/NVIDIA/NemoClaw/issues/42/comments"*) printf '%s' '{"id":1,"body":"ordinary comment","user":{"login":"reviewer"},"updated_at":"2026-01-01T00:00:00Z"}' ;;
  "api repos/NVIDIA/NemoClaw/pulls/42/commits"*) printf '%s' ${shellSingleQuote(commitOutput)} ;;
  "api --paginate --slurp repos/NVIDIA/NemoClaw/issues/42/events?per_page=100") printf '%s' ${shellSingleQuote(JSON.stringify(issueEventPages))} ;;
  "api --paginate --slurp repos/NVIDIA/NemoClaw/commits/${HEAD_SHA}/check-runs?check_name=E2E%20%2F%20PR%20Gate%20Coordination&filter=all&per_page=100") printf '%s' ${shellSingleQuote(JSON.stringify(coordinationCheckPages))} ;;
  "api --paginate --slurp repos/NVIDIA/NemoClaw/commits/${HEAD_SHA}/check-runs?check_name=E2E%20%2F%20PR%20Gate&filter=all&per_page=100") printf '%s' ${shellSingleQuote(JSON.stringify(legacyCoordinationCheckPages))} ;;
${actionRunCases}
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`,
  );
  fs.chmodSync(ghPath, 0o755);

  try {
    return spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        ".agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts",
        "42",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runComparatorGate(fixture: ComparatorFixture, prNumber = "42") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "collect-gates-compliance-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const ghPath = path.join(bin, "gh");

  const pr = {
    number: Number(prNumber),
    state: fixture.state ?? "OPEN",
    body: fixture.body,
    author: { login: fixture.prAuthorLogin ?? "example-user" },
    headRefOid: fixture.headRefOid ?? "abc123",
    statusCheckRollup: (fixture.checkNames ?? REQUIRED_CHECK_NAMES).map((name) => ({
      name,
      status: "COMPLETED",
      conclusion: fixture.checkConclusions?.[name] ?? "SUCCESS",
    })),
    mergeable: fixture.mergeable ?? "MERGEABLE",
    mergeStateStatus: fixture.mergeStateStatus ?? "CLEAN",
    reviewDecision: fixture.reviewDecision ?? "APPROVED",
  };
  const commit = {
    sha: "abc123",
    verified: fixture.verified,
    reason: fixture.reason ?? (fixture.verified ? "valid" : "unsigned"),
  };
  const commitOutput = fixture.commitOutput ?? JSON.stringify(commit);

  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "pr view") printf '%s' ${shellSingleQuote(JSON.stringify(pr))} ;;
  ${shellSingleQuote(`api repos/NVIDIA/NemoClaw/pulls/${prNumber}/commits`)}) printf '%s' ${shellSingleQuote(commitOutput)} ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`,
  );
  fs.chmodSync(ghPath, 0o755);

  try {
    return spawnSync(
      "bash",
      [
        ".agents/skills/nemoclaw-maintainer-pr-comparator/scripts/collect-gates.sh",
        prNumber,
        "--repo",
        "NVIDIA/NemoClaw",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export type {
  ActionJobFixture,
  ActionRunFixture,
  ComparatorFixture,
  ComplianceFixture,
  E2eCheckFixture,
};
export {
  BASE_SHA,
  CUSTOM_RUN_URL,
  coordinationCheck,
  E2E_COORDINATION_EXTERNAL_ID,
  E2E_COORDINATION_NAME,
  e2eChecks,
  e2eGateCheck,
  e2eJobs,
  e2eRunFixture,
  exactDiffGateRun,
  HEAD_SHA,
  INCOMPLETE_E2E,
  installerHashRun,
  prWorkflowJobs,
  prWorkflowRun,
  REQUIRED_CHECK_NAMES,
  requiredCheck,
  runComparatorGate,
  runGate,
  successfulRequiredChecks,
  successfulRequiredChecksWithoutE2e,
};

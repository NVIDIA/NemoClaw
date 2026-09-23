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
] as const;

type ActionCheckFixture = [number, number, string, string?, string?, string?, string?];
const CUSTOM_RUN_URL = "https://github.com/NVIDIA/NemoClaw/runs/123";
const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PR_WORKFLOW_JOB_NAMES = [
  "changes",
  "docs-only-checks",
  "static-checks",
  "build-typecheck",
  "installer-integration",
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
  };

interface ActionJobFixture {
  id: number;
  name: string;
  status?: string;
  conclusion?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  omitStartedAt?: boolean;
  omitCompletedAt?: boolean;
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
  createdAt?: string | null;
  updatedAt?: string | null;
  omitCreatedAt?: boolean;
  omitUpdatedAt?: boolean;
  headSha?: string;
  headBranch?: string;
  headRepository?: string;
  repository?: string;
  pullRequestHeadSha?: string;
  pullRequests?: unknown[];
  baseSha?: string;
  displayTitle?: string;
  event?: string;
  path?: string;
  status?: string;
  conclusion?: string | null;
}

interface StatusCheckFixture {
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
}

interface ComplianceFixture {
  body: string;
  checkConclusions?: Record<string, string>;
  checkNames?: string[];
  checkWorkflows?: Record<string, string>;
  statusChecks?: StatusCheckFixture[];
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
  headRefName?: string;
  headRepository?: string;
  emptyHeadRepositoryNameWithOwner?: boolean;
  headRepositoryNameWithOwner?: string;
  prAuthorLogin?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  currentBaseSha?: string | null;
  finalCurrentBaseSha?: string | null;
  files?: Array<{ path: string; status: string }>;
  verified: boolean;
  reason?: string;
  actionRunAttempts?: Record<string, ActionRunFixture>;
  issueEventPages?: unknown[];
  observationTime?: string;
  finalPr?: Record<string, unknown>;
  finalPrAfterCurrentBase?: Record<string, unknown>;
  finalPrAfterCiEvidence?: Record<string, unknown>;
  finalPrAfterFinalCi?: Record<string, unknown>;
  finalCommitTotalCount?: number;
  finalStatusContextTotalCount?: number;
  finalStatusCheckCommitOid?: string;
  finalStatusCheckHasNextPage?: boolean;
  finalStatusCheckPageSize?: number;
  finalStatusChecksAfterFirstRead?: StatusCheckFixture[];
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

function successfulRequiredChecks() {
  return REQUIRED_CHECK_NAMES.map((name) => requiredCheck(name));
}

function requiredCheck(name: string, conclusion = "SUCCESS") {
  const { runId, jobId, workflowName } = REQUIRED_CHECK_RUNS[name];
  return actionCheck([runId, jobId, conclusion, undefined, undefined, workflowName, name]);
}

function actionCheck(check: ActionCheckFixture, index = 0) {
  const [runId, jobId, conclusion, startedAt, detailsUrl, workflowName, name] = check;
  return {
    __typename: "CheckRun",
    name: name ?? "optional-check",
    workflowName: workflowName ?? "CI / Optional",
    detailsUrl:
      detailsUrl ?? `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}/job/${jobId}`,
    startedAt: startedAt ?? `2026-01-01T00:${String(index * 2).padStart(2, "0")}:00Z`,
    status: "COMPLETED",
    conclusion,
  };
}

function exactDiffActionRun(
  result: string,
  jobs: ActionJobFixture[],
  attempt = 1,
): ActionRunFixture {
  return {
    attempt,
    headSha: HEAD_SHA,
    headBranch: "feature-branch",
    headRepository: "NVIDIA/NemoClaw",
    baseSha: BASE_SHA,
    displayTitle: `Optional CI for PR #42 at ${HEAD_SHA}`,
    event: "push",
    path: ".github/workflows/optional.yaml",
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
    ...exactDiffActionRun(result, jobs),
    displayTitle: `Installer Hash PR #42 head ${HEAD_SHA} base ${BASE_SHA} gate ${gate}`,
    event: "pull_request",
    path: ".github/workflows/installer-hash-check.yaml",
  };
}

function prWorkflowRun(result: string, jobs: ActionJobFixture[], gate: boolean): ActionRunFixture {
  return {
    ...exactDiffActionRun(result, jobs),
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

function actionRunFixture(
  checks: ActionCheckFixture[],
  actionRunAttempts: Record<string, ActionRunFixture>,
): ComplianceFixture {
  return {
    body: "Signed-off-by: Example User <user@example.com>",
    verified: true,
    statusChecks: [...successfulRequiredChecks(), ...checks.map(actionCheck)],
    actionRunAttempts,
  };
}

function runGate(fixture: ComplianceFixture) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-gates-compliance-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const ghPath = path.join(bin, "gh");
  const clockPath = path.join(tmp, "clock.mjs");
  const observationTime = fixture.observationTime ?? "2026-01-01T00:03:00Z";
  fs.writeFileSync(clockPath, `Date.now = () => ${Date.parse(observationTime)};\n`);

  const headRepository = fixture.headRepository ?? "NVIDIA/NemoClaw";
  const [headRepositoryOwner, headRepositoryName] = headRepository.split("/");
  const defaultStatusChecks: NonNullable<ComplianceFixture["statusChecks"]> =
    fixture.checkNames === undefined
      ? successfulRequiredChecks().map((check) => {
          const conclusion = fixture.checkConclusions?.[check.name];
          return conclusion === undefined ? check : { ...check, conclusion };
        })
      : fixture.checkNames.map((name) => requiredCheck(name, fixture.checkConclusions?.[name]));
  const pr = {
    number: 42,
    title: "fix(policy): align maintainer workflow",
    url: "https://github.com/NVIDIA/NemoClaw/pull/42",
    body: fixture.body,
    files: fixture.files ?? [],
    statusCheckRollup: fixture.statusChecks ?? defaultStatusChecks,
    mergeable: fixture.mergeable ?? "MERGEABLE",
    mergeStateStatus: fixture.mergeStateStatus ?? "CLEAN",
    state: "OPEN",
    isDraft: false,
    headRefOid: HEAD_SHA,
    baseRefOid: BASE_SHA,
    headRefName: fixture.headRefName ?? "feature-branch",
    baseRefName: "main",
    headRepository: {
      name: headRepositoryName,
      nameWithOwner:
        fixture.headRepositoryNameWithOwner ??
        (fixture.emptyHeadRepositoryNameWithOwner ? "" : headRepository),
    },
    headRepositoryOwner: { login: headRepositoryOwner },
    author: { login: fixture.prAuthorLogin ?? "contributor" },
  };
  const finalPr = { ...pr, ...fixture.finalPr };
  const finalPrAfterCurrentBase = { ...finalPr, ...fixture.finalPrAfterCurrentBase };
  const finalPrAfterCiEvidence = {
    ...finalPrAfterCurrentBase,
    ...fixture.finalPrAfterCiEvidence,
  };
  const finalPrAfterFinalCi = {
    ...finalPrAfterCiEvidence,
    ...fixture.finalPrAfterFinalCi,
  };
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
  const finalCurrentBaseSha =
    fixture.finalCurrentBaseSha === undefined
      ? fixture.currentBaseSha
      : fixture.finalCurrentBaseSha;
  const buildFinalPrSnapshotOutput = (statusChecks: StatusCheckFixture[]) => {
    const nodes = statusChecks.map(({ workflowName, ...check }) => ({
      ...check,
      ...(workflowName
        ? { checkSuite: { workflowRun: { workflow: { name: workflowName } } } }
        : {}),
    }));
    const pageSize = fixture.finalStatusCheckPageSize ?? Math.max(1, nodes.length);
    const nodePages =
      nodes.length === 0
        ? [[]]
        : Array.from({ length: Math.ceil(nodes.length / pageSize) }, (_, index) =>
            nodes.slice(index * pageSize, (index + 1) * pageSize),
          );
    return JSON.stringify(
      nodePages.map((pageNodes, pageIndex) => {
        const isLastPage = pageIndex === nodePages.length - 1;
        const hasNextPage = !isLastPage || fixture.finalStatusCheckHasNextPage === true;
        return {
          data: {
            repository: {
              pullRequest: {
                title: finalPrAfterFinalCi.title,
                body: finalPrAfterFinalCi.body,
                state: finalPrAfterFinalCi.state,
                isDraft: finalPrAfterFinalCi.isDraft,
                mergeable: finalPrAfterFinalCi.mergeable,
                mergeStateStatus: finalPrAfterFinalCi.mergeStateStatus,
                headRefOid: finalPrAfterFinalCi.headRefOid,
                baseRefOid: finalPrAfterFinalCi.baseRefOid,
                headRefName: finalPrAfterFinalCi.headRefName,
                baseRefName: finalPrAfterFinalCi.baseRefName,
                headRepository: finalPrAfterFinalCi.headRepository,
                headRepositoryOwner: finalPrAfterFinalCi.headRepositoryOwner,
                baseRef:
                  finalCurrentBaseSha === null
                    ? null
                    : { target: { oid: finalCurrentBaseSha ?? BASE_SHA } },
                commits: {
                  totalCount: fixture.finalCommitTotalCount ?? 1,
                  nodes: [
                    {
                      commit: {
                        oid: fixture.finalStatusCheckCommitOid ?? finalPrAfterFinalCi.headRefOid,
                        statusCheckRollup: {
                          contexts: {
                            totalCount: fixture.finalStatusContextTotalCount ?? nodes.length,
                            pageInfo: {
                              hasNextPage,
                              endCursor: hasNextPage ? `cursor-${pageIndex + 1}` : null,
                            },
                            nodes: pageNodes,
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        };
      }),
    );
  };
  const finalPrSnapshotOutput = buildFinalPrSnapshotOutput(finalPrAfterFinalCi.statusCheckRollup);
  const finalPrSnapshotAfterFirstReadOutput = buildFinalPrSnapshotOutput(
    fixture.finalStatusChecksAfterFirstRead ?? finalPrAfterFinalCi.statusCheckRollup,
  );
  const issueEventPages = fixture.issueEventPages ?? [[]];
  const actionRunFixtures: Record<string, ActionRunFixture> = {
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
      ...exactDiffActionRun("success", [{ id: 1, name: "commit-lint" }]),
      event: "pull_request",
      path: ".github/workflows/commit-lint.yaml",
    },
    "93": {
      ...exactDiffActionRun("success", [{ id: 1, name: "dco-check" }]),
      event: "pull_request",
      path: ".github/workflows/dco-check.yaml",
    },
    ...fixture.actionRunAttempts,
  };
  const actionRunData = (runId: string, value: ActionRunFixture): Record<string, unknown> => ({
    id: Number(runId),
    run_attempt: value.attempt,
    ...(value.omitCreatedAt
      ? {}
      : {
          created_at: value.createdAt === undefined ? "2026-01-01T00:01:00Z" : value.createdAt,
        }),
    ...(value.omitUpdatedAt
      ? {}
      : {
          updated_at: value.updatedAt === undefined ? "2026-01-01T00:03:00Z" : value.updatedAt,
        }),
    event: value.event,
    path: value.path,
    status: value.status,
    conclusion: value.conclusion,
    display_title: value.displayTitle,
    repository: { full_name: value.repository ?? "NVIDIA/NemoClaw" },
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
  });
  const actionRunCases = Object.entries(actionRunFixtures)
    .flatMap(([runId, value]) => {
      const jobPages = (value.jobPages ?? [value.jobs ?? []]).map((page) =>
        page.map(({ startedAt, completedAt, omitStartedAt, omitCompletedAt, ...job }) => ({
          ...job,
          status: job.status ?? "completed",
          conclusion: job.conclusion === undefined ? "success" : job.conclusion,
          ...(omitStartedAt
            ? {}
            : { started_at: startedAt === undefined ? "2026-01-01T00:01:00Z" : startedAt }),
          ...(omitCompletedAt
            ? {}
            : {
                completed_at: completedAt === undefined ? "2026-01-01T00:03:00Z" : completedAt,
              }),
        })),
      );
      const jobs = jobPages.flat();
      const runData = actionRunData(runId, value);
      const refreshedRunData = {
        ...runData,
        run_attempt: value.nextAttempt ?? value.attempt,
        ...(value.nextCreatedAt === undefined ? {} : { created_at: value.nextCreatedAt }),
        ...(value.nextUpdatedAt === undefined ? {} : { updated_at: value.nextUpdatedAt }),
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
  const finalPrFirstReadMarker = path.join(tmp, "final-pr-first-read");
  const finalPrReadMarker = path.join(tmp, "final-pr-read");

  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [ -d ${shellSingleQuote(finalPrReadMarker)} ]; then
  echo "unexpected gh args after final PR read: $*" >&2
  exit 9
fi
case "$*" in
  "pr view"*) if mkdir ${shellSingleQuote(path.join(tmp, "pr-view-seen"))} 2>/dev/null; then printf '%s' ${shellSingleQuote(JSON.stringify(pr))}; elif mkdir ${shellSingleQuote(path.join(tmp, "pr-before-final-ci-seen"))} 2>/dev/null; then printf '%s' ${shellSingleQuote(JSON.stringify(finalPrAfterCurrentBase))}; else printf '%s' ${shellSingleQuote(JSON.stringify(finalPrAfterCiEvidence))}; fi ;;
  *"ContributorCommits"*) printf '%s' ${shellSingleQuote(contributorCommitOutput)} ;;
  *"ContributorReviews"*) printf '%s' ${shellSingleQuote(contributorReviewOutput)} ;;
  *"CurrentBaseRef"*) mkdir -p ${shellSingleQuote(path.join(tmp, "current-base-seen"))}; printf '%s' ${shellSingleQuote(currentBaseOutput)} ;;
  *"FinalPrSnapshot"*) if mkdir ${shellSingleQuote(finalPrFirstReadMarker)} 2>/dev/null; then printf '%s' ${shellSingleQuote(finalPrSnapshotOutput)}; else mkdir -p ${shellSingleQuote(finalPrReadMarker)}; printf '%s' ${shellSingleQuote(finalPrSnapshotAfterFirstReadOutput)}; fi ;;
  "api graphql"*) printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}' ;;
  "api repos/NVIDIA/NemoClaw/issues/42/comments"*) printf '%s' '{"id":1,"body":"ordinary comment","user":{"login":"reviewer"},"updated_at":"2026-01-01T00:00:00Z"}' ;;
  "api repos/NVIDIA/NemoClaw/pulls/42/commits"*) printf '%s' ${shellSingleQuote(commitOutput)} ;;
  "api --paginate --slurp repos/NVIDIA/NemoClaw/issues/42/events?per_page=100") printf '%s' ${shellSingleQuote(JSON.stringify(issueEventPages))} ;;
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
        "--import",
        clockPath,
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
      workflowName: fixture.checkWorkflows?.[name],
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

export type { ActionJobFixture, ActionRunFixture, ComparatorFixture, ComplianceFixture };
export {
  actionCheck,
  actionRunFixture,
  BASE_SHA,
  CUSTOM_RUN_URL,
  exactDiffActionRun,
  HEAD_SHA,
  installerHashRun,
  prWorkflowJobs,
  prWorkflowRun,
  REQUIRED_CHECK_NAMES,
  requiredCheck,
  runComparatorGate,
  runGate,
  successfulRequiredChecks,
};

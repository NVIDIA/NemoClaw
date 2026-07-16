// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
const REQUIRED_RUN_ID = 90;

interface ActionJobFixture {
  id: number;
  name: string;
  status?: string;
  conclusion?: string | null;
}

interface ActionRunFixture {
  attempt: number;
  nextAttempt?: number;
  jobs?: ActionJobFixture[];
  jobPages?: ActionJobFixture[][];
  headSha?: string;
  baseSha?: string;
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
  verified: boolean;
  reason?: string;
  actionRunAttempts?: Record<string, ActionRunFixture>;
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
  return REQUIRED_CHECK_NAMES.filter((name) => name !== "E2E / PR Gate").map((name, index) =>
    e2eGateCheck([REQUIRED_RUN_ID, index + 1, "SUCCESS", undefined, undefined, "CI", name]),
  );
}

function e2eGateCheck(check: E2eCheckFixture, index = 0) {
  const [runId, jobId, conclusion, startedAt, detailsUrl, workflowName, name] = check;
  return {
    __typename: "CheckRun",
    name: name ?? "E2E / PR Gate",
    workflowName: workflowName ?? "E2E / PR Gate Controller",
    detailsUrl:
      detailsUrl ?? `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}/job/${jobId}`,
    startedAt: startedAt ?? `2026-01-01T00:0${index * 2}:00Z`,
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
    headSha: "abc123",
    baseSha: "base123",
    event: "pull_request_target",
    path: ".github/workflows/pr-e2e-gate.yaml",
    status: "completed",
    conclusion: result,
    jobs,
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
        e2eGateCheck([
          REQUIRED_RUN_ID,
          REQUIRED_CHECK_NAMES.findIndex((requiredName) => requiredName === name) + 1,
          fixture.checkConclusions?.[name] ?? "SUCCESS",
          undefined,
          undefined,
          "CI",
          name,
        ]),
      ),
    mergeStateStatus: "CLEAN",
    headRefOid: "abc123",
    baseRefOid: "base123",
    author: { login: fixture.prAuthorLogin ?? "contributor" },
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
  const requiredJobs = REQUIRED_CHECK_NAMES.map((name, index) => ({ id: index + 1, name }));
  const actionRunCases = Object.entries({
    [REQUIRED_RUN_ID]: exactDiffGateRun("success", requiredJobs),
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
        event: value.event,
        path: value.path,
        status: value.status,
        conclusion: value.conclusion,
        ...(value.headSha ? { head_sha: value.headSha } : {}),
        ...(value.headSha && value.baseSha
          ? {
              pull_requests: [
                {
                  number: 42,
                  head: { sha: value.headSha },
                  base: { sha: value.baseSha },
                },
              ],
            }
          : {}),
      };
      const refreshedRunData = { ...runData, run_attempt: value.nextAttempt ?? value.attempt };
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
  "pr view"*) printf '%s' ${shellSingleQuote(JSON.stringify(pr))} ;;
  *"ContributorCommits"*) printf '%s' ${shellSingleQuote(contributorCommitOutput)} ;;
  *"ContributorReviews"*) printf '%s' ${shellSingleQuote(contributorReviewOutput)} ;;
  "api graphql"*) printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}' ;;
  "api repos/NVIDIA/NemoClaw/issues/42/comments"*) printf '%s' '{"id":1,"body":"ordinary comment","user":{"login":"reviewer"},"updated_at":"2026-01-01T00:00:00Z"}' ;;
  "api repos/NVIDIA/NemoClaw/pulls/42/commits"*) printf '%s' ${shellSingleQuote(commitOutput)} ;;
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
    number: 42,
    state: fixture.state ?? "OPEN",
    body: fixture.body,
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
  "api repos/NVIDIA/NemoClaw/pulls/42/commits") printf '%s' ${shellSingleQuote(commitOutput)} ;;
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

describe("maintainer merge-gate contributor compliance", () => {
  it("uses the latest attempt for duplicate check-run contexts", () => {
    const result = runGate(
      e2eRunFixture(
        [
          [100, 1, "CANCELLED"],
          [101, 2, "SUCCESS"],
        ],
        {
          "100": exactDiffGateRun("cancelled", [{ id: 1, name: "E2E / PR Gate" }]),
          "101": exactDiffGateRun("success", [{ id: 2, name: "E2E / PR Gate" }]),
        },
      ),
    );

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci).toMatchObject({ pass: true });
  });
  it("keeps every duplicate job from the latest workflow run", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [
        ...REQUIRED_CHECK_NAMES.map((name) => ({
          __typename: "CheckRun",
          name,
          workflowName: `CI / ${name}`,
          detailsUrl: `https://github.com/NVIDIA/NemoClaw/actions/runs/200/job/${name}`,
          startedAt: "2026-01-01T00:02:00Z",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        })),
        {
          __typename: "CheckRun",
          name: "matrix-check",
          workflowName: "CI / Matrix",
          detailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/199/job/1",
          startedAt: "2026-01-01T00:00:00Z",
          status: "COMPLETED",
          conclusion: "FAILURE",
        },
        {
          __typename: "CheckRun",
          name: "matrix-check",
          workflowName: "CI / Matrix",
          detailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/200/job/2",
          startedAt: "2026-01-01T00:02:00Z",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        },
        {
          __typename: "CheckRun",
          name: "matrix-check",
          workflowName: "CI / Matrix",
          detailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/200/job/3",
          startedAt: "2026-01-01T00:03:00Z",
          status: "COMPLETED",
          conclusion: "FAILURE",
        },
      ],
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["matrix-check: FAILURE"],
    });
  });
  it("accepts exact-head evidence from a non-PR Actions event", () => {
    const fixture = e2eRunFixture(e2eChecks([874, 2, "SUCCESS"]), {
      "874": exactDiffGateRun("success", e2eJobs(2)),
      "875": {
        attempt: 1,
        headSha: "abc123",
        event: "dynamic",
        path: "dynamic/github-code-scanning/codeql",
        status: "completed",
        conclusion: "success",
        jobs: [{ id: 1, name: "optional-check" }],
      },
    });
    fixture.statusChecks?.push(
      e2eGateCheck([875, 1, "SUCCESS", undefined, undefined, "CodeQL", "optional-check"]),
    );
    expect(JSON.parse(runGate(fixture).stdout).gates.ci).toMatchObject({ pass: true });
  });
  it("rejects required checks represented only by a status context", () => {
    const fixture = e2eRunFixture([], {});
    fixture.statusChecks?.push({
      __typename: "StatusContext",
      context: "E2E / PR Gate",
      state: "SUCCESS",
    });
    expect(JSON.parse(runGate(fixture).stdout).gates.ci).toMatchObject({
      pass: false,
      failingChecks: INCOMPLETE_E2E,
    });
  });
  it("uses the latest attempt for custom check-run details URLs", () => {
    const fixture = e2eRunFixture(
      [
        [874, 2, "SUCCESS"],
        [0, 0, "FAILURE", "2026-01-01T00:00:00Z", `${CUSTOM_RUN_URL}1`, "CodeQL", "custom-check"],
        [0, 0, "SUCCESS", "2026-01-01T00:02:00Z", `${CUSTOM_RUN_URL}2`, "CodeQL", "custom-check"],
      ],
      { "874": exactDiffGateRun("success", e2eJobs(2)) },
    );
    expect(JSON.parse(runGate(fixture).stdout).gates.ci).toMatchObject({ pass: true });
  });
  it("uses the latest attempt when GitHub reuses an Actions run ID", () => {
    const fixture = {
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [
        ...successfulRequiredChecksWithoutE2e(),
        e2eGateCheck([300, 10, "FAILURE", "2026-01-01T00:00:00Z"]),
        e2eGateCheck([300, 20, "SUCCESS", "2026-01-01T00:02:00Z"]),
      ],
    };
    const result = runGate({
      ...fixture,
      actionRunAttempts: {
        "300": exactDiffGateRun("success", [{ id: 20, name: "E2E / PR Gate" }], 2),
      },
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci).toMatchObject({ pass: true });

    const unavailable = runGate(fixture);
    expect(JSON.parse(unavailable.stdout).gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["E2E / PR Gate: FAILURE"],
    });
  });
  it("ignores a later all-skipped workflow run for the same exact PR diff", () => {
    const result = runGate(
      e2eRunFixture(
        [
          [400, 40, "SUCCESS"],
          [401, 41, "SKIPPED"],
        ],
        {
          "400": exactDiffGateRun("success", [{ id: 40, name: "E2E / PR Gate" }]),
          "401": exactDiffGateRun("skipped", [
            { id: 41, name: "E2E / PR Gate", conclusion: "skipped" },
          ]),
        },
      ),
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });
  it("keeps a later run when only the grouped job was skipped", () => {
    const result = runGate(
      e2eRunFixture(
        [
          [410, 40, "SUCCESS"],
          [411, 41, "SKIPPED"],
        ],
        {
          "410": exactDiffGateRun("success", [{ id: 40, name: "E2E / PR Gate" }]),
          "411": exactDiffGateRun("success", [
            { id: 41, name: "E2E / PR Gate", conclusion: "skipped" },
            { id: 42, name: "initialize" },
          ]),
        },
      ),
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false, failingChecks: ["E2E / PR Gate: SKIPPED"] } },
    });
  });

  it.each([
    {
      name: "keeps current-diff evidence ahead of a later nonmatching run",
      checks: e2eChecks([420, 40, "FAILURE"], [421, 41, "SUCCESS"]),
      runs: {
        "420": exactDiffGateRun("failure", [{ id: 40, name: "E2E / PR Gate" }]),
        "421": {
          ...exactDiffGateRun("success", [{ id: 41, name: "E2E / PR Gate" }]),
          headSha: "stale",
        },
      } as Record<string, ActionRunFixture>,
      failingChecks: ["E2E / PR Gate: FAILURE"],
    },
    {
      name: "fails closed on a later run with unknown diff identity",
      checks: e2eChecks([430, 40, "SUCCESS"], [431, 41, "SUCCESS"]),
      runs: {
        "430": exactDiffGateRun("success", [{ id: 40, name: "E2E / PR Gate" }]),
        "431": { attempt: 1, jobs: [{ id: 41, name: "E2E / PR Gate" }] },
      } as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects a singleton check from an older run attempt",
      checks: e2eChecks([440, 41, "SUCCESS"]),
      runs: {
        "440": exactDiffGateRun("success", [{ id: 42, name: "E2E / PR Gate" }]),
      } as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects a singleton check from a stale PR diff",
      checks: e2eChecks([442, 41, "SUCCESS"]),
      runs: {
        "442": { ...exactDiffGateRun("success", e2eJobs(41)), headSha: "stale" },
      } as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects an optional Actions check from a stale PR diff",
      checks: e2eChecks(
        [442, 41, "SUCCESS"],
        [443, 43, "SUCCESS", undefined, undefined, undefined, "optional-check"],
      ),
      runs: {
        "442": exactDiffGateRun("success", e2eJobs(41)),
        "443": {
          ...exactDiffGateRun("success", [{ id: 43, name: "optional-check" }]),
          headSha: "stale",
        },
      } as Record<string, ActionRunFixture>,
      failingChecks: ["optional-check: latest attempt evidence incomplete"],
    },
    {
      name: "rejects a singleton Actions check with a malformed URL",
      checks: e2eChecks([470, 41, "SUCCESS", undefined, "malformed"]),
      runs: {} as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects a required native check with no workflow or URL identity",
      checks: e2eChecks([474, 41, "SUCCESS", undefined, "", ""]),
      runs: {} as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects a required native check with a custom check-run URL",
      checks: e2eChecks([475, 41, "SUCCESS", undefined, CUSTOM_RUN_URL, "CodeQL"]),
      runs: {} as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects duplicate Actions checks when one URL is malformed",
      checks: e2eChecks([472, 40, "SUCCESS"], [473, 41, "SUCCESS", undefined, "malformed"]),
      runs: {} as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects exact-diff runs with different workflow identities",
      checks: e2eChecks([480, 40, "FAILURE"], [481, 41, "SUCCESS"]),
      runs: {
        "480": exactDiffGateRun("failure", e2eJobs(40)),
        "481": {
          ...exactDiffGateRun("success", e2eJobs(41)),
          path: ".github/workflows/unrelated.yaml",
        },
      } as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects an exact-diff run with a null workflow path",
      checks: e2eChecks([482, 41, "SUCCESS"]),
      runs: {
        "482": { ...exactDiffGateRun("success", e2eJobs(41)), path: undefined },
      } as Record<string, ActionRunFixture>,
    },
    {
      name: "rejects jobs when a newer run attempt starts during collection",
      checks: e2eChecks([490, 41, "SUCCESS"]),
      runs: {
        "490": { ...exactDiffGateRun("success", e2eJobs(41)), nextAttempt: 2 },
      } as Record<string, ActionRunFixture>,
    },
    {
      name: "validates latest-attempt jobs for tied workflow runs",
      checks: e2eChecks(
        [445, 40, "SUCCESS", "2026-01-01T00:00:00Z"],
        [446, 41, "SUCCESS", "2026-01-01T00:00:00Z"],
      ),
      runs: {
        "445": exactDiffGateRun("success", [{ id: 42, name: "E2E / PR Gate" }]),
        "446": exactDiffGateRun("success", [{ id: 43, name: "E2E / PR Gate" }]),
      } as Record<string, ActionRunFixture>,
    },
    {
      name: "keeps a skipped run when prior conclusions are invalid or incomplete",
      checks: e2eChecks(
        [450, 40, "SUCCESS"],
        [452, 42, "SUCCESS"],
        [453, 43, "SUCCESS"],
        [451, 41, "SKIPPED"],
      ),
      runs: {
        "450": exactDiffGateRun("mystery", e2eJobs(40)),
        "452": exactDiffGateRun("success", [
          { id: 42, name: "E2E / PR Gate", conclusion: "mystery" },
        ]),
        "453": exactDiffGateRun("success", [{ id: 43, name: "E2E / PR Gate", conclusion: null }]),
        "451": exactDiffGateRun("skipped", [
          { id: 41, name: "E2E / PR Gate", conclusion: "skipped" },
        ]),
      } as Record<string, ActionRunFixture>,
      failingChecks: ["E2E / PR Gate: SKIPPED"],
    },
  ])("$name", ({ checks, runs, failingChecks = INCOMPLETE_E2E }) => {
    const result = runGate(e2eRunFixture(checks, runs));
    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: false,
      gates: { ci: { pass: false, failingChecks } },
    });
  });
  it("paginates every job before selecting the latest run attempt", () => {
    const firstPage = Array.from({ length: 100 }, (_value, index) => ({
      id: index + 20,
      name: `unrelated-job-${index}`,
    }));
    const result = runGate(
      e2eRunFixture(
        [
          [500, 10, "FAILURE"],
          [500, 120, "SUCCESS"],
        ],
        {
          "500": {
            ...exactDiffGateRun("success", [], 2),
            jobPages: [firstPage, [{ id: 120, name: "E2E / PR Gate" }]],
          },
        },
      ),
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });
  it("fails closed when a latest-attempt job is absent from the PR rollup", () => {
    const result = runGate(
      e2eRunFixture(
        [
          [600, 10, "SUCCESS"],
          [600, 20, "SUCCESS"],
        ],
        {
          "600": exactDiffGateRun("success", e2eJobs(20, 21), 2),
        },
      ),
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: false,
      gates: {
        ci: {
          pass: false,
          failingChecks: ["E2E / PR Gate: latest attempt evidence incomplete"],
        },
      },
    });
  });
  it.each([
    "",
    "1",
    "2026-02-30T00:00:00Z",
  ])("fails closed on invalid check-run ordering timestamp '%s'", (timestamp) => {
    const result = runGate(
      e2eRunFixture(
        [
          [700, 1, "SUCCESS", timestamp],
          [701, 2, "SUCCESS", timestamp],
        ],
        {
          "700": exactDiffGateRun("success", [{ id: 1, name: "E2E / PR Gate" }]),
          "701": exactDiffGateRun("success", [{ id: 2, name: "E2E / PR Gate" }]),
        },
      ),
    );

    expect(JSON.parse(result.stdout).gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["E2E / PR Gate: latest attempt evidence incomplete"],
    });
  });
  it("passes when the PR body has DCO and every commit is GitHub Verified", () => {
    const result = runGate({
      body: "## Summary\n\nPolicy alignment.\n\nSigned-off-by: Example User <user@example.com>",
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributorCompliance).toMatchObject({
      pass: true,
      dcoDeclarationPresent: true,
      unverifiedCommits: [],
    });
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "clear",
      actors: [],
      uncertainActors: [],
    });
    expect(output.advisories.contributorApprovalOverlap.details).toContain(
      "not proof of independent approval",
    );
    expect(output.gates).not.toHaveProperty("prAdvisor");
  });
  it("warns without blocking when a contributor also approved (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["apurvvkumaria"],
      reviews: [
        {
          author: { login: "apurvvkumaria" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "apurvvkumaria" },
          state: "COMMENTED",
          submittedAt: "2026-01-02T00:00:00Z",
        },
      ],
      prAuthorLogin: "laitingsheng",
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: ["apurvvkumaria"],
      uncertainActors: [],
    });
    expect(output.advisories.contributorApprovalOverlap.details).toContain("advisory");
  });
  it("warns when the PR opener approved their own PR (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["coauthor"],
      prAuthorLogin: "opener",
      reviews: [
        {
          author: { login: "opener" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: ["opener"],
      uncertainActors: [],
    });
  });
  it("uses contributors and approvals from every paginated GitHub page (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      contributorCommitPages: [
        [{ authors: [{ login: "first-page-contributor" }] }],
        [{ authors: [{ login: "later-page-contributor" }] }],
      ],
      contributorReviewPages: [
        [
          {
            author: { login: "first-page-reviewer" },
            state: "APPROVED",
            submittedAt: "2026-01-01T00:00:00Z",
          },
        ],
        [
          {
            author: { login: "later-page-contributor" },
            state: "APPROVED",
            submittedAt: "2026-01-02T00:00:00Z",
          },
        ],
      ],
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: ["later-page-contributor"],
      uncertainActors: [],
    });
  });
  it("uses a later review page to supersede an earlier approval (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      contributorReviewPages: [
        [
          {
            author: { login: "contributor" },
            state: "APPROVED",
            submittedAt: "2026-01-01T00:00:00Z",
          },
        ],
        [
          {
            author: { login: "contributor" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-01-02T00:00:00Z",
          },
        ],
      ],
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "clear",
      actors: [],
      uncertainActors: [],
    });
  });
  it("warns when a commit author page is incomplete (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      contributorCommitPages: [[{ authors: [{ login: "contributor" }], authorCount: 101 }]],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: [],
    });
    expect(output.advisories.contributorApprovalOverlap.details).toContain(
      "complete paginated commit and review history",
    );
  });

  it("warns when the paginated review count is incomplete (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      contributorReviewPages: [
        [
          {
            author: { login: "other-reviewer" },
            state: "APPROVED",
            submittedAt: "2026-01-01T00:00:00Z",
          },
        ],
      ],
      contributorReviewTotalCount: 2,
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: [],
    });
    expect(output.advisories.contributorApprovalOverlap.details).toContain(
      "complete paginated commit and review history",
    );
  });

  it("matches multiple commit authors and co-authors case-insensitively (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["PrimaryAuthor", "CoAuthor"],
      prAuthorLogin: "opener",
      reviews: [
        {
          author: { login: "coauthor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "PRIMARYAUTHOR" },
          state: "APPROVED",
          submittedAt: "2026-01-02T00:00:00Z",
        },
      ],
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: ["coauthor", "primaryauthor"],
      uncertainActors: [],
    });
  });

  it("ignores automated contributor and reviewer identities (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["dependabot[bot]", "coderabbitai", "github-actions[bot]"],
      prAuthorLogin: "human-author",
      reviews: [
        {
          author: { login: "dependabot[bot]" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "coderabbitai" },
          state: "APPROVED",
          submittedAt: "2026-01-02T00:00:00Z",
        },
        {
          author: { login: "github-actions[bot]" },
          state: "APPROVED",
          submittedAt: "2026-01-03T00:00:00Z",
        },
      ],
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "clear",
      actors: [],
      uncertainActors: [],
    });
  });

  it("clears overlap when approval is superseded by requested changes (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "contributor" },
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-01-02T00:00:00Z",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "clear",
      actors: [],
      uncertainActors: [],
    });
  });

  it("warns when approval supersedes requested changes regardless of input order (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-02T00:00:00Z",
        },
        {
          author: { login: "contributor" },
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: ["contributor"],
      uncertainActors: [],
    });
  });

  it("clears overlap when approval is superseded by dismissal (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "contributor" },
          state: "DISMISSED",
          submittedAt: "2026-01-02T00:00:00Z",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "clear",
      actors: [],
      uncertainActors: [],
    });
  });

  it("reports uncertainty when a contributor review timestamp is malformed (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "not-a-timestamp",
        },
      ],
      verified: true,
    });

    const advisory = JSON.parse(result.stdout).advisories.contributorApprovalOverlap;
    expect(advisory).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: ["contributor"],
    });
    expect(advisory.details).toContain("could not be determined");
  });

  it("reports uncertainty when a contributor review timestamp is missing (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
        },
      ],
      verified: true,
    });

    const advisory = JSON.parse(result.stdout).advisories.contributorApprovalOverlap;
    expect(advisory).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: ["contributor"],
    });
    expect(advisory.details).toContain("missing");
  });

  it("does not confirm approval when a later opinion has a malformed timestamp (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "contributor" },
          state: "CHANGES_REQUESTED",
          submittedAt: "not-a-timestamp",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: ["contributor"],
    });
  });

  it("does not confirm approval when an earlier input opinion has a malformed timestamp (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "CHANGES_REQUESTED",
          submittedAt: "not-a-timestamp",
        },
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: ["contributor"],
    });
  });

  it("reports uncertainty for conflicting opinions with equal timestamps (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "contributor" },
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: ["contributor"],
    });
  });

  it("reports equal-timestamp conflicts independently of API order (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: ["contributor"],
    });
  });

  it("accepts GraphQL RFC3339 timestamp variants (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["fractional", "offset", "whole-second"],
      reviews: [
        {
          author: { login: "fractional" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00.123Z",
        },
        {
          author: { login: "offset" },
          state: "APPROVED",
          submittedAt: "2026-01-01T05:30:00+05:30",
        },
        {
          author: { login: "whole-second" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: ["fractional", "offset", "whole-second"],
      uncertainActors: [],
    });
  });

  it("fails closed when the PR body lacks the DCO declaration", () => {
    const result = runGate({ body: "## Summary\n\nNo declaration.", verified: true });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributorCompliance.pass).toBe(false);
    expect(output.gates.contributorCompliance.details).toContain("lacks a valid Signed-off-by");
  });

  it("fails closed when any PR commit is not GitHub Verified", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: false,
      reason: "unsigned",
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributorCompliance).toMatchObject({
      pass: false,
      dcoDeclarationPresent: true,
      unverifiedCommits: [{ sha: "abc123", reason: "unsigned" }],
    });
  });

  it("fails closed for type-skewed commit verification data", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      commitOutput: JSON.stringify({
        sha: "abc123",
        verified: "false",
        reason: "unsigned",
      }),
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributorCompliance).toMatchObject({
      pass: false,
      unverifiedCommits: [{ sha: "abc123", reason: "malformed_commit_verification_data" }],
    });
  });
});

describe("maintainer PR comparator contributor compliance", () => {
  it("passes when DCO and every commit are verified", () => {
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci_green_latest_sha).toBe(true);
    expect(output.gates.contributor_compliance).toBe(true);
    expect(output.details).toMatchObject({
      dco_declaration_present: true,
      commit_count: 1,
      unverified_commits: [],
    });
  });

  it("fails when a commit is not verified", () => {
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: false,
      reason: "unsigned",
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributor_compliance).toBe(false);
    expect(output.details.unverified_commits).toEqual([{ sha: "abc123", reason: "unsigned" }]);
    expect(output.failures).toContain("ineligible:contributor_compliance");
  });

  it("emits fail-closed JSON when commit API output is malformed", () => {
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      commitOutput: "not-json",
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributor_compliance).toBe(false);
    expect(output.details).toMatchObject({
      commit_count: 0,
      unverified_commits: [],
      commit_fetch_failed: false,
      commit_parse_failed: true,
    });
    expect(output.failures).toContain("ineligible:contributor_compliance");
  });

  it("fails when the PR body lacks the DCO declaration", () => {
    const result = runComparatorGate({
      body: "## Summary\n\nNo declaration.",
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributor_compliance).toBe(false);
    expect(output.details.dco_declaration_present).toBe(false);
    expect(output.failures).toContain("ineligible:contributor_compliance");
  });

  it("rejects a non-numeric PR argument without emitting malformed JSON", () => {
    const result = runComparatorGate(
      {
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
      },
      '42,"injected":true',
    );

    expect(JSON.parse(result.stdout)).toEqual({
      pr: '42,"injected":true',
      error: "invalid_pr_number",
    });
    expect(result.stderr).toBe("");
  });

  it("serializes unusual GitHub string values as valid JSON", () => {
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      headRefOid: 'abc"123\\nnext',
      state: 'OPEN"unexpected',
      mergeable: 'MERGEABLE"unexpected',
      mergeStateStatus: 'CLEAN"unexpected',
      reviewDecision: 'APPROVED"unexpected',
    });

    const output = JSON.parse(result.stdout);
    expect(output.head_sha).toBe('abc"123\\nnext');
    expect(output.details).toMatchObject({
      state: 'OPEN"unexpected',
      mergeable: 'MERGEABLE"unexpected',
      merge_state_status: 'CLEAN"unexpected',
      review_decision: 'APPROVED"unexpected',
    });
  });

  it("fails closed when the status check rollup is empty", () => {
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      checkNames: [],
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci_green_latest_sha).toBe(false);
    expect(output.details.ci_missing_required_checks).toEqual(REQUIRED_CHECK_NAMES);
    expect(output.failures).toContain(
      "substantive:ci_failures=0,pending=0,missing=checks,check-hash,changes,commit-lint,dco-check,E2E / PR Gate",
    );
  });

  describe("contributor-compliance DCO parity", () => {
    it("requires the canonical Signed-off-by trailer casing in both gates", () => {
      const fixture = {
        body: "signed-off-by: Example User <user@example.com>",
        verified: true,
      };
      const mergeGate = runGate(fixture);
      const comparator = runComparatorGate(fixture);

      expect(mergeGate.status).toBe(0);
      expect(comparator.status).toBe(0);
      expect(JSON.parse(mergeGate.stdout).gates.contributorCompliance.pass).toBe(false);
      expect(JSON.parse(comparator.stdout).gates.contributor_compliance).toBe(false);
    });
  });

  it("names a missing required check and fails the CI gate", () => {
    const fixture = {
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      checkNames: REQUIRED_CHECK_NAMES.filter((name) => name !== "E2E / PR Gate"),
    };
    const mergeGate = runGate(fixture);
    const comparator = runComparatorGate(fixture);

    expect(mergeGate.status).toBe(0);
    expect(comparator.status).toBe(0);
    const mergeOutput = JSON.parse(mergeGate.stdout);
    const comparatorOutput = JSON.parse(comparator.stdout);
    expect(mergeOutput.gates.ci).toMatchObject({
      pass: false,
      missingChecks: ["E2E / PR Gate"],
    });
    expect(mergeOutput.allPass).toBe(false);
    expect(comparatorOutput.gates.ci_green_latest_sha).toBe(false);
    expect(comparatorOutput.details.ci_missing_required_checks).toEqual(["E2E / PR Gate"]);
    expect(comparatorOutput.failures).toContain(
      "substantive:ci_failures=0,pending=0,missing=E2E / PR Gate",
    );
  });

  it.each([
    "NEUTRAL",
    "SKIPPED",
  ])("requires a literal SUCCESS conclusion from E2E / PR Gate when it is %s", (conclusion) => {
    const fixture = {
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      checkConclusions: { "E2E / PR Gate": conclusion },
    };
    const mergeGate = runGate(fixture);
    const comparator = runComparatorGate(fixture);

    expect(mergeGate.status).toBe(0);
    expect(comparator.status).toBe(0);
    const mergeOutput = JSON.parse(mergeGate.stdout);
    const comparatorOutput = JSON.parse(comparator.stdout);
    expect(mergeOutput.gates.ci).toMatchObject({
      pass: false,
      failingChecks: [`E2E / PR Gate: ${conclusion}`],
    });
    expect(mergeOutput.allPass).toBe(false);
    expect(comparatorOutput.gates.ci_green_latest_sha).toBe(false);
    expect(comparatorOutput.details.ci_failing_checks).toEqual([`E2E / PR Gate: ${conclusion}`]);
  });

  it.each([
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
  ])("fails closed for a completed required check with conclusion %s", (conclusion) => {
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      checkConclusions: { checks: conclusion },
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci_green_latest_sha).toBe(false);
    expect(output.details.ci_failing_checks).toEqual([`checks: ${conclusion}`]);
    expect(output.failures).toContain("substantive:ci_failures=1,pending=0,missing=");
  });
});

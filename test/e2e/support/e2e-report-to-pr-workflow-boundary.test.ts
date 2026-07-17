// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";
import YAML from "yaml";
import {
  type CredentialFreeTestMatrixRow,
  discoverCredentialFreeTests,
} from "../../../tools/e2e/credential-free-tests.mts";
import {
  loadReportJobs,
  type ReportApiJob,
  type ReportContext,
  type ReportGithub,
  type ReportNeeds,
  renderE2eReport,
  resolveReportPr,
} from "../../../tools/e2e/report-e2e-results.mts";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";
import { requireFixture } from "./require-fixture";

function readWorkflow(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(path.join(process.cwd(), ".github/workflows/e2e.yaml"), "utf-8"),
  ) as Record<string, unknown>;
}

function generateMatrixScript(): string {
  const workflow = readWorkflow() as {
    jobs: Record<string, { steps: Array<{ id?: string; run?: string }> }>;
  };
  const step = workflow.jobs["generate-matrix"].steps.find(
    (candidate) => candidate.id === "matrix",
  );
  expect(step?.run).toEqual(expect.any(String));
  return String(step!.run);
}

function trustedControllerMatrixScript(): string {
  const workflow = readWorkflow() as {
    jobs: Record<string, { steps: Array<{ id?: string; run?: string }> }>;
  };
  const step = workflow.jobs["generate-matrix"].steps.find(
    (candidate) => candidate.id === "controller_matrix",
  );
  expect(step?.run).toEqual(expect.any(String));
  return String(step!.run);
}

function executeTrustedControllerMatrix(targets: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-controller-matrix-"));
  const outputPath = path.join(directory, "github-output");
  try {
    const result = spawnSync("bash", ["-c", trustedControllerMatrixScript()], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        TARGETS: targets,
      },
      timeout: 30_000,
    });
    return {
      result,
      workflowOutput: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "",
    };
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

function executeGenerateMatrixWithPlannerOutput(
  plan: unknown,
  options: {
    checkoutSha?: string;
    controllerMatrix?: string;
    jobs?: string;
    targets?: string;
  } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-planner-schema-"));
  const binDirectory = path.join(directory, "bin");
  const fakeNpx = path.join(binDirectory, "npx");
  const outputPath = path.join(directory, "github-output");
  fs.mkdirSync(binDirectory);
  fs.writeFileSync(
    fakeNpx,
    [
      "#!/usr/bin/env bash",
      "expected=(tsx tools/e2e/workflow-plan.mts)",
      '[[ -z "${JOBS:-}" ]] || expected+=(--jobs "$JOBS")',
      '[[ -z "${TARGETS:-}" ]] || expected+=(--targets "$TARGETS")',
      'actual=("$@")',
      '[[ "${#actual[@]}" -eq "${#expected[@]}" ]] || exit 97',
      'for index in "${!expected[@]}"; do [[ "${actual[$index]}" == "${expected[$index]}" ]] || exit 97; done',
      "printf '%s\\n' \"${FAKE_E2E_PLAN}\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  try {
    return {
      result: spawnSync("bash", ["-c", generateMatrixScript()], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CHECKOUT_SHA: options.checkoutSha ?? "",
          CONTROLLER_MATRIX: options.controllerMatrix ?? "",
          FAKE_E2E_PLAN: JSON.stringify(plan),
          GITHUB_OUTPUT: outputPath,
          GITHUB_STEP_SUMMARY: path.join(directory, "summary.md"),
          INFERENCE_MODE: "mock",
          JOBS: options.jobs ?? "cloud-onboard",
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          TARGETS: options.targets ?? "",
        },
        timeout: 30_000,
      }),
      workflowOutput: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "",
    };
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

const DEFAULT_TEST_MATRIX: CredentialFreeTestMatrixRow[] = [
  {
    id: "alpha",
    file: "test/e2e/live/alpha.test.ts",
    project: "e2e-live",
  },
  {
    id: "beta",
    file: "test/e2e/live/beta.test.ts",
    project: "e2e-live",
  },
];

const REPORT_CONTEXT: ReportContext = {
  ref: "refs/heads/main",
  repo: { owner: "NVIDIA", repo: "NemoClaw" },
  runId: 123,
  serverUrl: "https://github.com",
};

const RUN_URL = "https://github.com/NVIDIA/NemoClaw/actions/runs/123";

function reportGithub(fields: {
  createComment?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
  list?: ReturnType<typeof vi.fn>;
  paginate?: ReturnType<typeof vi.fn>;
}): ReportGithub {
  return {
    paginate: fields.paginate ?? vi.fn(async () => []),
    rest: {
      actions: { listJobsForWorkflowRun: Symbol("listJobsForWorkflowRun") },
      issues: { createComment: fields.createComment ?? vi.fn(async () => undefined) },
      pulls: {
        get: fields.get ?? vi.fn(async () => ({ data: { state: "open" } })),
        list: fields.list ?? vi.fn(async () => ({ data: [] })),
      },
    },
  } as unknown as ReportGithub;
}

async function executeReport(options: {
  apiJobs?: ReportApiJob[];
  testMatrix?: CredentialFreeTestMatrixRow[];
  jobs?: string;
  needs?: ReportNeeds;
  paginateError?: Error;
}): Promise<{
  body: string;
  setFailed: ReturnType<typeof vi.fn>;
  warning: ReturnType<typeof vi.fn>;
}> {
  const {
    apiJobs = [],
    testMatrix = DEFAULT_TEST_MATRIX,
    jobs = testMatrix.map(({ id }) => id).join(","),
    needs = {
      "generate-matrix": { result: "success" },
      "shared-e2e": { result: "failure" },
      live: { result: "skipped" },
    },
    paginateError,
  } = options;
  const createComment = vi.fn(async (_input: { body: string }) => undefined);
  const setFailed = vi.fn();
  const warning = vi.fn();
  const paginate = paginateError
    ? vi.fn(() => Promise.reject(paginateError))
    : vi.fn(async () => apiJobs);
  const github = reportGithub({ createComment, paginate });
  const core = { info: vi.fn(), setFailed, warning };
  const env = {
    EXPLICIT_ONLY_JOBS: "",
    TEST_MATRIX: JSON.stringify(testMatrix),
    JOB_PR_NUMBER: "42",
    JOB_TARGETS: "",
    JOBS: jobs,
  };

  const prNumber = await resolveReportPr({ github, context: REPORT_CONTEXT, core, env });
  expect(prNumber).toBe(42);
  const loaded = await loadReportJobs({ github, context: REPORT_CONTEXT, core });
  const report = renderE2eReport({
    needs,
    env,
    apiJobs: loaded.apiJobs,
    apiJobsLoaded: loaded.loaded,
    context: REPORT_CONTEXT,
  });
  for (const message of report.warnings) warning(message);
  await github.rest.issues.createComment({
    owner: REPORT_CONTEXT.repo.owner,
    repo: REPORT_CONTEXT.repo.repo,
    issue_number: prNumber as number,
    body: report.body,
  });

  expect(createComment).toHaveBeenCalledOnce();
  return {
    body: createComment.mock.calls[0]?.[0]?.body as string,
    setFailed,
    warning,
  };
}

function parseSimpleOutput(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        expect(separator).toBeGreaterThan(0);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

it("rejects a non-numeric pr_number before contacting GitHub", async () => {
  const setFailed = vi.fn();
  const get = vi.fn();
  const prNumber = await resolveReportPr({
    github: reportGithub({ get }),
    context: REPORT_CONTEXT,
    core: { info: vi.fn(), setFailed, warning: vi.fn() },
    env: { JOB_PR_NUMBER: "12ab" },
  });

  expect(prNumber).toBeUndefined();
  expect(setFailed).toHaveBeenCalledWith(
    "Invalid pr_number input: 12ab. Use a positive pull request number.",
  );
  expect(get).not.toHaveBeenCalled();
});

it("rejects an unsafe pr_number integer", async () => {
  const setFailed = vi.fn();
  const prNumber = await resolveReportPr({
    github: reportGithub({}),
    context: REPORT_CONTEXT,
    core: { info: vi.fn(), setFailed, warning: vi.fn() },
    env: { JOB_PR_NUMBER: "99999999999999999999" },
  });

  expect(prNumber).toBeUndefined();
  expect(setFailed).toHaveBeenCalledWith(
    "Invalid pr_number input: 99999999999999999999. Use a safe positive integer.",
  );
});

it("verifies pr_number identifies an open pull request via pulls.get", async () => {
  const get = vi.fn(async () => ({ data: { state: "open" } }));
  const prNumber = await resolveReportPr({
    github: reportGithub({ get }),
    context: REPORT_CONTEXT,
    core: { info: vi.fn(), setFailed: vi.fn(), warning: vi.fn() },
    env: { JOB_PR_NUMBER: "42" },
  });

  expect(prNumber).toBe(42);
  expect(get).toHaveBeenCalledWith({ owner: "NVIDIA", repo: "NemoClaw", pull_number: 42 });
});

it("rejects a closed pr_number", async () => {
  const setFailed = vi.fn();
  const get = vi.fn(async () => ({ data: { state: "closed" } }));
  const prNumber = await resolveReportPr({
    github: reportGithub({ get }),
    context: REPORT_CONTEXT,
    core: { info: vi.fn(), setFailed, warning: vi.fn() },
    env: { JOB_PR_NUMBER: "42" },
  });

  expect(prNumber).toBeUndefined();
  expect(setFailed).toHaveBeenCalledWith("PR #42 is closed; E2E reports only comment on open PRs.");
});

it("treats a 404 pr_number as a missing pull request", async () => {
  const setFailed = vi.fn();
  const get = vi.fn(async () => {
    throw Object.assign(new Error("Not Found"), { status: 404 });
  });
  const prNumber = await resolveReportPr({
    github: reportGithub({ get }),
    context: REPORT_CONTEXT,
    core: { info: vi.fn(), setFailed, warning: vi.fn() },
    env: { JOB_PR_NUMBER: "42" },
  });

  expect(prNumber).toBeUndefined();
  expect(setFailed).toHaveBeenCalledWith(
    "pr_number 42 does not identify a pull request in NVIDIA/NemoClaw.",
  );
});

it("falls back to the workflow branch pull request when pr_number is empty", async () => {
  const list = vi.fn(async () => ({ data: [{ number: 7 }] }));
  const prNumber = await resolveReportPr({
    github: reportGithub({ list }),
    context: REPORT_CONTEXT,
    core: { info: vi.fn(), setFailed: vi.fn(), warning: vi.fn() },
    env: { JOB_PR_NUMBER: "" },
  });

  expect(prNumber).toBe(7);
  expect(list).toHaveBeenCalledWith({
    owner: "NVIDIA",
    repo: "NemoClaw",
    head: "NVIDIA:main",
    state: "open",
  });
});

it("fails closed when multiple open PRs match the workflow branch", async () => {
  const setFailed = vi.fn();
  const list = vi.fn(async () => ({ data: [{ number: 7 }, { number: 9 }] }));
  const prNumber = await resolveReportPr({
    github: reportGithub({ list }),
    context: REPORT_CONTEXT,
    core: { info: vi.fn(), setFailed, warning: vi.fn() },
    env: { JOB_PR_NUMBER: "" },
  });

  expect(prNumber).toBeUndefined();
  expect(setFailed).toHaveBeenCalledWith(
    "Multiple open PRs found for branch main; provide an explicit pr_number.",
  );
});

it("skips commenting when no open PR matches the workflow branch", async () => {
  const info = vi.fn();
  const prNumber = await resolveReportPr({
    github: reportGithub({ list: vi.fn(async () => ({ data: [] })) }),
    context: REPORT_CONTEXT,
    core: { info, setFailed: vi.fn(), warning: vi.fn() },
    env: { JOB_PR_NUMBER: "" },
  });

  expect(prNumber).toBeUndefined();
  expect(info).toHaveBeenCalledWith("No open PR found for branch main — skipping comment.");
});

it("renders comment content from job evidence without a live GitHub mutation", () => {
  const report = renderE2eReport({
    needs: {
      "generate-matrix": { result: "success" },
      "shared-e2e": { result: "success" },
    },
    env: {
      EXPLICIT_ONLY_JOBS: "",
      TEST_MATRIX: JSON.stringify(DEFAULT_TEST_MATRIX.slice(0, 1)),
      JOB_PR_NUMBER: "42",
      JOB_TARGETS: "",
      JOBS: "alpha",
    },
    apiJobs: [{ conclusion: "success", name: "Shared E2E (alpha)", status: "completed" }],
    apiJobsLoaded: true,
    context: REPORT_CONTEXT,
  });

  expect(report.fatal).toBeUndefined();
  expect(report.warnings).toEqual([]);
  expect(report.body).toContain("| alpha | ✅ success | — |");
  expect(report.body).toContain("All requested tests passed");
});

it("fails closed on an invalid test matrix without rendering a comment", () => {
  const report = renderE2eReport({
    needs: {
      "generate-matrix": { result: "success" },
      "shared-e2e": { result: "success" },
    },
    env: {
      EXPLICIT_ONLY_JOBS: "",
      TEST_MATRIX: '[{"id":"bad id"}]',
      JOB_PR_NUMBER: "42",
      JOB_TARGETS: "",
      JOBS: "",
    },
    apiJobs: [],
    apiJobsLoaded: true,
    context: REPORT_CONTEXT,
  });

  expect(report.fatal).toBe("Invalid test matrix: matrix row has an invalid id");
  expect(report.body).toBe("");
});

it("marks requested targets and test IDs as rejected when selector validation failed", () => {
  const report = renderE2eReport({
    needs: {
      "generate-matrix": { result: "failure" },
    },
    env: {
      EXPLICIT_ONLY_JOBS: "",
      TEST_MATRIX: "[]",
      JOB_PR_NUMBER: "42",
      JOB_TARGETS: "cloud-onboard",
      JOBS: "alpha",
    },
    apiJobs: [],
    apiJobsLoaded: true,
    context: REPORT_CONTEXT,
  });

  expect(report.fatal).toBeUndefined();
  expect(report.body).toContain(
    "**Requested targets:** _(selector rejected by workflow validation)_",
  );
  expect(report.body).toContain(
    "**Requested test IDs:** _(selector rejected by workflow validation)_",
  );
});

it("reports a requested test ID that never appears among rendered entries as not reported", () => {
  const report = renderE2eReport({
    needs: {
      "generate-matrix": { result: "success" },
      "shared-e2e": { result: "success" },
    },
    env: {
      EXPLICIT_ONLY_JOBS: "",
      TEST_MATRIX: JSON.stringify(DEFAULT_TEST_MATRIX.slice(0, 1)),
      JOB_PR_NUMBER: "42",
      JOB_TARGETS: "",
      JOBS: "alpha,ghost",
    },
    apiJobs: [
      {
        conclusion: "success",
        name: "Shared E2E (alpha)",
        status: "completed",
      },
    ],
    apiJobsLoaded: true,
    context: REPORT_CONTEXT,
  });

  expect(report.body).toContain("| ghost | ❓ not reported | — |");
  expect(report.body).toContain(
    "> **Missing requested test IDs:** ghost. The reporting workflow needs to include these tests.",
  );
  expect(report.body).toContain("❌ Some tests failed");
});

it("reports a cancelled shared-e2e run with no passing tests as no signal", () => {
  const report = renderE2eReport({
    needs: {
      "generate-matrix": { result: "success" },
      "shared-e2e": { result: "cancelled" },
    },
    env: {
      EXPLICIT_ONLY_JOBS: "",
      TEST_MATRIX: JSON.stringify(DEFAULT_TEST_MATRIX.slice(0, 1)),
      JOB_PR_NUMBER: "42",
      JOB_TARGETS: "",
      JOBS: "alpha",
    },
    apiJobs: [
      {
        conclusion: "cancelled",
        name: "Shared E2E (alpha)",
        status: "completed",
      },
    ],
    apiJobsLoaded: true,
    context: REPORT_CONTEXT,
  });

  expect(report.body).toContain("⚠️ Run cancelled — no signal");
  expect(report.body).toContain("| alpha | ⚠️ cancelled | — |");
});

it("reports cancelled tests alongside passing tests as a partial pass", () => {
  const report = renderE2eReport({
    needs: {
      "generate-matrix": { result: "success" },
      "shared-e2e": { result: "cancelled" },
    },
    env: {
      EXPLICIT_ONLY_JOBS: "",
      TEST_MATRIX: JSON.stringify(DEFAULT_TEST_MATRIX),
      JOB_PR_NUMBER: "42",
      JOB_TARGETS: "",
      JOBS: "alpha,beta",
    },
    apiJobs: [
      {
        conclusion: "success",
        name: "Shared E2E (alpha)",
        status: "completed",
      },
      {
        conclusion: "cancelled",
        name: "Shared E2E (beta)",
        status: "completed",
      },
    ],
    apiJobsLoaded: true,
    context: REPORT_CONTEXT,
  });

  expect(report.body).toContain("⚠️ Some tests cancelled — partial pass");
});

it("lists explicit-only jobs skipped by default dispatch with their selection hints", () => {
  const report = renderE2eReport({
    needs: {
      "generate-matrix": { result: "success" },
    },
    env: {
      EXPLICIT_ONLY_JOBS: "mcp-bridge-dev",
      TEST_MATRIX: "[]",
      JOB_PR_NUMBER: "42",
      JOB_TARGETS: "",
      JOBS: "",
    },
    apiJobs: [],
    apiJobsLoaded: true,
    context: REPORT_CONTEXT,
  });

  expect(report.body).toContain(
    "> **Explicit-only jobs skipped:** `mcp-bridge-dev` (default dispatch excludes moving OpenShell dev artifacts unless explicitly selected; validate with `jobs=mcp-bridge-dev` or `targets=mcp-bridge-dev`).",
  );
});

it("reports matrix children by test ID without fabricating a missing child result", async () => {
  const { body, setFailed, warning } = await executeReport({
    apiJobs: [
      {
        conclusion: "success",
        name: "Shared E2E (alpha)",
        status: "completed",
      },
    ],
  });

  expect(setFailed).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith(
    "Missing per-test results for beta; reporting them as unknown.",
  );
  expect(body).toContain("| alpha | ✅ success | — |");
  expect(body).toContain("| beta | ❓ unknown | — |");
  expect(body).toContain("Some tests failed");
  expect(body).toContain("Shared E2E job aggregate: failure");
});

it("reports the total wall clock time for a selected E2E job", async () => {
  const { body, setFailed } = await executeReport({
    apiJobs: [
      {
        completed_at: "2026-07-15T00:27:58Z",
        conclusion: "success",
        name: "rebuild-openclaw",
        started_at: "2026-07-15T00:16:48Z",
        status: "completed",
      },
    ],
    testMatrix: [],
    jobs: "rebuild-openclaw",
    needs: {
      "generate-matrix": { result: "success" },
      "rebuild-openclaw": { result: "success" },
    },
  });

  expect(setFailed).not.toHaveBeenCalled();
  expect(body).toContain("| Test | Result | Total wall clock time |");
  expect(body).toContain("| rebuild-openclaw | ✅ success | 11m 10s |");
});

it("links every failed entry to a validated same-run job and keeps the run fallback", async () => {
  const { body, setFailed } = await executeReport({
    apiJobs: [
      {
        conclusion: "failure",
        html_url: "https://attacker.example/job/456",
        id: 456,
        name: "rebuild-openclaw",
        status: "completed",
      },
      {
        conclusion: "failure",
        id: 0,
        name: "cloud-onboard",
        status: "completed",
      },
    ],
    testMatrix: [],
    jobs: "rebuild-openclaw,cloud-onboard",
    needs: {
      "generate-matrix": { result: "success" },
      "rebuild-openclaw": { result: "failure" },
      "cloud-onboard": { result: "failure" },
    },
  });

  const jobUrl = `${RUN_URL}/job/456`;
  expect(setFailed).not.toHaveBeenCalled();
  expect(body).toContain(`| [rebuild-openclaw](${jobUrl}) | ❌ failure | — |`);
  expect(body).toContain(`| [cloud-onboard](${RUN_URL}) | ❌ failure | — |`);
  expect(body).toContain(
    `> **Failed tests:** [cloud-onboard](${RUN_URL}), [rebuild-openclaw](${jobUrl}).`,
  );
  expect(body).not.toContain("attacker.example");
  expect(body).not.toContain("/job/0");
});

it("links failed shared-matrix entries to their physical job", async () => {
  const { body, setFailed } = await executeReport({
    apiJobs: [
      {
        conclusion: "failure",
        id: 789,
        name: "Shared E2E (alpha)",
        status: "completed",
      },
    ],
    testMatrix: DEFAULT_TEST_MATRIX.slice(0, 1),
    jobs: "alpha",
    needs: {
      "generate-matrix": { result: "success" },
      "shared-e2e": { result: "failure" },
    },
  });

  const jobUrl = `${RUN_URL}/job/789`;
  expect(setFailed).not.toHaveBeenCalled();
  expect(body).toContain(`| [alpha](${jobUrl}) | ❌ failure | — |`);
  expect(body).toContain(`> **Failed tests:** [alpha](${jobUrl}).`);
});

it("reports one total wall clock span from valid matrix E2E jobs", async () => {
  const { body, setFailed } = await executeReport({
    apiJobs: [
      {
        completed_at: "2026-07-15T00:05:00Z",
        conclusion: "success",
        name: "OpenShell gateway upgrade (v0.1.0)",
        started_at: "2026-07-15T00:00:00Z",
        status: "completed",
      },
      {
        completed_at: "2026-07-15T00:11:00Z",
        conclusion: "success",
        name: "OpenShell gateway upgrade (v0.2.0)",
        started_at: "2026-07-15T00:02:00Z",
        status: "completed",
      },
      {
        completed_at: "2026-07-14T23:40:00Z",
        conclusion: "success",
        name: "OpenShell gateway upgrade (reversed-timestamps)",
        started_at: "2026-07-14T23:50:00Z",
        status: "completed",
      },
      {
        completed_at: "not-a-timestamp",
        conclusion: "success",
        name: "OpenShell gateway upgrade (invalid-timestamp)",
        started_at: "2026-07-14T23:30:00Z",
        status: "completed",
      },
      {
        completed_at: "2026-07-15T01:00:00Z",
        conclusion: "skipped",
        name: "OpenShell gateway upgrade (skipped)",
        started_at: "2026-07-14T23:00:00Z",
        status: "completed",
      },
    ],
    testMatrix: [],
    jobs: "openshell-gateway-upgrade",
    needs: {
      "generate-matrix": { result: "success" },
      "openshell-gateway-upgrade": { result: "success" },
    },
  });

  expect(setFailed).not.toHaveBeenCalled();
  expect(body).toContain("| openshell-gateway-upgrade | ✅ success | 11m 0s |");
  expect(body).not.toContain("OpenShell gateway upgrade (v0.1.0)");
  expect(body).not.toContain("OpenShell gateway upgrade (v0.2.0)");
});

it("reports one total wall clock span when matrix job names start with their job ID", async () => {
  const { body, setFailed } = await executeReport({
    apiJobs: [
      {
        completed_at: "2026-07-15T04:56:38Z",
        conclusion: "success",
        name: "hermes-inference-switch (anthropic, e2e-hermes-anthropic-inference-switch, compatible-anthropic-e...",
        started_at: "2026-07-15T04:49:26Z",
        status: "completed",
      },
      {
        completed_at: "2026-07-15T05:06:51Z",
        conclusion: "success",
        name: "hermes-inference-switch (hosted, e2e-hermes-inference-switch, nvidia-prod, nvidia/nemotron-3-supe...",
        started_at: "2026-07-15T04:49:26Z",
        status: "completed",
      },
    ],
    testMatrix: [],
    jobs: "hermes-inference-switch",
    needs: {
      "generate-matrix": { result: "success" },
      "hermes-inference-switch": { result: "success" },
    },
  });

  expect(setFailed).not.toHaveBeenCalled();
  expect(body).toContain("| hermes-inference-switch | ✅ success | 17m 25s |");
  expect(body).not.toContain("hermes-inference-switch (anthropic");
  expect(body).not.toContain("hermes-inference-switch (hosted");
});

it("reports API lookup failures as unknown rather than copying the aggregate result", async () => {
  const { body, setFailed, warning } = await executeReport({
    testMatrix: DEFAULT_TEST_MATRIX.slice(0, 1),
    jobs: "alpha",
    needs: {
      "generate-matrix": { result: "success" },
      "shared-e2e": { result: "success" },
    },
    paginateError: new Error("API unavailable"),
  });

  expect(setFailed).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith(
    "Could not load per-test results; reporting them as unknown: API unavailable",
  );
  expect(body).toContain("Per-test results incomplete");
  expect(body).toContain("| alpha | ❓ unknown |");
  expect(body).not.toContain("| alpha | ✅ success |");
});

it("keeps nonterminal API conclusions unknown", async () => {
  const { body, setFailed } = await executeReport({
    apiJobs: [
      {
        conclusion: null,
        name: "Shared E2E (alpha)",
        status: "in_progress",
      },
    ],
    testMatrix: DEFAULT_TEST_MATRIX.slice(0, 1),
    jobs: "alpha",
    needs: {
      "generate-matrix": { result: "success" },
      "shared-e2e": { result: "success" },
    },
  });

  expect(setFailed).not.toHaveBeenCalled();
  expect(body).toContain("Per-test results incomplete");
  expect(body).toContain("| alpha | ❓ unknown |");
});

it("does not claim child success when complete API results contradict the aggregate", async () => {
  const { body, setFailed, warning } = await executeReport({
    apiJobs: [
      {
        conclusion: "success",
        name: "Shared E2E (alpha)",
        status: "completed",
      },
    ],
    testMatrix: DEFAULT_TEST_MATRIX.slice(0, 1),
    jobs: "alpha",
    needs: {
      "generate-matrix": { result: "success" },
      "shared-e2e": { result: "failure" },
    },
  });

  expect(setFailed).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith(
    "Per-test conclusions (success) contradict shared E2E job aggregate failure; reporting child attribution as unknown.",
  );
  expect(body).toContain("Some tests failed");
  expect(body).toContain("| alpha | ❓ unknown |");
  expect(body).not.toContain("| alpha | ✅ success |");
});

it("carries the generated planner matrix through the workflow output and PR report", async () => {
  const [selected] = discoverCredentialFreeTests();
  expect(selected).toBeDefined();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shared-e2e-integration-"));
  const outputPath = path.join(directory, "github-output");
  const summaryPath = path.join(directory, "summary.md");
  try {
    const generated = spawnSync("bash", ["-c", generateMatrixScript()], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CHECKOUT_SHA: "",
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        INFERENCE_MODE: "mock",
        JOBS: selected.id,
        TARGETS: "",
      },
      timeout: 30_000,
    });
    expect(generated.status, generated.stderr || generated.stdout).toBe(0);
    const outputs = parseSimpleOutput(fs.readFileSync(outputPath, "utf8"));
    const testMatrix = JSON.parse(outputs.test_matrix) as CredentialFreeTestMatrixRow[];
    expect(testMatrix).toEqual([selected]);

    const { body, setFailed } = await executeReport({
      apiJobs: [
        {
          conclusion: "success",
          name: `Shared E2E (${selected.id})`,
          status: "completed",
        },
      ],
      testMatrix,
      jobs: selected.id,
      needs: {
        "generate-matrix": { result: "success" },
        "shared-e2e": { result: "success" },
      },
    });

    expect(setFailed).not.toHaveBeenCalled();
    expect(body).toContain("All requested tests passed");
    expect(body).toContain(`| ${selected.id} | ✅ success |`);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

it("fails closed when planner output violates the workflow schema", () => {
  const [selected] = discoverCredentialFreeTests();
  expect(selected).toBeDefined();
  const validPlan = buildE2eWorkflowPlan();
  const [registryRow] = validPlan.matrix;
  expect(registryRow).toBeDefined();
  const { explicitOnlyJobs: _omitted, ...missingField } = validPlan;
  const malformedPlans = [
    ["missing required field", missingField],
    ["duplicate matrix id", { ...validPlan, matrix: [...validPlan.matrix, { ...registryRow }] }],
    ["invalid test ID", { ...validPlan, testMatrix: [{ ...selected, id: "invalid_id" }] }],
    ["nonboolean selection", { ...validPlan, hermesSelected: "false" }],
  ] as const;

  for (const [label, plan] of malformedPlans) {
    const generated = executeGenerateMatrixWithPlannerOutput(plan);
    expect(
      generated.result.status,
      `${label}: ${generated.result.stderr || generated.result.stdout}`,
    ).toBe(1);
    expect(generated.result.stderr).toContain(
      "::error::E2E planner returned an invalid output schema",
    );
    expect(generated.workflowOutput).toBe("");
  }
});

it("builds controller target matrices only from trusted runner mappings (#7031)", () => {
  const target = "ubuntu-repo-cloud-langchain-deepagents-code";

  const empty = executeTrustedControllerMatrix("");
  expect(empty.result.status, empty.result.stderr || empty.result.stdout).toBe(0);
  expect(empty.workflowOutput).toBe("matrix=[]\n");

  const approved = executeTrustedControllerMatrix(target);
  expect(approved.result.status, approved.result.stderr || approved.result.stdout).toBe(0);
  expect(parseSimpleOutput(approved.workflowOutput).matrix).toBe(
    JSON.stringify([{ id: target, runner: "ubuntu-latest", label: target }]),
  );

  const rejected = executeTrustedControllerMatrix("untrusted-target");
  expect(rejected.result.status).toBe(1);
  expect(rejected.result.stderr).toContain(
    "::error::PR E2E target is not approved by the trusted controller",
  );
  expect(rejected.workflowOutput).toBe("");
});

it("binds controller matrix IDs and runners to the trusted target selector (#7031)", () => {
  const target = "ubuntu-repo-cloud-langchain-deepagents-code";
  const validPlan = buildE2eWorkflowPlan({ jobs: "cloud-onboard", targets: target });
  const trustedControllerMatrix = JSON.stringify([
    { id: target, runner: "ubuntu-latest", label: target },
  ]);
  const options = {
    checkoutSha: "a".repeat(40),
    controllerMatrix: trustedControllerMatrix,
    jobs: "cloud-onboard",
    targets: target,
  };

  const matching = executeGenerateMatrixWithPlannerOutput(validPlan, options);
  expect(matching.result.status, matching.result.stderr || matching.result.stdout).toBe(0);

  const injectedWithoutSelection = executeGenerateMatrixWithPlannerOutput(validPlan, {
    ...options,
    controllerMatrix: "[]",
    targets: "",
  });
  expect(injectedWithoutSelection.result.status).toBe(1);
  expect(injectedWithoutSelection.result.stderr).toContain(
    "::error::E2E planner matrix does not match controller-selected targets",
  );

  const mismatchedPlan = {
    ...validPlan,
    matrix: validPlan.matrix.map((row) => ({ ...row, id: "ubuntu-repo-cloud-openclaw" })),
  };
  const mismatched = executeGenerateMatrixWithPlannerOutput(mismatchedPlan, options);
  expect(mismatched.result.status).toBe(1);
  expect(mismatched.result.stderr).toContain(
    "::error::E2E planner matrix does not match controller-selected targets",
  );

  const runnerInjectedPlan = {
    ...validPlan,
    matrix: validPlan.matrix.map((row) => ({ ...row, runner: "self-hosted" })),
  };
  const runnerInjected = executeGenerateMatrixWithPlannerOutput(runnerInjectedPlan, options);
  expect(runnerInjected.result.status).toBe(1);
  expect(runnerInjected.result.stderr).toContain(
    "::error::E2E planner matrix does not match controller-selected targets",
  );
  expect(runnerInjected.workflowOutput).toBe("");
});

it("requires the report-to-pr job to check out the trusted workflow revision", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  const workflow = readWorkflow() as {
    jobs: Record<
      string,
      { steps: Array<{ name?: string; uses?: string; with?: { ref?: string } }> }
    >;
  };
  const reportJob = workflow.jobs["report-to-pr"];
  requireFixture(Array.isArray(reportJob?.steps), "missing report-to-pr steps");
  reportJob.steps = reportJob.steps.filter((step) => !step.uses?.startsWith("actions/checkout@"));
  fs.writeFileSync(workflowPath, YAML.stringify(workflow));

  try {
    expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
      expect.arrayContaining([
        "report-to-pr must check out the trusted workflow revision before reporting",
      ]),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

it("rejects a report helper checkout pinned outside the trusted workflow revision", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  const workflow = readWorkflow() as {
    jobs: Record<string, { steps: Array<{ uses?: string; with?: { ref?: string } }> }>;
  };
  const reportJob = workflow.jobs["report-to-pr"];
  const checkout = reportJob?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
  requireFixture(checkout?.with !== undefined, "missing report-to-pr checkout");
  checkout!.with!.ref = "${{ inputs.checkout_sha }}";
  fs.writeFileSync(workflowPath, YAML.stringify(workflow));

  try {
    expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
      expect.arrayContaining([
        "report-to-pr must pin the report helper checkout to github.workflow_sha",
      ]),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

it("rejects a report-to-pr script that references the trusted helpers without invoking them", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  const workflow = readWorkflow() as {
    jobs: Record<string, { steps: Array<{ name?: string; with?: { script?: string } }> }>;
  };
  const reportStep = workflow.jobs["report-to-pr"]?.steps?.find(
    (step) => step.name === "Post E2E target results to PR",
  );
  requireFixture(reportStep?.with !== undefined, "missing report-to-pr script step");
  reportStep!.with!.script = [
    "const path = require('node:path');",
    "const { pathToFileURL } = require('node:url');",
    "const { resolveReportPr, loadReportJobs, renderE2eReport } = await import(",
    "  pathToFileURL(path.join(process.env.GITHUB_WORKSPACE, 'tools/e2e/report-e2e-results.mts')).href",
    ");",
    "const prNumber = 42;",
    "const report = { body: 'fake' };",
    "await github.rest.issues.createComment({",
    "  owner: context.repo.owner,",
    "  repo: context.repo.repo,",
    "  issue_number: prNumber,",
    "  body: report.body,",
    "});",
  ].join("\n");
  fs.writeFileSync(workflowPath, YAML.stringify(workflow));

  try {
    expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
      expect.arrayContaining([
        "step 'Post E2E target results to PR' run script must assign resolveReportPr's result before use",
        "step 'Post E2E target results to PR' run script must destructure loadReportJobs's result before use",
        "step 'Post E2E target results to PR' run script must assign renderE2eReport's result before use",
      ]),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

it("rejects a report-to-pr script that resolves the trusted helpers but posts a locally constructed comment", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  const workflow = readWorkflow() as {
    jobs: Record<string, { steps: Array<{ name?: string; with?: { script?: string } }> }>;
  };
  const reportStep = workflow.jobs["report-to-pr"]?.steps?.find(
    (step) => step.name === "Post E2E target results to PR",
  );
  requireFixture(reportStep?.with !== undefined, "missing report-to-pr script step");
  reportStep!.with!.script = [
    "const path = require('node:path');",
    "const { pathToFileURL } = require('node:url');",
    "const { resolveReportPr, loadReportJobs, renderE2eReport } = await import(",
    "  pathToFileURL(path.join(process.env.GITHUB_WORKSPACE, 'tools/e2e/report-e2e-results.mts')).href",
    ");",
    "const prNumber = await resolveReportPr({ github, context, core, env: process.env });",
    "const { apiJobs, loaded } = await loadReportJobs({ github, context, core });",
    "const report = renderE2eReport({ needs: {}, env: process.env, apiJobs, apiJobsLoaded: loaded, context });",
    "const decoyPrNumber = 42;",
    "const decoyReport = { body: 'fake' };",
    "await github.rest.issues.createComment({",
    "  owner: context.repo.owner,",
    "  repo: context.repo.repo,",
    "  issue_number: decoyPrNumber,",
    "  body: decoyReport.body,",
    "});",
  ].join("\n");
  fs.writeFileSync(workflowPath, YAML.stringify(workflow));

  try {
    expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
      expect.arrayContaining([
        "step 'Post E2E target results to PR' run script must pass resolveReportPr's result as the comment issue_number",
        "step 'Post E2E target results to PR' run script must pass renderE2eReport's result body as the comment body",
      ]),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

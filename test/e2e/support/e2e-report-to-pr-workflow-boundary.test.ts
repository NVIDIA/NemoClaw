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
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";
import { requireFixture } from "./require-fixture";

function readWorkflow(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(path.join(process.cwd(), ".github/workflows/e2e.yaml"), "utf-8"),
  ) as Record<string, unknown>;
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parameters: string[]
) => (...args: unknown[]) => Promise<void>;

function reportScript(): string {
  const workflow = readWorkflow() as {
    jobs: Record<string, { steps: Array<{ name?: string; with?: { script?: string } }> }>;
  };
  const step = workflow.jobs["report-to-pr"].steps.find(
    (candidate) => candidate.name === "Post E2E target results to PR",
  );
  expect(step?.with?.script).toEqual(expect.any(String));
  return String(step!.with!.script);
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

function executeGenerateMatrixWithPlannerOutput(plan: unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-planner-schema-"));
  const binDirectory = path.join(directory, "bin");
  const fakeNpx = path.join(binDirectory, "npx");
  const outputPath = path.join(directory, "github-output");
  fs.mkdirSync(binDirectory);
  fs.writeFileSync(
    fakeNpx,
    [
      "#!/usr/bin/env bash",
      '[[ "$#" -eq 2 && "$1" == "tsx" && "$2" == "tools/e2e/workflow-plan.mts" ]] || exit 97',
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
          FAKE_E2E_PLAN: JSON.stringify(plan),
          GITHUB_OUTPUT: outputPath,
          GITHUB_STEP_SUMMARY: path.join(directory, "summary.md"),
          JOBS: "",
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          TARGETS: "",
        },
        timeout: 30_000,
      }),
      workflowOutput: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "",
    };
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

type ApiJob = {
  completed_at?: string;
  conclusion: string | null;
  name: string;
  started_at?: string;
  status: string;
};

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

async function executeReport(options: {
  apiJobs?: ApiJob[];
  testMatrix?: CredentialFreeTestMatrixRow[];
  jobs?: string;
  needs?: Record<string, { result: string }>;
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
  const script = reportScript().replace(
    "const needs = ${{ toJSON(needs) }};",
    `const needs = ${JSON.stringify(needs)};`,
  );
  const createComment = vi.fn(async (_input: { body: string }) => undefined);
  const setFailed = vi.fn();
  const warning = vi.fn();
  const paginate = paginateError
    ? vi.fn(() => Promise.reject(paginateError))
    : vi.fn(async () => apiJobs);
  const github = {
    paginate,
    rest: {
      actions: { listJobsForWorkflowRun: Symbol("listJobsForWorkflowRun") },
      issues: { createComment },
      pulls: {
        get: vi.fn(async () => ({ data: { state: "open" } })),
        list: vi.fn(),
      },
    },
  };
  const context = {
    ref: "refs/heads/main",
    repo: { owner: "NVIDIA", repo: "NemoClaw" },
    runId: 123,
    serverUrl: "https://github.com",
  };
  const core = { info: vi.fn(), setFailed, warning };
  const processStub = {
    env: {
      EXPLICIT_ONLY_JOBS: "",
      TEST_MATRIX: JSON.stringify(testMatrix),
      JOB_PR_NUMBER: "42",
      JOB_TARGETS: "",
      JOBS: jobs,
    },
  };

  await new AsyncFunction("github", "context", "core", "process", script)(
    github,
    context,
    core,
    processStub,
  );

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

it("rejects report-to-pr PR number validation drift", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  const workflow = readWorkflow() as {
    jobs: Record<
      string,
      {
        steps: Array<{
          name?: string;
          with?: {
            script?: string;
          };
        }>;
      }
    >;
  };
  const reportStep = workflow.jobs["report-to-pr"].steps.find(
    (step) => step.name === "Post E2E target results to PR",
  );
  requireFixture(typeof reportStep?.with?.script === "string", "missing report-to-pr script");
  reportStep!.with!.script = String(reportStep!.with!.script)
    .replace(/\/\^\[1-9\]\[0-9\]\*\$\/\.test\(prNumberInput\)/, "prNumberInput.length > 0")
    .replace("Number(prNumberInput)", "Number.parseInt(prNumberInput, 10)")
    .replace("github.rest.pulls.get", "github.rest.issues.get");
  fs.writeFileSync(workflowPath, YAML.stringify(workflow));

  try {
    expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
      expect.arrayContaining([
        "step 'Post E2E target results to PR' run script must not parse JOB_PR_NUMBER with Number.parseInt",
        "step 'Post E2E target results to PR' run script must validate JOB_PR_NUMBER with an all-digits regex before parsing",
        "step 'Post E2E target results to PR' run script must verify JOB_PR_NUMBER identifies a pull request before commenting",
      ]),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
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

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";
import YAML from "yaml";
import { discoverExecutionProfileTests } from "../../../tools/e2e/execution-profile.mts";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";

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

type HermeticMatrixRow = {
  id: string;
  file: string;
  project: "e2e-live" | "integration";
};

type ApiJob = {
  conclusion: string | null;
  name: string;
  status: string;
};

const DEFAULT_HERMETIC_MATRIX: HermeticMatrixRow[] = [
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
  hermeticMatrix?: HermeticMatrixRow[];
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
    hermeticMatrix = DEFAULT_HERMETIC_MATRIX,
    jobs = hermeticMatrix.map(({ id }) => id).join(","),
    needs = {
      "generate-matrix": { result: "success" },
      hermetic: { result: "failure" },
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
      HERMETIC_MATRIX: JSON.stringify(hermeticMatrix),
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
  expect(reportStep?.with?.script).toEqual(expect.any(String));
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

it("reports matrix children by logical id without fabricating a missing child result", async () => {
  const { body, setFailed, warning } = await executeReport({
    apiJobs: [
      {
        conclusion: "success",
        name: "Hermetic E2E (alpha)",
        status: "completed",
      },
    ],
  });

  expect(setFailed).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith(
    "Missing per-test hermetic results for beta; reporting them as unknown.",
  );
  expect(body).toContain("| alpha | ✅ success |");
  expect(body).toContain("| beta | ❓ unknown |");
  expect(body).toContain("Some jobs failed");
  expect(body).toContain("Hermetic matrix aggregate: failure");
});

it("reports API lookup failures as unknown rather than copying the aggregate result", async () => {
  const { body, setFailed, warning } = await executeReport({
    hermeticMatrix: DEFAULT_HERMETIC_MATRIX.slice(0, 1),
    jobs: "alpha",
    needs: {
      "generate-matrix": { result: "success" },
      hermetic: { result: "success" },
    },
    paginateError: new Error("API unavailable"),
  });

  expect(setFailed).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith(
    "Could not load per-test hermetic results; reporting them as unknown: API unavailable",
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
        name: "Hermetic E2E (alpha)",
        status: "in_progress",
      },
    ],
    hermeticMatrix: DEFAULT_HERMETIC_MATRIX.slice(0, 1),
    jobs: "alpha",
    needs: {
      "generate-matrix": { result: "success" },
      hermetic: { result: "success" },
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
        name: "Hermetic E2E (alpha)",
        status: "completed",
      },
    ],
    hermeticMatrix: DEFAULT_HERMETIC_MATRIX.slice(0, 1),
    jobs: "alpha",
    needs: {
      "generate-matrix": { result: "success" },
      hermetic: { result: "failure" },
    },
  });

  expect(setFailed).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith(
    "Per-test hermetic conclusions (success) contradict aggregate failure; reporting child attribution as unknown.",
  );
  expect(body).toContain("Some jobs failed");
  expect(body).toContain("| alpha | ❓ unknown |");
  expect(body).not.toContain("| alpha | ✅ success |");
});

it("carries the generated planner matrix through the workflow output and PR report", async () => {
  const [selected] = discoverExecutionProfileTests();
  expect(selected).toBeDefined();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermetic-integration-"));
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
    const hermeticMatrix = JSON.parse(outputs.hermetic_matrix) as HermeticMatrixRow[];
    expect(hermeticMatrix).toEqual([selected]);

    const { body, setFailed } = await executeReport({
      apiJobs: [
        {
          conclusion: "success",
          name: `Hermetic E2E (${selected.id})`,
          status: "completed",
        },
      ],
      hermeticMatrix,
      jobs: selected.id,
      needs: {
        "generate-matrix": { result: "success" },
        hermetic: { result: "success" },
      },
    });

    expect(setFailed).not.toHaveBeenCalled();
    expect(body).toContain("All requested jobs passed");
    expect(body).toContain(`| ${selected.id} | ✅ success |`);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

it("fails closed when planner output violates the workflow schema", () => {
  const [selected] = discoverExecutionProfileTests();
  expect(selected).toBeDefined();
  const validPlan = buildE2eWorkflowPlan();
  const [registryRow] = validPlan.matrix;
  expect(registryRow).toBeDefined();
  const { explicitOnlyJobs: _omitted, ...missingField } = validPlan;
  const malformedPlans = [
    ["missing required field", missingField],
    ["duplicate matrix id", { ...validPlan, matrix: [...validPlan.matrix, { ...registryRow }] }],
    ["invalid hermetic id", { ...validPlan, hermeticMatrix: [{ ...selected, id: "invalid_id" }] }],
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

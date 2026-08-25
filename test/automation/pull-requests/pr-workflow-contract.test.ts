// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type CompositeAction,
  readYaml,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract";

type CiWorkflow = {
  "run-name"?: string;
  on?: { pull_request?: { paths?: string[]; types?: string[] } };
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob & { if?: string; needs?: string | string[] }>;
};

type InstallerHashAction = CompositeAction & {
  inputs?: Record<string, { required?: boolean }>;
};

type CodebaseGrowthGuardrailsWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

type PrekConfig = {
  default_stages?: string[];
  repos: Array<{
    hooks?: Array<{
      id: string;
      always_run?: boolean;
      entry?: string;
      files?: string;
      stages?: string[];
    }>;
  }>;
};

type PackageJson = {
  scripts: Record<string, string>;
};

type TypeScriptConfig = {
  include: string[];
};

const sharedActionPaths = {
  staticChecks: "./.github/actions/ci-static-checks",
  buildTypecheck: "./.github/actions/ci-build-typecheck",
  cliCoverageShard: "./.github/actions/ci-cli-coverage-shard",
  cliCoverageMerge: "./.github/actions/ci-cli-coverage-merge",
  pluginCoverage: "./.github/actions/ci-plugin-coverage",
  installerIntegration: "./.github/actions/ci-installer-integration",
} as const;

const trustedPrActionPaths = {
  staticChecks: "./.trusted-ci-actions/.github/actions/ci-static-checks",
  buildTypecheck: "./.trusted-ci-actions/.github/actions/ci-build-typecheck",
  cliCoverageShard: "./.trusted-ci-actions/.github/actions/ci-cli-coverage-shard",
  cliCoverageMerge: "./.trusted-ci-actions/.github/actions/ci-cli-coverage-merge",
  pluginCoverage: "./.trusted-ci-actions/.github/actions/ci-plugin-coverage",
  installerIntegration: "./.trusted-ci-actions/.github/actions/ci-installer-integration",
} as const;

const trustedCheckoutAction = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const trustedSetupNodeAction = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const trustedActionDirs = [
  ".github/actions/ci-static-checks",
  ".github/actions/ci-build-typecheck",
  ".github/actions/ci-cli-coverage-shard",
  ".github/actions/ci-cli-coverage-merge",
  ".github/actions/ci-plugin-coverage",
  ".github/actions/ci-installer-integration",
] as const;

const cliShardCount = "12";
const cliShardTimeoutMinutes = 30;

function stepRuns(jobOrAction: WorkflowJob | CompositeAction): string[] {
  const steps = "runs" in jobOrAction ? jobOrAction.runs.steps : (jobOrAction.steps ?? []);
  return steps.flatMap((step) => (step.run ? [step.run] : []));
}

function stepUses(job: WorkflowJob): string[] {
  return (job.steps ?? []).flatMap((step) => (step.uses ? [step.uses] : []));
}

function requiredStep(action: CompositeAction, stepName: string): WorkflowStep {
  const step = action.runs.steps.find((candidate) => candidate.name === stepName);
  if (!step) {
    throw new Error(`Missing shared action step: ${stepName}`);
  }
  return step;
}

function requiredStepIndex(action: CompositeAction, stepName: string): number {
  const stepIndex = action.runs.steps.findIndex((candidate) => candidate.name === stepName);
  if (stepIndex === -1) {
    throw new Error(`Missing shared action step: ${stepName}`);
  }
  return stepIndex;
}

function requiredWorkflowStep(job: WorkflowJob, stepName: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === stepName);
  if (!step) {
    throw new Error(`Missing workflow step: ${stepName}`);
  }
  return step;
}

function requiredWorkflowStepIndex(job: WorkflowJob, stepName: string): number {
  const stepIndex = job.steps?.findIndex((candidate) => candidate.name === stepName) ?? -1;
  if (stepIndex === -1) {
    throw new Error(`Missing workflow step: ${stepName}`);
  }
  return stepIndex;
}

function runWorkflowShellStep(
  step: WorkflowStep,
  env: Record<string, string>,
  cwd = process.cwd(),
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", ["-c", step.run ?? ""], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...step.env, ...env },
    timeout: 5_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

function workflowJob(
  id: unknown,
  name: unknown,
  conclusion: unknown,
  status: unknown = "completed",
): Record<string, unknown> {
  return { conclusion, id, name, status };
}

function workflowJobListing(
  jobs: Record<string, unknown>[],
  totalCount: unknown = jobs.length,
): string {
  return JSON.stringify({ jobs, total_count: totalCount });
}

function runWorkflowShellStepWithJobs(
  step: WorkflowStep,
  env: Record<string, string>,
  jobsResponse: string,
  ghExitCode = 0,
): { status: number | null; stdout: string; stderr: string } {
  const temp = mkdtempSync(join(tmpdir(), "nemoclaw-workflow-jobs-"));
  const fakeBin = join(temp, "bin");
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const expected = `api repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.RUN_ID}/attempts/${process.env.RUN_ATTEMPT}/jobs?per_page=100`;",
      'if (process.argv.slice(2).join(" ") !== expected) process.exit(64);',
      "const exitCode = Number(process.env.FAKE_GH_EXIT_CODE);",
      "if (exitCode !== 0) process.exit(exitCode);",
      'process.stdout.write(process.env.FAKE_GH_RESPONSE ?? "");',
    ].join("\n"),
    { mode: 0o755 },
  );
  try {
    return runWorkflowShellStep(step, {
      FAKE_GH_EXIT_CODE: String(ghExitCode),
      FAKE_GH_RESPONSE: jobsResponse,
      GH_TOKEN: "test-token",
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      RUN_ATTEMPT: "2",
      RUN_ID: "123",
      RUN_URL: "https://github.com/NVIDIA/NemoClaw/actions/runs/123",
      ...env,
    });
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
}

type LoggedPackageScript = {
  calls: string[][];
  stderr: string;
};

function runLoggedPackageScriptWithOutput(script: string): LoggedPackageScript {
  const temp = mkdtempSync(join(tmpdir(), "nemoclaw-package-script-"));
  const fakeBin = join(temp, "bin");
  const commandLog = join(temp, "commands.jsonl");
  mkdirSync(fakeBin);

  for (const command of ["npm", "npx", "tsx", "vitest"]) {
    writeFileSync(
      join(fakeBin, command),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(["${command}", ...process.argv.slice(2)]) + "\\n");`,
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  try {
    const result = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        COMMAND_LOG: commandLog,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    expect(result.status, `Package script failed: ${result.stderr}`).toBe(0);
    return {
      calls: readFileSync(commandLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
      stderr: result.stderr,
    };
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
}

function runLoggedPackageScript(script: string): string[][] {
  return runLoggedPackageScriptWithOutput(script).calls;
}

function codeFilterMatchesChangedPaths(workflow: CiWorkflow, paths: string[]): boolean {
  const filterStep = workflow.jobs.changes.steps?.find((step) => step.id === "filter");
  const quantifier = filterStep?.with?.["predicate-quantifier"];
  const filters = String(filterStep?.with?.filters ?? "");
  const patterns = filters
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).replace(/^['"]|['"]$/g, ""));

  const patternMatches = (path: string, pattern: string): boolean => {
    switch (pattern) {
      case "**":
        return true;
      case "!**/*.md":
        return !path.endsWith(".md");
      case "!docs/**":
        return !path.startsWith("docs/");
      default:
        throw new Error(`Unhandled PR workflow code filter pattern: ${pattern}`);
    }
  };

  return paths.some((path) => {
    if (quantifier === "every") {
      return patterns.every((pattern) => patternMatches(path, pattern));
    }
    if (quantifier === "some") {
      return patterns.some((pattern) => patternMatches(path, pattern));
    }
    throw new Error(`Unhandled PR workflow predicate quantifier: ${String(quantifier)}`);
  });
}

function installerHashTrustViolations(workflow: CiWorkflow): string[] {
  const steps = workflow.jobs["check-hash"]?.steps ?? [];
  const baseCheckout = steps.find(
    (step) => step.name === "Checkout base-trusted installer hash action",
  );
  const prCheck = steps.find(
    (step) => step.name === "Verify pull request installer hashes from base-trusted code",
  );
  const allowedExecutors = new Set([
    "./.trusted-installer-hash/.github/actions/ci-installer-hash-check",
    "./.github/actions/ci-installer-hash-check",
  ]);

  return [
    ...(baseCheckout ? [] : ["missing base-trusted installer hash checkout"]),
    ...(baseCheckout?.uses === trustedCheckoutAction
      ? []
      : ["base-trusted installer hash checkout must use the pinned checkout action"]),
    ...(baseCheckout?.with?.ref === "${{ github.event.pull_request.base.sha }}"
      ? []
      : ["base-trusted installer hash checkout must use the PR base SHA"]),
    ...(baseCheckout?.with?.path === ".trusted-installer-hash"
      ? []
      : ["base-trusted installer hash checkout must use the trusted action path"]),
    ...(prCheck?.if === "github.event_name == 'pull_request'" &&
    prCheck.uses === "./.trusted-installer-hash/.github/actions/ci-installer-hash-check"
      ? []
      : ["pull request installer hashes must use only the base-trusted action"]),
    ...steps.flatMap((step) => [
      ...(step.uses === "./.github/actions/ci-installer-hash-check" &&
      step.if !== "github.event_name != 'pull_request'"
        ? ["installer hash action from the latest PR commit must not execute for pull requests"]
        : []),
      ...(step.uses?.includes("ci-installer-hash-check") && !allowedExecutors.has(step.uses)
        ? [`unapproved installer hash executor: ${step.uses}`]
        : []),
    ]),
  ];
}

describe("pull request and main workflow contracts", () => {
  const prWorkflow = readYaml<CiWorkflow>(".github/workflows/pr.yaml");
  const mainWorkflow = readYaml<CiWorkflow>(".github/workflows/main.yaml");
  const dcoWorkflow = readYaml<CiWorkflow>(".github/workflows/dco-check.yaml");
  const installerHashWorkflow = readYaml<CiWorkflow>(".github/workflows/installer-hash-check.yaml");

  const installerHashAction = readYaml<InstallerHashAction>(
    ".github/actions/ci-installer-hash-check/action.yaml",
  );
  const prekConfig = readYaml<PrekConfig>(".pre-commit-config.yaml");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
  const cliTypeScriptConfig = JSON.parse(
    readFileSync("tsconfig.cli.json", "utf8"),
  ) as TypeScriptConfig;
  const sharedActions = {
    staticChecks: readYaml<CompositeAction>(".github/actions/ci-static-checks/action.yaml"),
    buildTypecheck: readYaml<CompositeAction>(".github/actions/ci-build-typecheck/action.yaml"),
    cliCoverageShard: readYaml<CompositeAction>(
      ".github/actions/ci-cli-coverage-shard/action.yaml",
    ),
    cliCoverageMerge: readYaml<CompositeAction>(
      ".github/actions/ci-cli-coverage-merge/action.yaml",
    ),
    pluginCoverage: readYaml<CompositeAction>(".github/actions/ci-plugin-coverage/action.yaml"),
    installerIntegration: readYaml<CompositeAction>(
      ".github/actions/ci-installer-integration/action.yaml",
    ),
  };

  it.each([
    ["pull_request", prWorkflow],
    ["main", mainWorkflow],
  ] as const)("keeps the %s CLI coverage shard budget aligned", (_workflowName, workflow) => {
    expect(workflow.jobs["cli-test-shards"]?.["timeout-minutes"]).toBe(
      cliShardTimeoutMinutes,
    );
  });

  // source-shape-contract: security -- PR base SHA action execution prevents pull-request code from authorizing installer hashes
  it("executes pull request installer hash checks only from the PR base SHA", () => {
    expect(installerHashTrustViolations(installerHashWorkflow)).toEqual([]);

    const headCheckout = structuredClone(installerHashWorkflow);
    requiredWorkflowStep(
      headCheckout.jobs["check-hash"],
      "Checkout base-trusted installer hash action",
    ).with = {
      ref: "${{ github.event.pull_request.head.sha }}",
      path: ".trusted-installer-hash",
    };

    const missingBaseCheckout = structuredClone(installerHashWorkflow);
    missingBaseCheckout.jobs["check-hash"].steps = missingBaseCheckout.jobs[
      "check-hash"
    ].steps?.filter((step) => step.name !== "Checkout base-trusted installer hash action");

    const mutableExecutor = structuredClone(installerHashWorkflow);
    requiredWorkflowStep(
      mutableExecutor.jobs["check-hash"],
      "Verify pull request installer hashes from base-trusted code",
    ).uses = "./.github/actions/ci-installer-hash-check";

    const bootstrapExecutor = structuredClone(installerHashWorkflow);
    bootstrapExecutor.jobs["check-hash"].steps?.push({
      name: "Run installer hash bootstrap",
      uses: "./.bootstrap-installer-hash/.github/actions/ci-installer-hash-check",
    });

    const prOnlyLocalExecutor = structuredClone(installerHashWorkflow);
    prOnlyLocalExecutor.jobs["check-hash"].steps?.push({
      name: "Run local installer hash action for pull requests",
      if: "github.event_name == 'pull_request'",
      uses: "./.github/actions/ci-installer-hash-check",
    });

    expect(installerHashTrustViolations(headCheckout)).toContain(
      "base-trusted installer hash checkout must use the PR base SHA",
    );
    expect(installerHashTrustViolations(missingBaseCheckout)).toContain(
      "missing base-trusted installer hash checkout",
    );
    expect(installerHashTrustViolations(mutableExecutor)).toContain(
      "pull request installer hashes must use only the base-trusted action",
    );
    expect(installerHashTrustViolations(bootstrapExecutor)).toContain(
      "unapproved installer hash executor: ./.bootstrap-installer-hash/.github/actions/ci-installer-hash-check",
    );

    expect(installerHashTrustViolations(prOnlyLocalExecutor)).toContain(
      "installer hash action from the latest PR commit must not execute for pull requests",
    );
  });

  it("validates CLI shard inputs before using them in shell commands", () => {
    const shardValidationStep = requiredStep(
      sharedActions.cliCoverageShard,
      "Validate shard inputs",
    );
    const mergeValidationStep = requiredStep(
      sharedActions.cliCoverageMerge,
      "Validate shard inputs",
    );
    const temp = mkdtempSync(join(tmpdir(), "nemoclaw-cli-shard-validation-"));
    const marker = join(temp, "injected");
    const shellPayload = `$(touch ${marker})`;
    const output = join(temp, "github-output");

    try {
      const validShard = runWorkflowShellStep(shardValidationStep, {
        CLI_SHARD: cliShardCount,
        CLI_SHARD_COUNT: cliShardCount,
        GITHUB_OUTPUT: output,
      });
      const invalidShard = runWorkflowShellStep(shardValidationStep, {
        CLI_SHARD: shellPayload,
        CLI_SHARD_COUNT: cliShardCount,
        GITHUB_OUTPUT: output,
      });
      const invalidRange = runWorkflowShellStep(shardValidationStep, {
        CLI_SHARD: "13",
        CLI_SHARD_COUNT: cliShardCount,
        GITHUB_OUTPUT: join(temp, "github-output"),
      });
      const invalidCount = runWorkflowShellStep(mergeValidationStep, {
        CLI_SHARD_COUNT: shellPayload,
      });

      expect(validShard.status).toBe(0);
      expect(readFileSync(output, "utf8")).toContain("upload_build_artifact=false");
      expect(invalidShard.status).not.toBe(0);
      expect(invalidShard.stdout).toContain("Invalid CLI shard");
      expect(invalidRange.status).not.toBe(0);
      expect(invalidRange.stdout).toContain("Invalid CLI shard range");
      expect(invalidCount.status).not.toBe(0);
      expect(invalidCount.stdout).toContain("Invalid CLI shard count");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });

  const coverageEntrypointCases = [
    {
      action: sharedActions.cliCoverageShard,
      step: "Build CLI for coverage shard",
      stem: "scripts/check-dist-sourcemaps",
    },
    {
      action: sharedActions.cliCoverageMerge,
      step: "Verify compiled CLI artifact",
      stem: "scripts/check-dist-sourcemaps",
    },
    {
      action: sharedActions.cliCoverageMerge,
      step: "Merge CLI coverage",
      stem: "scripts/check-coverage-ratchet",
    },
    {
      action: sharedActions.pluginCoverage,
      step: "Run plugin coverage",
      stem: "scripts/check-coverage-ratchet",
    },
  ] as const;
  const coverageEntrypointVariants = [
    {
      fixtureExtension: "mts",
      expectedEntrypointExtension: "mts",
      expectedStatus: 0,
    },
    {
      fixtureExtension: "missing",
      expectedEntrypointExtension: "mts",
      expectedStatus: 1,
    },
  ] as const;

  it.each(
    coverageEntrypointCases.flatMap((testCase) =>
      coverageEntrypointVariants.map((variant) => ({ testCase, variant })),
    ),
  )(
    "requires the migrated $testCase.stem.$variant.expectedEntrypointExtension entrypoint",
    ({ testCase, variant }) => {
      const temp = mkdtempSync(join(tmpdir(), "nemoclaw-coverage-entrypoint-"));
      const fakeBin = join(temp, "bin");
      mkdirSync(fakeBin);
      mkdirSync(join(temp, "dist"));
      mkdirSync(join(temp, "scripts"));
      writeFileSync(join(temp, "dist", ["nemoclaw", "js"].join(".")), "built\n");
      writeFileSync(join(fakeBin, "node"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(
        join(fakeBin, "npx"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'if [ "${1:-}" = "tsx" ] && [[ "${2:-}" == scripts/check-* ]]; then',
          '  test "${2}" = "${EXPECTED_ENTRYPOINT}"',
          '  test -f "${2}"',
          "fi",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(join(temp, `${testCase.stem}.${variant.fixtureExtension}`), "// fixture\n");

      try {
        const result = runWorkflowShellStep(
          requiredStep(testCase.action, testCase.step),
          {
            EXPECTED_ENTRYPOINT: `${testCase.stem}.${variant.expectedEntrypointExtension}`,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          },
          temp,
        );

        expect(result.status, result.stderr).toBe(variant.expectedStatus);
      } finally {
        rmSync(temp, { force: true, recursive: true });
      }
    },
  );

  it.each([
    ["pull_request", prWorkflow],
    ["main", mainWorkflow],
  ] as const)(
    "links every failed %s CLI shard and falls back when job metadata is unavailable",
    (workflowName, workflow) => {
      const runUrl = "https://github.com/NVIDIA/NemoClaw/actions/runs/123";
      const failedShards = workflowJobListing([
        workflowJob(101, "cli-test-shards (1)", "success"),
        workflowJob(102, "cli-test-shards (2)", "failure"),
        workflowJob(112, "cli-test-shards (12)", "cancelled"),
        workflowJob(109, "plugin-tests", "success"),
      ]);
      const malformedShards = workflowJobListing([
        workflowJob("not-a-number", "cli-test-shards (2)", "failure"),
      ]);
      const oversizedShards = workflowJobListing([
        workflowJob(9_007_199_254_740_992, "cli-test-shards (2)", "failure"),
      ]);

      const cliGate = requiredWorkflowStep(
        workflow.jobs["cli-tests"],
        "Verify CLI shards completed",
      );
      const failure = runWorkflowShellStepWithJobs(
        cliGate,
        { CLI_SHARD_RESULT: "failure" },
        failedShards,
      );
      const malformed = runWorkflowShellStepWithJobs(
        cliGate,
        { CLI_SHARD_RESULT: "failure" },
        malformedShards,
      );
      const oversized = runWorkflowShellStepWithJobs(
        cliGate,
        { CLI_SHARD_RESULT: "failure" },
        oversizedShards,
      );
      const unavailable = runWorkflowShellStepWithJobs(
        cliGate,
        { CLI_SHARD_RESULT: "cancelled" },
        "",
        1,
      );

      expect(failure.status, `${workflowName}: ${failure.stderr}`).not.toBe(0);
      expect(failure.stdout).toContain(`${runUrl}/job/102`);
      expect(failure.stdout).toContain(`${runUrl}/job/112`);
      expect(malformed.status).not.toBe(0);
      expect(malformed.stdout).toContain(`Details: ${runUrl}`);
      expect(malformed.stdout).not.toContain(`${runUrl}/job/`);
      expect(oversized.status).not.toBe(0);
      expect(oversized.stdout).toContain(`Details: ${runUrl}`);
      expect(oversized.stdout).not.toContain(`${runUrl}/job/`);
      expect(unavailable.status).not.toBe(0);
      expect(unavailable.stdout).toContain(`Expected success, got cancelled. Details: ${runUrl}`);
    },
  );

  it("accepts successful aggregate checks and rejects failed required lanes", () => {
    const prChecks = prWorkflow.jobs.checks;
    const mainChecks = mainWorkflow.jobs.checks;
    const prGate = requiredWorkflowStep(prChecks, "Verify required PR checks");
    const mainGate = requiredWorkflowStep(mainChecks, "Verify required main checks");
    const successfulCode = {
      BUILD_TYPECHECK_RESULT: "success",
      CHANGES_RESULT: "success",
      CI_REQUIRED: "true",
      CLI_TESTS_RESULT: "success",
      CODE_CHANGED: "true",
      DOCS_ONLY_RESULT: "skipped",
      INSTALLER_INTEGRATION_RESULT: "success",
      PLUGIN_TESTS_RESULT: "success",
      REVIEWED_NPM_AUDIT_RESULT: "success",
      STATIC_RESULT: "success",
      WECHAT_RUNTIME_AUDIT_RESULT: "success",
    };
    const successfulMain = {
      BUILD_TYPECHECK_RESULT: "success",
      CLI_TESTS_RESULT: "success",
      INSTALLER_INTEGRATION_RESULT: "success",
      PLUGIN_TESTS_RESULT: "success",
      REVIEWED_NPM_AUDIT_RESULT: "success",
      REAL_OPENCLAW_DIST_HARNESS_RESULT: "success",
      SANDBOX_IMAGES_E2E_RESULT: "success",
      STATIC_RESULT: "success",
      WECHAT_RUNTIME_AUDIT_RESULT: "success",
    };

    const codeSuccess = runWorkflowShellStep(prGate, successfulCode);
    const codeFailure = runWorkflowShellStepWithJobs(
      prGate,
      {
        ...successfulCode,
        PLUGIN_TESTS_RESULT: "cancelled",
        STATIC_RESULT: "failure",
      },
      workflowJobListing([
        workflowJob(201, "static-checks", "failure"),
        workflowJob(202, "plugin-tests", "cancelled"),
      ]),
    );
    const docsOnlySuccess = runWorkflowShellStep(prGate, {
      ...successfulCode,
      BUILD_TYPECHECK_RESULT: "skipped",
      CLI_TESTS_RESULT: "skipped",
      CODE_CHANGED: "false",
      DOCS_ONLY_RESULT: "success",
      INSTALLER_INTEGRATION_RESULT: "skipped",
      PLUGIN_TESTS_RESULT: "skipped",
      REVIEWED_NPM_AUDIT_RESULT: "skipped",
      STATIC_RESULT: "skipped",
      WECHAT_RUNTIME_AUDIT_RESULT: "skipped",
    });
    const mainSuccess = runWorkflowShellStep(mainGate, successfulMain);
    const mainFailure = runWorkflowShellStepWithJobs(
      mainGate,
      {
        ...successfulMain,
        SANDBOX_IMAGES_E2E_RESULT: "failure",
      },
      workflowJobListing([workflowJob(302, "sandbox-images-and-e2e", "failure")]),
    );
    const malformedFailure = runWorkflowShellStepWithJobs(
      prGate,
      { ...successfulCode, STATIC_RESULT: "failure" },
      workflowJobListing([workflowJob("invalid", "static-checks", "failure")]),
    );
    const oversizedFailure = runWorkflowShellStepWithJobs(
      prGate,
      { ...successfulCode, STATIC_RESULT: "failure" },
      workflowJobListing([workflowJob(9_007_199_254_740_992, "static-checks", "failure")]),
    );

    expect(codeSuccess.status).toBe(0);
    expect(codeFailure.status).not.toBe(0);
    expect(codeFailure.stdout).toContain("static-checks failed");
    expect(codeFailure.stdout).toContain(
      "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/201",
    );
    expect(codeFailure.stdout).toContain("plugin-tests failed");
    expect(codeFailure.stdout).toContain(
      "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/202",
    );
    expect(docsOnlySuccess.status).toBe(0);
    expect(mainSuccess.status).toBe(0);
    expect(mainFailure.status).not.toBe(0);
    expect(mainFailure.stdout).toContain("sandbox-images-and-e2e failed");
    expect(mainFailure.stdout).toContain(
      "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/302",
    );
    expect(malformedFailure.status).not.toBe(0);
    expect(malformedFailure.stdout).toContain(
      "Details: https://github.com/NVIDIA/NemoClaw/actions/runs/123",
    );
    expect(malformedFailure.stdout).not.toContain("actions/runs/123/job/");
    expect(oversizedFailure.status).not.toBe(0);
    expect(oversizedFailure.stdout).toContain(
      "Details: https://github.com/NVIDIA/NemoClaw/actions/runs/123",
    );
    expect(oversizedFailure.stdout).not.toContain("actions/runs/123/job/");
  });
});

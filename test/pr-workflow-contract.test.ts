// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readYaml,
  type CompositeAction,
  type WorkflowJob,
  type WorkflowStep,
} from "./helpers/e2e-workflow-contract";

type CiWorkflow = {
  jobs: Record<string, WorkflowJob & { if?: string; needs?: string | string[] }>;
};

type CodebaseGrowthGuardrailsWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

const sharedActionPaths = {
  staticChecks: "./.github/actions/ci-static-checks",
  buildTypecheck: "./.github/actions/ci-build-typecheck",
  cliCoverageShard: "./.github/actions/ci-cli-coverage-shard",
  cliCoverageMerge: "./.github/actions/ci-cli-coverage-merge",
  pluginCoverage: "./.github/actions/ci-plugin-coverage",
} as const;

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

function requiredWorkflowStep(job: WorkflowJob, stepName: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === stepName);
  if (!step) {
    throw new Error(`Missing workflow step: ${stepName}`);
  }
  return step;
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

describe("pull request and main workflow contracts", () => {
  const prWorkflow = readYaml<CiWorkflow>(".github/workflows/pr.yaml");
  const mainWorkflow = readYaml<CiWorkflow>(".github/workflows/main.yaml");
  const sharedActions = {
    staticChecks: readYaml<CompositeAction>(
      ".github/actions/ci-static-checks/action.yaml",
    ),
    buildTypecheck: readYaml<CompositeAction>(
      ".github/actions/ci-build-typecheck/action.yaml",
    ),
    cliCoverageShard: readYaml<CompositeAction>(
      ".github/actions/ci-cli-coverage-shard/action.yaml",
    ),
    cliCoverageMerge: readYaml<CompositeAction>(
      ".github/actions/ci-cli-coverage-merge/action.yaml",
    ),
    pluginCoverage: readYaml<CompositeAction>(
      ".github/actions/ci-plugin-coverage/action.yaml",
    ),
  };

  it("routes only code-changing PRs through the code-check path", () => {
    const filterStep = prWorkflow.jobs.changes.steps?.find(
      (step) => step.id === "filter",
    );

    expect(filterStep?.uses).toContain("dorny/paths-filter");
    expect(filterStep?.with?.["predicate-quantifier"]).toBe("every");
    expect(filterStep?.with?.filters).toContain("code:");
    expect(filterStep?.with?.filters).toContain("!**/*.md");
    expect(filterStep?.with?.filters).toContain("!docs/**");

    expect(
      codeFilterMatchesChangedPaths(prWorkflow, ["docs/get-started/prerequisites.mdx"]),
    ).toBe(false);
    expect(codeFilterMatchesChangedPaths(prWorkflow, ["README.md"])).toBe(false);
    expect(codeFilterMatchesChangedPaths(prWorkflow, ["src/lib/runner.ts"])).toBe(
      true,
    );
    expect(
      codeFilterMatchesChangedPaths(prWorkflow, [
        "docs/get-started/prerequisites.mdx",
        "src/lib/runner.ts",
      ]),
    ).toBe(true);
  });

  it("reuses the same shared CI actions in PR and main workflows", () => {
    for (const [jobName, actionPath] of [
      ["static-checks", sharedActionPaths.staticChecks],
      ["build-typecheck", sharedActionPaths.buildTypecheck],
      ["cli-test-shards", sharedActionPaths.cliCoverageShard],
      ["cli-tests", sharedActionPaths.cliCoverageMerge],
      ["plugin-tests", sharedActionPaths.pluginCoverage],
    ] as const) {
      expect(stepUses(prWorkflow.jobs[jobName]), `PR ${jobName}`).toContain(
        actionPath,
      );
      expect(stepUses(mainWorkflow.jobs[jobName]), `main ${jobName}`).toContain(
        actionPath,
      );
    }

    expect(stepUses(mainWorkflow.jobs.checks)).not.toContain(
      "./.github/actions/basic-checks",
    );
    expect(prWorkflow.jobs["cli-test-shards"].strategy?.["fail-fast"]).toBe(false);
    expect(mainWorkflow.jobs["cli-test-shards"].strategy?.["fail-fast"]).toBe(false);
    expect(prWorkflow.jobs["cli-test-shards"].strategy?.matrix?.shard).toEqual([
      1, 2, 3,
    ]);
    expect(mainWorkflow.jobs["cli-test-shards"].strategy?.matrix?.shard).toEqual([
      1, 2, 3,
    ]);
    expect(
      requiredWorkflowStep(prWorkflow.jobs["cli-test-shards"], "Run CLI coverage shard")
        .with?.shard,
    ).toBe("${{ matrix.shard }}");
    expect(
      requiredWorkflowStep(mainWorkflow.jobs["cli-test-shards"], "Run CLI coverage shard")
        .with?.shard,
    ).toBe("${{ matrix.shard }}");
  });

  it("preserves the shared static, build, and coverage gates", () => {
    const staticRuns = stepRuns(sharedActions.staticChecks);
    const staticPrekRun = staticRuns.find((run) =>
      run.includes("npx prek run --all-files --stage pre-push"),
    );
    const buildRuns = stepRuns(sharedActions.buildTypecheck);
    const cliShardRuns = stepRuns(sharedActions.cliCoverageShard).join("\n");
    const cliMergeRuns = stepRuns(sharedActions.cliCoverageMerge).join("\n");
    const pluginRuns = stepRuns(sharedActions.pluginCoverage).join("\n");

    expect(staticRuns).toContain("npm install --ignore-scripts");
    expect(staticRuns).toContain("npm run validate:configs");
    expect(staticPrekRun).toContain("npx prek run --all-files --stage pre-push");
    for (const skippedHook of [
      "tsc-plugin",
      "tsc-js",
      "tsc-cli",
      "version-tag-sync",
      "test-cli",
      "test-plugin",
      "source-shape-test-budget",
      "test-file-size-budget",
      "test-skills-yaml",
    ]) {
      expect(staticPrekRun).toContain(`--skip ${skippedHook}`);
    }
    expect(staticRuns).toContain("npm run source-shape:check");
    expect(staticRuns).toContain("npm run test-size:check");
    expect(staticRuns).toContain("npx vitest run test/skills-frontmatter.test.ts");
    expect(staticRuns).toContain("python3 scripts/generate-platform-docs.py --check");

    expect(buildRuns.join("\n")).toContain("cd nemoclaw && npm install --ignore-scripts");
    expect(buildRuns).toContain("cd nemoclaw && npm run build");
    expect(buildRuns).toContain("npm run build:cli");
    expect(buildRuns).toContain("npm run typecheck:cli");
    expect(buildRuns).toContain("cd nemoclaw && npx tsc --noEmit --incremental");
    expect(buildRuns).toContain("npx tsc -p jsconfig.json");
    expect(buildRuns).toContain("bash scripts/check-version-tag-sync.sh");

    expect(cliShardRuns).toContain("cd nemoclaw && npm run build");
    expect(cliShardRuns).toContain("npm run build:cli");
    expect(cliShardRuns).toContain("npx tsx scripts/check-dist-sourcemaps.ts dist");
    expect(cliShardRuns).toContain("npx vitest run --project cli");
    expect(cliShardRuns).toContain("--shard=${{ inputs.shard }}/${{ inputs.shard-count }}");
    expect(cliShardRuns).toContain("--reporter=github-actions");
    expect(cliShardRuns).toContain("--reporter=blob");
    expect(cliShardRuns).toContain(
      "--outputFile.blob=.vitest-reports/blob-${{ inputs.shard }}-${{ inputs.shard-count }}.json",
    );
    expect(cliShardRuns).toContain("--coverage.reportsDirectory=coverage/cli/shard-${{ inputs.shard }}");
    expect(cliShardRuns).not.toContain("scripts/check-coverage-ratchet.ts");

    expect(cliMergeRuns).toContain("npm run build:cli");
    expect(cliMergeRuns).toContain("npx tsx scripts/check-dist-sourcemaps.ts dist");
    expect(cliMergeRuns).toContain(
      'blob=".vitest-reports/blob-${shard}-${{ inputs.shard-count }}.json"',
    );
    expect(cliMergeRuns).toContain(
      "find .vitest-reports -maxdepth 1 -type f -name 'blob-*-${{ inputs.shard-count }}.json'",
    );
    expect(cliMergeRuns).toContain("npx vitest --mergeReports .vitest-reports");
    expect(cliMergeRuns).toContain("--reporter=json");
    expect(cliMergeRuns).toContain(
      "--outputFile.json=coverage/cli/vitest-results.json",
    );
    expect(cliMergeRuns).toContain("--coverage.reportsDirectory=coverage/cli");
    expect(cliMergeRuns).toContain(
      'scripts/check-coverage-ratchet.ts coverage/cli/coverage-summary.json ci/coverage-threshold-cli.json "CLI coverage"',
    );

    expect(pluginRuns).toContain("npx vitest run --project plugin");
    expect(pluginRuns).toContain(
      'scripts/check-coverage-ratchet.ts coverage/plugin/coverage-summary.json ci/coverage-threshold-plugin.json "Plugin coverage"',
    );
  });

  it("keeps the trusted test-size guard closed around budget policy changes", () => {
    const growthGuardrails = readYaml<CodebaseGrowthGuardrailsWorkflow>(
      ".github/workflows/codebase-growth-guardrails.yaml",
    );
    const guardRun = stepRuns(growthGuardrails.jobs["codebase-growth-guardrails"]).join(
      "\n",
    );

    expect(guardRun).toContain("HEAD_REPO");
    expect(guardRun).toContain("HEAD_SHA");
    expect(guardRun).not.toContain(".raw_url");
    expect(guardRun).toContain("previous_filename");
    expect(guardRun).toContain("budgetChanged");
    expect(guardRun).toContain(
      "has a legacy budget but no matching test file at the PR head",
    );
  });

  it("uploads CLI Vitest JSON results for timing analysis", () => {
    const uploadStep = requiredStep(
      sharedActions.cliCoverageMerge,
      "Upload CLI Vitest timing report",
    );

    expect(uploadStep.if).toBe("always()");
    expect(uploadStep.uses).toContain("actions/upload-artifact@");
    expect(uploadStep.with?.name).toBe("cli-vitest-results");
    expect(uploadStep.with?.path).toBe("coverage/cli/vitest-results.json");
    expect(uploadStep.with?.["if-no-files-found"]).toBe("warn");
    expect(uploadStep.with?.["retention-days"]).toBe(14);
  });

  it("runs CLI coverage in shards and merges coverage before ratcheting", () => {
    const shardUploadStep = requiredStep(
      sharedActions.cliCoverageShard,
      "Upload CLI shard blob report",
    );
    const downloadStep = requiredStep(
      sharedActions.cliCoverageMerge,
      "Download CLI shard blob reports",
    );
    const verifyRun = requiredStep(
      sharedActions.cliCoverageMerge,
      "Verify CLI shard blob reports",
    ).run;

    expect(shardUploadStep.if).toBe("always()");
    expect(shardUploadStep.uses).toContain("actions/upload-artifact@");
    expect(shardUploadStep.with?.name).toBe("cli-blob-report-${{ inputs.shard }}");
    expect(shardUploadStep.with?.path).toBe(
      ".vitest-reports/blob-${{ inputs.shard }}-${{ inputs.shard-count }}.json",
    );
    expect(shardUploadStep.with?.["if-no-files-found"]).toBe("error");
    expect(shardUploadStep.with?.["retention-days"]).toBe(1);

    expect(downloadStep.uses).toContain("actions/download-artifact@");
    expect(downloadStep.with?.pattern).toBe("cli-blob-report-*");
    expect(downloadStep.with?.path).toBe(".vitest-reports");
    expect(downloadStep.with?.["merge-multiple"]).toBe(true);

    expect(verifyRun).toContain('seq 1 "${{ inputs.shard-count }}"');
    expect(verifyRun).toContain('[ ! -s "$blob" ]');
    expect(verifyRun).toContain("Expected ${{ inputs.shard-count }} blob reports");
    expect(stepRuns(sharedActions.cliCoverageMerge).join("\n")).toContain(
      'scripts/check-coverage-ratchet.ts coverage/cli/coverage-summary.json ci/coverage-threshold-cli.json "CLI coverage"',
    );
  });

  it("keeps final aggregate checks for PR and main workflows", () => {
    const prChecks = prWorkflow.jobs.checks;
    const prChecksRun = stepRuns(prChecks).join("\n");
    const mainChecks = mainWorkflow.jobs.checks;
    const mainChecksRun = stepRuns(mainChecks).join("\n");

    expect(prChecks.if).toBe("always()");
    expect(prChecks.needs).toEqual([
      "changes",
      "docs-only-checks",
      "static-checks",
      "build-typecheck",
      "cli-tests",
      "plugin-tests",
      "test-e2e-ollama-proxy",
    ]);
    expect(prWorkflow.jobs["cli-tests"].needs).toEqual(["changes", "cli-test-shards"]);

    for (const jobName of [
      "changes",
      "static-checks",
      "build-typecheck",
      "cli-tests",
      "plugin-tests",
      "test-e2e-ollama-proxy",
    ]) {
      expect(prChecksRun).toContain(`require_success "${jobName}"`);
    }
    expect(prChecksRun).toContain('require_success "docs-only-checks"');

    expect(mainChecks.if).toBe("always()");
    expect(mainChecks.needs).toEqual([
      "static-checks",
      "build-typecheck",
      "cli-tests",
      "plugin-tests",
      "test-e2e-ollama-proxy",
    ]);
    expect(mainWorkflow.jobs["cli-tests"].needs).toBe("cli-test-shards");
    for (const jobName of [
      "static-checks",
      "build-typecheck",
      "cli-tests",
      "plugin-tests",
      "test-e2e-ollama-proxy",
    ]) {
      expect(mainChecksRun).toContain(`require_success "${jobName}"`);
    }
    expect(mainWorkflow.jobs["sandbox-images-and-e2e"].needs).toBe("checks");
  });

  it("does not run npm lifecycle scripts during CI dependency installs", () => {
    for (const [actionName, action] of Object.entries(sharedActions)) {
      const installRuns = stepRuns(action).filter((run) => run.includes("npm install"));

      expect(installRuns.length, `${actionName} install steps`).toBeGreaterThan(0);
      for (const run of installRuns) {
        for (const line of run.split("\n").map((candidate) => candidate.trim())) {
          if (line.includes("npm install")) {
            expect(line, `${actionName} install command`).toContain("--ignore-scripts");
          }
        }
      }
    }

    const docsOnlyInstall = stepRuns(prWorkflow.jobs["docs-only-checks"]).find((run) =>
      run.includes("npm install"),
    );
    expect(docsOnlyInstall).toBe("npm install --ignore-scripts");
  });

  it("does not persist checkout credentials in PR or main jobs", () => {
    for (const [workflowName, workflow] of [
      ["pull_request", prWorkflow],
      ["main", mainWorkflow],
    ] as const) {
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          if (!step.uses?.startsWith("actions/checkout@")) {
            continue;
          }

          expect(step.with?.["persist-credentials"], `${workflowName} ${jobName}`).toBe(
            false,
          );
        }
      }
    }
  });
});

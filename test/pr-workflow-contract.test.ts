// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readYaml,
  type CompositeAction,
  type WorkflowJob,
} from "./helpers/e2e-workflow-contract";

type PullRequestWorkflow = {
  jobs: Record<string, WorkflowJob & { if?: string; needs?: string | string[] }>;
};

type CodebaseGrowthGuardrailsWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

function stepRuns(job: WorkflowJob): string[] {
  return (job.steps ?? []).flatMap((step) => (step.run ? [step.run] : []));
}

function requiredRun(action: CompositeAction, stepName: string): string {
  const run = action.runs.steps.find((step) => step.name === stepName)?.run;
  if (!run) {
    throw new Error(`Missing basic-checks step: ${stepName}`);
  }
  return run;
}

function codeFilterMatchesChangedPaths(
  workflow: PullRequestWorkflow,
  paths: string[],
): boolean {
  const filterStep = workflow.jobs.changes.steps?.find(
    (step) => step.id === "filter",
  );
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

describe("pull request workflow contract", () => {
  const workflow = readYaml<PullRequestWorkflow>(".github/workflows/pr.yaml");

  it("routes only code-changing PRs through the code-check path", () => {
    const filterStep = workflow.jobs.changes.steps?.find(
      (step) => step.id === "filter",
    );

    expect(filterStep?.uses).toContain("dorny/paths-filter");
    expect(filterStep?.with?.["predicate-quantifier"]).toBe("every");
    expect(filterStep?.with?.filters).toContain("code:");
    expect(filterStep?.with?.filters).toContain("!**/*.md");
    expect(filterStep?.with?.filters).toContain("!docs/**");

    expect(codeFilterMatchesChangedPaths(workflow, ["docs/get-started/prerequisites.mdx"])).toBe(
      false,
    );
    expect(codeFilterMatchesChangedPaths(workflow, ["README.md"])).toBe(false);
    expect(codeFilterMatchesChangedPaths(workflow, ["src/lib/runner.ts"])).toBe(true);
    expect(
      codeFilterMatchesChangedPaths(workflow, [
        "docs/get-started/prerequisites.mdx",
        "src/lib/runner.ts",
      ]),
    ).toBe(true);
  });

  it("preserves the basic-checks gates for code PRs", () => {
    const basicChecks = readYaml<CompositeAction>(".github/actions/basic-checks/action.yaml");
    const staticRuns = stepRuns(workflow.jobs["static-checks"]);
    const buildRuns = stepRuns(workflow.jobs["build-typecheck"]);
    const cliShardRun = stepRuns(workflow.jobs["cli-test-shards"]).join("\n");
    const cliTestRun = stepRuns(workflow.jobs["cli-tests"]).join("\n");
    const pluginTestRun = stepRuns(workflow.jobs["plugin-tests"]).join("\n");
    const staticPrekRun = staticRuns.find((run) =>
      run.includes("npx prek run --all-files --stage pre-push"),
    );

    expect(staticRuns).toContain(requiredRun(basicChecks, "Install hadolint"));
    expect(buildRuns).toContain(requiredRun(basicChecks, "Build TypeScript plugin"));
    expect(buildRuns).toContain(requiredRun(basicChecks, "Build CLI TypeScript modules"));
    expect(buildRuns).toContain(requiredRun(basicChecks, "Typecheck CLI + tests (strict)"));
    expect(staticRuns).toContain(requiredRun(basicChecks, "Validate config schemas"));
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

    expect(buildRuns).toContain("cd nemoclaw && npx tsc --noEmit --incremental");
    expect(buildRuns).toContain("npx tsc -p jsconfig.json");
    expect(buildRuns).toContain("bash scripts/check-version-tag-sync.sh");
    expect(cliShardRun).toContain("cd nemoclaw && npm run build");
    expect(cliShardRun).toContain("npm run build:cli");
    expect(cliShardRun).toContain("npx tsx scripts/check-dist-sourcemaps.ts dist");
    expect(cliShardRun).toContain("npx vitest run --project cli");
    expect(cliShardRun).toContain("--shard=${{ matrix.shard }}/3");
    expect(cliShardRun).toContain("--reporter=github-actions");
    expect(cliShardRun).toContain("--reporter=blob");
    expect(cliShardRun).toContain(
      "--outputFile.blob=.vitest-reports/blob-${{ matrix.shard }}-3.json",
    );
    expect(cliShardRun).toContain("--coverage.reportsDirectory=coverage/cli/shard-${{ matrix.shard }}");
    expect(cliShardRun).not.toContain("scripts/check-coverage-ratchet.ts");
    expect(cliTestRun).toContain("npm run build:cli");
    expect(cliTestRun).toContain("npx tsx scripts/check-dist-sourcemaps.ts dist");
    expect(cliTestRun).toContain("npx vitest --mergeReports .vitest-reports");
    expect(cliTestRun).toContain("--reporter=json");
    expect(cliTestRun).toContain(
      "--outputFile.json=coverage/cli/vitest-results.json",
    );
    expect(cliTestRun).toContain("--coverage.reportsDirectory=coverage/cli");
    expect(cliTestRun).toContain("npx tsx scripts/check-coverage-ratchet.ts");
    expect(pluginTestRun).toContain("npx vitest run --project plugin");
    expect(pluginTestRun).toContain("npx tsx scripts/check-coverage-ratchet.ts");
    expect(staticRuns).toContain("npm run source-shape:check");
    expect(staticRuns).toContain("npm run test-size:check");
    expect(staticRuns).toContain("npx vitest run test/skills-frontmatter.test.ts");
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
    const uploadStep = workflow.jobs["cli-tests"].steps?.find(
      (step) => step.name === "Upload CLI Vitest timing report",
    );

    expect(uploadStep?.if).toBe("always()");
    expect(uploadStep?.uses).toContain("actions/upload-artifact@");
    expect(uploadStep?.with?.name).toBe("cli-vitest-results");
    expect(uploadStep?.with?.path).toBe("coverage/cli/vitest-results.json");
    expect(uploadStep?.with?.["if-no-files-found"]).toBe("warn");
    expect(uploadStep?.with?.["retention-days"]).toBe(14);
  });

  it("runs CLI coverage in shards and merges coverage before ratcheting", () => {
    const shardJob = workflow.jobs["cli-test-shards"];
    const mergeJob = workflow.jobs["cli-tests"];
    const shardRuns = stepRuns(shardJob).join("\n");
    const mergeRuns = stepRuns(mergeJob).join("\n");
    const shardUploadStep = shardJob.steps?.find(
      (step) => step.name === "Upload CLI shard blob report",
    );
    const downloadStep = mergeJob.steps?.find(
      (step) => step.name === "Download CLI shard blob reports",
    );
    const verifyStep = mergeJob.steps?.find(
      (step) => step.name === "Verify CLI shard blob reports",
    );
    const verifyRun = verifyStep?.run ?? "";

    expect(shardJob.needs).toBe("changes");
    expect(shardJob.if).toBe("needs.changes.outputs.code == 'true'");
    expect(shardJob.strategy?.["fail-fast"]).toBe(false);
    expect(shardJob.strategy?.matrix?.shard).toEqual([1, 2, 3]);
    expect(shardRuns).toContain("--shard=${{ matrix.shard }}/3");
    expect(shardRuns).toContain("--reporter=blob");
    expect(shardRuns).toContain(
      "--outputFile.blob=.vitest-reports/blob-${{ matrix.shard }}-3.json",
    );
    expect(shardRuns).toContain("--coverage");
    expect(shardRuns).not.toContain("--outputFile.json=coverage/cli/vitest-results.json");
    expect(shardRuns).not.toContain("scripts/check-coverage-ratchet.ts");

    expect(shardUploadStep?.if).toBe("always()");
    expect(shardUploadStep?.uses).toContain("actions/upload-artifact@");
    expect(shardUploadStep?.with?.name).toBe("cli-blob-report-${{ matrix.shard }}");
    expect(shardUploadStep?.with?.path).toBe(
      ".vitest-reports/blob-${{ matrix.shard }}-3.json",
    );
    expect(shardUploadStep?.with?.["if-no-files-found"]).toBe("error");
    expect(shardUploadStep?.with?.["retention-days"]).toBe(1);

    expect(mergeJob.needs).toEqual(["changes", "cli-test-shards"]);
    expect(mergeJob.if).toBe("${{ always() && needs.changes.outputs.code == 'true' }}");
    expect(mergeRuns).toContain("CLI_SHARD_RESULT");
    expect(verifyRun).toContain("for shard in 1 2 3");
    expect(verifyRun).toContain('blob=".vitest-reports/blob-${shard}-3.json"');
    expect(verifyRun).toContain('[ ! -s "$blob" ]');
    expect(verifyRun).toContain(
      "find .vitest-reports -maxdepth 1 -type f -name 'blob-*-3.json'",
    );
    expect(verifyRun).toContain("Expected 3 blob reports");
    expect(mergeRuns).toContain("npx vitest --mergeReports .vitest-reports");
    expect(mergeRuns).toContain("--outputFile.json=coverage/cli/vitest-results.json");
    expect(mergeRuns).toContain("--coverage.reportsDirectory=coverage/cli");
    expect(mergeRuns).toContain(
      'scripts/check-coverage-ratchet.ts coverage/cli/coverage-summary.json ci/coverage-threshold-cli.json "CLI coverage"',
    );

    expect(downloadStep?.uses).toContain("actions/download-artifact@");
    expect(downloadStep?.with?.pattern).toBe("cli-blob-report-*");
    expect(downloadStep?.with?.path).toBe(".vitest-reports");
    expect(downloadStep?.with?.["merge-multiple"]).toBe(true);
  });

  it("keeps the final checks job as the branch-protection aggregate", () => {
    const checks = workflow.jobs.checks;
    const checksRun = stepRuns(checks).join("\n");

    expect(checks.if).toBe("always()");
    expect(checks.needs).toEqual([
      "changes",
      "docs-only-checks",
      "static-checks",
      "build-typecheck",
      "cli-tests",
      "plugin-tests",
      "test-e2e-ollama-proxy",
    ]);
    expect(workflow.jobs["cli-tests"].needs).toContain("cli-test-shards");

    for (const jobName of [
      "changes",
      "static-checks",
      "build-typecheck",
      "cli-tests",
      "plugin-tests",
      "test-e2e-ollama-proxy",
    ]) {
      expect(checksRun).toContain(`require_success "${jobName}"`);
    }

    expect(checksRun).toContain('require_success "docs-only-checks"');
  });

  it("does not run npm lifecycle scripts during pull_request dependency installs", () => {
    for (const jobName of ["build-typecheck", "cli-test-shards", "plugin-tests"]) {
      const installRun = stepRuns(workflow.jobs[jobName]).find((run) =>
        run.includes("cd nemoclaw && npm install"),
      );

      expect(installRun, `${jobName} plugin install`).toContain(
        "cd nemoclaw && npm install --ignore-scripts",
      );
      expect(installRun, `${jobName} plugin install`).not.toContain(
        "cd nemoclaw && npm install\n",
      );
    }

    const aggregateCliInstall = stepRuns(workflow.jobs["cli-tests"]).find((run) =>
      run.includes("npm install"),
    );
    expect(aggregateCliInstall).toBe("npm install --ignore-scripts");
  });

  it("does not persist checkout credentials in pull_request jobs", () => {
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith("actions/checkout@")) {
          continue;
        }

        expect(step.with?.["persist-credentials"], `${jobName} checkout`).toBe(false);
      }
    }
  });
});

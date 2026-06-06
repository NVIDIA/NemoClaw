// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readYaml,
  type CompositeAction,
  type WorkflowJob,
} from "./helpers/e2e-workflow-contract";

type PullRequestWorkflow = {
  jobs: Record<string, WorkflowJob & { if?: string; needs?: string[] }>;
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
      "test-skills-yaml",
    ]) {
      expect(staticPrekRun).toContain(`--skip ${skippedHook}`);
    }

    expect(buildRuns).toContain("cd nemoclaw && npx tsc --noEmit --incremental");
    expect(buildRuns).toContain("npx tsc -p jsconfig.json");
    expect(buildRuns).toContain("bash scripts/check-version-tag-sync.sh");
    expect(cliTestRun).toContain("npx vitest run --project cli");
    expect(cliTestRun).toContain("--reporter=github-actions");
    expect(cliTestRun).toContain("--reporter=json");
    expect(cliTestRun).toContain(
      "--outputFile.json=coverage/cli/vitest-results.json",
    );
    expect(cliTestRun).toContain("npx tsx scripts/check-coverage-ratchet.ts");
    expect(pluginTestRun).toContain("npx vitest run --project plugin");
    expect(pluginTestRun).toContain("npx tsx scripts/check-coverage-ratchet.ts");
    expect(staticRuns).toContain("npm run source-shape:check");
    expect(staticRuns).toContain("npx vitest run test/skills-frontmatter.test.ts");
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
    for (const jobName of ["build-typecheck", "cli-tests", "plugin-tests"]) {
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

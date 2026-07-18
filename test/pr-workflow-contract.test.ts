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
} from "./helpers/e2e-workflow-contract";

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

const trustedCheckoutAction = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
const trustedSetupNodeAction = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";
const installerHashBootstrapCommit = "cb5e9aefab2b16fedc0995149fc3520da0d5e0c7";
const installerHashBootstrapTree = "1fdf59efe40b78c407e222fd42043b23a61e199a";
const installerHashBootstrapCreatedAt = "2026-07-02T19:35:41Z";
const installerHashBootstrapExpiresAt = "2026-12-29T19:35:41Z";

const trustedActionDirs = [
  ".github/actions/ci-static-checks",
  ".github/actions/ci-build-typecheck",
  ".github/actions/ci-cli-coverage-shard",
  ".github/actions/ci-cli-coverage-merge",
  ".github/actions/ci-plugin-coverage",
  ".github/actions/ci-installer-integration",
] as const;

const cliShardMatrix = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const cliShardCount = String(cliShardMatrix.length);

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

function runLoggedPackageScript(script: string): string[][] {
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
    return readFileSync(commandLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
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

  // source-shape-contract: security -- Base retargets must rerun trusted installer verification without minting skipped required evidence
  it("reruns installer hash verification after a pull request base retarget", () => {
    expect(installerHashWorkflow.on?.pull_request?.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "edited",
    ]);
    expect(installerHashWorkflow.jobs["check-hash"].if).toBe(
      "github.repository == 'NVIDIA/NemoClaw'",
    );
  });

  // source-shape-contract: security -- Dependabot's bounded DCO exemption must report an explicit successful required check
  it("records the Dependabot DCO bypass as a successful required job", () => {
    const job = dcoWorkflow.jobs["dco-check"];
    const bypass = requiredWorkflowStep(job, "Check Dependabot DCO bypass");
    const declaration = requiredWorkflowStep(job, "Check PR body for Signed-off-by");

    expect(job.if).toBeUndefined();
    expect(job.steps?.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(bypass.env?.USERNAME).toBe("${{ github.event.pull_request.user.login }}");
    expect(bypass.run).toContain('"$USERNAME" == "dependabot[bot]"');
    expect(bypass.run).toContain('"$USERNAME" == "app/dependabot"');
    expect(bypass.run).not.toContain(".github/dco-bypass.txt");
    expect(declaration.if).toBe("${{ steps.dco-bypass.outputs.bypass != 'true' }}");
  });

  // source-shape-contract: security -- Installer hashes must be verified by base-trusted or immutable bootstrap code
  it("runs pull request installer verification from immutable trusted code", () => {
    const job = installerHashWorkflow.jobs["check-hash"];
    const parserRuntimeSetup = requiredWorkflowStep(
      job,
      "Set up trusted installer hash parser runtime",
    );
    const prCheckout = requiredWorkflowStep(job, "Checkout pull request head");
    const baseCheckout = requiredWorkflowStep(job, "Checkout base-trusted installer hash action");
    const trustedActionProbe = requiredWorkflowStep(
      job,
      "Detect base-trusted installer hash action",
    );
    const bootstrapCheckout = requiredWorkflowStep(
      job,
      "Checkout immutable installer hash bootstrap",
    );
    const bootstrapTreeVerification = requiredWorkflowStep(
      job,
      "Verify immutable installer hash bootstrap tree",
    );
    const bootstrapExpiry = requiredWorkflowStep(
      job,
      "Enforce immutable installer hash bootstrap expiry",
    );
    const baseVerification = requiredWorkflowStep(
      job,
      "Verify pull request installer hashes from base-trusted code",
    );
    const bootstrapVerification = requiredWorkflowStep(
      job,
      "Verify pull request installer hashes from immutable bootstrap",
    );
    const trustedEventVerification = requiredWorkflowStep(
      job,
      "Verify trusted event installer hashes",
    );

    expect(installerHashWorkflow.on?.pull_request?.paths).toBeUndefined();
    expect(installerHashWorkflow.on?.pull_request?.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "edited",
    ]);
    expect(installerHashWorkflow["run-name"]).toContain(
      "Installer Hash PR #{0} head {1} base {2} gate true",
    );
    expect(installerHashWorkflow["run-name"]).toContain("github.event.pull_request.base.sha");
    expect(installerHashWorkflow["run-name"]).not.toContain("github.event.changes.base");
    expect(job.if).toBe("github.repository == 'NVIDIA/NemoClaw'");
    expect(installerHashWorkflow.permissions).toEqual({ contents: "read" });
    expect(parserRuntimeSetup.uses).toBe(trustedSetupNodeAction);
    expect(parserRuntimeSetup.with?.["node-version"]).toBe("22.19.0");
    expect(prCheckout.with?.repository).toBe(
      "${{ github.event.pull_request.head.repo.full_name }}",
    );
    expect(prCheckout.with?.ref).toBe("${{ github.event.pull_request.head.sha }}");

    for (const checkout of (job.steps ?? []).filter(
      (step) => step.uses === trustedCheckoutAction,
    )) {
      expect(checkout.with?.["persist-credentials"], checkout.name).toBe(false);
    }
    expect(
      (job.steps ?? [])
        .filter((step) => step.uses?.startsWith("actions/checkout@"))
        .every((step) => step.uses === trustedCheckoutAction),
    ).toBe(true);

    expect(baseCheckout.with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(baseCheckout.with?.path).toBe(".trusted-installer-hash");
    expect(baseCheckout.with?.["sparse-checkout"]).toContain(
      ".github/actions/ci-installer-hash-check",
    );
    expect(baseCheckout.with?.["sparse-checkout"]).toContain("scripts/check-installer-hash.sh");
    expect(baseCheckout.with?.["sparse-checkout"]).toContain(
      "scripts/checks/extract-installer-pins.mts",
    );

    expect(trustedActionProbe.id).toBe("trusted-installer-hash");
    expect(trustedActionProbe.run).toContain(
      ".trusted-installer-hash/.github/actions/ci-installer-hash-check/action.yaml",
    );
    expect(trustedActionProbe.run).not.toContain("scripts/check-installer-hash.sh");
    expect(bootstrapCheckout.with?.ref).toBe(installerHashBootstrapCommit);
    expect(String(bootstrapCheckout.with?.ref)).toMatch(/^[a-f0-9]{40}$/u);
    expect(bootstrapCheckout.with?.path).toBe(".bootstrap-installer-hash");
    expect(bootstrapCheckout.with?.["sparse-checkout"]).toContain(
      ".github/actions/ci-installer-hash-check",
    );
    expect(bootstrapCheckout.with?.["sparse-checkout"]).toContain(
      "scripts/check-installer-hash.sh",
    );
    expect(bootstrapCheckout.with?.["sparse-checkout"]).toContain(
      "scripts/checks/extract-installer-pins.mts",
    );
    expect(bootstrapCheckout.with?.["sparse-checkout-cone-mode"]).toBe(false);
    expect((bootstrapExpiry as WorkflowStep & { shell?: string }).shell).toBe("bash");
    expect(bootstrapExpiry.env).toBeUndefined();
    expect(bootstrapExpiry.run).toContain(installerHashBootstrapCommit);
    expect(bootstrapExpiry.run).toContain(installerHashBootstrapExpiresAt);
    expect(bootstrapExpiry.if).toBe(bootstrapCheckout.if);
    expect(bootstrapExpiry.if).toBe(bootstrapVerification.if);
    expect(bootstrapTreeVerification.if).toBe(bootstrapCheckout.if);
    expect(bootstrapTreeVerification.run).toContain(installerHashBootstrapCommit);
    expect(bootstrapTreeVerification.run).toContain(installerHashBootstrapTree);
    expect(
      requiredWorkflowStepIndex(job, "Enforce immutable installer hash bootstrap expiry"),
    ).toBeLessThan(requiredWorkflowStepIndex(job, "Checkout immutable installer hash bootstrap"));
    expect(
      requiredWorkflowStepIndex(job, "Checkout immutable installer hash bootstrap"),
    ).toBeLessThan(
      requiredWorkflowStepIndex(job, "Verify immutable installer hash bootstrap tree"),
    );
    expect(
      requiredWorkflowStepIndex(job, "Verify immutable installer hash bootstrap tree"),
    ).toBeLessThan(
      requiredWorkflowStepIndex(
        job,
        "Verify pull request installer hashes from immutable bootstrap",
      ),
    );
    expect(
      requiredWorkflowStepIndex(job, "Set up trusted installer hash parser runtime"),
    ).toBeLessThan(
      requiredWorkflowStepIndex(job, "Verify pull request installer hashes from base-trusted code"),
    );
    expect(
      requiredWorkflowStepIndex(job, "Set up trusted installer hash parser runtime"),
    ).toBeLessThan(
      requiredWorkflowStepIndex(
        job,
        "Verify pull request installer hashes from immutable bootstrap",
      ),
    );
    expect(
      requiredWorkflowStepIndex(job, "Set up trusted installer hash parser runtime"),
    ).toBeLessThan(requiredWorkflowStepIndex(job, "Verify trusted event installer hashes"));
    expect(
      (Date.parse(installerHashBootstrapExpiresAt) - Date.parse(installerHashBootstrapCreatedAt)) /
        86_400_000,
    ).toBe(180);
    expect(bootstrapExpiry.run).toContain("Date.now() >= expiresAtMs");
    expect(bootstrapExpiry.run).toContain("Remove the bootstrap fallback");

    expect(baseVerification.uses).toBe(
      "./.trusted-installer-hash/.github/actions/ci-installer-hash-check",
    );
    expect(bootstrapVerification.uses).toBe(
      "./.bootstrap-installer-hash/.github/actions/ci-installer-hash-check",
    );
    expect(trustedEventVerification.uses).toBe("./.github/actions/ci-installer-hash-check");
    expect(baseVerification.if).toBe(
      "github.event_name == 'pull_request' && steps.trusted-installer-hash.outputs.available == 'true'",
    );
    expect(bootstrapVerification.if).toBe(
      "github.event_name == 'pull_request' && steps.trusted-installer-hash.outputs.available != 'true'",
    );
    expect(trustedEventVerification.if).toBe("github.event_name != 'pull_request'");
    for (const verification of [
      baseVerification,
      bootstrapVerification,
      trustedEventVerification,
    ]) {
      expect(verification.with?.["repo-root"], verification.name).toBe("${{ github.workspace }}");
    }

    expect(job.steps?.some((step) => step.name === "Detect installer-affecting changes")).toBe(
      false,
    );
    expect(stepRuns(job).join("\n")).not.toContain("bash scripts/check-installer-hash.sh");
  });

  it("fails closed when the immutable installer hash bootstrap expiry is mutated", () => {
    const expiryStep = requiredWorkflowStep(
      installerHashWorkflow.jobs["check-hash"],
      "Enforce immutable installer hash bootstrap expiry",
    );
    const expired = runWorkflowShellStep(
      {
        ...expiryStep,
        run: expiryStep.run?.replace(installerHashBootstrapExpiresAt, "2000-12-27T23:26:13Z"),
      },
      {},
    );
    const malformedExpiry = runWorkflowShellStep(
      {
        ...expiryStep,
        run: expiryStep.run?.replace(installerHashBootstrapExpiresAt, "not-a-canonical-utc-date"),
      },
      {},
    );
    const mutableRef = runWorkflowShellStep(
      {
        ...expiryStep,
        run: expiryStep.run?.replace(installerHashBootstrapCommit, "main"),
      },
      {},
    );
    const valid = runWorkflowShellStep(expiryStep, {});

    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain("remains valid");
    expect(expired.status).not.toBe(0);
    expect(expired.stderr).toContain("expired at 2000-12-27T23:26:13Z");
    expect(expired.stderr).toContain("Remove the bootstrap fallback");
    expect(malformedExpiry.status).not.toBe(0);
    expect(malformedExpiry.stderr).toContain("expiry configuration is invalid");
    expect(mutableRef.status).not.toBe(0);
    expect(mutableRef.stderr).toContain("refusing the fallback");
  });

  it("fails closed when the immutable installer hash bootstrap tree differs", () => {
    const treeStep = requiredWorkflowStep(
      installerHashWorkflow.jobs["check-hash"],
      "Verify immutable installer hash bootstrap tree",
    );
    const fakeBin = mkdtempSync(join(tmpdir(), "nemoclaw-bootstrap-git-"));
    const fakeGit = join(fakeBin, "git");
    writeFileSync(
      fakeGit,
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *"HEAD^{tree}"*) printf \'%s\\n\' "${FAKE_TREE}" ;;',
        `  *) printf '%s\\n' ${installerHashBootstrapCommit} ;;`,
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = {
        GITHUB_WORKSPACE: tmpdir(),
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      };
      const valid = runWorkflowShellStep(treeStep, {
        ...env,
        FAKE_TREE: installerHashBootstrapTree,
      });
      const mismatch = runWorkflowShellStep(treeStep, {
        ...env,
        FAKE_TREE: "0000000000000000000000000000000000000000",
      });

      expect(valid.status).toBe(0);
      expect(mismatch.status).not.toBe(0);
      expect(mismatch.stderr).toContain("does not match the reviewed tree");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  // source-shape-contract: security -- The trusted action must invoke its bundled verifier without PR-controlled resolution
  it("keeps the installer verifier inside the trusted composite action", () => {
    const verification = requiredStep(installerHashAction, "Verify installer hashes are current");

    expect(installerHashAction.inputs?.["repo-root"]?.required).toBe(true);
    expect(verification.env).toEqual({
      NEMOCLAW_INSTALLER_HASH_REPO_ROOT: "${{ inputs.repo-root }}",
    });
    expect(verification.run).toBe(
      'bash "${{ github.action_path }}/../../../scripts/check-installer-hash.sh"',
    );
  });

  // source-shape-contract: compatibility -- Path-filter semantics keep documentation-only and code-changing PR lanes distinct
  it("routes only code-changing PRs through the code-check path", () => {
    const filterStep = prWorkflow.jobs.changes.steps?.find((step) => step.id === "filter");

    expect(filterStep?.uses).toContain("dorny/paths-filter");
    expect(filterStep?.with?.["predicate-quantifier"]).toBe("every");
    expect(filterStep?.with?.filters).toContain("code:");
    expect(filterStep?.with?.filters).toContain("!**/*.md");
    expect(filterStep?.with?.filters).toContain("!docs/**");

    expect(codeFilterMatchesChangedPaths(prWorkflow, ["docs/get-started/prerequisites.mdx"])).toBe(
      false,
    );
    expect(codeFilterMatchesChangedPaths(prWorkflow, ["README.md"])).toBe(false);
    expect(codeFilterMatchesChangedPaths(prWorkflow, ["src/lib/runner.ts"])).toBe(true);
    expect(
      codeFilterMatchesChangedPaths(prWorkflow, [
        "docs/get-started/prerequisites.mdx",
        "src/lib/runner.ts",
      ]),
    ).toBe(true);
  });

  // source-shape-contract: compatibility -- Repository checks must follow every authoritative dependency-pin input and consumer
  it("runs repository checks for every operational dependency-pin authority and consumer", () => {
    const hooks = prekConfig.repos.flatMap((repo) => repo.hooks ?? []);
    const repositoryChecks = hooks.find((candidate) => candidate.id === "repository-checks");
    const files = new RegExp(repositoryChecks?.files ?? "(?!)", "u");

    for (const path of [
      ".pre-commit-config.yaml",
      "Dockerfile",
      "Dockerfile.base",
      "agents/openclaw/manifest.yaml",
      "agents/hermes/Dockerfile",
      "agents/hermes/Dockerfile.base",
      "agents/hermes/manifest.yaml",
      "agents/hermes/mcp-config-transaction.py",
      "nemoclaw-blueprint/blueprint.yaml",
      "nemoclaw/package.json",
      "scripts/brev-launchable-ci-cpu.sh",
      "scripts/check-installer-hash.sh",
      "scripts/install-openshell.sh",
      "scripts/update-hermes-agent.sh",
      "src/lib/actions/sandbox/mcp-bridge-validation.ts",
      "src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.85.json",
    ]) {
      expect(files.test(path), path).toBe(true);
    }
    expect(files.test("dependency-pins.yaml")).toBe(false);
    expect(files.test("docs/reference/commands.mdx")).toBe(false);
  });

  // source-shape-contract: compatibility -- Pre-commit routing must apply the declarative guard to every supported test location
  it("runs the source-shape guard for root and co-located tests", () => {
    const hooks = prekConfig.repos.flatMap((repo) => repo.hooks ?? []);
    const sourceShape = hooks.find((candidate) => candidate.id === "source-shape-test-budget");
    const files = new RegExp(sourceShape?.files ?? "(?!)", "u");

    expect(sourceShape?.entry).toBe("npm run source-shape:check");
    for (const path of [
      "test/example.test.ts",
      "src/lib/example.spec.ts",
      "nemoclaw/src/example.test.ts",
      "scripts/find-source-shape-tests.mts",
      "ci/source-shape-test-budget.json",
    ]) {
      expect(files.test(path), path).toBe(true);
    }
    expect(files.test("src/lib/example.ts")).toBe(false);
  });

  // source-shape-contract: compatibility -- Changed-file routing must typecheck each project and its transitive configuration inputs
  it("scopes pre-push typechecks to project and transitive inputs", () => {
    const hooks = prekConfig.repos.flatMap((repo) => repo.hooks ?? []);
    const pluginTypecheck = hooks.find((candidate) => candidate.id === "tsc-plugin");
    const cliTypecheck = hooks.find((candidate) => candidate.id === "tsc-cli");
    const jsTypecheck = hooks.find((candidate) => candidate.id === "tsc-js");
    const pluginFiles = new RegExp(pluginTypecheck?.files ?? "(?!)", "u");
    const files = new RegExp(cliTypecheck?.files ?? "(?!)", "u");
    const jsFiles = new RegExp(jsTypecheck?.files ?? "(?!)", "u");

    expect(pluginTypecheck?.entry).toBe("npm --prefix nemoclaw run typecheck");
    expect(cliTypecheck?.entry).toBe("npm run typecheck:cli -- --incremental");
    expect(cliTypecheck?.always_run).toBeUndefined();
    for (const include of cliTypeScriptConfig.include) {
      const representativeInput = include.replace("**/*", "nested/input");
      expect(files.test(representativeInput), include).toBe(true);
    }
    for (const path of [
      ".agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts",
      ".agents/skills/nemoclaw-maintainer-day/scripts/shared.ts",
      "agents/hermes/generate-config.ts",
      "bin/nemoclaw.ts",
      "scripts/check.ts",
      "scripts/check.mts",
      "src/lib/runner.ts",
      "test/runner.test.ts",
      "tools/e2e/workflow-boundary.mts",
      "nemoclaw/src/lib/subprocess-env.ts",
      "nemoclaw/src/blueprint/private-networks.ts",
      "nemoclaw-blueprint/scripts/render.ts",
      "src/lib/actions/sandbox/credentials.json",
      "package.json",
      "package-lock.json",
      "tsconfig.cli.json",
      "vitest.config.ts",
    ]) {
      expect(files.test(path), path).toBe(true);
    }
    for (const path of [
      ".agents/skills/example/scripts/unchecked.ts",
      "agents/hermes/start.sh",
      "docs/get-started/quickstart.mdx",
      "nemoclaw/src/commands/status.ts",
      "scripts/check.js",
    ]) {
      expect(files.test(path), path).toBe(false);
    }
    for (const path of [
      "nemoclaw/src/lib/subprocess-env.ts",
      "nemoclaw/src/blueprint/private-networks.ts",
      "nemoclaw/src/commands/status.ts",
    ]) {
      expect(pluginFiles.test(path), path).toBe(true);
    }
    expect(pluginFiles.test(".agents/skills/example/scripts/unchecked.ts")).toBe(false);
    for (const path of ["bin/nemoclaw.js", "jsconfig.json", "package.json", "package-lock.json"]) {
      expect(jsFiles.test(path), path).toBe(true);
    }
    expect(jsFiles.test("docs/_components/nemoclaw.js")).toBe(false);
  });

  it("executes repo-wide coverage and diff-scoped automatic hook commands", () => {
    const scripts = packageJson.scripts;
    const cliCoverageCalls = runLoggedPackageScript(scripts["test:coverage:cli"]);
    const pluginCoverageCalls = runLoggedPackageScript(scripts["test:coverage:plugin"]);
    const repoCheckCalls = runLoggedPackageScript(scripts.check);
    const diffCheckCalls = runLoggedPackageScript(scripts["check:diff"]);

    expect(cliCoverageCalls.map(([command]) => command)).toEqual([
      "npm",
      "npm",
      "tsx",
      "vitest",
      "tsx",
    ]);
    expect(cliCoverageCalls[3]).toEqual(
      expect.arrayContaining(["--project", "cli", "integration", "--coverage"]),
    );
    expect(cliCoverageCalls[4]).toEqual([
      "tsx",
      "scripts/check-coverage-ratchet.mts",
      "coverage/cli/coverage-summary.json",
      "ci/coverage-threshold-cli.json",
      "CLI coverage",
    ]);
    expect(pluginCoverageCalls[0]).toEqual(
      expect.arrayContaining([
        "--project",
        "plugin",
        "--coverage.include=nemoclaw/src/**/*.ts",
        "--coverage.include=nemoclaw/src/**/*.cts",
      ]),
    );
    expect(pluginCoverageCalls[1]).toEqual([
      "tsx",
      "scripts/check-coverage-ratchet.mts",
      "coverage/plugin/coverage-summary.json",
      "ci/coverage-threshold-plugin.json",
      "Plugin coverage",
    ]);
    expect(repoCheckCalls).toEqual([
      ["npx", "prek", "run", "--all-files", "--stage", "pre-commit"],
      ["npx", "prek", "run", "--all-files", "--stage", "manual"],
    ]);
    expect(diffCheckCalls).toEqual([
      [
        "npx",
        "prek",
        "run",
        "--from-ref",
        "origin/main",
        "--to-ref",
        "HEAD",
        "--stage",
        "pre-commit",
      ],
      ["npx", "commitlint", "--from", "origin/main", "--to", "HEAD"],
      [
        "npx",
        "prek",
        "run",
        "--from-ref",
        "origin/main",
        "--to-ref",
        "HEAD",
        "--stage",
        "pre-push",
      ],
    ]);
  });

  // source-shape-contract: security -- Pull requests must execute base-trusted actions while main uses reviewed repository actions
  it("reuses the same shared CI actions in PR and main workflows", () => {
    expect(prWorkflow.on?.pull_request?.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "edited",
    ]);
    expect(prWorkflow["run-name"]).toBe(
      "CI PR #${{ github.event.pull_request.number }} head ${{ github.event.pull_request.head.sha }} base ${{ github.event.pull_request.base.sha }} gate ${{ github.event.action != 'edited' || github.event.changes.base != null }}",
    );
    expect(prWorkflow.concurrency).toEqual({
      group:
        "${{ github.workflow }}-${{ github.ref }}-${{ github.event.action != 'edited' || github.event.changes.base != null }}",
      "cancel-in-progress": true,
    });
    for (const [jobName, stepName, trustedActionPath, mainActionPath] of [
      [
        "static-checks",
        "Run static checks",
        trustedPrActionPaths.staticChecks,
        sharedActionPaths.staticChecks,
      ],
      [
        "build-typecheck",
        "Run build and type checks",
        trustedPrActionPaths.buildTypecheck,
        sharedActionPaths.buildTypecheck,
      ],
      [
        "cli-test-shards",
        "Run CLI coverage shard",
        trustedPrActionPaths.cliCoverageShard,
        sharedActionPaths.cliCoverageShard,
      ],
      [
        "cli-tests",
        "Merge CLI coverage",
        trustedPrActionPaths.cliCoverageMerge,
        sharedActionPaths.cliCoverageMerge,
      ],
      [
        "plugin-tests",
        "Run plugin coverage",
        trustedPrActionPaths.pluginCoverage,
        sharedActionPaths.pluginCoverage,
      ],
    ] as const) {
      expect(stepUses(prWorkflow.jobs[jobName]), `PR ${jobName}`).toContain(trustedActionPath);
      expect(stepUses(mainWorkflow.jobs[jobName]), `main ${jobName}`).toContain(mainActionPath);
      expect(stepUses(prWorkflow.jobs[jobName]), `PR ${jobName}`).not.toContain(mainActionPath);
      expect(stepUses(mainWorkflow.jobs[jobName]), `main ${jobName}`).not.toContain(
        trustedActionPath,
      );

      const trustedCheckout = requiredWorkflowStep(
        prWorkflow.jobs[jobName],
        "Checkout trusted CI actions",
      );
      expect(trustedCheckout.uses).toBe(trustedCheckoutAction);
      expect(trustedCheckout.with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
      expect(trustedCheckout.with?.path).toBe(".trusted-ci-actions");
      expect(trustedCheckout.with?.["persist-credentials"]).toBe(false);
      expect(trustedCheckout.with?.["sparse-checkout-cone-mode"]).toBe(false);
      for (const trustedActionDir of trustedActionDirs) {
        expect(String(trustedCheckout.with?.["sparse-checkout"])).toContain(trustedActionDir);
      }
      expect(
        requiredWorkflowStepIndex(prWorkflow.jobs[jobName], "Checkout trusted CI actions"),
      ).toBeLessThan(requiredWorkflowStepIndex(prWorkflow.jobs[jobName], stepName));
    }

    expect(stepUses(prWorkflow.jobs["installer-integration"])).toContain(
      trustedPrActionPaths.installerIntegration,
    );
    expect(stepUses(prWorkflow.jobs["installer-integration"])).not.toContain(
      sharedActionPaths.installerIntegration,
    );
    expect(stepUses(mainWorkflow.jobs["installer-integration"])).toContain(
      sharedActionPaths.installerIntegration,
    );
    expect(stepUses(mainWorkflow.jobs["installer-integration"])).not.toContain(
      trustedPrActionPaths.installerIntegration,
    );
    const installerTrustedCheckout = requiredWorkflowStep(
      prWorkflow.jobs["installer-integration"],
      "Checkout trusted CI actions",
    );
    expect(installerTrustedCheckout.uses).toBe(trustedCheckoutAction);
    expect(installerTrustedCheckout.with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(installerTrustedCheckout.with?.path).toBe(".trusted-ci-actions");
    expect(installerTrustedCheckout.with?.["persist-credentials"]).toBe(false);
    expect(installerTrustedCheckout.with?.["sparse-checkout-cone-mode"]).toBe(false);
    expect(String(installerTrustedCheckout.with?.["sparse-checkout"])).toContain(
      ".github/actions/ci-installer-integration",
    );
    const installerActionProbe = requiredWorkflowStep(
      prWorkflow.jobs["installer-integration"],
      "Detect trusted installer integration action",
    );
    expect(installerActionProbe.id).toBe("trusted-installer-integration");
    expect(installerActionProbe.run).toContain(
      ".trusted-ci-actions/.github/actions/ci-installer-integration/action.yaml",
    );
    expect(installerActionProbe.run).toContain("available=true");
    expect(installerActionProbe.run).toContain("available=false");
    const installerActionStep = requiredWorkflowStep(
      prWorkflow.jobs["installer-integration"],
      "Run installer integration tests",
    );
    expect(installerActionStep.if).toBe(
      "${{ steps.trusted-installer-integration.outputs.available == 'true' }}",
    );
    const bootstrapSetup = requiredWorkflowStep(
      prWorkflow.jobs["installer-integration"],
      "Setup Node.js for installer integration",
    );
    expect(bootstrapSetup.if).toBe(
      "${{ steps.trusted-installer-integration.outputs.available != 'true' }}",
    );
    expect(bootstrapSetup.uses).toContain("actions/setup-node@");
    expect(bootstrapSetup.with?.["node-version"]).toBe("22");
    expect(bootstrapSetup.with?.cache).toBe("npm");
    const bootstrapInstall = requiredWorkflowStep(
      prWorkflow.jobs["installer-integration"],
      "Install installer integration dependencies",
    );
    expect(bootstrapInstall.if).toBe(
      "${{ steps.trusted-installer-integration.outputs.available != 'true' }}",
    );
    expect(bootstrapInstall.run).toContain("npm install --ignore-scripts");
    expect(bootstrapInstall.run).toContain("cd nemoclaw && npm install --ignore-scripts");
    const bootstrapBuild = requiredWorkflowStep(
      prWorkflow.jobs["installer-integration"],
      "Build installer integration artifacts",
    );
    expect(bootstrapBuild.if).toBe(
      "${{ steps.trusted-installer-integration.outputs.available != 'true' }}",
    );
    expect(bootstrapBuild.run).toContain("npm run build:cli");
    expect(bootstrapBuild.run).toContain("cd nemoclaw && npm run build");
    const bootstrapRun = requiredWorkflowStep(
      prWorkflow.jobs["installer-integration"],
      "Run installer integration tests (bootstrap)",
    );
    expect(bootstrapRun.if).toBe(
      "${{ steps.trusted-installer-integration.outputs.available != 'true' }}",
    );
    expect(bootstrapRun.run).toBe("CI=true npx vitest run --project installer-integration");
    expect(
      requiredWorkflowStepIndex(
        prWorkflow.jobs["installer-integration"],
        "Checkout trusted CI actions",
      ),
    ).toBeLessThan(
      requiredWorkflowStepIndex(
        prWorkflow.jobs["installer-integration"],
        "Run installer integration tests",
      ),
    );
    expect(
      requiredWorkflowStepIndex(
        prWorkflow.jobs["installer-integration"],
        "Detect trusted installer integration action",
      ),
    ).toBeLessThan(
      requiredWorkflowStepIndex(
        prWorkflow.jobs["installer-integration"],
        "Run installer integration tests (bootstrap)",
      ),
    );

    expect(stepUses(mainWorkflow.jobs.checks)).not.toContain("./.github/actions/basic-checks");
    expect(prWorkflow.jobs["cli-test-shards"].strategy?.["fail-fast"]).toBe(false);
    expect(mainWorkflow.jobs["cli-test-shards"].strategy?.["fail-fast"]).toBe(false);
    expect(prWorkflow.jobs["cli-test-shards"].strategy?.matrix?.shard).toEqual([...cliShardMatrix]);
    expect(mainWorkflow.jobs["cli-test-shards"].strategy?.matrix?.shard).toEqual([
      ...cliShardMatrix,
    ]);
    for (const [workflowName, workflow] of [
      ["pull_request", prWorkflow],
      ["main", mainWorkflow],
    ] as const) {
      const checkoutStep = requiredWorkflowStep(workflow.jobs["cli-test-shards"], "Checkout");
      const shardStep = requiredWorkflowStep(
        workflow.jobs["cli-test-shards"],
        "Run CLI coverage shard",
      );
      const mergeStep = requiredWorkflowStep(workflow.jobs["cli-tests"], "Merge CLI coverage");
      expect(checkoutStep.with?.["fetch-depth"], `${workflowName} checkout depth`).toBe(0);
      expect(shardStep.with?.shard, `${workflowName} shard input`).toBe("${{ matrix.shard }}");
      expect(shardStep.with?.["shard-count"], `${workflowName} shard-count input`).toBe(
        cliShardCount,
      );
      expect(mergeStep.with?.["shard-count"], `${workflowName} merge shard-count`).toBe(
        cliShardCount,
      );
      expect(workflow.jobs["cli-tests"].permissions?.actions, workflowName).toBe("read");
      expect(workflow.jobs.checks.permissions?.actions, workflowName).toBe("read");
    }
  });

  // source-shape-contract: security -- Base-trusted PR sharding must retain hermetic coverage while retired duplicate lanes stay absent
  it("folds hermetic E2E support and Ollama proxy coverage into existing Vitest lanes", () => {
    const shardRun = requiredStep(
      sharedActions.cliCoverageShard,
      "Run CLI coverage and E2E support shard",
    );
    expect(shardRun.run).toContain("--project cli --project integration --project e2e-support");

    const parityStep = requiredStep(
      sharedActions.cliCoverageShard,
      "Validate changed live E2E mock parity",
    );
    expect(parityStep.if).toBe("${{ inputs.shard == '1' }}");
    expect(parityStep.run).toContain("base=HEAD^1");
    expect(parityStep.run).toContain("head=HEAD^2");
    expect(parityStep.run).toContain('base="$PUSH_BASE_SHA"');

    const trustedCapabilityProbe = requiredWorkflowStep(
      prWorkflow.jobs["cli-test-shards"],
      "Detect trusted E2E support sharding",
    );
    expect(trustedCapabilityProbe.id).toBe("trusted-shard-capabilities");
    expect(trustedCapabilityProbe.run).toContain("--project e2e-support");
    expect(trustedCapabilityProbe.run).toContain("e2e-support=true");
    expect(trustedCapabilityProbe.run).toContain("e2e-support=false");

    const bootstrapParity = requiredWorkflowStep(
      prWorkflow.jobs["cli-test-shards"],
      "Validate changed live E2E mock parity (bootstrap)",
    );
    expect(bootstrapParity.if).toBe(
      "${{ steps.trusted-shard-capabilities.outputs.e2e-support != 'true' && matrix.shard == 1 }}",
    );
    expect(bootstrapParity.run).toContain("--base HEAD^1 --head HEAD^2");

    const bootstrapShard = requiredWorkflowStep(
      prWorkflow.jobs["cli-test-shards"],
      "Run E2E support shard (bootstrap)",
    );
    expect(bootstrapShard.if).toBe(
      "${{ steps.trusted-shard-capabilities.outputs.e2e-support != 'true' }}",
    );
    expect(bootstrapShard.run).toContain("--project e2e-support");
    expect(bootstrapShard.run).toContain(
      '--shard="${E2E_SUPPORT_SHARD}/${E2E_SUPPORT_SHARD_COUNT}"',
    );

    for (const workflow of [prWorkflow, mainWorkflow]) {
      expect(workflow.jobs["e2e-support"]).toBeUndefined();
      expect(workflow.jobs["test-e2e-ollama-proxy"]).toBeUndefined();
      expect(workflow.jobs.checks.needs).not.toContain("e2e-support");
      expect(workflow.jobs.checks.needs).not.toContain("test-e2e-ollama-proxy");
    }

    expect(stepRuns(sharedActions.staticChecks).join("\n")).not.toContain(
      "skills-frontmatter.test.ts",
    );
    const trustedRatchetDependencies = requiredStep(
      sharedActions.staticChecks,
      "Install base-trusted createRequire verifier dependencies",
    );
    const trustedRatchet = requiredStep(
      sharedActions.staticChecks,
      "Enforce base-trusted createRequire allowlist ratchet",
    );
    expect(trustedRatchetDependencies.run).toBe(
      'npm ci --ignore-scripts --no-audit --no-fund --prefix "$GITHUB_ACTION_PATH"',
    );
    expect(trustedRatchet.run).toBe(
      'node --experimental-strip-types "$GITHUB_ACTION_PATH/create-require-ratchet.mts"',
    );
    expect(
      requiredStepIndex(
        sharedActions.staticChecks,
        "Install base-trusted createRequire verifier dependencies",
      ),
    ).toBeLessThan(
      requiredStepIndex(
        sharedActions.staticChecks,
        "Enforce base-trusted createRequire allowlist ratchet",
      ),
    );
    expect(
      requiredStepIndex(
        sharedActions.staticChecks,
        "Enforce base-trusted createRequire allowlist ratchet",
      ),
    ).toBeLessThan(requiredStepIndex(sharedActions.staticChecks, "Install dependencies"));

    const ratchetPackage = JSON.parse(
      readFileSync(".github/actions/ci-static-checks/package.json", "utf8"),
    ) as { dependencies?: Record<string, string> };
    const ratchetLock = JSON.parse(
      readFileSync(".github/actions/ci-static-checks/package-lock.json", "utf8"),
    ) as {
      packages?: Record<string, { integrity?: string; version?: string }>;
    };
    const ratchetRuntime = readFileSync(
      ".github/actions/ci-static-checks/create-require-ratchet.mts",
      "utf8",
    );
    expect(ratchetPackage.dependencies).toEqual({ typescript: "6.0.3" });
    expect(ratchetLock.packages?.["node_modules/typescript"]?.version).toBe("6.0.3");
    expect(ratchetLock.packages?.["node_modules/typescript"]?.integrity).toMatch(/^sha512-/);
    expect(ratchetRuntime).toContain(
      'import ts from "./node_modules/typescript/lib/typescript.js";',
    );
    expect(ratchetRuntime).not.toMatch(/from ["']typescript["']/);
  });

  // source-shape-contract: security -- Downloaded CI tooling must use a committed digest rather than upstream metadata
  it("pins downloaded CI tooling to reviewed integrity", () => {
    const staticRunsJoined = stepRuns(sharedActions.staticChecks).join("\n");

    expect(staticRunsJoined).toContain(
      'HADOLINT_SHA256="6bf226944684f56c84dd014e8b979d27425c0148f61b3bd99bcc6f39e9dc5a47"',
    );
    expect(staticRunsJoined).not.toContain('"${HADOLINT_URL}.sha256"');
    expect(staticRunsJoined).not.toContain("EXPECTED=$(curl");
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

    try {
      const invalidShard = runWorkflowShellStep(shardValidationStep, {
        CLI_SHARD: shellPayload,
        CLI_SHARD_COUNT: "8",
        GITHUB_OUTPUT: join(temp, "github-output"),
      });
      const invalidRange = runWorkflowShellStep(shardValidationStep, {
        CLI_SHARD: "9",
        CLI_SHARD_COUNT: "8",
        GITHUB_OUTPUT: join(temp, "github-output"),
      });
      const invalidCount = runWorkflowShellStep(mergeValidationStep, {
        CLI_SHARD_COUNT: shellPayload,
      });

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

  it("keeps trusted coverage actions compatible across the .ts to .mts migration (#6935)", () => {
    const cases = [
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
    const variants = [
      {
        fixtureExtension: "mts",
        expectedEntrypointExtension: "mts",
        expectedStatus: 0,
      },
      {
        fixtureExtension: "ts",
        expectedEntrypointExtension: "ts",
        expectedStatus: 0,
      },
      {
        fixtureExtension: "missing",
        expectedEntrypointExtension: "ts",
        expectedStatus: 1,
      },
    ] as const;

    for (const testCase of cases) {
      for (const variant of variants) {
        const temp = mkdtempSync(join(tmpdir(), "nemoclaw-coverage-entrypoint-"));
        const fakeBin = join(temp, "bin");
        mkdirSync(fakeBin);
        mkdirSync(join(temp, "dist"));
        mkdirSync(join(temp, "scripts"));
        writeFileSync(join(temp, "dist", ["nemoclaw", "js"].join(".")), "built\n");
        for (const command of ["node", "npm"]) {
          writeFileSync(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n", {
            mode: 0o755,
          });
        }
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
      }
    }
  });

  // source-shape-contract: security -- Growth-budget changes must inspect trusted GitHub data without fetching PR-authored URLs
  it("keeps the trusted test-size guard closed around budget policy changes", () => {
    const growthGuardrails = readYaml<CodebaseGrowthGuardrailsWorkflow>(
      ".github/workflows/codebase-growth-guardrails.yaml",
    );
    const guardJob = growthGuardrails.jobs["codebase-growth-guardrails"];
    const guardRun = stepRuns(guardJob).join("\n");
    const guardEnv = JSON.stringify((guardJob.steps ?? []).map((step) => step.env ?? {}));
    expect(guardEnv).toContain("HEAD_REPO");
    expect(guardRun).not.toContain(".raw_url");
    expect(guardRun).not.toContain("node <<'NODE'");
    expect(guardRun).toContain("tools/growth-guardrails/test-size-budget.mts");
    expect(guardRun).toContain("tools/growth-guardrails/test-conditionals.mts");
  });

  // source-shape-contract: security -- Coverage publication must exclude fork-authored reports and pin the publishing action
  it("publishes coverage only from same-repository code (#6692)", () => {
    const sameRepositoryGuard =
      "${{ always() && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}";
    const uploadAction = "actions/upload-code-coverage@abb5995db9e0199b0e2bb9dbd136fce4cb1ec4d3";
    const reports = [
      {
        action: sharedActions.cliCoverageMerge,
        uploadStep: "Upload CLI coverage report",
      },
      {
        action: sharedActions.pluginCoverage,
        uploadStep: "Upload plugin coverage report",
      },
    ] as const;

    for (const report of reports) {
      const uploadStep = requiredStep(report.action, report.uploadStep);
      expect(uploadStep.if).toBe(sameRepositoryGuard);
      expect(uploadStep.uses).toBe(uploadAction);
    }
  });

  it("links every failed CLI shard and falls back safely when job metadata is unavailable", () => {
    const runUrl = "https://github.com/NVIDIA/NemoClaw/actions/runs/123";
    const failedShards = workflowJobListing([
      workflowJob(101, "cli-test-shards (1)", "success"),
      workflowJob(102, "cli-test-shards (2)", "failure"),
      workflowJob(108, "cli-test-shards (8)", "cancelled"),
      workflowJob(109, "plugin-tests", "success"),
    ]);
    const malformedShards = workflowJobListing([
      workflowJob("not-a-number", "cli-test-shards (2)", "failure"),
    ]);
    const oversizedShards = workflowJobListing([
      workflowJob(9_007_199_254_740_992, "cli-test-shards (2)", "failure"),
    ]);

    for (const [workflowName, workflow] of [
      ["pull_request", prWorkflow],
      ["main", mainWorkflow],
    ] as const) {
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
      expect(failure.stdout).toContain(`${runUrl}/job/108`);
      expect(malformed.status).not.toBe(0);
      expect(malformed.stdout).toContain(`Details: ${runUrl}`);
      expect(malformed.stdout).not.toContain(`${runUrl}/job/`);
      expect(oversized.status).not.toBe(0);
      expect(oversized.stdout).toContain(`Details: ${runUrl}`);
      expect(oversized.stdout).not.toContain(`${runUrl}/job/`);
      expect(unavailable.status).not.toBe(0);
      expect(unavailable.stdout).toContain(`Expected success, got cancelled. Details: ${runUrl}`);
    }
  });

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
        REAL_OPENCLAW_DIST_HARNESS_RESULT: "failure",
      },
      workflowJobListing([workflowJob(301, "real-openclaw-dist-harness", "failure")]),
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
    expect(mainFailure.stdout).toContain("real-openclaw-dist-harness failed");
    expect(mainFailure.stdout).toContain(
      "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/301",
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

  // source-shape-contract: security -- CI dependency installs must never execute package lifecycle scripts from fetched code
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
    const installerBootstrapInstall = stepRuns(prWorkflow.jobs["installer-integration"]).find(
      (run) => run.includes("npm install"),
    );
    expect(installerBootstrapInstall).toContain("npm install --ignore-scripts");
    expect(installerBootstrapInstall).toContain("cd nemoclaw && npm install --ignore-scripts");
  });

  // source-shape-contract: security -- Workflow checkouts must not leave write-capable credentials available to later steps
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

          expect(step.with?.["persist-credentials"], `${workflowName} ${jobName}`).toBe(false);
        }
      }
    }
  });
});

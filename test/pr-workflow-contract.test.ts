// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  on?: { pull_request?: { paths?: string[] } };
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

const cliShardMatrix = [1, 2, 3, 4, 5] as const;
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

function uploadsCompiledCliArtifact(
  action: CompositeAction,
  shard: number,
  shardCount: number,
): boolean {
  const validationRun = requiredStep(action, "Validate shard inputs").run ?? "";
  const outputDirectory = mkdtempSync(join(tmpdir(), "nemoclaw-cli-shard-output-"));
  const outputPath = join(outputDirectory, "github-output");
  try {
    // Execute the repository-owned action body so producer selection stays a behavioral contract.
    const result = spawnSync("bash", ["-c", validationRun], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLI_SHARD: String(shard),
        CLI_SHARD_COUNT: String(shardCount),
        GITHUB_OUTPUT: outputPath,
      },
    });
    expect(
      result.status,
      `Shard validation failed for ${shard}/${shardCount}: ${result.stderr}`,
    ).toBe(0);
    const output = readFileSync(outputPath, "utf8").match(
      /^upload_build_artifact=(true|false)$/mu,
    )?.[1];
    expect(
      output,
      `Shard validation omitted its artifact output for ${shard}/${shardCount}`,
    ).toBeDefined();
    return output === "true";
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
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
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", ["-c", step.run ?? ""], {
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
  const resolveHermesBaseAction = readYaml<CompositeAction>(
    ".github/actions/resolve-hermes-base-image/action.yaml",
  );

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
    expect(installerHashWorkflow.permissions).toEqual({ contents: "read" });
    expect(parserRuntimeSetup.uses).toBe(trustedSetupNodeAction);
    expect(parserRuntimeSetup.with?.["node-version"]).toBe("22.16.0");
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

  it("keeps ordinary hooks automatic and full coverage explicit", () => {
    const hooks = prekConfig.repos.flatMap((repo) => repo.hooks ?? []);
    const hook = (id: string) => hooks.find((candidate) => candidate.id === id);

    expect(prekConfig.default_stages).toEqual(["pre-commit"]);
    expect(hook("test-cli")?.stages).toEqual(["manual"]);
    expect(hook("test-cli")?.entry).toBe("npm run test:coverage:cli");
    expect(hook("test-plugin")?.stages).toEqual(["manual"]);
    expect(hook("test-plugin")?.entry).toBe("npm run test:coverage:plugin");
    for (const id of [
      "trailing-whitespace",
      "end-of-file-fixer",
      "shfmt",
      "check-added-large-files",
      "check-executables-have-shebangs",
      "check-shebang-scripts-are-executable",
    ]) {
      expect(hook(id)?.stages, id).toEqual(["pre-commit"]);
    }
    for (const id of ["tsc-plugin", "tsc-js", "tsc-cli", "version-tag-sync"]) {
      expect(hook(id)?.stages, id).toEqual(["pre-push"]);
    }
  });

  it("scopes pre-push typechecks to project and transitive inputs", () => {
    const hooks = prekConfig.repos.flatMap((repo) => repo.hooks ?? []);
    const pluginTypecheck = hooks.find((candidate) => candidate.id === "tsc-plugin");
    const cliTypecheck = hooks.find((candidate) => candidate.id === "tsc-cli");
    const jsTypecheck = hooks.find((candidate) => candidate.id === "tsc-js");
    const pluginFiles = new RegExp(pluginTypecheck?.files ?? "(?!)", "u");
    const files = new RegExp(cliTypecheck?.files ?? "(?!)", "u");
    const jsFiles = new RegExp(jsTypecheck?.files ?? "(?!)", "u");

    expect(cliTypecheck?.entry).toBe("npm run typecheck:cli -- --incremental");
    expect(cliTypecheck?.always_run).toBeUndefined();
    for (const include of cliTypeScriptConfig.include) {
      const representativeInput = include.replace("**/*", "nested/input");
      expect(files.test(representativeInput), include).toBe(true);
    }
    for (const path of [
      ".agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts",
      ".agents/skills/nemoclaw-maintainer-day/scripts/pra-gate.ts",
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
    expect(jsFiles.test("docs/_ext/nemoclaw.js")).toBe(false);
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
      "scripts/check-coverage-ratchet.ts",
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
      "scripts/check-coverage-ratchet.ts",
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

  it("reuses the same shared CI actions in PR and main workflows", () => {
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
      const shardStep = requiredWorkflowStep(
        workflow.jobs["cli-test-shards"],
        "Run CLI coverage shard",
      );
      const mergeStep = requiredWorkflowStep(workflow.jobs["cli-tests"], "Merge CLI coverage");
      expect(shardStep.with?.shard, `${workflowName} shard input`).toBe("${{ matrix.shard }}");
      expect(shardStep.with?.["shard-count"], `${workflowName} shard-count input`).toBe(
        cliShardCount,
      );
      expect(mergeStep.with?.["shard-count"], `${workflowName} merge shard-count`).toBe(
        cliShardCount,
      );
    }
  });

  it("preserves the shared static, build, and coverage gates", () => {
    const staticRuns = stepRuns(sharedActions.staticChecks);
    const staticRunsJoined = staticRuns.join("\n");
    const staticPrekRun = staticRuns.find((run) =>
      run.includes("npx prek run --all-files --stage pre-commit"),
    );
    const buildRuns = stepRuns(sharedActions.buildTypecheck);
    const cliShardRuns = stepRuns(sharedActions.cliCoverageShard).join("\n");
    const cliMergeRuns = stepRuns(sharedActions.cliCoverageMerge).join("\n");
    const pluginRuns = stepRuns(sharedActions.pluginCoverage).join("\n");
    const installerRuns = stepRuns(sharedActions.installerIntegration).join("\n");

    expect(staticRuns).toContain("npm install --ignore-scripts");
    expect(staticRuns).toContain("npm run validate:configs");
    expect(staticRuns).toContain("npm run typecheck:scorecard");
    expect(staticPrekRun).toContain("npx prek run --all-files --stage pre-commit");
    for (const skippedHook of [
      "source-shape-test-budget",
      "test-file-size-budget",
      "test-skills-yaml",
    ]) {
      expect(staticPrekRun).toContain(`--skip ${skippedHook}`);
    }
    expect(staticPrekRun).not.toContain("--skip test-cli");
    expect(staticPrekRun).not.toContain("--skip test-plugin");
    expect(staticRuns).toContain("npm run source-shape:check");
    expect(staticRuns).toContain("npm run test-size:check");
    expect(staticRuns).toContain("npx vitest run test/skills-frontmatter.test.ts");
    expect(staticRuns).toContain("python3 scripts/generate-platform-docs.py --check");
    expect(staticRunsJoined).toContain(
      'HADOLINT_SHA256="6bf226944684f56c84dd014e8b979d27425c0148f61b3bd99bcc6f39e9dc5a47"',
    );
    expect(staticRunsJoined).not.toContain('"${HADOLINT_URL}.sha256"');
    expect(staticRunsJoined).not.toContain("EXPECTED=$(curl");

    expect(buildRuns.join("\n")).toContain("cd nemoclaw && npm install --ignore-scripts");
    expect(buildRuns).toContain("cd nemoclaw && npm run build");
    expect(buildRuns).toContain("npm run build:cli");
    expect(buildRuns).toContain("npx vitest run --project package-contract");
    expect(buildRuns).toContain("npm run typecheck:cli");
    expect(buildRuns).toContain("cd nemoclaw && npx tsc --noEmit --incremental");
    expect(buildRuns).toContain("npx tsc -p jsconfig.json");
    expect(buildRuns).toContain("bash scripts/check-version-tag-sync.sh");

    expect(cliShardRuns).toContain("cd nemoclaw && npm run build");
    expect(cliShardRuns).toContain("npm run build:cli");
    expect(cliShardRuns).toContain("npx tsx scripts/check-dist-sourcemaps.ts dist");
    expect(cliShardRuns).toContain("npx vitest run --project cli --project integration");
    expect(cliShardRuns).toContain('--coverage.include="src/**/*.ts"');
    expect(cliShardRuns).not.toContain('--coverage.include="dist/lib/**/*.js"');
    expect(cliShardRuns).toContain('--shard="${CLI_SHARD}/${CLI_SHARD_COUNT}"');
    expect(cliShardRuns).toContain("--reporter=github-actions");
    expect(cliShardRuns).toContain("--reporter=blob");
    expect(cliShardRuns).toContain(
      '--outputFile.blob=".vitest-reports/blob-${CLI_SHARD}-${CLI_SHARD_COUNT}.json"',
    );
    expect(cliShardRuns).toContain('--coverage.reportsDirectory="coverage/cli/shard-${CLI_SHARD}"');
    expect(cliShardRuns).not.toContain("${{ inputs.shard");
    expect(cliShardRuns).not.toContain("scripts/check-coverage-ratchet.ts");

    expect(cliMergeRuns).not.toContain("npm run build:cli");
    expect(cliMergeRuns).toContain("test -s dist/nemoclaw.js");
    expect(cliMergeRuns).toContain("npx tsx scripts/check-dist-sourcemaps.ts dist");
    expect(cliMergeRuns).toContain('blob=".vitest-reports/blob-${shard}-${CLI_SHARD_COUNT}.json"');
    expect(cliMergeRuns).toContain(
      'find .vitest-reports -maxdepth 1 -type f -name "blob-*-${CLI_SHARD_COUNT}.json"',
    );
    expect(cliMergeRuns).not.toContain("${{ inputs.shard-count");
    expect(cliMergeRuns).toContain("npx vitest --mergeReports .vitest-reports");
    expect(cliMergeRuns).toContain("--reporter=json");
    expect(cliMergeRuns).toContain("--outputFile.json=coverage/cli/vitest-results.json");
    expect(cliMergeRuns).toContain("--coverage.reportsDirectory=coverage/cli");
    expect(cliMergeRuns).toContain('--coverage.include="src/**/*.ts"');
    expect(cliMergeRuns).not.toContain('--coverage.include="dist/lib/**/*.js"');
    expect(cliMergeRuns).toContain(
      'scripts/check-coverage-ratchet.ts coverage/cli/coverage-summary.json ci/coverage-threshold-cli.json "CLI coverage"',
    );

    expect(pluginRuns).toContain("npx vitest run --project plugin");
    expect(pluginRuns).toContain(
      'scripts/check-coverage-ratchet.ts coverage/plugin/coverage-summary.json ci/coverage-threshold-plugin.json "Plugin coverage"',
    );

    expect(installerRuns).toContain("npm install --ignore-scripts");
    expect(installerRuns).toContain("cd nemoclaw && npm install --ignore-scripts");
    expect(installerRuns).toContain("npm run build:cli");
    expect(installerRuns).toContain("cd nemoclaw && npm run build");
    expect(installerRuns).toContain("CI=true npx vitest run --project installer-integration");
  });

  it("keeps PR coverage for non-opt-in Vitest projects after removing the self-hosted full run", () => {
    const vitestConfig = readFileSync("vitest.config.ts", "utf8");
    const cliShardRuns = stepRuns(sharedActions.cliCoverageShard).join("\n");
    const installerRuns = stepRuns(sharedActions.installerIntegration).join("\n");
    const prInstallerRuns = stepRuns(prWorkflow.jobs["installer-integration"]).join("\n");

    expect(installerRuns).toContain("CI=true npx vitest run --project installer-integration");
    expect(prInstallerRuns).toContain("CI=true npx vitest run --project installer-integration");
    expect(stepUses(prWorkflow.jobs["installer-integration"])).toContain(
      trustedPrActionPaths.installerIntegration,
    );
    expect(stepUses(mainWorkflow.jobs["installer-integration"])).toContain(
      sharedActionPaths.installerIntegration,
    );
    expect(vitestConfig).toContain('name: "installer-integration"');

    // Source and integration coverage are sharded together, while support,
    // installer, package, and live projects remain disjoint explicit lanes.
    expect(cliShardRuns).toContain("npx vitest run --project cli --project integration");
    expect(vitestConfig).toContain('name: "cli"');
    expect(vitestConfig).toContain('include: ["src/**/*.test.ts"]');
    expect(vitestConfig).toContain('name: "integration"');
    expect(vitestConfig).toContain('include: ["test/**/*.test.{js,ts}"]');
    expect(vitestConfig).toContain('name: "e2e-support"');
    expect(stepRuns(prWorkflow.jobs["e2e-support"])).toEqual([
      "npm ci --ignore-scripts",
      "npm run build:cli",
      "npx vitest run --project e2e-support",
    ]);
    expect(stepRuns(mainWorkflow.jobs["e2e-support"])).toEqual([
      "npm ci --ignore-scripts",
      "npm run build:cli",
      "npx vitest run --project e2e-support",
    ]);
    expect(vitestConfig).toContain('name: "package-contract"');
    expect(vitestConfig).toContain('"test/e2e/**"');
    expect(vitestConfig).toContain('"test/install-express-prompt.test.ts"');
    expect(vitestConfig).toContain('"test/install-preflight.test.ts"');
    expect(vitestConfig).toContain('"test/install-openshell-version-check.test.ts"');
  });

  it("validates CLI shard inputs before using them in shell commands", () => {
    const shardValidationStep = requiredStep(
      sharedActions.cliCoverageShard,
      "Validate shard inputs",
    );
    const shardValidationRun = shardValidationStep.run ?? "";
    const shardRunStep = requiredStep(sharedActions.cliCoverageShard, "Run CLI coverage shard");
    const mergeValidationStep = requiredStep(
      sharedActions.cliCoverageMerge,
      "Validate shard inputs",
    );
    const mergeValidationRun = mergeValidationStep.run ?? "";
    const mergeVerifyStep = requiredStep(
      sharedActions.cliCoverageMerge,
      "Verify CLI shard blob reports",
    );

    expect(shardValidationStep.env).toEqual({
      CLI_SHARD: "${{ inputs.shard }}",
      CLI_SHARD_COUNT: "${{ inputs.shard-count }}",
    });
    expect(shardValidationRun).toContain("*[!0-9]*");
    expect(shardValidationRun).toContain("Invalid CLI shard");
    expect(shardValidationRun).toContain("Invalid CLI shard count");
    expect(shardValidationRun).toContain("Invalid CLI shard range");
    expect(shardRunStep.env).toEqual({
      CLI_SHARD: "${{ inputs.shard }}",
      CLI_SHARD_COUNT: "${{ inputs.shard-count }}",
    });
    expect(requiredStepIndex(sharedActions.cliCoverageShard, "Validate shard inputs")).toBeLessThan(
      requiredStepIndex(sharedActions.cliCoverageShard, "Run CLI coverage shard"),
    );

    expect(mergeValidationStep.env).toEqual({
      CLI_SHARD_COUNT: "${{ inputs.shard-count }}",
    });
    expect(mergeValidationRun).toContain("*[!0-9]*");
    expect(mergeValidationRun).toContain("Invalid CLI shard count");
    expect(mergeVerifyStep.env).toEqual({
      CLI_SHARD_COUNT: "${{ inputs.shard-count }}",
    });
    expect(requiredStepIndex(sharedActions.cliCoverageMerge, "Validate shard inputs")).toBeLessThan(
      requiredStepIndex(sharedActions.cliCoverageMerge, "Verify CLI shard blob reports"),
    );
    expect(requiredStepIndex(sharedActions.cliCoverageMerge, "Validate shard inputs")).toBeLessThan(
      requiredStepIndex(sharedActions.cliCoverageMerge, "Merge CLI coverage"),
    );
  });

  it("keeps the trusted test-size guard closed around budget policy changes", () => {
    const growthGuardrails = readYaml<CodebaseGrowthGuardrailsWorkflow>(
      ".github/workflows/codebase-growth-guardrails.yaml",
    );
    const guardRun = stepRuns(growthGuardrails.jobs["codebase-growth-guardrails"]).join("\n");

    expect(guardRun).toContain("HEAD_REPO");
    expect(guardRun).toContain("HEAD_SHA");
    expect(guardRun).not.toContain(".raw_url");
    expect(guardRun).toContain("previous_filename");
    expect(guardRun).toContain("budgetChanged");
    expect(guardRun).toContain("has a legacy budget but no matching test file at the PR head");
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
    expect(sharedActions.cliCoverageShard.inputs?.["shard-count"]?.default).toBe(cliShardCount);
    expect(sharedActions.cliCoverageMerge.inputs?.["shard-count"]?.default).toBe(cliShardCount);

    const compiledCliUploadStep = requiredStep(
      sharedActions.cliCoverageShard,
      "Upload compiled CLI artifact",
    );
    const shardUploadStep = requiredStep(
      sharedActions.cliCoverageShard,
      "Upload CLI shard blob report",
    );
    const compiledCliDownloadStep = requiredStep(
      sharedActions.cliCoverageMerge,
      "Download compiled CLI artifact",
    );
    const downloadStep = requiredStep(
      sharedActions.cliCoverageMerge,
      "Download CLI shard blob reports",
    );
    const verifyRun = requiredStep(
      sharedActions.cliCoverageMerge,
      "Verify CLI shard blob reports",
    ).run;

    expect(compiledCliUploadStep.if).toBe(
      "${{ steps.validate-shard-inputs.outputs.upload_build_artifact == 'true' && success() }}",
    );
    expect(compiledCliUploadStep.uses).toContain("actions/upload-artifact@");
    expect(compiledCliUploadStep.with).toEqual({
      name: "cli-build-output",
      path: "dist",
      "if-no-files-found": "error",
      "retention-days": 1,
    });
    expect(
      requiredStepIndex(sharedActions.cliCoverageShard, "Build CLI for coverage shard"),
    ).toBeLessThan(
      requiredStepIndex(sharedActions.cliCoverageShard, "Upload compiled CLI artifact"),
    );
    expect(
      requiredStepIndex(sharedActions.cliCoverageShard, "Upload compiled CLI artifact"),
    ).toBeLessThan(requiredStepIndex(sharedActions.cliCoverageShard, "Run CLI coverage shard"));

    expect(shardUploadStep.if).toBe(
      "${{ always() && steps.validate-shard-inputs.outcome == 'success' }}",
    );
    expect(shardUploadStep.uses).toContain("actions/upload-artifact@");
    expect(shardUploadStep.with?.name).toBe("cli-blob-report-${{ inputs.shard }}");
    expect(shardUploadStep.with?.path).toBe(
      ".vitest-reports/blob-${{ inputs.shard }}-${{ inputs.shard-count }}.json",
    );
    expect(shardUploadStep.with?.["if-no-files-found"]).toBe("error");
    expect(shardUploadStep.with?.["retention-days"]).toBe(1);

    expect(compiledCliDownloadStep.uses).toContain("actions/download-artifact@");
    expect(compiledCliDownloadStep.with).toEqual({
      name: "cli-build-output",
      path: "dist",
    });
    expect(
      requiredStepIndex(sharedActions.cliCoverageMerge, "Download compiled CLI artifact"),
    ).toBeLessThan(
      requiredStepIndex(sharedActions.cliCoverageMerge, "Verify compiled CLI artifact"),
    );
    expect(
      requiredStepIndex(sharedActions.cliCoverageMerge, "Verify compiled CLI artifact"),
    ).toBeLessThan(
      requiredStepIndex(sharedActions.cliCoverageMerge, "Download CLI shard blob reports"),
    );

    expect(downloadStep.uses).toContain("actions/download-artifact@");
    expect(downloadStep.with?.pattern).toBe("cli-blob-report-*");
    expect(downloadStep.with?.path).toBe(".vitest-reports");
    expect(downloadStep.with?.["merge-multiple"]).toBe(true);

    expect(verifyRun).toContain('seq 1 "$CLI_SHARD_COUNT"');
    expect(verifyRun).toContain('[ ! -s "$blob" ]');
    expect(verifyRun).toContain("Expected ${CLI_SHARD_COUNT} blob reports");
    expect(stepRuns(sharedActions.cliCoverageMerge).join("\n")).toContain(
      'scripts/check-coverage-ratchet.ts coverage/cli/coverage-summary.json ci/coverage-threshold-cli.json "CLI coverage"',
    );
  });

  it("selects an available shard to publish the compiled CLI artifact", () => {
    for (const shardCount of [1, 2, 3, 5]) {
      const expectedProducer = Math.min(4, shardCount);
      const producers = Array.from({ length: shardCount }, (_, index) => index + 1).filter(
        (shard) => uploadsCompiledCliArtifact(sharedActions.cliCoverageShard, shard, shardCount),
      );

      expect(producers, `${shardCount} total shards`).toEqual([expectedProducer]);
    }
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
      "installer-integration",
      "cli-tests",
      "plugin-tests",
      "e2e-support",
      "test-e2e-ollama-proxy",
    ]);
    expect(prWorkflow.jobs["cli-tests"].needs).toEqual(["changes", "cli-test-shards"]);

    for (const jobName of [
      "changes",
      "static-checks",
      "build-typecheck",
      "installer-integration",
      "cli-tests",
      "plugin-tests",
      "e2e-support",
      "test-e2e-ollama-proxy",
    ]) {
      expect(prChecksRun).toContain(`require_success "${jobName}"`);
    }
    expect(prChecksRun).toContain('require_success "docs-only-checks"');

    expect(mainChecks.if).toBe("always()");
    expect(mainChecks.needs).toEqual([
      "static-checks",
      "build-typecheck",
      "installer-integration",
      "real-openclaw-dist-harness",
      "cli-tests",
      "plugin-tests",
      "e2e-support",
      "test-e2e-ollama-proxy",
    ]);
    expect(mainWorkflow.jobs["cli-tests"].needs).toBe("cli-test-shards");
    for (const jobName of [
      "static-checks",
      "build-typecheck",
      "installer-integration",
      "real-openclaw-dist-harness",
      "cli-tests",
      "plugin-tests",
      "e2e-support",
      "test-e2e-ollama-proxy",
    ]) {
      expect(mainChecksRun).toContain(`require_success "${jobName}"`);
    }
    expect(mainWorkflow.jobs["sandbox-images-and-e2e"].needs).toBe("checks");
  });

  it("exports immutable GHCR digests from the Hermes base resolver", () => {
    const runs = stepRuns(resolveHermesBaseAction).join("\n");

    expect(runs).toContain("docker image inspect");
    expect(runs).toContain("${image}@sha256:");
    expect(runs).toContain("mcp_client_imports_ok");
    expect(runs).toContain("Build-time package/import guard only");
    expect(runs).toContain("_MCP_HTTP_AVAILABLE");
    expect(runs).toContain("layout_ok");
    expect(runs).toContain("mapfile -t tracked_refs");
    expect(runs).toContain('candidates=("$tracked_ref")');
    expect(runs).toContain("HERMES_BASE_IMAGE=${digest_ref}");
    expect(runs).toContain("HERMES_BASE_IMAGE=nemoclaw-hermes-base-local");
  });

  it("rejects a pulled Hermes base without MCP HTTP imports and falls back locally", () => {
    const temp = mkdtempSync(join(tmpdir(), "nemoclaw-hermes-base-resolver-"));
    const fakeBin = join(temp, "bin");
    const dockerLog = join(temp, "docker.log");
    const githubEnv = join(temp, "github.env");
    const remoteDigest = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`;
    const resolver = requiredStep(resolveHermesBaseAction, "Resolve Hermes sandbox base image").run;

    try {
      mkdirSync(fakeBin);
      writeFileSync(githubEnv, "");
      writeFileSync(
        join(fakeBin, "docker"),
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          "const args = process.argv.slice(2);",
          'fs.appendFileSync(process.env.DOCKER_LOG, JSON.stringify(args) + "\\n");',
          'if (args[0] === "pull" || args[0] === "build") process.exit(0);',
          'if (args[0] === "image" && args[1] === "inspect") {',
          '  process.stdout.write(process.env.REMOTE_DIGEST + "\\n");',
          "  process.exit(0);",
          "}",
          'if (args[0] === "run") {',
          '  const entrypointIndex = args.indexOf("--entrypoint");',
          "  const entrypoint = args[entrypointIndex + 1];",
          "  const image = args[entrypointIndex + 2];",
          '  if (entrypoint === "/usr/bin/ldd") {',
          '    process.stdout.write("ldd (Ubuntu GLIBC 2.39) 2.39\\n");',
          "    process.exit(0);",
          "  }",
          '  if (entrypoint === "sh") process.exit(0);',
          '  if (entrypoint === "/opt/hermes/.venv/bin/python") {',
          "    process.exit(image === process.env.REMOTE_DIGEST ? 42 : 0);",
          "  }",
          "}",
          "console.error(`unexpected docker invocation: ${JSON.stringify(args)}`);",
          "process.exit(2);",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      // Keep the fake executable in a dedicated PATH directory so every other
      // command in the composite action remains the real host utility.
      const result = spawnSync("bash", ["-c", resolver ?? ""], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          DOCKER_LOG: dockerLog,
          GITHUB_ENV: githubEnv,
          GITHUB_SHA: "1".repeat(40),
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          REMOTE_DIGEST: remoteDigest,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("lacks the packaged MCP Streamable HTTP client imports");
      expect(result.stdout).toContain("building locally");
      expect(readFileSync(githubEnv, "utf8").trim()).toBe(
        "HERMES_BASE_IMAGE=nemoclaw-hermes-base-local",
      );

      const calls = readFileSync(dockerLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const firstPull = calls.find((args) => args[0] === "pull");
      expect(firstPull?.[0]).toBe("pull");
      expect(firstPull?.[1]).toMatch(
        /^ghcr\.io\/nvidia\/nemoclaw\/hermes-sandbox-base@sha256:[0-9a-f]{64}$/,
      );
      const remoteProbe = calls.findIndex(
        (args) => args.includes("/opt/hermes/.venv/bin/python") && args.includes(remoteDigest),
      );
      const localBuild = calls.findIndex((args) => args[0] === "build");
      const localProbe = calls.findIndex(
        (args) =>
          args.includes("/opt/hermes/.venv/bin/python") &&
          args.includes("nemoclaw-hermes-base-local"),
      );
      expect(remoteProbe).toBeGreaterThanOrEqual(0);
      expect(localBuild).toBeGreaterThan(remoteProbe);
      expect(localProbe).toBeGreaterThan(localBuild);
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
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
    const installerBootstrapInstall = stepRuns(prWorkflow.jobs["installer-integration"]).find(
      (run) => run.includes("npm install"),
    );
    expect(installerBootstrapInstall).toContain("npm install --ignore-scripts");
    expect(installerBootstrapInstall).toContain("cd nemoclaw && npm install --ignore-scripts");
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

          expect(step.with?.["persist-credentials"], `${workflowName} ${jobName}`).toBe(false);
        }
      }
    }
  });
});

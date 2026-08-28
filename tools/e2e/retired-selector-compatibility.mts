// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createPrivateRegularFile } from "./private-file.mts";
import * as importedRiskSignal from "./risk-signal.ts";
import {
  RETIRED_CONTROLLER_SELECTOR_IDS,
  RETIRED_CONTROLLER_TARGET_SELECTOR_IDS,
  readFreeStandingJobsInventory,
} from "./workflow-boundary.mts";

export { RETIRED_CONTROLLER_SELECTOR_IDS } from "./workflow-boundary.mts";

const riskSignal = (
  "default" in importedRiskSignal && importedRiskSignal.default
    ? importedRiskSignal.default
    : importedRiskSignal
) as typeof import("./risk-signal.ts");
const { buildRiskSignal, configuredRiskSignalEnvironment, RISK_SIGNAL_FILE } = riskSignal;

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SELECTOR_LIST_PATTERN = /^[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*$/u;

type RetiredControllerSelectorId = (typeof RETIRED_CONTROLLER_SELECTOR_IDS)[number];
type ReplacementTest = {
  files: readonly string[];
  project: "cli" | "integration" | "installer-integration" | "package-contract";
};
type Replacement = {
  legacyFile?: string;
  tests: readonly ReplacementTest[];
};

const RETIRED_SELECTOR_ID_SET = new Set<string>(RETIRED_CONTROLLER_SELECTOR_IDS);
const RETIRED_TARGET_SELECTOR_ID_SET = new Set<string>(RETIRED_CONTROLLER_TARGET_SELECTOR_IDS);
const REPLACEMENTS: Readonly<Record<RetiredControllerSelectorId, Replacement>> = {
  "credential-migration": {
    legacyFile: "test/e2e/live/credential-migration.test.ts",
    tests: [
      {
        files: ["test/credentials/credential-migration-reconciliation.test.ts"],
        project: "integration",
      },
    ],
  },
  "credential-sanitization": {
    legacyFile: "test/e2e/live/credential-sanitization.test.ts",
    tests: [
      {
        files: ["src/lib/security/credential-filter.test.ts"],
        project: "cli",
      },
    ],
  },
  diagnostics: {
    legacyFile: "test/e2e/live/diagnostics.test.ts",
    tests: [
      {
        files: ["test/package-contract/cli/debug-cli-command.test.ts"],
        project: "package-contract",
      },
    ],
  },
  "docs-validation": {
    legacyFile: "test/e2e/live/docs-validation.test.ts",
    tests: [
      {
        files: ["test/package-contract/cli/public-cli-contracts.test.ts"],
        project: "package-contract",
      },
    ],
  },
  "gateway-drift-preflight": {
    tests: [{ files: ["test/runtime/gateway/gateway-drift-preflight.test.ts"], project: "integration" }],
  },
  "gateway-health-honest": {
    legacyFile: "test/e2e/live/gateway-health-honest.test.ts",
    tests: [{ files: ["test/runtime/gateway/gateway-health-honest.test.ts"], project: "integration" }],
  },
  "onboard-negative-paths": {
    legacyFile: "test/e2e/live/onboard-negative-paths.test.ts",
    tests: [
      { files: ["test/credentials/credentials.test.ts"], project: "integration" },
      {
        files: ["test/package-contract/onboard/invalid-nvidia-key.test.ts"],
        project: "package-contract",
      },
    ],
  },
  "openshell-version-pin": {
    legacyFile: "test/e2e/live/openshell-version-pin.test.ts",
    tests: [
      {
        files: ["test/installer-integration/install-openshell-version-pin.test.ts"],
        project: "installer-integration",
      },
    ],
  },
  "sandbox-rebuild": {
    legacyFile: "test/e2e/live/sandbox-rebuild.test.ts",
    tests: [
      {
        files: [
          "src/lib/actions/sandbox/rebuild-flow-helpers.test.ts",
          "src/lib/actions/sandbox/rebuild-post-restore-phase.test.ts",
          "src/lib/actions/sandbox/rebuild-recreate-observability.test.ts",
        ],
        project: "cli",
      },
      {
        files: ["test/process-recovery/rebuild-stale-recovery.test.ts"],
        project: "integration",
      },
    ],
  },
  "ubuntu-repo-cli-smoke": {
    legacyFile: "test/e2e/live/ubuntu-repo-cli-smoke.test.ts",
    tests: [
      {
        files: ["test/package-contract/cli/public-cli-contracts.test.ts"],
        project: "package-contract",
      },
    ],
  },
  "upgrade-stale-sandbox": {
    legacyFile: "test/e2e/live/upgrade-stale-sandbox.test.ts",
    tests: [
      {
        files: [
          "src/lib/actions/sandbox/rebuild-route-preflight.test.ts",
          "src/lib/actions/upgrade-sandboxes-recovery.test.ts",
          "src/lib/sandbox/version.test.ts",
        ],
        project: "cli",
      },
      {
        files: ["test/cli/list-share-live-inference.test.ts"],
        project: "integration",
      },
    ],
  },
};

export function selectedRetiredControllerJobs(options: {
  allowedJobs: readonly string[];
  expectedSha?: string;
  jobs?: string;
  targets?: string;
}): RetiredControllerSelectorId[] {
  if (!SHA_PATTERN.test(options.expectedSha ?? "")) return [];
  for (const selectors of [options.jobs, options.targets]) {
    if (selectors && !SELECTOR_LIST_PATTERN.test(selectors)) {
      throw new Error(
        "retired selector compatibility requires comma-separated selector IDs containing only letters, numbers, underscores, and hyphens",
      );
    }
  }
  const allowedJobs = new Set(options.allowedJobs);
  const requestedJobs = options.jobs?.split(",") ?? [];
  const requestedTargets = (options.targets?.split(",") ?? []).filter((target) =>
    RETIRED_TARGET_SELECTOR_ID_SET.has(target),
  );
  return [
    ...new Set(
      [...requestedJobs, ...requestedTargets].filter(
        (selector): selector is RetiredControllerSelectorId =>
          RETIRED_SELECTOR_ID_SET.has(selector) && !allowedJobs.has(selector),
      ),
    ),
  ].sort();
}

type Command = { command: string; args: string[] };
type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
) => void;

function replacementCommands(selected: readonly RetiredControllerSelectorId[]): Command[] {
  const replacements = selected.map((id) => REPLACEMENTS[id]);
  const commands: Command[] = [];
  const filesByProject = new Map<ReplacementTest["project"], Set<string>>();
  for (const replacement of replacements) {
    for (const test of replacement.tests) {
      const files = filesByProject.get(test.project) ?? new Set<string>();
      for (const file of test.files) files.add(file);
      filesByProject.set(test.project, files);
    }
  }
  for (const project of [
    "cli",
    "integration",
    "installer-integration",
    "package-contract",
  ] as const) {
    const files = filesByProject.get(project);
    if (!files) continue;
    commands.push({
      command: "npx",
      args: ["vitest", "run", "--project", project, ...[...files].sort()],
    });
  }
  return commands;
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): void {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    killSignal: "SIGKILL",
    stdio: "inherit",
    timeout: 10 * 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with status ${result.status ?? "unknown"}`,
    );
  }
}

function verifyReplacementBoundary(
  selected: readonly RetiredControllerSelectorId[],
  repositoryRoot: string,
): void {
  for (const id of selected) {
    const replacement = REPLACEMENTS[id];
    if (
      replacement.legacyFile &&
      fs.existsSync(path.join(repositoryRoot, replacement.legacyFile))
    ) {
      throw new Error(`${id} compatibility requires its live E2E file to remain retired`);
    }
    for (const test of replacement.tests) {
      for (const file of test.files) {
        const fullPath = path.join(repositoryRoot, file);
        if (!fs.existsSync(fullPath)) {
          throw new Error(`${id} replacement test is missing: ${file}`);
        }
        if (fs.readFileSync(fullPath, "utf8").includes("@module-tag e2e/credential-free")) {
          throw new Error(`${id} replacement must remain in an ordinary Vitest project: ${file}`);
        }
      }
    }
  }
}

export function runRetiredSelectorCompatibility(
  environment: NodeJS.ProcessEnv,
  options: {
    allowedJobs?: readonly string[];
    repositoryRoot?: string;
    resolveHead?: (workspace: string) => string;
    runCommand?: CommandRunner;
  } = {},
): RetiredControllerSelectorId[] {
  const allowedJobs = options.allowedJobs ?? readFreeStandingJobsInventory().allowedJobs;
  const selected = selectedRetiredControllerJobs({
    allowedJobs,
    expectedSha: environment.NEMOCLAW_E2E_EXPECTED_SHA,
    jobs: environment.JOBS,
    targets: environment.TARGETS,
  });
  const output = environment.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required");
  fs.appendFileSync(output, `selected=${selected.length > 0}\n`, "utf8");
  if (selected.length === 0) return [];

  const repositoryRoot = options.repositoryRoot ?? REPO_ROOT;
  const artifactRoot = environment.E2E_ARTIFACT_DIR;
  if (!artifactRoot) throw new Error("E2E_ARTIFACT_DIR is required");
  verifyReplacementBoundary(selected, repositoryRoot);

  const commands = replacementCommands(selected);
  for (const command of commands) {
    (options.runCommand ?? runCommand)(command.command, command.args, repositoryRoot, environment);
  }

  fs.mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  for (const id of selected) {
    const signalDirectory = path.join(artifactRoot, id);
    fs.mkdirSync(signalDirectory, { recursive: true, mode: 0o700 });
    const signalEnvironment = configuredRiskSignalEnvironment(
      {
        ...environment,
        E2E_ARTIFACT_DIR: signalDirectory,
        E2E_TARGET_ID: id,
      },
      options.resolveHead,
    );
    if (!signalEnvironment) {
      throw new Error("retired selector compatibility requires a controller-bound risk signal");
    }
    const signal = buildRiskSignal(signalEnvironment, {
      passed: 1,
      failed: 0,
      skipped: 0,
      pending: 0,
      unhandledErrors: 0,
      runReason: "passed",
    });
    createPrivateRegularFile(
      path.join(signalDirectory, RISK_SIGNAL_FILE),
      `${JSON.stringify(signal, null, 2)}\n`,
    );
  }
  createPrivateRegularFile(
    path.join(artifactRoot, "retired-selector-compatibility.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "passed",
        selected,
        replacements: selected.map((id) => ({ id, ...REPLACEMENTS[id] })),
        commands,
      },
      null,
      2,
    )}\n`,
  );
  return selected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const selected = runRetiredSelectorCompatibility(process.env);
    if (selected.length > 0) {
      console.log(`Verified ordinary-test replacements for: ${selected.join(", ")}`);
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

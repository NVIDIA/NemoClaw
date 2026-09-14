// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Runs repository checks that Oxlint does not provide. */

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

type CheckCommand = {
  name: string;
  args: string[];
  inputs?: RegExp;
};

type CheckSpawnResult = {
  status: number | null;
  error?: Error;
};

type CheckSpawn = (command: string, args: string[], options: SpawnSyncOptions) => CheckSpawnResult;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = fileURLToPath(import.meta.resolve("tsx/cli"));
export const CHECKS: readonly CheckCommand[] = [
  {
    name: "direct-credential-env",
    inputs: /^src\/lib\/(?:onboard(?:\.ts|\/)|security\/)/,
    args: [
      "scripts/checks/direct-credential-env.mts",
      "src/lib/onboard.ts",
      "src/lib/onboard/provider-key-bridge.ts",
      "src/lib/onboard/providers.ts",
    ],
  },
  {
    name: "local-credential-helper-pin",
    inputs:
      /^(?:src\/lib\/security\/|docs\/resources\/(?:starter-prompt\.md|local-credential-form\.html)$)/,
    args: ["scripts/checks/local-credential-helper-pin.mts"],
  },
  {
    name: "hermes-light-skin-boundary",
    inputs: /^(?:agents\/hermes\/Dockerfile\.base$|src\/lib\/domain\/sandbox\/connect-env\.ts$)/,
    args: ["scripts/checks/hermes-light-skin-boundary.mts"],
  },
  {
    name: "dependency-pins",
    inputs:
      /^(?:Dockerfile(?:\.base)?$|agents\/(?:openclaw|hermes)\/|nemoclaw-blueprint\/blueprint\.yaml$|src\/lib\/(?:onboard\/|actions\/sandbox\/)|\.github\/workflows\/e2e\.yaml$)/,
    args: ["scripts/checks/dependency-pins.mts"],
  },
  {
    name: "no-defaulted-dependent-flags",
    inputs: /^(?:src|nemoclaw\/src)\//,
    args: ["scripts/checks/no-defaulted-dependent-flags.mts"],
  },
  {
    name: "no-coverage-ignore",
    inputs: /^(?:bin|src|scripts|test|nemoclaw\/src)\//,
    args: ["scripts/checks/no-coverage-ignore.mts"],
  },
  {
    name: "layer-import-boundaries",
    inputs: /^src\//,
    args: ["scripts/checks/layer-import-boundaries.mts"],
  },
  {
    name: "source-architecture",
    inputs: /^(?:src|nemoclaw\/src|agents\/hermes|bin|scripts|tools|nemoclaw-blueprint\/scripts)\//,
    args: ["scripts/checks/source-architecture.mts"],
  },
  {
    name: "onboard-entry-composition",
    inputs: /^src\/lib\/onboard\.ts$/,
    args: ["scripts/checks/onboard-entry-composition.mts"],
  },
  {
    name: "no-test-dist-imports",
    inputs: /\.[cm]?[jt]sx?$/,
    args: ["scripts/checks/no-test-dist-imports.mts"],
  },
  {
    name: "test-create-require-budget",
    inputs: /^(?:src|test)\//,
    args: ["scripts/checks/test-create-require-budget.mts"],
  },
  {
    name: "vitest-project-overlap",
    inputs: /^(?:src|test|nemoclaw\/src)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/,
    args: ["scripts/checks/vitest-project-overlap.mts"],
  },
  {
    name: "test-title-style",
    inputs: /^(?:src|test|nemoclaw\/src)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/,
    args: ["scripts/checks/test-title-style.mts"],
  },
  {
    name: "no-unit-blocks-in-live-e2e",
    inputs: /^test\/e2e\/live\//,
    args: ["scripts/checks/no-unit-blocks-in-live-e2e.mts"],
  },
  {
    name: "e2e-assertion-census",
    inputs: /^test\//,
    args: ["scripts/checks/e2e-assertion-census.mts", "--check"],
  },
  {
    name: "optimized-build-context-copy-sources",
    args: ["scripts/checks/optimized-build-context-copy-sources.mts"],
  },
  {
    name: "pi-qualification-receipt-refresh",
    args: ["scripts/checks/pi-qualification-receipt-refresh.mts"],
  },
  {
    name: "test-registration-boundary",
    inputs: /^(?:bin|nemoclaw\/src|scripts|src|test|tools)\//,
    args: ["scripts/checks/test-registration-boundary.mts"],
  },
  {
    name: "growth-guardrails-workflow-boundary",
    inputs:
      /^\.github\/(?:workflows\/codebase-growth-guardrails\.yaml|actions\/ci-static-checks\/action\.yaml)$/,
    args: ["scripts/checks/growth-guardrails-workflow-boundary.mts"],
  },
];

type RunChecksOptions = {
  checks?: readonly CheckCommand[];
  spawn?: CheckSpawn;
  exit?: (code?: number) => never;
  files?: readonly string[];
  report?: (line: string) => void;
  now?: () => number;
};

// Changes to checker implementations, shared helpers, budgets, or tool configuration
// invalidate every selector. Checks with transitive or dynamic inputs stay unconditional.
const SHARED_INPUT =
  /^(?:scripts\/|test\/helpers\/|ci\/|nemoclaw\/vitest\.project\.ts$|\.pre-commit-config\.yaml$)|(?:^|\/)(?:package(?:-lock)?\.json|\.npmrc|[^/]*config\.[^/]+)$/;

export function selectChecks(
  checks: readonly CheckCommand[],
  files?: readonly string[],
): readonly CheckCommand[] {
  if (files === undefined || files.some((file) => SHARED_INPUT.test(file))) return checks;
  return checks.filter(
    (check) => check.inputs === undefined || files.some((file) => check.inputs!.test(file)),
  );
}

export function changedCheckFiles(
  args: readonly string[],
  env = process.env,
  root = REPO_ROOT,
): string[] | undefined {
  if (args.length === 0) return undefined;
  if (args[0] !== "--files") throw new Error("Usage: checks:repository [--files PATH...]");
  // Prek omits deleted files. Disable rename detection so both sides remain inputs.
  const from = env.PRE_COMMIT_FROM_REF;
  const to = env.PRE_COMMIT_TO_REF;
  if (Boolean(from) !== Boolean(to)) throw new Error("Both comparison refs are required");
  if (from?.startsWith("-") || to?.startsWith("-")) throw new Error("Invalid comparison ref");
  const revisions = from && to ? [`${from}...${to}`] : ["--cached"];
  const result = spawnSync(
    "git",
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "--no-renames",
      "-z",
      ...revisions,
      "--",
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (result.error || result.status !== 0)
    throw new Error("Could not resolve repository check inputs", { cause: result.error });
  return [...new Set([...args.slice(1), ...result.stdout.split("\0").filter(Boolean)])];
}

export function runChecks(options: RunChecksOptions = {}): void {
  const available = options.checks ?? CHECKS;
  const checks = selectChecks(available, options.files);
  const spawn: CheckSpawn =
    options.spawn ?? ((command, args, spawnOptions) => spawnSync(command, args, spawnOptions));
  const exit = options.exit ?? process.exit;
  const report = options.report ?? console.log;
  const now = options.now ?? performance.now.bind(performance);
  report(
    `Repository checks: ${checks.length} selected, ${available.length - checks.length} unaffected`,
  );
  for (const check of checks) {
    const started = now();
    const result = spawn(process.execPath, [TSX, ...check.args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: "inherit",
    });
    report(
      `${check.name}: ${result.status === 0 ? "passed" : "failed"} (${Math.round(now() - started)} ms)`,
    );
    if (result.status !== 0) {
      console.error(`Check failed: ${check.name}`);
      if (result.status === null && result.error?.message) {
        console.error(result.error.message);
      }
      exit(result.status ?? 1);
    }
  }
}

const currentModule = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentModule) {
  runChecks({ files: changedCheckFiles(process.argv.slice(2)) });
}

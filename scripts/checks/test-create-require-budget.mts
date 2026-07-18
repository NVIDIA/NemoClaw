// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_TEST_ROOT = path.join(REPO_ROOT, "src");
const TEST_SUPPORT_ROOT = path.join(REPO_ROOT, "test");
const TEST_FILE_PATTERN = /\.test\.(?:[cm]?ts|tsx)$/;
const TYPESCRIPT_PATTERN = /\.(?:[cm]?ts|tsx)$/;

// Keep the exact paths rather than treating a scalar count as spare capacity.
// When another CommonJS test seam is retired, removing its path is part of
// that change; a different file cannot silently consume the freed slot.
export const CLI_CREATE_REQUIRE_FILES = [
  "src/lib/actions/sandbox/doctor-flow.test.ts",
  "src/lib/actions/sandbox/doctor-system-checks.test.ts",
  "src/lib/actions/sandbox/gateway-state-drift.test.ts",
  "src/lib/actions/sandbox/gateway-state-hints.test.ts",
  "src/lib/actions/sandbox/process-recovery-lock.test.ts",
  "src/lib/actions/sandbox/rebuild-agent-base-image-preflight.test.ts",
  "src/lib/actions/sandbox/rebuild-local-provider-recreate.test.ts",
  "src/lib/actions/sandbox/rebuild-resume-config.test.ts",
  "src/lib/actions/sandbox/rebuild-resume-reasoning.test.ts",
  "src/lib/actions/sandbox/sandbox-gateway-routing.test.ts",
  "src/lib/adapters/openshell/gateway-drift.test.ts",
  "src/lib/hermes-provider-auth.test.ts",
  "src/lib/inference/nim-igpu-compute-constrained.test.ts",
  "src/lib/inference/nim.test.ts",
  "src/lib/inference/ollama/proxy.test.ts",
  "src/lib/inference/ollama/windows.test.ts",
  "src/lib/onboard/sandbox-registration.test.ts",
  "src/lib/sandbox/privileged-exec.test.ts",
  "src/lib/shields/flow.test.ts",
  "src/lib/shields/legacy-hermes-compat.test.ts",
  "src/lib/shields/mutable-config-repair.test.ts",
  "src/lib/shields/openclaw-transition.test.ts",
  "src/lib/shields/policy-transition.test.ts",
  "src/lib/state/onboard-session-cross-process-lock.test.ts",
  "src/lib/state/onboard-session-tool-disclosure.test.ts",
  "src/lib/state/onboard-session.test.ts",
  "src/lib/state/user-managed-files-probe.test.ts",
] as const;

export const TEST_SUPPORT_CREATE_REQUIRE_FILES = [
  "test/fixtures/strict-tool-call-probe-driver.ts",
  "test/fixtures/uninstall-prompt-pty-driver.ts",
  "test/helpers/base-image-test-harness.ts",
  "test/helpers/destroy-flow-test-harness.ts",
  "test/helpers/rebuild-flow-harness.ts",
  "test/helpers/rebuild-flow-test-harness.ts",
  "test/support/connect-flow-test-harness.ts",
  "test/support/status-flow-test-harness.ts",
] as const;

export type CreateRequireAllowlists = Readonly<{
  cli: readonly string[];
  testSupport: readonly string[];
}>;

const ALLOWLIST_EXPORTS = {
  CLI_CREATE_REQUIRE_FILES: "cli",
  TEST_SUPPORT_CREATE_REQUIRE_FILES: "testSupport",
} as const;

function arrayLiteral(initializer: ts.Expression | undefined): ts.ArrayLiteralExpression | null {
  let expression = initializer;
  while (
    expression &&
    (ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isParenthesizedExpression(expression))
  ) {
    expression = expression.expression;
  }
  return expression && ts.isArrayLiteralExpression(expression) ? expression : null;
}

export function extractCreateRequireAllowlists(
  sourceText: string,
  fileName = "scripts/checks/test-create-require-budget.ts",
): CreateRequireAllowlists {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const values: Partial<Record<keyof CreateRequireAllowlists, string[]>> = {};

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const target = ALLOWLIST_EXPORTS[declaration.name.text as keyof typeof ALLOWLIST_EXPORTS];
      if (!target) continue;
      const array = arrayLiteral(declaration.initializer);
      if (!array || array.elements.some((element) => !ts.isStringLiteralLike(element))) {
        throw new Error(`${declaration.name.text} must be a literal string array`);
      }
      if (values[target]) throw new Error(`${declaration.name.text} must be declared exactly once`);
      values[target] = array.elements.map((element) => (element as ts.StringLiteralLike).text);
    }
  }

  if (!values.cli || !values.testSupport) {
    throw new Error("createRequire allowlist source must declare both reviewed allowlists");
  }
  return { cli: values.cli, testSupport: values.testSupport };
}

export function createRequireAllowlistExpansionFailure(
  current: CreateRequireAllowlists,
  baseline: CreateRequireAllowlists,
): string | null {
  const cliAdditions = current.cli.filter((file) => !baseline.cli.includes(file)).sort();
  const supportAdditions = current.testSupport
    .filter((file) => !baseline.testSupport.includes(file))
    .sort();
  if (cliAdditions.length === 0 && supportAdditions.length === 0) return null;

  return [
    "createRequire allowlists must not expand relative to the merge base.",
    ...cliAdditions.map((file) => `- CLI_CREATE_REQUIRE_FILES: ${file}`),
    ...supportAdditions.map((file) => `- TEST_SUPPORT_CREATE_REQUIRE_FILES: ${file}`),
  ].join("\n");
}

function mergeBaseAllowlists(): CreateRequireAllowlists | null {
  const baseBranch = process.env.GITHUB_BASE_REF?.trim();
  const baseRef = baseBranch ? `origin/${baseBranch}` : "origin/main";
  const mergeBase = spawnSync("git", ["merge-base", "HEAD", baseRef], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) {
    if (baseBranch) {
      throw new Error(`could not resolve the pull-request merge base against ${baseRef}`);
    }
    return null;
  }

  const revision = mergeBase.stdout.trim();
  for (const relativePath of [
    "scripts/checks/test-create-require-budget.mts",
    "scripts/checks/test-create-require-budget.ts",
  ]) {
    const source = spawnSync("git", ["show", `${revision}:${relativePath}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 5_000,
    });
    if (source.status === 0) return extractCreateRequireAllowlists(source.stdout, relativePath);
  }
  throw new Error(`merge base ${revision} does not contain the createRequire budget check`);
}

function* walkTypeScriptFiles(directory: string): Generator<string> {
  if (!existsSync(directory)) return;

  for (const entry of readdirSync(directory)) {
    const absolutePath = path.join(directory, entry);
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      yield* walkTypeScriptFiles(absolutePath);
    } else if (stats.isFile() && TYPESCRIPT_PATTERN.test(entry)) {
      yield absolutePath;
    }
  }
}

export function containsCreateRequireIdentifier(
  sourceText: string,
  fileName = "example.test.ts",
): boolean {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let found = false;

  // Count identifiers in executable syntax, including property access, because
  // either can introduce a loader seam. Literal text cannot invoke createRequire.
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === "createRequire") {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

export function collectCliCreateRequireTests(root = CLI_TEST_ROOT): string[] {
  return [...walkTypeScriptFiles(root)]
    .filter((absolutePath) => TEST_FILE_PATTERN.test(absolutePath))
    .filter((absolutePath) =>
      containsCreateRequireIdentifier(readFileSync(absolutePath, "utf8"), absolutePath),
    )
    .map((absolutePath) => path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/"))
    .sort();
}

function collectNonTestCreateRequireSources(root: string): string[] {
  return [...walkTypeScriptFiles(root)]
    .filter((absolutePath) => !TEST_FILE_PATTERN.test(absolutePath))
    .filter((absolutePath) =>
      containsCreateRequireIdentifier(readFileSync(absolutePath, "utf8"), absolutePath),
    )
    .map((absolutePath) => path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/"))
    .sort();
}

export function collectProductionCreateRequireSources(root = CLI_TEST_ROOT): string[] {
  return collectNonTestCreateRequireSources(root);
}

export function collectTestSupportCreateRequireSources(root = TEST_SUPPORT_ROOT): string[] {
  return collectNonTestCreateRequireSources(root);
}

export function createRequireBudgetFailure(
  files: readonly string[],
  allowedFiles: readonly string[] = CLI_CREATE_REQUIRE_FILES,
): string | null {
  const actual = new Set(files);
  const allowed = new Set(allowedFiles);
  const added = [...actual].filter((file) => !allowed.has(file)).sort();
  const removed = [...allowed].filter((file) => !actual.has(file)).sort();
  if (added.length === 0 && removed.length === 0) return null;

  const lines = ["CLI createRequire path budget failed."];
  if (added.length > 0) {
    lines.push(
      "",
      "Replace new CommonJS test seams with native imports or explicit dependencies:",
      ...added.map((file) => `- ${file}`),
    );
  }
  if (removed.length > 0) {
    lines.push(
      "",
      "Remove retired paths from CLI_CREATE_REQUIRE_FILES so they cannot return:",
      ...removed.map((file) => `- ${file}`),
    );
  }
  return lines.join("\n");
}

function main(): void {
  const baseline = mergeBaseAllowlists();
  const expansionFailure = baseline
    ? createRequireAllowlistExpansionFailure(
        {
          cli: CLI_CREATE_REQUIRE_FILES,
          testSupport: TEST_SUPPORT_CREATE_REQUIRE_FILES,
        },
        baseline,
      )
    : null;
  if (expansionFailure) {
    console.error(expansionFailure);
    process.exitCode = 1;
    return;
  }

  const productionFiles = collectProductionCreateRequireSources();
  if (productionFiles.length > 0) {
    console.error(
      [
        "Production TypeScript must not introduce createRequire boundaries.",
        "Use static imports, explicit dependencies, or retain a genuine CommonJS boundary outside src/.",
        "",
        ...productionFiles.map((file) => `- ${file}`),
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const files = collectCliCreateRequireTests();
  const failure = createRequireBudgetFailure(files);
  if (failure) {
    console.error(failure);
    process.exitCode = 1;
    return;
  }

  const supportFiles = collectTestSupportCreateRequireSources();
  const supportFailure = createRequireBudgetFailure(
    supportFiles,
    TEST_SUPPORT_CREATE_REQUIRE_FILES,
  );
  if (supportFailure) {
    console.error(
      supportFailure
        .replace("CLI createRequire", "Test-support createRequire")
        .replaceAll("CLI_CREATE_REQUIRE_FILES", "TEST_SUPPORT_CREATE_REQUIRE_FILES"),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `CLI createRequire budget passed: ${files.length} CLI test file(s), ${supportFiles.length} support file(s).`,
  );
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main();
}

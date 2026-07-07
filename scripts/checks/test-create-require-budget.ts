// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

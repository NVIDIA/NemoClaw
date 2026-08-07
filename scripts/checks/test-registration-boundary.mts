// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

export type TestRegistrationViolation = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly call: string;
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_SCAN_ROOTS = Object.freeze([
  "bin",
  "nemoclaw/src",
  "scripts",
  "src",
  "test",
  "tools",
]);
const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const SUITE_FILE_PATTERN = /-suite\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set([".git", ".venv", "coverage", "dist", "node_modules"]);
const REGISTRATION_NAMES = new Set(["describe", "it", "suite", "test"]);
const REGISTRATION_MODIFIERS = new Set([
  "concurrent",
  "each",
  "fails",
  "for",
  "only",
  "runIf",
  "scoped",
  "sequential",
  "skip",
  "skipIf",
  "todo",
]);

type CallChain = {
  readonly rootName: string;
  readonly rootNode: ts.Identifier;
  readonly members: readonly string[];
};

type VitestBindings = {
  readonly registrations: ReadonlyMap<string, string>;
  readonly namespaces: ReadonlySet<string>;
};

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function collectVitestBindings(sourceFile: ts.SourceFile): VitestBindings {
  const registrations = new Map<string, string>();
  const namespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "vitest"
    ) {
      continue;
    }
    const importClause = statement.importClause;
    if (importClause === undefined || importClause.isTypeOnly) continue;

    const bindings = importClause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const importedName = element.propertyName?.text ?? element.name.text;
      if (REGISTRATION_NAMES.has(importedName)) {
        registrations.set(element.name.text, importedName);
      }
    }
  }

  return { registrations, namespaces };
}

function callChain(expression: ts.Expression): CallChain | null {
  if (ts.isIdentifier(expression)) {
    return { rootName: expression.text, rootNode: expression, members: [] };
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const inner = callChain(expression.expression);
    if (inner === null) return null;
    return { ...inner, members: [...inner.members, expression.name.text] };
  }
  if (ts.isCallExpression(expression)) return callChain(expression.expression);
  return null;
}

function registrationCall(chain: CallChain, bindings: VitestBindings): string | null {
  const imported = bindings.registrations.get(chain.rootName);
  const name = imported ?? (bindings.namespaces.has(chain.rootName) ? chain.members[0] : undefined);
  const modifiers = imported === undefined ? chain.members.slice(1) : chain.members;
  if (name === undefined || !REGISTRATION_NAMES.has(name)) return null;
  if (!modifiers.every((modifier) => REGISTRATION_MODIFIERS.has(modifier))) return null;
  return [chain.rootName, ...chain.members].join(".");
}

export function scanTestRegistrations(
  file: string,
  source: string,
): readonly TestRegistrationViolation[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );
  const bindings = collectVitestBindings(sourceFile);
  if (bindings.registrations.size === 0 && bindings.namespaces.size === 0) return [];

  const violations: TestRegistrationViolation[] = [];
  const reported = new Set<number>();

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const chain = callChain(node.expression);
      const call = chain === null ? null : registrationCall(chain, bindings);
      if (chain !== null && call !== null) {
        const start = chain.rootNode.getStart(sourceFile);
        if (!reported.has(start)) {
          reported.add(start);
          const location = sourceFile.getLineAndCharacterOfPosition(start);
          violations.push({
            file,
            line: location.line + 1,
            column: location.character + 1,
            call,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

export function isScannedModule(file: string): boolean {
  const name = path.basename(file);
  return (
    SOURCE_FILE_PATTERN.test(name) &&
    !TEST_FILE_PATTERN.test(name) &&
    !SUITE_FILE_PATTERN.test(name)
  );
}

function isSkipped(absolutePath: string): boolean {
  const segments = path.relative(REPO_ROOT, absolutePath).split(path.sep);
  return segments.some((segment) => SKIP_DIRS.has(segment));
}

function* walkModules(directory: string): Generator<string> {
  if (!existsSync(directory) || isSkipped(directory)) return;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = path.join(directory, entry.name);
    if (isSkipped(absolutePath)) continue;
    if (entry.isDirectory()) {
      yield* walkModules(absolutePath);
    } else if (entry.isFile() && isScannedModule(entry.name)) {
      yield absolutePath;
    }
  }
}

export function findTestRegistrationViolations(
  roots: readonly string[] = DEFAULT_SCAN_ROOTS,
): readonly TestRegistrationViolation[] {
  const violations: TestRegistrationViolation[] = [];
  for (const root of roots) {
    const absoluteRoot = path.resolve(REPO_ROOT, root);
    for (const absolutePath of walkModules(absoluteRoot)) {
      const file = path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
      violations.push(...scanTestRegistrations(file, readFileSync(absolutePath, "utf8")));
    }
  }
  return violations;
}

export function formatViolations(violations: readonly TestRegistrationViolation[]): string {
  const lines = [
    "Test registration boundary check failed.",
    "",
    "These modules register Vitest tests, but Vitest does not collect them as test",
    "files. Their cases run only when a collected test file imports the module, and",
    "not at all when nothing imports it. Either way the cases stay outside the",
    "vitest-project-overlap, test file size budget, and test-title-style checks.",
    "",
    "Fix: move each registration into a collected test file — root test/**/*.test.ts,",
    "a co-located src/**/*.test.ts, or test/e2e/support/**. Rename the module to",
    "*-suite.ts only when a collected test file imports it to register shared tests.",
    "",
  ];
  for (const violation of violations) {
    lines.push(`- ${violation.file}:${violation.line}:${violation.column} ${violation.call}(...)`);
  }
  return lines.join("\n");
}

function main(): void {
  const violations = findTestRegistrationViolations();
  if (violations.length === 0) {
    console.log("Test registration boundary check passed.");
    return;
  }

  console.error(formatViolations(violations));
  console.error(`Found ${violations.length} test registration violation(s).`);
  process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  main();
}

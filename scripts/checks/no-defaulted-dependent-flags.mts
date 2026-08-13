// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Guard oclif flag definitions against combining `default` with `dependsOn`.
 *
 * oclif validates dependsOn whenever the flag has a value. A parser default
 * always supplies one, so oclif rejects every invocation that omits the
 * dependency. Apply defaults in the action layer instead, as channels status
 * does for --timeout (#8883).
 *
 * The scan covers direct `Flags.<method>({...})` object literals. Options
 * passed through `Flags.custom` factories, spread composition, or aliased
 * imports are out of scope; no flag under `src` or `nemoclaw/src` combines
 * them with dependsOn today.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_ROOTS = ["src", "nemoclaw/src"];
const SKIP_DIRS = new Set([".git", "coverage", "dist", "node_modules"]);

export interface DefaultedDependentFlagViolation {
  filePath: string;
  line: number;
  flagName: string;
}

function flagObjectPropertyNames(node: ts.ObjectLiteralExpression): string[] {
  return node.properties.flatMap((property) =>
    (ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property) ||
      ts.isMethodDeclaration(property)) &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ? [property.name.text]
      : [],
  );
}

function flagNameFor(callExpression: ts.CallExpression): string {
  const parent = callExpression.parent;
  return ts.isPropertyAssignment(parent) &&
    (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
    ? parent.name.text
    : "(unnamed flag)";
}

export function findDefaultedDependentFlags(
  sourceText: string,
  filePath: string,
): DefaultedDependentFlagViolation[] {
  if (!sourceText.includes("dependsOn")) return [];
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const violations: DefaultedDependentFlagViolation[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Flags" &&
      node.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const names = flagObjectPropertyNames(node.arguments[0]);
      if (names.includes("dependsOn") && names.includes("default")) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({ filePath, line: line + 1, flagName: flagNameFor(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export function checkFiles(filePaths: readonly string[]): DefaultedDependentFlagViolation[] {
  return filePaths.flatMap((filePath) => {
    const absolutePath = path.resolve(REPO_ROOT, filePath);
    return findDefaultedDependentFlags(
      fs.readFileSync(absolutePath, "utf-8"),
      path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/"),
    );
  });
}

export function formatViolations(
  violations: readonly DefaultedDependentFlagViolation[],
): string {
  return [
    "oclif flags must not combine a parser default with dependsOn.",
    "The default gives the flag a value on every parse, so oclif applies",
    "dependsOn validation and rejects each invocation that omits the",
    "dependency (#8883). Apply the default in the action layer instead.",
    "",
    ...violations.map(
      (violation) => `${violation.filePath}:${violation.line} ${violation.flagName}`,
    ),
  ].join("\n");
}

export function isScannedSourcePath(filePath: string): boolean {
  return (
    SCAN_ROOTS.some((root) => filePath.startsWith(`${root}/`)) &&
    filePath.endsWith(".ts") &&
    !filePath.endsWith(".test.ts") &&
    !filePath.endsWith(".test-helpers.ts") &&
    !filePath.endsWith(".d.ts")
  );
}

function sourceFiles(): string[] {
  return SCAN_ROOTS.flatMap((root) => [...walkSourceFiles(path.join(REPO_ROOT, root))])
    .map((filePath) => path.relative(REPO_ROOT, filePath).split(path.sep).join("/"))
    .filter(isScannedSourcePath);
}

function* walkSourceFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkSourceFiles(fullPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) yield fullPath;
  }
}

function normalizeCliPaths(args: readonly string[]): string[] {
  return args
    .filter((arg) => arg !== "--")
    .map((arg) => path.relative(REPO_ROOT, path.resolve(arg)).split(path.sep).join("/"))
    .filter(isScannedSourcePath);
}

function main(): void {
  const cliPaths = normalizeCliPaths(process.argv.slice(2));
  const filePaths = cliPaths.length > 0 ? cliPaths : sourceFiles();
  const violations = checkFiles(filePaths);
  if (violations.length > 0) {
    console.error(formatViolations(violations));
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main();
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

type Violation = { file: string; line: number; detail: string };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP_DIRS = new Set([".git", "coverage", "dist", "node_modules"]);
const EXCLUDED_FILES = new Set([
  "test/dist-sourcemaps.test.ts",
  "test/install-express-prompt.test.ts",
  "test/install-openshell-version-check.test.ts",
  "test/install-preflight-docker-bootstrap.test.ts",
  "test/install-preflight.test.ts",
  "test/stale-dist-check.test.ts",
]);
const EXCLUDED_PREFIXES = ["test/e2e/", "test/e2e-scenario/live/", "test/package-contract/"];

function repoPath(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
}

function isScannedTestFile(absolutePath: string): boolean {
  const relativePath = repoPath(absolutePath);
  if (EXCLUDED_FILES.has(relativePath)) return false;
  if (EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) return false;
  if (relativePath.startsWith("src/")) return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath);
  return relativePath.startsWith("test/") && /\.[cm]?[jt]sx?$/.test(relativePath);
}

function* walk(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolutePath = path.join(directory, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) yield* walk(absolutePath);
    else if (stats.isFile() && isScannedTestFile(absolutePath)) yield absolutePath;
  }
}

function isCompiledInternalSpecifier(specifier: string): boolean {
  const normalized = specifier.replaceAll("\\", "/");
  return (
    /(^|\/)dist\/(?:lib|commands)(?:\/|$)/.test(normalized) ||
    /(^|\/)dist\/nemoclaw(?:\.js)?$/.test(normalized)
  );
}

function findViolations(absolutePath: string): Violation[] {
  const source = readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(
    absolutePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    absolutePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const file = repoPath(absolutePath);
  const violations: Violation[] = [];

  function add(node: ts.Node, detail: string): void {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ file, line: position.line + 1, detail });
  }

  function checkSpecifier(node: ts.Node, specifier: string): void {
    if (isCompiledInternalSpecifier(specifier)) {
      add(node, `imports compiled CLI internals from ${JSON.stringify(specifier)}`);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      checkSpecifier(node.moduleSpecifier, node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      checkSpecifier(node.moduleSpecifier, node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireResolve =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "require" &&
        node.expression.name.text === "resolve";
      const firstArgument = node.arguments[0];
      if (
        (isRequire || isDynamicImport || isRequireResolve) &&
        firstArgument &&
        ts.isStringLiteralLike(firstArgument)
      ) {
        checkSpecifier(firstArgument, firstArgument.text);
      }

      const isPathBuilder =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "path" &&
        ["join", "resolve"].includes(node.expression.name.text);
      if (isPathBuilder) {
        const parts = node.arguments.map((argument) =>
          ts.isStringLiteralLike(argument) ? argument.text : null,
        );
        const distIndex = parts.indexOf("dist");
        const compiledTarget = distIndex >= 0 ? parts[distIndex + 1] : null;
        if (compiledTarget === "lib" || compiledTarget === "commands") {
          add(node, `constructs a path into dist/${compiledTarget}`);
        } else if (distIndex >= 0 && compiledTarget === "nemoclaw.js") {
          add(node, "constructs a path to dist/nemoclaw.js");
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  for (const match of source.matchAll(/require\([^\n)]*(?:\.\/|\.\.\/)dist\/(?:lib|commands)\//g)) {
    const position = sourceFile.getLineAndCharacterOfPosition(match.index);
    violations.push({
      file,
      line: position.line + 1,
      detail: "embeds a compiled-internal require in generated test code",
    });
  }
  return violations;
}

const violations = [...walk(path.join(REPO_ROOT, "src")), ...walk(path.join(REPO_ROOT, "test"))]
  .flatMap(findViolations)
  .filter(
    (violation, index, all) =>
      all.findIndex(
        (candidate) => candidate.file === violation.file && candidate.line === violation.line,
      ) === index,
  );

if (violations.length > 0) {
  console.error(
    "Compiled CLI internals may only be imported by the package-contract test project:",
  );
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} ${violation.detail}`);
  }
  console.error(
    "Import src/ instead, or move a genuine compiled-package contract under test/package-contract/.",
  );
  process.exit(1);
}

console.log("Test imports respect the source/package boundary.");

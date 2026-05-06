// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

type Violation = {
  file: string;
  line: number;
  column: number;
  rule: string;
  detail: string;
};

type ImportRef = {
  specifier: string;
  line: number;
  column: number;
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_LIB_ROOT = path.join(REPO_ROOT, "src", "lib");
const SKIP_DIRS = new Set([".git", "coverage", "dist", "node_modules"]);

function toRepoPath(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

function isProductionTsFile(absPath: string): boolean {
  return absPath.endsWith(".ts") && !absPath.endsWith(".test.ts") && !absPath.endsWith(".spec.ts");
}

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absPath = path.join(dir, entry);
    const stats = statSync(absPath);
    if (stats.isDirectory()) {
      yield* walk(absPath);
    } else if (stats.isFile() && isProductionTsFile(absPath)) {
      yield absPath;
    }
  }
}

function sourceFileFor(absPath: string): ts.SourceFile {
  return ts.createSourceFile(
    absPath,
    readFileSync(absPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function position(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: pos.line + 1, column: pos.character + 1 };
}

function collectImportRefs(absPath: string): ImportRef[] {
  const sourceFile = sourceFileFor(absPath);
  const refs: ImportRef[] = [];

  function add(specifier: string, node: ts.Node): void {
    const pos = position(sourceFile, node);
    refs.push({ specifier, ...pos });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      add(node.arguments[0].text, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return refs;
}

function resolveInternalImport(fromAbsPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromAbsPath), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ? toRepoPath(found) : toRepoPath(`${base}.ts`);
}

function isDomainFile(repoPath: string): boolean {
  return repoPath.startsWith("src/lib/domain/");
}

function isAdapterFile(repoPath: string): boolean {
  return repoPath.startsWith("src/lib/adapters/");
}

function isCommandFile(repoPath: string): boolean {
  return repoPath.startsWith("src/lib/commands/");
}

function isActionFile(repoPath: string): boolean {
  if (repoPath.startsWith("src/lib/actions/")) return true;
  return /(^|\/)[^/]+-actions?\.ts$/.test(repoPath);
}

function isGeneratedOrRegistryCommandFile(repoPath: string): boolean {
  return repoPath === "src/lib/commands/index.ts" || repoPath.endsWith("/common.ts");
}

function importTargetsForbiddenLayer(
  fromAbsPath: string,
  ref: ImportRef,
  forbiddenPrefixes: readonly string[],
  forbiddenActionFiles = false,
): string | null {
  const target = resolveInternalImport(fromAbsPath, ref.specifier);
  if (!target) return null;
  if (forbiddenPrefixes.some((prefix) => target.startsWith(prefix))) return target;
  if (forbiddenActionFiles && isActionFile(target)) return target;
  return null;
}

function addViolation(
  violations: Violation[],
  file: string,
  line: number,
  column: number,
  rule: string,
  detail: string,
): void {
  violations.push({ file, line, column, rule, detail });
}

function checkDomainFile(absPath: string, repoPath: string, violations: Violation[]): void {
  const imports = collectImportRefs(absPath);
  for (const ref of imports) {
    if (ref.specifier === "@oclif/core") {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "domain-purity",
        "domain must not import @oclif/core",
      );
    }
    if (ref.specifier === "node:child_process" || ref.specifier === "child_process") {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "domain-purity",
        "domain must not spawn child processes",
      );
    }
    const target = importTargetsForbiddenLayer(
      absPath,
      ref,
      ["src/lib/adapters/", "src/lib/commands/", "src/lib/cli/"],
      true,
    );
    if (target) {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "domain-purity",
        `domain must not import ${target}`,
      );
    }
  }

  const sourceFile = sourceFileFor(absPath);
  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "exit"
    ) {
      const pos = position(sourceFile, node);
      addViolation(
        violations,
        repoPath,
        pos.line,
        pos.column,
        "domain-purity",
        "domain must not call process.exit",
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function checkActionFile(absPath: string, repoPath: string, violations: Violation[]): void {
  for (const ref of collectImportRefs(absPath)) {
    if (ref.specifier === "@oclif/core") {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "actions-no-oclif",
        "actions must not import @oclif/core",
      );
    }
  }
}

function checkAdapterFile(absPath: string, repoPath: string, violations: Violation[]): void {
  for (const ref of collectImportRefs(absPath)) {
    const target = importTargetsForbiddenLayer(absPath, ref, ["src/lib/commands/"], true);
    if (target) {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "adapters-no-workflows",
        `adapters must not import command/action layer module ${target}`,
      );
    }
  }
}

function checkCommandFile(absPath: string, repoPath: string, violations: Violation[]): void {
  if (isGeneratedOrRegistryCommandFile(repoPath)) return;
  const sourceFile = sourceFileFor(absPath);
  let commandClassCount = 0;

  function isCommandBase(expression: ts.ExpressionWithTypeArguments): boolean {
    const text = expression.expression.getText(sourceFile);
    return text === "Command" || text === "NemoClawCommand";
  }

  function visit(node: ts.Node): void {
    if (
      ts.isClassDeclaration(node) &&
      node.heritageClauses?.some((clause) => clause.types.some(isCommandBase))
    ) {
      commandClassCount += 1;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (commandClassCount !== 1) {
    addViolation(
      violations,
      repoPath,
      1,
      1,
      "one-command-per-file",
      `command files must define exactly one registered oclif command class; found ${commandClassCount}`,
    );
  }
}

export function findLayerImportBoundaryViolations(root = SRC_LIB_ROOT): Violation[] {
  const violations: Violation[] = [];
  for (const absPath of walk(root)) {
    const repoPath = toRepoPath(absPath);
    if (isDomainFile(repoPath)) checkDomainFile(absPath, repoPath, violations);
    if (isActionFile(repoPath)) checkActionFile(absPath, repoPath, violations);
    if (isAdapterFile(repoPath)) checkAdapterFile(absPath, repoPath, violations);
    if (isCommandFile(repoPath)) checkCommandFile(absPath, repoPath, violations);
  }
  return violations;
}

function main(): void {
  const violations = findLayerImportBoundaryViolations();
  if (violations.length > 0) {
    const formatted = violations
      .map(
        (violation) =>
          `${violation.file}:${String(violation.line)}:${String(violation.column)} ${violation.rule}: ${violation.detail}`,
      )
      .join("\n");
    console.error(`Layer import boundary violations:\n${formatted}`);
    process.exit(1);
  }
  console.log("Layer import boundaries passed.");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  main();
}

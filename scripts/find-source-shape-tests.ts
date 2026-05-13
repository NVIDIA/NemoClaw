#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Finds tests that read production source text and assert on its shape. These
// tests tend to couple coverage to implementation strings instead of behavior.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

type SourceRead = {
  readonly line: number;
  readonly column: number;
  readonly variable: string;
  readonly expression: string;
};

type Assertion = {
  readonly line: number;
  readonly column: number;
  readonly subject: string;
  readonly matcher: string;
  readonly text: string;
};

type SourceShapeCase = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly name: string;
  readonly assertions: readonly Assertion[];
  readonly sourceReads: readonly SourceRead[];
};

type Report = {
  readonly summary: {
    readonly source_shape_cases: number;
    readonly source_shape_assertions: number;
    readonly source_shape_files: number;
    readonly source_shape_max_cases_per_file: number;
  };
  readonly cases: readonly SourceShapeCase[];
};

type VariableDecl = {
  readonly name: string;
  readonly initializer: ts.Expression;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_NAME_PATTERN = /\.(test|spec)\.(js|ts|mjs|mts|cjs|cts)$/;
const SKIP_DIRS = new Set([
  ".git",
  ".venv",
  "coverage",
  "dist",
  "docs/_build",
  "nemoclaw/dist",
  "nemoclaw/node_modules",
  "node_modules",
]);

function normalizePathText(text: string): string {
  return text.replaceAll("\\", "/");
}

function isSkippedPath(absPath: string): boolean {
  const rel = normalizePathText(relative(REPO_ROOT, absPath));
  return [...SKIP_DIRS].some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

function* walkFiles(dir: string): Generator<string> {
  if (!existsSync(dir) || isSkippedPath(dir)) return;

  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (isSkippedPath(abs)) continue;

    const stats = statSync(abs);
    if (stats.isDirectory()) {
      yield* walkFiles(abs);
    } else if (stats.isFile()) {
      yield abs;
    }
  }
}

function isTestFile(absPath: string): boolean {
  const rel = normalizePathText(relative(REPO_ROOT, absPath));
  return TEST_NAME_PATTERN.test(basename(rel));
}

function textContainsIdentifier(text: string, identifier: string): boolean {
  return new RegExp(`\\b${escapeRegExp(identifier)}\\b`).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeTestFixturePath(text: string): boolean {
  const normalized = normalizePathText(text);
  return (
    /Dockerfile\.sandbox/.test(normalized) ||
    /["'`]test["'`]/.test(normalized) ||
    /\.agents\/skills/.test(normalized)
  );
}

function isProductionPathExpression(
  text: string,
  productionPathVars: ReadonlySet<string>,
): boolean {
  const normalized = normalizePathText(text);
  if (looksLikeTestFixturePath(normalized)) return false;
  if ([...productionPathVars].some((name) => textContainsIdentifier(normalized, name))) return true;

  return hasDirectProductionPathHint(normalized);
}

function hasDirectProductionPathHint(text: string): boolean {
  return (
    /Dockerfile(?:\.base)?\b/.test(text) ||
    /["'`]\.\.\/bin\//.test(text) ||
    /["'`]\.\.\/scripts\//.test(text) ||
    /["'`]\.\.\/src\//.test(text) ||
    /["'`]\.\.\/dist\//.test(text) ||
    /["'`]scripts["'`]/.test(text) ||
    /["'`]src["'`]/.test(text) ||
    /["'`]dist["'`]/.test(text) ||
    /["'`]nemoclaw-blueprint["'`]/.test(text) ||
    /["'`]nemoclaw["'`].*["'`]src["'`]/.test(text) ||
    /["'`](nemoclaw|nemohermes)\.js["'`]/.test(text)
  );
}

function isPathLikeVariableName(name: string): boolean {
  return /(path|file|script|source|src|dockerfile|payload|installer)/i.test(name);
}

function isReadFileCall(node: ts.CallExpression): boolean {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) {
    return expression.text === "readFileSync" || expression.text === "readFile";
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "readFileSync" || expression.name.text === "readFile";
  }
  return false;
}

function isSourceTextLikeName(name: string): boolean {
  return /(src|source|text|content|body|block|snippet|heredoc|docker|script|shell|fn|lines?|matches|calls|usages)/i.test(
    name,
  );
}

function isTextDerivation(initText: string): boolean {
  return /(\.match(All)?\b|\.slice\b|\.split\b|\.replace(All)?\b|\.trim(End)?\b|\.join\b|String\(|Heredoc\b|Snippet\b|Block\b|extract[A-Z])/.test(
    initText,
  );
}

function collectVariableDecls(sourceFile: ts.SourceFile): VariableDecl[] {
  const variables: VariableDecl[] = [];

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      variables.push({ name: node.name.text, initializer: node.initializer });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return variables;
}

function isAncestor(ancestor: ts.Node, node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function nearestLexicalScope(node: ts.Node): ts.Block | ts.SourceFile {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isBlock(current)) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

function scopedVariableDecls(
  sourceFile: ts.SourceFile,
  variables: readonly VariableDecl[],
  testCall: ts.CallExpression,
  body: ts.Node,
): VariableDecl[] {
  return variables.filter((variable) => {
    if (isAncestor(body, variable.initializer)) return true;
    const scope = nearestLexicalScope(variable.initializer);
    return scope === sourceFile || isAncestor(scope, testCall);
  });
}

function collectProductionPathVars(
  sourceFile: ts.SourceFile,
  variables: readonly VariableDecl[],
): Set<string> {
  const pathVars = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    for (const variable of variables) {
      if (pathVars.has(variable.name)) continue;
      const initText = normalizePathText(variable.initializer.getText(sourceFile));
      const directlyNamesProductionPath = hasDirectProductionPathHint(initText);
      const derivesNamedProductionPath =
        isPathLikeVariableName(variable.name) &&
        [...pathVars].some((name) => textContainsIdentifier(initText, name));
      if (
        !looksLikeTestFixturePath(initText) &&
        (directlyNamesProductionPath || derivesNamedProductionPath)
      ) {
        pathVars.add(variable.name);
        changed = true;
      }
    }
  }

  return pathVars;
}

function sourceReadFromInitializer(
  sourceFile: ts.SourceFile,
  variable: VariableDecl,
  productionPathVars: ReadonlySet<string>,
): SourceRead | null {
  const init = variable.initializer;
  if (!ts.isCallExpression(init) || !isReadFileCall(init) || init.arguments.length === 0) {
    return null;
  }

  const targetText = init.arguments[0].getText(sourceFile);
  if (!isProductionPathExpression(targetText, productionPathVars)) {
    return null;
  }

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    variable.initializer.getStart(),
  );
  return {
    line: line + 1,
    column: character + 1,
    variable: variable.name,
    expression: variable.initializer.getText(sourceFile),
  };
}

function collectSourceVars(
  sourceFile: ts.SourceFile,
  variables: readonly VariableDecl[],
  productionPathVars: ReadonlySet<string>,
): { sourceVars: Set<string>; sourceReads: SourceRead[] } {
  const sourceVars = new Set<string>();
  const sourceReads: SourceRead[] = [];

  for (const variable of variables) {
    const sourceRead = sourceReadFromInitializer(sourceFile, variable, productionPathVars);
    if (sourceRead) {
      sourceVars.add(variable.name);
      sourceReads.push(sourceRead);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const variable of variables) {
      if (sourceVars.has(variable.name)) continue;
      const initText = variable.initializer.getText(sourceFile);
      const referencesSource = [...sourceVars].some((name) =>
        textContainsIdentifier(initText, name),
      );
      if (referencesSource && (isSourceTextLikeName(variable.name) || isTextDerivation(initText))) {
        sourceVars.add(variable.name);
        changed = true;
      }
    }
  }

  return { sourceVars, sourceReads };
}

function getExpectBase(expression: ts.Expression): ts.CallExpression | null {
  if (ts.isCallExpression(expression)) {
    if (ts.isIdentifier(expression.expression) && expression.expression.text === "expect") {
      return expression;
    }
    return getExpectBase(expression.expression);
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return getExpectBase(expression.expression);
  }
  return null;
}

function matcherName(expression: ts.Expression): string {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (ts.isCallExpression(expression)) {
    return matcherName(expression.expression);
  }
  return expression.getText();
}

function assertionFromCall(
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  sourceVars: ReadonlySet<string>,
  productionPathVars: ReadonlySet<string>,
): Assertion | null {
  const expectBase = getExpectBase(node.expression);
  if (!expectBase || expectBase.arguments.length === 0) {
    return null;
  }

  const subjectExpr = expectBase.arguments[0];
  const subject = subjectExpr.getText(sourceFile);
  const referencesSource = [...sourceVars].some((name) => textContainsIdentifier(subject, name));
  const directSourceRead =
    ts.isCallExpression(subjectExpr) &&
    isReadFileCall(subjectExpr) &&
    subjectExpr.arguments.length > 0 &&
    isProductionPathExpression(subjectExpr.arguments[0].getText(sourceFile), productionPathVars);
  if (!referencesSource && !directSourceRead) {
    return null;
  }

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return {
    line: line + 1,
    column: character + 1,
    subject,
    matcher: matcherName(node.expression),
    text: node.getText(sourceFile).replace(/\s+/g, " "),
  };
}

function isTestCallee(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text === "it" || expression.text === "test";
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      expression.name.text === "it" ||
      expression.name.text === "test" ||
      isTestCallee(expression.expression)
    );
  }
  if (ts.isCallExpression(expression)) {
    return isTestCallee(expression.expression);
  }
  return false;
}

function isTestCall(node: ts.CallExpression): boolean {
  return isTestCallee(node.expression);
}

function testCaseName(sourceFile: ts.SourceFile, node: ts.CallExpression): string {
  const first = node.arguments[0];
  if (!first) return "<unnamed>";
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
    return first.text;
  }
  return first.getText(sourceFile).replace(/\s+/g, " ");
}

function testBody(node: ts.CallExpression): ts.Node | null {
  for (const arg of node.arguments) {
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      return arg.body;
    }
  }
  return null;
}

function collectAssertionsInNode(
  sourceFile: ts.SourceFile,
  root: ts.Node,
  sourceVars: ReadonlySet<string>,
  productionPathVars: ReadonlySet<string>,
): Assertion[] {
  const assertions: Assertion[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const assertion = assertionFromCall(sourceFile, node, sourceVars, productionPathVars);
      if (assertion) assertions.push(assertion);
    }
    ts.forEachChild(node, visit);
  }

  visit(root);
  return assertions;
}

function scanFile(absPath: string): SourceShapeCase[] {
  const relPath = normalizePathText(relative(REPO_ROOT, absPath));
  const text = readFileSync(absPath, "utf-8");
  const sourceFile = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true);
  const allVariables = collectVariableDecls(sourceFile);

  const cases: SourceShapeCase[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isTestCall(node)) {
      const body = testBody(node);
      if (body) {
        const variables = scopedVariableDecls(sourceFile, allVariables, node, body);
        const productionPathVars = collectProductionPathVars(sourceFile, variables);
        const { sourceVars, sourceReads } = collectSourceVars(
          sourceFile,
          variables,
          productionPathVars,
        );
        const assertions = collectAssertionsInNode(
          sourceFile,
          body,
          sourceVars,
          productionPathVars,
        );
        if (assertions.length > 0) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          cases.push({
            file: relPath,
            line: line + 1,
            column: character + 1,
            name: testCaseName(sourceFile, node),
            assertions,
            sourceReads,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return cases;
}

function scan(): Report {
  const cases = [...walkFiles(REPO_ROOT)].filter(isTestFile).flatMap(scanFile);
  const casesPerFile = new Map<string, number>();
  for (const entry of cases) {
    casesPerFile.set(entry.file, (casesPerFile.get(entry.file) ?? 0) + 1);
  }

  return {
    summary: {
      source_shape_cases: cases.length,
      source_shape_assertions: cases.reduce((sum, entry) => sum + entry.assertions.length, 0),
      source_shape_files: casesPerFile.size,
      source_shape_max_cases_per_file: Math.max(0, ...casesPerFile.values()),
    },
    cases,
  };
}

function printMetrics(report: Report): void {
  for (const [name, value] of Object.entries(report.summary)) {
    console.log(`METRIC ${name}=${value}`);
  }
}

function printHuman(report: Report): void {
  if (report.cases.length === 0) {
    console.log("No source-shape tests detected.");
    printMetrics(report);
    return;
  }

  console.log(`Detected ${report.summary.source_shape_cases} source-shape test cases:`);
  for (const testCase of report.cases) {
    console.log(`- ${testCase.file}:${testCase.line}:${testCase.column} ${testCase.name}`);
    for (const assertion of testCase.assertions) {
      console.log(
        `  - ${assertion.line}:${assertion.column} ${assertion.matcher} on ${assertion.subject}`,
      );
    }
  }
  printMetrics(report);
}

function checkBudget(report: Report): void {
  const budgetPath = join(REPO_ROOT, "ci", "source-shape-test-budget.json");
  const budget = JSON.parse(readFileSync(budgetPath, "utf-8")) as {
    readonly maxSourceShapeCases?: unknown;
  };
  if (typeof budget.maxSourceShapeCases !== "number") {
    throw new Error(`${budgetPath} must define numeric maxSourceShapeCases`);
  }

  const actual = report.summary.source_shape_cases;
  if (actual > budget.maxSourceShapeCases) {
    console.error(
      `Source-shape test budget exceeded: ${actual} cases > ${budget.maxSourceShapeCases}.`,
    );
    console.error("Replace source-text assertions with behavior tests, then ratchet the budget.");
    process.exitCode = 1;
  }
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const report = scan();

  if (args.has("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else if (args.has("--metrics")) {
    printMetrics(report);
  } else {
    printHuman(report);
  }

  if (args.has("--check")) {
    checkBudget(report);
  }
}

main();

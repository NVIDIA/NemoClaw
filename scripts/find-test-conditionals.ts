#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Finds `if` statements in test files. Branching inside tests often hides two
// test paths in one case, makes failures environment-dependent, or lets missing
// fixtures silently skip assertions.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export type TestConditionalContextKind = "test" | "hook" | "suite" | "helper" | "top-level";

export type TestConditionalOccurrence = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly condition: string;
  readonly contextKind: TestConditionalContextKind;
  readonly contextName: string | null;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly hasElse: boolean;
  readonly containsAssertion: boolean;
  readonly containsControlFlow: boolean;
  readonly inLoop: boolean;
  readonly nestedDepth: number;
  readonly branchLines: number;
  readonly branchStatementCount: number;
};

export type TestConditionalFileSummary = {
  readonly file: string;
  readonly count: number;
  readonly score: number;
  readonly testBodyCount: number;
  readonly assertionBranchCount: number;
  readonly maxScore: number;
};

export type TestConditionalReport = {
  readonly summary: {
    readonly scannedFiles: number;
    readonly filesWithConditionals: number;
    readonly conditionalCount: number;
    readonly testBodyConditionalCount: number;
    readonly assertionBranchCount: number;
    readonly highScoreCount: number;
  };
  readonly files: readonly TestConditionalFileSummary[];
  readonly occurrences: readonly TestConditionalOccurrence[];
};

type CallbackContext = {
  readonly kind: TestConditionalContextKind;
  readonly name: string | null;
};

type CliOptions = {
  readonly json: boolean;
  readonly top: number;
  readonly minScore: number;
  readonly roots: readonly string[];
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SCAN_ROOTS = Object.freeze(["test", "src", "nemoclaw/src"]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]s)$/;
const HIGH_SCORE_THRESHOLD = 8;
const TEST_CALL_NAMES = new Set(["it", "test"]);
const HOOK_CALL_NAMES = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll"]);
const SUITE_CALL_NAMES = new Set(["describe"]);
const ASSERTION_CALL_NAMES = new Set(["expect", "assert"]);
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

function toRepoPath(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

function isSkipped(absPath: string): boolean {
  const rel = toRepoPath(absPath);
  return [...SKIP_DIRS].some((skipDir) => rel === skipDir || rel.startsWith(`${skipDir}/`));
}

function* walkFiles(dir: string): Generator<string> {
  if (!existsSync(dir) || isSkipped(dir)) return;

  for (const entry of readdirSync(dir)) {
    const absPath = path.join(dir, entry);
    if (isSkipped(absPath)) continue;

    const stats = statSync(absPath);
    if (stats.isDirectory()) {
      yield* walkFiles(absPath);
    } else if (stats.isFile() && TEST_FILE_PATTERN.test(entry)) {
      yield absPath;
    }
  }
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  return /\.[cm]?js$/i.test(filePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength = 140): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function getLine(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function getLineColumn(
  sourceFile: ts.SourceFile,
  position: number,
): { line: number; column: number } {
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: location.line + 1, column: location.character + 1 };
}

function expressionName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function isNamedCall(expression: ts.Expression, names: ReadonlySet<string>): boolean {
  const name = expressionName(expression);
  return name !== null && names.has(name);
}

function rootCallName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootCallName(expression.expression);
  if (ts.isCallExpression(expression)) return rootCallName(expression.expression);
  return null;
}

function firstStringArgument(call: ts.CallExpression): string | null {
  const first = call.arguments[0];
  if (first === undefined) return null;
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
  return null;
}

function callbackContextForFunction(node: ts.Node): CallbackContext | null {
  const parent = node.parent;
  if (!ts.isCallExpression(parent)) return null;

  const rootName = rootCallName(parent.expression);
  if (rootName !== null && TEST_CALL_NAMES.has(rootName)) {
    return { kind: "test", name: firstStringArgument(parent) };
  }
  if (rootName !== null && HOOK_CALL_NAMES.has(rootName)) {
    return { kind: "hook", name: rootName };
  }
  if (rootName !== null && SUITE_CALL_NAMES.has(rootName)) {
    return { kind: "suite", name: firstStringArgument(parent) };
  }
  return null;
}

function isFunctionLikeNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function descendantMatches(node: ts.Node, predicate: (child: ts.Node) => boolean): boolean {
  let found = false;

  function visit(child: ts.Node): void {
    if (found) return;
    if (predicate(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  }

  ts.forEachChild(node, visit);
  return found;
}

function descendantStatementCount(node: ts.Statement | undefined): number {
  if (node === undefined) return 0;
  let count = 0;

  function visit(child: ts.Node): void {
    if (ts.isStatement(child)) count += 1;
    ts.forEachChild(child, visit);
  }

  visit(node);
  return count;
}

function nearestContext(contexts: readonly CallbackContext[]): CallbackContext | null {
  return contexts.at(-1) ?? null;
}

function classifyContext(
  contexts: readonly CallbackContext[],
  functionDepth: number,
): CallbackContext {
  const context = nearestContext(contexts);
  if (context !== null) return context;
  if (functionDepth > 0) return { kind: "helper", name: null };
  return { kind: "top-level", name: null };
}

function hasAncestor(node: ts.Node, predicate: (ancestor: ts.Node) => boolean): boolean {
  let parent = node.parent;
  while (parent !== undefined) {
    if (predicate(parent)) return true;
    parent = parent.parent;
  }
  return false;
}

function countIfAncestors(node: ts.Node): number {
  let depth = 0;
  let parent = node.parent;
  while (parent !== undefined) {
    if (ts.isIfStatement(parent)) depth += 1;
    parent = parent.parent;
  }
  return depth;
}

function isLoop(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function computeScore(input: {
  readonly contextKind: TestConditionalContextKind;
  readonly hasElse: boolean;
  readonly containsAssertion: boolean;
  readonly containsControlFlow: boolean;
  readonly inLoop: boolean;
  readonly nestedDepth: number;
  readonly branchLines: number;
  readonly branchStatementCount: number;
  readonly condition: string;
}): { score: number; reasons: string[] } {
  let score = 1;
  const reasons: string[] = [];

  if (input.contextKind === "test") {
    score += 4;
    reasons.push("inside test body");
  } else if (input.contextKind === "hook") {
    score += 3;
    reasons.push("inside test hook");
  } else if (input.contextKind === "suite") {
    score += 2;
    reasons.push("inside describe callback");
  } else if (input.contextKind === "helper") {
    score += 1;
    reasons.push("inside test helper");
  }

  if (input.containsAssertion) {
    score += 4;
    reasons.push("branches assertions");
  }
  if (input.containsControlFlow) {
    score += 2;
    reasons.push("branches return/throw/break/continue");
  }
  if (input.hasElse) {
    score += 1;
    reasons.push("has else branch");
  }
  if (input.inLoop) {
    score += 2;
    reasons.push("inside loop");
  }
  if (input.nestedDepth > 0) {
    score += input.nestedDepth * 2;
    reasons.push(`nested ${input.nestedDepth} level(s)`);
  }
  if (input.branchStatementCount >= 8) {
    score += 2;
    reasons.push(`${input.branchStatementCount} branch statements`);
  }
  if (input.branchLines >= 50) {
    score += 5;
    reasons.push(`${input.branchLines} branch lines`);
  } else if (input.branchLines >= 20) {
    score += 2;
    reasons.push(`${input.branchLines} branch lines`);
  }
  if (
    /\b(?:process\.env|process\.platform|os\.platform|CI|BREV|SKIP|RUN_E2E)\b/.test(input.condition)
  ) {
    score += 1;
    reasons.push("environment-sensitive condition");
  }

  return { score, reasons };
}

function scanIfStatement(
  node: ts.IfStatement,
  sourceFile: ts.SourceFile,
  contexts: readonly CallbackContext[],
  functionDepth: number,
  file: string,
): TestConditionalOccurrence {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const branchLines = Math.max(1, getLine(sourceFile, end) - getLine(sourceFile, start) + 1);
  const condition = truncate(normalizeWhitespace(node.expression.getText(sourceFile)));
  const containsAssertion =
    descendantMatches(
      node.thenStatement,
      (child) => ts.isCallExpression(child) && isNamedCall(child.expression, ASSERTION_CALL_NAMES),
    ) ||
    (node.elseStatement !== undefined &&
      descendantMatches(
        node.elseStatement,
        (child) =>
          ts.isCallExpression(child) && isNamedCall(child.expression, ASSERTION_CALL_NAMES),
      ));
  const containsControlFlow = descendantMatches(
    node,
    (child) =>
      ts.isReturnStatement(child) ||
      ts.isThrowStatement(child) ||
      ts.isBreakStatement(child) ||
      ts.isContinueStatement(child),
  );
  const context = classifyContext(contexts, functionDepth);
  const branchStatementCount =
    descendantStatementCount(node.thenStatement) + descendantStatementCount(node.elseStatement);
  const input = {
    contextKind: context.kind,
    hasElse: node.elseStatement !== undefined,
    containsAssertion,
    containsControlFlow,
    inLoop: hasAncestor(node, isLoop),
    nestedDepth: countIfAncestors(node),
    branchLines,
    branchStatementCount,
    condition,
  };
  const { score, reasons } = computeScore(input);
  const { line, column } = getLineColumn(sourceFile, start);

  return {
    file,
    line,
    column,
    condition,
    contextKind: context.kind,
    contextName: context.name,
    score,
    reasons,
    hasElse: input.hasElse,
    containsAssertion,
    containsControlFlow,
    inLoop: input.inLoop,
    nestedDepth: input.nestedDepth,
    branchLines,
    branchStatementCount,
  };
}

export function scanTextForTestConditionals(
  file: string,
  sourceText: string,
): TestConditionalOccurrence[] {
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );
  const occurrences: TestConditionalOccurrence[] = [];
  const contexts: CallbackContext[] = [];
  let functionDepth = 0;

  function visit(node: ts.Node): void {
    let pushedContext = false;
    let enteredFunction = false;

    if (isFunctionLikeNode(node)) {
      functionDepth += 1;
      enteredFunction = true;
      const context = callbackContextForFunction(node);
      if (context !== null) {
        contexts.push(context);
        pushedContext = true;
      }
    }

    if (ts.isIfStatement(node)) {
      occurrences.push(scanIfStatement(node, sourceFile, contexts, functionDepth, file));
    }

    ts.forEachChild(node, visit);

    if (pushedContext) contexts.pop();
    if (enteredFunction) functionDepth -= 1;
  }

  visit(sourceFile);
  return occurrences;
}

function summarizeFiles(
  occurrences: readonly TestConditionalOccurrence[],
): TestConditionalFileSummary[] {
  const summaries = new Map<string, TestConditionalFileSummary>();

  for (const occurrence of occurrences) {
    const previous = summaries.get(occurrence.file) ?? {
      file: occurrence.file,
      count: 0,
      score: 0,
      testBodyCount: 0,
      assertionBranchCount: 0,
      maxScore: 0,
    };
    summaries.set(occurrence.file, {
      file: occurrence.file,
      count: previous.count + 1,
      score: previous.score + occurrence.score,
      testBodyCount: previous.testBodyCount + (occurrence.contextKind === "test" ? 1 : 0),
      assertionBranchCount: previous.assertionBranchCount + (occurrence.containsAssertion ? 1 : 0),
      maxScore: Math.max(previous.maxScore, occurrence.score),
    });
  }

  return [...summaries.values()].sort(
    (a, b) => b.score - a.score || b.count - a.count || a.file.localeCompare(b.file),
  );
}

export function collectTestConditionals(roots = DEFAULT_SCAN_ROOTS): TestConditionalReport {
  const absFiles = roots.flatMap((root) => [...walkFiles(path.join(REPO_ROOT, root))]);
  const occurrences = absFiles
    .flatMap((absPath) =>
      scanTextForTestConditionals(toRepoPath(absPath), readFileSync(absPath, "utf-8")),
    )
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  const files = summarizeFiles(occurrences);

  return {
    summary: {
      scannedFiles: absFiles.length,
      filesWithConditionals: files.length,
      conditionalCount: occurrences.length,
      testBodyConditionalCount: occurrences.filter((entry) => entry.contextKind === "test").length,
      assertionBranchCount: occurrences.filter((entry) => entry.containsAssertion).length,
      highScoreCount: occurrences.filter((entry) => entry.score >= HIGH_SCORE_THRESHOLD).length,
    },
    files,
    occurrences,
  };
}

function formatContext(occurrence: TestConditionalOccurrence): string {
  const name = occurrence.contextName === null ? "" : `: ${occurrence.contextName}`;
  return `${occurrence.contextKind}${name}`;
}

function formatOccurrence(occurrence: TestConditionalOccurrence): string {
  const reasons = occurrence.reasons.length > 0 ? occurrence.reasons.join(", ") : "plain branch";
  return [
    `- ${occurrence.file}:${occurrence.line}:${occurrence.column}`,
    `score=${occurrence.score}`,
    `[${formatContext(occurrence)}]`,
    `if (${occurrence.condition})`,
    `— ${reasons}`,
  ].join(" ");
}

export function formatReport(
  report: TestConditionalReport,
  options: Pick<CliOptions, "top">,
): string {
  const lines = [
    `Scanned ${report.summary.scannedFiles} test files; found ${report.summary.conditionalCount} if statement(s) in ${report.summary.filesWithConditionals} file(s).`,
    `${report.summary.testBodyConditionalCount} are inside test bodies; ${report.summary.assertionBranchCount} branch assertions; ${report.summary.highScoreCount} score >= ${HIGH_SCORE_THRESHOLD}.`,
    "",
    "Top files by conditional score:",
  ];

  for (const file of report.files.slice(0, options.top)) {
    lines.push(
      `- ${file.file}: score=${file.score}, ifs=${file.count}, test-body=${file.testBodyCount}, assertion-branches=${file.assertionBranchCount}, max=${file.maxScore}`,
    );
  }

  lines.push("", "Most egregious if statements:");
  for (const occurrence of report.occurrences.slice(0, options.top)) {
    lines.push(formatOccurrence(occurrence));
  }

  return lines.join("\n");
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const roots: string[] = [];
  let json = false;
  let top = 20;
  let minScore = 1;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--top") {
      top = parsePositiveInt(argv[++index] ?? "", "--top");
    } else if (arg === "--min-score") {
      minScore = parsePositiveInt(argv[++index] ?? "", "--min-score");
    } else if (arg === "--root") {
      roots.push(argv[++index] ?? "");
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: tsx scripts/find-test-conditionals.ts [--top N] [--min-score N] [--root PATH] [--json]\n\nScans test/spec files under test, src, and nemoclaw/src by default.`,
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (roots.some((root) => root.trim() === "")) throw new Error("--root requires a path");
  return { json, top, minScore, roots: roots.length > 0 ? roots : DEFAULT_SCAN_ROOTS };
}

function filterReport(report: TestConditionalReport, minScore: number): TestConditionalReport {
  if (minScore <= 1) return report;
  const occurrences = report.occurrences.filter((entry) => entry.score >= minScore);
  const files = summarizeFiles(occurrences);
  return {
    summary: {
      ...report.summary,
      filesWithConditionals: files.length,
      conditionalCount: occurrences.length,
      testBodyConditionalCount: occurrences.filter((entry) => entry.contextKind === "test").length,
      assertionBranchCount: occurrences.filter((entry) => entry.containsAssertion).length,
      highScoreCount: occurrences.filter((entry) => entry.score >= HIGH_SCORE_THRESHOLD).length,
    },
    files,
    occurrences,
  };
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = filterReport(collectTestConditionals(options.roots), options.minScore);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(formatReport(report, options));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main();
}

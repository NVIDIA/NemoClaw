#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Finds `for` loops that make test cases or generated test definitions
// iterative. Independent rows should use it.each or test.each so each failure
// identifies one behavior. Required iteration can stay in a named helper
// outside the test callback.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export type TestLoopContextKind = "test" | "hook" | "suite" | "helper" | "top-level";

export type TestLoopKind = "for" | "for-await-of" | "for-in" | "for-of";

export type TestLoopOccurrence = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly kind: TestLoopKind;
  readonly contextKind: TestLoopContextKind;
  readonly contextName: string | null;
};

export type TestLoopFileSummary = {
  readonly file: string;
  readonly count: number;
};

export type TestLoopReport = {
  readonly summary: {
    readonly scannedFiles: number;
    readonly filesWithLoops: number;
    readonly loopCount: number;
  };
  readonly files: readonly TestLoopFileSummary[];
  readonly occurrences: readonly TestLoopOccurrence[];
};

type CallbackContext = {
  readonly kind: TestLoopContextKind;
  readonly name: string | null;
};

type CliOptions = {
  readonly json: boolean;
  readonly top: number;
  readonly roots: readonly string[];
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_SCAN_ROOTS = Object.freeze(["test", "src", "nemoclaw/src"]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]s)$/;
const TEST_CALL_NAMES = new Set(["it", "test"]);
const HOOK_CALL_NAMES = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll"]);
const SUITE_CALL_NAMES = new Set(["describe"]);
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

function classifyContext(
  contexts: readonly CallbackContext[],
  functionDepth: number,
): CallbackContext {
  const context = contexts.at(-1);
  if (context !== undefined) return context;
  if (functionDepth > 0) return { kind: "helper", name: null };
  return { kind: "top-level", name: null };
}

function loopKind(node: ts.Node): TestLoopKind | null {
  if (ts.isForStatement(node)) return "for";
  if (ts.isForInStatement(node)) return "for-in";
  if (ts.isForOfStatement(node))
    return node.awaitModifier === undefined ? "for-of" : "for-await-of";
  return null;
}

function containsTestDefinition(node: ts.Node): boolean {
  let found = false;

  function visit(child: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(child)) {
      const rootName = rootCallName(child.expression);
      if (rootName !== null && TEST_CALL_NAMES.has(rootName)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  }

  ts.forEachChild(node, visit);
  return found;
}

export function scanTextForTestLoops(file: string, sourceText: string): TestLoopOccurrence[] {
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );
  const occurrences: TestLoopOccurrence[] = [];
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

    const kind = loopKind(node);
    if (kind !== null) {
      const context = classifyContext(contexts, functionDepth);
      if (context.kind === "test" || containsTestDefinition(node)) {
        const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        occurrences.push({
          file,
          line: location.line + 1,
          column: location.character + 1,
          kind,
          contextKind: context.kind,
          contextName: context.name,
        });
      }
    }

    ts.forEachChild(node, visit);

    if (pushedContext) contexts.pop();
    if (enteredFunction) functionDepth -= 1;
  }

  visit(sourceFile);
  return occurrences;
}

function summarizeFiles(occurrences: readonly TestLoopOccurrence[]): TestLoopFileSummary[] {
  const counts = new Map<string, number>();
  for (const occurrence of occurrences) {
    counts.set(occurrence.file, (counts.get(occurrence.file) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

export function collectTestLoops(roots = DEFAULT_SCAN_ROOTS): TestLoopReport {
  const absFiles = roots.flatMap((root) => [...walkFiles(path.join(REPO_ROOT, root))]);
  const occurrences = absFiles
    .flatMap((absPath) => scanTextForTestLoops(toRepoPath(absPath), readFileSync(absPath, "utf-8")))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  const files = summarizeFiles(occurrences);
  return {
    summary: {
      scannedFiles: absFiles.length,
      filesWithLoops: files.length,
      loopCount: occurrences.length,
    },
    files,
    occurrences,
  };
}

function formatContext(occurrence: TestLoopOccurrence): string {
  const name = occurrence.contextName === null ? "" : `: ${occurrence.contextName}`;
  return `${occurrence.contextKind}${name}`;
}

export function formatReport(report: TestLoopReport, options: Pick<CliOptions, "top">): string {
  const lines = [
    `Scanned ${report.summary.scannedFiles} test files; found ${report.summary.loopCount} table-test candidate loop(s) in ${report.summary.filesWithLoops} file(s).`,
    "",
    "Top files by loop count:",
  ];
  for (const file of report.files.slice(0, options.top)) {
    lines.push(`- ${file.file}: loops=${file.count}`);
  }
  lines.push("", "Table-test candidate loops:");
  for (const occurrence of report.occurrences.slice(0, options.top)) {
    lines.push(
      `- ${occurrence.file}:${occurrence.line}:${occurrence.column} [${formatContext(occurrence)}] ${occurrence.kind}`,
    );
  }
  return lines.join("\n");
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const roots: string[] = [];
  let json = false;
  let top = 20;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--top") {
      top = parsePositiveInt(argv[++index] ?? "", "--top");
    } else if (arg === "--root") {
      roots.push(argv[++index] ?? "");
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: tsx scripts/growth-guardrails/find-test-loops.mts [--top N] [--root PATH] [--json]\n\nScans test/spec files under test, src, and nemoclaw/src by default.",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (roots.some((root) => root.trim() === "")) throw new Error("--root requires a path");
  return { json, top, roots: roots.length > 0 ? roots : DEFAULT_SCAN_ROOTS };
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = collectTestLoops(options.roots);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report, options));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) main();

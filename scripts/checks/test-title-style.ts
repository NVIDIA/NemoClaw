#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

export type TestTitleRule =
  | "issue-reference-suffix"
  | "leading-metadata"
  | "placeholder-only"
  | "result-arrow";

export type TestTitleViolation = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly call: "describe" | "it" | "test";
  readonly title: string;
  readonly rule: TestTitleRule;
  readonly message: string;
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_SCAN_ROOTS = Object.freeze(["src", "test", "nemoclaw/src"]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const TEST_CALL_NAMES = new Set(["describe", "it", "test"]);
const SKIP_DIRS = new Set([".git", ".venv", "coverage", "dist", "node_modules"]);
const LEADING_METADATA_PATTERN =
  /^(?:#\d+\b|issue\s+#?\d+\b|regression\s+#?\d+\b|--\S+|-\w\b|\[[^\]]+\]|scenario\b)/i;
const LOCAL_ISSUE_REFERENCE_PATTERN = /(?<![\w/-])#\d+\b/;
const ISSUE_SUFFIX_PATTERN = /\s\(#\d+(?:\s*(?:,|\/|and)\s*#\d+)*\)$/;
const PLACEHOLDER_ONLY_PATTERN = /^(?:%[sdifjo]|\$\{…\})$/;

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function rootCallName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootCallName(expression.expression);
  if (ts.isCallExpression(expression)) return rootCallName(expression.expression);
  return null;
}

function literalTitle(argument: ts.Expression | undefined): string | null {
  if (argument === undefined) return null;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  if (!ts.isTemplateExpression(argument)) return null;

  return `${argument.head.text}${argument.templateSpans
    .map((span) => `\${…}${span.literal.text}`)
    .join("")}`;
}

function titleRules(title: string): readonly { rule: TestTitleRule; message: string }[] {
  const trimmed = title.trim();
  const violations: { rule: TestTitleRule; message: string }[] = [];

  if (LOCAL_ISSUE_REFERENCE_PATTERN.test(trimmed) && !ISSUE_SUFFIX_PATTERN.test(trimmed)) {
    violations.push({
      rule: "issue-reference-suffix",
      message: "move local issue references to a final '(#1234)' suffix",
    });
  }
  if (LEADING_METADATA_PATTERN.test(trimmed)) {
    violations.push({
      rule: "leading-metadata",
      message: "start with behavior or context instead of metadata, flags, or scenario labels",
    });
  }
  if (PLACEHOLDER_ONLY_PATTERN.test(trimmed)) {
    violations.push({
      rule: "placeholder-only",
      message: "add behavior around the parameter placeholder",
    });
  }
  if (/\s→\s/.test(trimmed)) {
    violations.push({
      rule: "result-arrow",
      message: "describe the expected result as a sentence instead of an input-to-output label",
    });
  }

  return violations;
}

export function scanTestTitleStyle(file: string, source: string): readonly TestTitleViolation[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );
  const violations: TestTitleViolation[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const call = rootCallName(node.expression);
      const title = literalTitle(node.arguments[0]);
      if (call !== null && TEST_CALL_NAMES.has(call) && title !== null) {
        const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        for (const violation of titleRules(title)) {
          violations.push({
            file,
            line: location.line + 1,
            column: location.character + 1,
            call: call as TestTitleViolation["call"],
            title,
            ...violation,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function isSkipped(absolutePath: string): boolean {
  const segments = path.relative(REPO_ROOT, absolutePath).split(path.sep);
  return segments.some((segment) => SKIP_DIRS.has(segment));
}

function* walkTestFiles(directory: string): Generator<string> {
  if (!existsSync(directory) || isSkipped(directory)) return;

  for (const entry of readdirSync(directory)) {
    const absolutePath = path.join(directory, entry);
    if (isSkipped(absolutePath)) continue;
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      yield* walkTestFiles(absolutePath);
    } else if (stats.isFile() && TEST_FILE_PATTERN.test(entry)) {
      yield absolutePath;
    }
  }
}

export function findTestTitleStyleViolations(
  roots: readonly string[] = DEFAULT_SCAN_ROOTS,
): readonly TestTitleViolation[] {
  const violations: TestTitleViolation[] = [];
  for (const root of roots) {
    const absoluteRoot = path.resolve(REPO_ROOT, root);
    for (const absolutePath of walkTestFiles(absoluteRoot)) {
      const file = path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
      violations.push(...scanTestTitleStyle(file, readFileSync(absolutePath, "utf8")));
    }
  }
  return violations;
}

function main(): void {
  const violations = findTestTitleStyleViolations();
  if (violations.length === 0) {
    console.log("Test title style check passed.");
    return;
  }

  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line}:${violation.column} [${violation.rule}] ${violation.message}: ${JSON.stringify(violation.title)}`,
    );
  }
  console.error(`Found ${violations.length} test title style violation(s).`);
  process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  main();
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Doc-drift gate: every NEMOCLAW_* env var read in src/ (or bin/) must be
 * either documented in docs/reference/commands.md or explicitly allowlisted
 * in ci/env-var-doc-allowlist.json with a real reason.
 *
 * See #3184. Modeled on scripts/check-direct-credential-env.ts.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const ENV_PREFIX = "NEMOCLAW_";
const ENV_NAME_PATTERN = /^NEMOCLAW_[A-Z][A-Z0-9_]*$/;

export interface AllowlistEntry {
  name: string;
  reason: string;
}

export interface AuditOptions {
  sourceFiles: readonly string[];
  commandsMdText: string;
  allowlist: readonly AllowlistEntry[];
}

export interface AuditResult {
  undocumented: string[];
  staleAllowlist: string[];
  invalidAllowlist: string[];
}

export function findEnvVarReads(sourceText: string, filePath = "source.ts"): Set<string> {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(filePath),
  );
  const found = new Set<string>();

  function visit(node: ts.Node): void {
    const name = envVarNameFor(node);
    if (name && !isAssignmentOrDeleteTarget(node)) {
      found.add(name);
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name) &&
      isProcessEnvExpression(stripParentheses(node.initializer))
    ) {
      for (const bindingName of envVarNamesForObjectBindingPattern(node.name)) {
        found.add(bindingName);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

export function findDocumentedVars(commandsMdText: string): Set<string> {
  const out = new Set<string>();
  const re = /NEMOCLAW_[A-Z][A-Z0-9_]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(commandsMdText)) !== null) {
    out.add(match[0]);
  }
  return out;
}

export function loadAllowlist(jsonText: string): AllowlistEntry[] {
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed)) {
    throw new Error("Allowlist must be a JSON array of {name, reason} objects.");
  }
  return parsed.map((entry, idx) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      typeof entry.reason !== "string"
    ) {
      throw new Error(
        `Allowlist entry at index ${idx} must be {name: string, reason: string}, got ${JSON.stringify(entry)}.`,
      );
    }
    return { name: entry.name, reason: entry.reason };
  });
}

export function auditEnvVarDocs(opts: AuditOptions): AuditResult {
  const documented = findDocumentedVars(opts.commandsMdText);
  const allowlistByName = new Map(opts.allowlist.map((entry) => [entry.name, entry]));
  const allReadVars = new Set<string>();
  for (const filePath of opts.sourceFiles) {
    const text = readFileSync(filePath, "utf-8");
    for (const name of findEnvVarReads(text, filePath)) {
      allReadVars.add(name);
    }
  }

  const undocumented: string[] = [];
  for (const name of allReadVars) {
    if (documented.has(name)) continue;
    if (allowlistByName.has(name)) continue;
    undocumented.push(name);
  }

  const staleAllowlist: string[] = [];
  for (const entry of opts.allowlist) {
    if (!allReadVars.has(entry.name)) {
      staleAllowlist.push(entry.name);
    }
  }

  const invalidAllowlist: string[] = [];
  for (const entry of opts.allowlist) {
    if (!ENV_NAME_PATTERN.test(entry.name)) {
      invalidAllowlist.push(`${entry.name}: not a valid NEMOCLAW_* env var name`);
      continue;
    }
    if (entry.reason.trim().length < 12) {
      invalidAllowlist.push(`${entry.name}: reason too short — write a real explanation`);
      continue;
    }
    if (documented.has(entry.name)) {
      invalidAllowlist.push(`${entry.name}: documented in commands.md AND in allowlist — pick one`);
    }
  }

  return {
    undocumented: undocumented.sort(),
    staleAllowlist: staleAllowlist.sort(),
    invalidAllowlist: invalidAllowlist.sort(),
  };
}

export function walkSourceFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    walk(root, out);
  }
  return out.sort();
}

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (
      st.isFile() &&
      (full.endsWith(".ts") || full.endsWith(".tsx") || full.endsWith(".js")) &&
      !full.endsWith(".test.ts") &&
      !full.endsWith(".test.js") &&
      !full.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
}

function envVarNameFor(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node) && isProcessEnvExpression(node.expression)) {
    return node.name.text.startsWith(ENV_PREFIX) ? node.name.text : null;
  }
  if (ts.isElementAccessExpression(node) && isProcessEnvExpression(node.expression)) {
    const arg = stripParentheses(node.argumentExpression);
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      return arg.text.startsWith(ENV_PREFIX) ? arg.text : null;
    }
  }
  return null;
}

function envVarNamesForObjectBindingPattern(pattern: ts.ObjectBindingPattern): string[] {
  const out: string[] = [];
  for (const element of pattern.elements) {
    if (element.dotDotDotToken) continue;
    const propertyName = element.propertyName ?? element.name;
    if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) {
      const name = propertyName.text;
      if (name.startsWith(ENV_PREFIX)) out.push(name);
    }
  }
  return out;
}

function isProcessEnvExpression(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "process" &&
    expression.name.text === "env"
  );
}

function isAssignmentOrDeleteTarget(node: ts.Node): boolean {
  let current = node;
  let parent = node.parent;
  while (
    parent &&
    isTransparentExpressionWrapper(parent) &&
    getWrappedExpression(parent) === current
  ) {
    current = parent;
    parent = parent.parent;
  }
  return (
    (parent !== undefined &&
      ts.isBinaryExpression(parent) &&
      parent.left === current &&
      isAssignmentOperator(parent.operatorToken.kind)) ||
    (parent !== undefined && ts.isDeleteExpression(parent) && parent.expression === current)
  );
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken
  );
}

function isTransparentExpressionWrapper(node: ts.Node): boolean {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

function getWrappedExpression(node: ts.Node): ts.Node | undefined {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return node.expression;
  }
  return undefined;
}

function stripParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath)) {
    case ".cjs":
    case ".js":
    case ".mjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function main(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourceRoots = [path.join(repoRoot, "src"), path.join(repoRoot, "bin")];
  const commandsMdPath = path.join(repoRoot, "docs", "reference", "commands.md");
  const allowlistPath = path.join(repoRoot, "ci", "env-var-doc-allowlist.json");

  const sourceFiles = walkSourceFiles(sourceRoots);
  const commandsMdText = readFileSync(commandsMdPath, "utf-8");
  const allowlist = loadAllowlist(readFileSync(allowlistPath, "utf-8"));

  const result = auditEnvVarDocs({ sourceFiles, commandsMdText, allowlist });

  let failed = false;
  if (result.undocumented.length > 0) {
    failed = true;
    console.error(
      "\nNEMOCLAW_* env vars read in src/ but missing from docs/reference/commands.md " +
        "and not in ci/env-var-doc-allowlist.json:",
    );
    for (const name of result.undocumented) console.error(`  - ${name}`);
    console.error(
      "\nFix one of:\n" +
        "  1. Add an entry for the variable in docs/reference/commands.md (Environment Variables section).\n" +
        "  2. If the variable is internal/test-only and never user-set, add it to ci/env-var-doc-allowlist.json with a real reason.\n",
    );
  }
  if (result.invalidAllowlist.length > 0) {
    failed = true;
    console.error("\nInvalid entries in ci/env-var-doc-allowlist.json:");
    for (const msg of result.invalidAllowlist) console.error(`  - ${msg}`);
  }
  if (result.staleAllowlist.length > 0) {
    failed = true;
    console.error(
      "\nci/env-var-doc-allowlist.json contains entries no longer read in src/ (stale):",
    );
    for (const name of result.staleAllowlist) console.error(`  - ${name}`);
    console.error("Remove these entries.\n");
  }
  if (failed) {
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main();
}

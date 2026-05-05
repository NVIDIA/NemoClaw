// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Guards src/lib/onboard.ts against direct reads of provider credential env vars.
 *
 * Direct `process.env.NVIDIA_API_KEY`-style reads bypass credentials.json. Use
 * resolveProviderCredential() or getCredential() for credential resolution unless
 * a narrowly-scoped raw env check is intentional and explicitly suppressed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const CREDENTIAL_ENV_KEYS = new Set([
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "COMPATIBLE_API_KEY",
  "COMPATIBLE_ANTHROPIC_API_KEY",
]);

const MESSAGE =
  "Direct process.env access for provider credentials bypasses credentials.json. " +
  "Use resolveProviderCredential() or getCredential() instead. See #2306.";

const SUPPRESSION_TOKEN_PATTERN =
  /\b(?:check-direct-credential-env-ignore|no-direct-credential-env)\b/;
const COMMENT_LINE_PREFIX_PATTERN = /^\s*(?:\/\/|\/\*|\*)/;

export interface DirectCredentialEnvViolation {
  filePath: string;
  line: number;
  column: number;
  key: string;
  text: string;
}

export function findDirectCredentialEnvReads(
  sourceText: string,
  filePath = "source.ts",
): DirectCredentialEnvViolation[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(filePath),
  );
  const violations: DirectCredentialEnvViolation[] = [];

  function visit(node: ts.Node): void {
    const credentialKey = credentialKeyForProcessEnvAccess(node);
    if (
      credentialKey &&
      !isAssignmentOrDeleteTarget(node) &&
      !hasSuppressionComment(sourceFile, node)
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({
        filePath,
        line: position.line + 1,
        column: position.character + 1,
        key: credentialKey,
        text: node.getText(sourceFile),
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

export function checkFiles(filePaths: readonly string[]): DirectCredentialEnvViolation[] {
  return filePaths.flatMap((filePath) =>
    findDirectCredentialEnvReads(readFileSync(filePath, "utf-8"), filePath),
  );
}

export function formatViolations(violations: readonly DirectCredentialEnvViolation[]): string {
  return violations
    .map(
      (violation) =>
        `${violation.filePath}:${violation.line}:${violation.column} ${MESSAGE} (${violation.text})`,
    )
    .join("\n");
}

function credentialKeyForProcessEnvAccess(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node) && isProcessEnvExpression(node.expression)) {
    return CREDENTIAL_ENV_KEYS.has(node.name.text) ? node.name.text : null;
  }

  if (!ts.isElementAccessExpression(node) || !isProcessEnvExpression(node.expression)) {
    return null;
  }

  const argument = stripParentheses(node.argumentExpression);
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return CREDENTIAL_ENV_KEYS.has(argument.text) ? argument.text : null;
  }

  if (ts.isIdentifier(argument) && /credential/i.test(argument.text)) {
    return `[${argument.text}]`;
  }

  return null;
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
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
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

function hasSuppressionComment(sourceFile: ts.SourceFile, node: ts.Node): boolean {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const lines = sourceFile.getFullText().split(/\r?\n/);
  return [line - 1, line].some((candidate) => {
    const text = lines[candidate];
    return (
      text !== undefined &&
      COMMENT_LINE_PREFIX_PATTERN.test(text) &&
      SUPPRESSION_TOKEN_PATTERN.test(text)
    );
  });
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
  const filePaths = process.argv.slice(2).filter((arg) => arg !== "--");
  if (filePaths.length === 0) {
    console.error("Usage: tsx scripts/check-direct-credential-env.ts FILE...");
    process.exitCode = 2;
    return;
  }

  const violations = checkFiles(filePaths);
  if (violations.length > 0) {
    console.error(formatViolations(violations));
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main();
}

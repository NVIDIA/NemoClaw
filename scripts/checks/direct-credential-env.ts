// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Guards onboarding boundary files against direct reads of provider credential env vars.
 *
 * Direct `process.env.NVIDIA_INFERENCE_API_KEY`-style reads bypass credentials.json. Use
 * resolveProviderCredential() or getCredential() for credential resolution unless
 * a narrowly-scoped raw env check is intentional and explicitly suppressed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { SUPPORTED_CREDENTIAL_ENV_NAMES } from "../../src/lib/security/credential-env";

const CREDENTIAL_ENV_KEYS = SUPPORTED_CREDENTIAL_ENV_NAMES;

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
  const constantCredentialEnvKeys = collectConstantCredentialEnvKeys(sourceFile);

  function visit(node: ts.Node): void {
    const credentialKey = credentialKeyForProcessEnvAccess(node, constantCredentialEnvKeys);
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

function collectConstantCredentialEnvKeys(sourceFile: ts.SourceFile): Map<string, string> {
  const keys = new Map<string, string>();

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const initializer = stripParentheses(node.initializer);
      if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
        if (CREDENTIAL_ENV_KEYS.has(initializer.text)) {
          keys.set(node.name.text, initializer.text);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return keys;
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

function credentialKeyForProcessEnvAccess(
  node: ts.Node,
  constantCredentialEnvKeys: ReadonlyMap<string, string>,
): string | null {
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

  if (ts.isIdentifier(argument)) {
    const constantKey = constantCredentialEnvKeys.get(argument.text);
    if (constantKey) return constantKey;
    if (/credential/i.test(argument.text)) return `[${argument.text}]`;
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
    console.error("Usage: tsx scripts/checks/direct-credential-env.ts FILE...");
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

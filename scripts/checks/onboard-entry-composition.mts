// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type OnboardDecisionCategory = "gateway" | "messaging" | "policy" | "provider";
export type OnboardDecisionCounts = Readonly<Record<string, number>>;
export type OnboardEntryCompositionBudget = Readonly<
  Record<OnboardDecisionCategory, OnboardDecisionCounts>
>;
export type OnboardEntryCompositionViolation = {
  readonly kind: "new-decision" | "decision-ratchet";
  readonly category: OnboardDecisionCategory;
  readonly declaration: string;
  readonly actualCount: number;
  readonly budgetCount: number;
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY_PATH = path.join(REPO_ROOT, "src/lib/onboard.ts");
const BUDGET_PATH = path.join(REPO_ROOT, "ci/onboard-entry-composition-budget.json");
const CATEGORIES = ["gateway", "messaging", "policy", "provider"] as const;
const LOGICAL_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);
const RECOVERY_NAME = /recover|recovery|repair|restore|retry|fallback|rollback/i;

function declarationBody(node: ts.Node): ts.ConciseBody | undefined {
  if (ts.isFunctionDeclaration(node)) return node.body;
  if (!ts.isVariableStatement(node)) return undefined;
  for (const declaration of node.declarationList.declarations) {
    const initializer = declaration.initializer;
    if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
      return initializer.body;
    }
  }
  return undefined;
}

function declarationName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? null;
  if (!ts.isVariableStatement(node)) return null;
  for (const declaration of node.declarationList.declarations) {
    if (
      ts.isIdentifier(declaration.name) &&
      declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
    ) {
      return declaration.name.text;
    }
  }
  return null;
}

function isGatewayLifecycleIdentifier(identifier: string): boolean {
  if (!/gateway/i.test(identifier)) return false;
  if (
    /toolGateway|gatewayRoute|routeGateway|gatewayProvider|providerExistsInGateway|readGatewayProviderMetadata/i.test(
      identifier,
    )
  ) {
    return false;
  }
  if (
    /gatewayCredential|gatewayEnvironment|gatewayName|gatewayPort|gatewayUrl|gatewayEndpoint/i.test(
      identifier,
    )
  ) {
    return false;
  }
  return (
    /^(?:chooseGateway|gatewayState)$/i.test(identifier) ||
    /(?:start|stop|restart|launch|destroy|recover|repair|retire|terminate|kill|wait|ensure|attach|register|reuse).*gateway/i.test(
      identifier,
    ) ||
    /gateway.*(?:start|stop|restart|launch|destroy|recover|repair|retire|terminate|kill|wait|health|ready|readiness|running|stale|process|runtime|lifecycle)/i.test(
      identifier,
    )
  );
}

function identifierCategories(identifier: string): ReadonlySet<OnboardDecisionCategory> {
  const categories = new Set<OnboardDecisionCategory>();
  if (isGatewayLifecycleIdentifier(identifier)) categories.add("gateway");
  if (/messaging|channel/i.test(identifier)) categories.add("messaging");
  if (/policy|preset/i.test(identifier)) categories.add("policy");
  if (/provider|inference|nim|ollama|routed|model/i.test(identifier)) categories.add("provider");
  return categories;
}

function isLogicalDecision(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind);
}

function isRecoveryCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && RECOVERY_NAME.test(node.expression.getText());
}

// Count branches, short-circuit operators, condition-controlled loops, try statements, and
// named recovery calls. Sequencing loops do not choose onboarding behavior.
function isDecisionNode(node: ts.Node): boolean {
  return (
    ts.isIfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isConditionalExpression(node) ||
    isLogicalDecision(node) ||
    ts.isForStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isTryStatement(node) ||
    isRecoveryCall(node)
  );
}

function decisionNodeCategories(node: ts.Node): ReadonlySet<OnboardDecisionCategory> {
  const categories = new Set<OnboardDecisionCategory>();

  function addIdentifiers(candidate: ts.Node): void {
    if (ts.isIdentifier(candidate)) {
      for (const category of identifierCategories(candidate.text)) categories.add(category);
    }
    ts.forEachChild(candidate, addIdentifiers);
  }

  function scanCondition(candidate: ts.Node, root: boolean): void {
    if (!root && isDecisionNode(candidate)) return;
    if (ts.isIdentifier(candidate)) {
      for (const category of identifierCategories(candidate.text)) categories.add(category);
    }
    ts.forEachChild(candidate, (child) => scanCondition(child, false));
  }

  function scanActions(candidate: ts.Node, root: boolean): void {
    if (!root && isDecisionNode(candidate)) return;
    if (ts.isCallExpression(candidate) || ts.isNewExpression(candidate)) {
      addIdentifiers(candidate.expression);
      return;
    }
    if (
      ts.isBinaryExpression(candidate) &&
      candidate.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      candidate.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      addIdentifiers(candidate.left);
      scanActions(candidate.right, false);
      return;
    }
    if (ts.isDeleteExpression(candidate)) {
      addIdentifiers(candidate.expression);
      return;
    }
    ts.forEachChild(candidate, (child) => scanActions(child, false));
  }

  if (ts.isIfStatement(node)) {
    scanCondition(node.expression, false);
    scanActions(node.thenStatement, true);
    if (node.elseStatement) scanActions(node.elseStatement, true);
  } else if (ts.isSwitchStatement(node)) {
    scanCondition(node.expression, false);
    scanActions(node.caseBlock, true);
  } else if (ts.isConditionalExpression(node)) {
    scanCondition(node.condition, false);
    scanActions(node.whenTrue, true);
    scanActions(node.whenFalse, true);
  } else if (isLogicalDecision(node)) {
    scanCondition(node, true);
  } else if (ts.isForStatement(node)) {
    if (node.condition) scanCondition(node.condition, false);
    scanActions(node.statement, true);
  } else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    scanCondition(node.expression, false);
    scanActions(node.statement, true);
  } else if (ts.isTryStatement(node)) {
    scanActions(node.tryBlock, true);
    if (node.catchClause) scanActions(node.catchClause, true);
    if (node.finallyBlock) scanActions(node.finallyBlock, true);
  } else if (isRecoveryCall(node)) {
    addIdentifiers(node.expression);
  }
  return categories;
}

function decisionCounts(
  name: string,
  body: ts.ConciseBody,
): Record<OnboardDecisionCategory, Record<string, number>> {
  const nameCategories = identifierCategories(name);
  const counts: Record<OnboardDecisionCategory, Record<string, number>> = {
    gateway: {},
    messaging: {},
    policy: {},
    provider: {},
  };

  function visit(node: ts.Node): void {
    if (isDecisionNode(node)) {
      const categories = new Set([...nameCategories, ...decisionNodeCategories(node)]);
      for (const category of categories) {
        counts[category][name] = (counts[category][name] ?? 0) + 1;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(body);
  return counts;
}

function sortCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function collectOnboardEntryDecisions(sourceText: string): OnboardEntryCompositionBudget {
  const sourceFile = ts.createSourceFile(
    "src/lib/onboard.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const decisions: Record<OnboardDecisionCategory, Record<string, number>> = {
    gateway: {},
    messaging: {},
    policy: {},
    provider: {},
  };

  for (const statement of sourceFile.statements) {
    const name = declarationName(statement);
    const body = declarationBody(statement);
    if (!name || !body) continue;
    const declarationCounts = decisionCounts(name, body);
    for (const category of CATEGORIES) {
      for (const [declaration, count] of Object.entries(declarationCounts[category])) {
        decisions[category][declaration] = (decisions[category][declaration] ?? 0) + count;
      }
    }
  }

  return Object.fromEntries(
    CATEGORIES.map((category) => [category, sortCounts(decisions[category])]),
  ) as Record<OnboardDecisionCategory, Record<string, number>>;
}

function parseDecisionCounts(
  value: unknown,
  category: OnboardDecisionCategory,
): OnboardDecisionCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${BUDGET_PATH}.${category} must contain declaration occurrence counts`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.some(
      ([name, count]) =>
        !name.trim() || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1,
    )
  ) {
    throw new Error(`${BUDGET_PATH}.${category} must contain positive integer occurrence counts`);
  }
  return sortCounts(Object.fromEntries(entries) as Record<string, number>);
}

export function parseOnboardEntryCompositionBudget(
  sourceText: string,
): OnboardEntryCompositionBudget {
  const parsed = JSON.parse(sourceText) as Record<string, unknown>;
  return Object.fromEntries(
    CATEGORIES.map((category) => [category, parseDecisionCounts(parsed[category], category)]),
  ) as Record<OnboardDecisionCategory, OnboardDecisionCounts>;
}

export function evaluateOnboardEntryComposition(
  actual: OnboardEntryCompositionBudget,
  budget: OnboardEntryCompositionBudget,
): OnboardEntryCompositionViolation[] {
  const violations: OnboardEntryCompositionViolation[] = [];
  for (const category of CATEGORIES) {
    const declarations = new Set([
      ...Object.keys(actual[category]),
      ...Object.keys(budget[category]),
    ]);
    for (const declaration of declarations) {
      const actualCount = actual[category][declaration] ?? 0;
      const budgetCount = budget[category][declaration] ?? 0;
      if (actualCount === budgetCount) continue;
      violations.push({
        kind: actualCount > budgetCount ? "new-decision" : "decision-ratchet",
        category,
        declaration,
        actualCount,
        budgetCount,
      });
    }
  }
  return violations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function formatOnboardEntryCompositionViolations(
  violations: readonly OnboardEntryCompositionViolation[],
): string {
  return [
    "Onboarding entry composition boundary failed.",
    "",
    ...violations.map((violation) =>
      violation.kind === "new-decision"
        ? `- ${violation.declaration}: ${violation.category} decisions increased from ${violation.budgetCount} to ${violation.actualCount} in src/lib/onboard.ts.`
        : `- ${violation.declaration}: ${violation.category} decisions decreased from ${violation.budgetCount} to ${violation.actualCount}. Lower the budget.`,
    ),
  ].join("\n");
}

function totalDecisions(counts: OnboardDecisionCounts): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

function main(): void {
  const actual = collectOnboardEntryDecisions(readFileSync(ENTRY_PATH, "utf8"));
  const budget = parseOnboardEntryCompositionBudget(readFileSync(BUDGET_PATH, "utf8"));
  const violations = evaluateOnboardEntryComposition(actual, budget);
  if (violations.length > 0) {
    console.error(formatOnboardEntryCompositionViolations(violations));
    process.exitCode = 1;
    return;
  }
  console.log(
    `Onboarding entry composition boundary passed. Decision counts: ${CATEGORIES.map((category) => `${category} ${totalDecisions(actual[category])}`).join(", ")}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

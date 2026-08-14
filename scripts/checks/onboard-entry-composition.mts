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
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);
const RECOVERY_NAME = /recover|recovery|repair|restore|retry|fallback|rollback/i;
const RECOVERY_FACTORY_NAME = /^(?:build|create|install|make)/i;
const RECOVERY_COMPOUND_ACTION =
  /(?:And|Or)(?:Fallback|Recover|Recovery|Repair|Restore|Retry|Rollback)|(?:Fallback|Recover|Recovery|Repair|Restore|Retry|Rollback)[A-Za-z0-9]*(?:And|Or)(?:Apply|Attach|Destroy|Ensure|Execute|Fallback|Kill|Launch|Perform|Recover|Register|Repair|Restart|Restore|Retire|Retry|Reuse|Rollback|Run|Start|Stop|Terminate|Wait)/i;
const RECOVERY_ACTION_METHOD =
  /^(?:apply|call|execute|perform|recover|repair|restore|retry|rollback|run|start)$/i;

type NamedScope = {
  readonly name: string;
  readonly node: ts.Node;
};

function functionBody(node: ts.Node): ts.ConciseBody | undefined {
  if (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return node.body;
  }
  return undefined;
}

function propertyName(node: ts.Node): string | null {
  if (
    !ts.isPropertyAssignment(node) &&
    !ts.isPropertyDeclaration(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node)
  ) {
    return null;
  }
  if (
    ts.isIdentifier(node.name) ||
    ts.isStringLiteral(node.name) ||
    ts.isNumericLiteral(node.name)
  ) {
    return node.name.text;
  }
  return node.name.getText();
}

function callableScopes(owner: string, root: ts.Node): NamedScope[] {
  const scopes: NamedScope[] = [];

  function visit(node: ts.Node, currentOwner: string, isRoot = false): void {
    const member = isRoot ? null : propertyName(node);
    const callableOwner = member ? `${currentOwner}.${member}` : currentOwner;
    const body = functionBody(node);
    if (body) {
      scopes.push({ name: callableOwner, node: body });
      return;
    }
    ts.forEachChild(node, (child) => visit(child, callableOwner));
  }

  visit(root, owner, true);
  return scopes;
}

function declarationOwner(declaration: ts.VariableDeclaration): string {
  if (ts.isIdentifier(declaration.name)) return declaration.name.text;
  if (declaration.initializer && ts.isCallExpression(declaration.initializer)) {
    return declaration.initializer.expression.getText();
  }
  return "destructuredBinding";
}

function topLevelScopes(statement: ts.Statement): NamedScope[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((declaration) => ({
      name: declarationOwner(declaration),
      node: declaration,
    }));
  }
  if (ts.isExportAssignment(statement)) {
    return [{ name: "defaultExport", node: statement.expression }];
  }
  const name =
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name
      ? statement.name.text
      : "<module>";
  return [{ name, node: statement }];
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
    /(?:start|stop|restart|launch|destroy|recover|repair|restore|retry|fallback|rollback|retire|terminate|kill|wait|ensure|attach|register|reuse).*gateway/i.test(
      identifier,
    ) ||
    /gateway.*(?:start|stop|restart|launch|destroy|recover|repair|restore|retry|fallback|rollback|retire|terminate|kill|wait|ensure|attach|register|reuse|health|ready|readiness|running|stale|process|runtime|lifecycle)/i.test(
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

function staticElementName(expression: ts.ElementAccessExpression): string | null {
  const argument = expression.argumentExpression
    ? unwrapTransparentExpression(expression.argumentExpression)
    : undefined;
  if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
    return argument.text;
  }
  return null;
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrapTransparentExpression(expression.expression);
  }
  return expression;
}

function calledName(expression: ts.Expression): string | null {
  const callee = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isElementAccessExpression(callee)) return staticElementName(callee);
  return null;
}

function calledReceiver(expression: ts.Expression): ts.Expression | null {
  const callee = unwrapTransparentExpression(expression);
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    return callee.expression;
  }
  return null;
}

function immediatelyBoundReceiver(expression: ts.Expression): ts.Expression | null {
  const callee = unwrapTransparentExpression(expression);
  if (!ts.isCallExpression(callee) || calledName(callee.expression) !== "bind") return null;
  return calledReceiver(callee.expression);
}

type RecoveryInvocation = ts.CallExpression | ts.TaggedTemplateExpression;

function recoveryInvocationExpression(node: RecoveryInvocation): ts.Expression {
  return ts.isCallExpression(node) ? node.expression : node.tag;
}

function isRecoveryInvocation(node: ts.Node): node is RecoveryInvocation {
  if (!ts.isCallExpression(node) && !ts.isTaggedTemplateExpression(node)) return false;
  const expression = recoveryInvocationExpression(node);
  const boundReceiver = immediatelyBoundReceiver(expression);
  if (boundReceiver && RECOVERY_NAME.test(boundReceiver.getText())) return true;
  const name = calledName(expression);
  if (
    name === null ||
    (RECOVERY_FACTORY_NAME.test(name) && !RECOVERY_COMPOUND_ACTION.test(name))
  ) {
    return false;
  }
  if (RECOVERY_NAME.test(name)) return true;
  const receiver = calledReceiver(expression);
  return receiver !== null && RECOVERY_ACTION_METHOD.test(name) && RECOVERY_NAME.test(receiver.getText());
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
    isRecoveryInvocation(node)
  );
}

function decisionNodeCategories(node: ts.Node): ReadonlySet<OnboardDecisionCategory> {
  const categories = new Set<OnboardDecisionCategory>();

  function addIdentifiers(candidate: ts.Node): void {
    if (ts.isIdentifier(candidate) || ts.isPrivateIdentifier(candidate)) {
      for (const category of identifierCategories(candidate.text)) categories.add(category);
    }
    if (ts.isElementAccessExpression(candidate)) {
      const name = staticElementName(candidate);
      if (name) {
        for (const category of identifierCategories(name)) categories.add(category);
        for (const category of identifierCategories(`${candidate.expression.getText()}${name}`)) {
          categories.add(category);
        }
      }
    }
    if (ts.isPropertyAccessExpression(candidate)) {
      for (const category of identifierCategories(
        `${candidate.expression.getText()}${candidate.name.text}`,
      )) {
        categories.add(category);
      }
    }
    ts.forEachChild(candidate, addIdentifiers);
  }

  function scanCondition(candidate: ts.Node, root: boolean): void {
    if (!root && isDecisionNode(candidate)) return;
    if (
      ts.isIdentifier(candidate) ||
      ts.isPrivateIdentifier(candidate) ||
      ts.isPropertyAccessExpression(candidate) ||
      ts.isElementAccessExpression(candidate)
    ) {
      addIdentifiers(candidate);
    }
    ts.forEachChild(candidate, (child) => scanCondition(child, false));
  }

  function scanActionArgument(candidate: ts.Node): void {
    const body = functionBody(candidate);
    if (body) {
      ts.forEachChild(candidate, (child) => {
        if (child !== body) scanActionArgument(child);
      });
      scanActions(body, true);
      return;
    }
    if (ts.isIdentifier(candidate) || ts.isPrivateIdentifier(candidate)) {
      addIdentifiers(candidate);
      return;
    }
    if (ts.isCallExpression(candidate) || ts.isNewExpression(candidate)) {
      addIdentifiers(candidate.expression);
      for (const argument of candidate.arguments ?? []) scanActionArgument(argument);
      return;
    }
    if (ts.isTaggedTemplateExpression(candidate)) {
      addIdentifiers(candidate.tag);
      scanActionArgument(candidate.template);
      return;
    }
    if (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) {
      addIdentifiers(candidate);
      return;
    }
    if (
      ts.isParenthesizedExpression(candidate) ||
      ts.isAsExpression(candidate) ||
      ts.isSatisfiesExpression(candidate) ||
      ts.isNonNullExpression(candidate)
    ) {
      scanActionArgument(candidate.expression);
      return;
    }
    if (ts.isSpreadElement(candidate) || ts.isSpreadAssignment(candidate)) {
      scanActionArgument(candidate.expression);
      return;
    }
    if (ts.isPropertyAssignment(candidate)) {
      scanActionArgument(candidate.initializer);
      return;
    }
    if (ts.isShorthandPropertyAssignment(candidate)) {
      addIdentifiers(candidate.name);
      return;
    }
    ts.forEachChild(candidate, scanActionArgument);
  }

  function scanActions(candidate: ts.Node, root: boolean): void {
    if (!root && isDecisionNode(candidate)) return;
    if (ts.isIdentifier(candidate) || ts.isPrivateIdentifier(candidate)) {
      addIdentifiers(candidate);
      return;
    }
    if (ts.isCallExpression(candidate) || ts.isNewExpression(candidate)) {
      addIdentifiers(candidate.expression);
      for (const argument of candidate.arguments ?? []) scanActionArgument(argument);
      return;
    }
    if (ts.isTaggedTemplateExpression(candidate)) {
      addIdentifiers(candidate.tag);
      scanActions(candidate.template, false);
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
    if (node.initializer) scanActionArgument(node.initializer);
    if (node.condition) scanCondition(node.condition, false);
    scanActions(node.statement, true);
    if (node.incrementor) scanActions(node.incrementor, false);
  } else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    scanCondition(node.expression, false);
    scanActions(node.statement, true);
  } else if (ts.isTryStatement(node)) {
    scanActions(node.tryBlock, true);
    if (node.catchClause) scanActions(node.catchClause, true);
    if (node.finallyBlock) scanActions(node.finallyBlock, true);
  } else if (isRecoveryInvocation(node)) {
    addIdentifiers(recoveryInvocationExpression(node));
  }
  return categories;
}

function decisionCounts(
  name: string,
  scope: ts.Node,
  prunedNodes: ReadonlySet<ts.Node> = new Set(),
): Record<OnboardDecisionCategory, Record<string, number>> {
  const nameCategories = identifierCategories(name);
  const counts: Record<OnboardDecisionCategory, Record<string, number>> = {
    gateway: {},
    messaging: {},
    policy: {},
    provider: {},
  };

  function visit(node: ts.Node): void {
    if (prunedNodes.has(node)) return;
    if (isDecisionNode(node)) {
      const categories = new Set([...nameCategories, ...decisionNodeCategories(node)]);
      for (const category of categories) {
        counts[category][name] = (counts[category][name] ?? 0) + 1;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(scope);
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
    for (const { name, node } of topLevelScopes(statement)) {
      const callables = callableScopes(name, node);
      const callableBodies = new Set(callables.map((scope) => scope.node));
      const scopes = [{ name, node, prunedNodes: callableBodies }, ...callables];
      for (const scope of scopes) {
        const declarationCounts = decisionCounts(
          scope.name,
          scope.node,
          "prunedNodes" in scope ? scope.prunedNodes : undefined,
        );
        for (const category of CATEGORIES) {
          for (const [declaration, count] of Object.entries(declarationCounts[category])) {
            decisions[category][declaration] = (decisions[category][declaration] ?? 0) + count;
          }
        }
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

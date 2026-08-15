// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
export type OnboardEntryCompositionCeiling = {
  readonly declarations: OnboardEntryCompositionBudget;
  readonly categoryTotals: Readonly<Record<OnboardDecisionCategory, number>>;
  readonly globalTotal: number;
};
export type OnboardEntryCompositionBudgetExpansion =
  | {
      readonly kind: "declaration";
      readonly category: OnboardDecisionCategory;
      readonly declaration: string;
      readonly budgetCount: number;
      readonly baselineCount: number;
    }
  | {
      readonly kind: "category";
      readonly category: OnboardDecisionCategory;
      readonly budgetCount: number;
      readonly baselineCount: number;
    }
  | {
      readonly kind: "global";
      readonly budgetCount: number;
      readonly baselineCount: number;
    };
export type CompositionGitResult = Readonly<{
  status: number | null;
  stdout: string;
  error?: string | null;
}>;
export type CompositionGitRunner = (args: readonly string[]) => CompositionGitResult;

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
const RECOVERY_NAMES = [
  "fallback",
  "recover",
  "recovery",
  "repair",
  "restore",
  "retry",
  "rollback",
] as const;
const GATEWAY_LIFECYCLE_NAMES = [
  "start",
  "stop",
  "restart",
  "launch",
  "destroy",
  "remove",
  "reset",
  ...RECOVERY_NAMES,
  "retire",
  "terminate",
  "kill",
  "wait",
  "ensure",
  "attach",
  "register",
  "reuse",
] as const;
const GATEWAY_STATE_NAMES = [
  "health",
  "ready",
  "readiness",
  "running",
  "stale",
  "process",
  "runtime",
  "lifecycle",
] as const;
const RECOVERY_FACTORY_NAMES = ["build", "create", "install", "make"] as const;
const RECOVERY_ACTION_METHOD_NAMES = [
  "apply",
  "call",
  "execute",
  "perform",
  ...RECOVERY_NAMES,
  "run",
  "start",
] as const;
const COMPOUND_ACTION_NAMES = [
  ...GATEWAY_LIFECYCLE_NAMES,
  "apply",
  "execute",
  "perform",
  "run",
] as const;

function alternation(names: readonly string[]): string {
  return names.join("|");
}

function titleCase(names: readonly string[]): string[] {
  return names.map((name) => `${name[0].toUpperCase()}${name.slice(1)}`);
}

const RECOVERY_NAME = new RegExp(alternation(RECOVERY_NAMES), "i");
const RECOVERY_FACTORY_NAME = new RegExp(`^(?:${alternation(RECOVERY_FACTORY_NAMES)})`, "i");
const RECOVERY_COMPOUND_ACTION = new RegExp(
  `(?:And|Or)(?:${alternation(titleCase(RECOVERY_NAMES))})|(?:${alternation(titleCase(RECOVERY_NAMES))})[A-Za-z0-9]*(?:And|Or)(?:${alternation(titleCase(COMPOUND_ACTION_NAMES))})`,
);
const RECOVERY_ACTION_METHOD = new RegExp(
  `^(?:${alternation(RECOVERY_ACTION_METHOD_NAMES)})$`,
  "i",
);
const GATEWAY_AFTER_LIFECYCLE = new RegExp(
  `(?:${alternation(GATEWAY_LIFECYCLE_NAMES)}).*gateway`,
  "i",
);
const GATEWAY_BEFORE_LIFECYCLE_OR_STATE = new RegExp(
  `gateway.*(?:${alternation([...GATEWAY_LIFECYCLE_NAMES, ...GATEWAY_STATE_NAMES])})`,
  "i",
);

type NamedScope = {
  readonly name: string;
  readonly node: ts.Node;
};

type DecisionScope = NamedScope & {
  readonly prunedNodes: ReadonlySet<ts.Node>;
};

type StaticAliasBinding = Readonly<{
  target: string | null;
  declaration: ts.Node;
}>;

type StaticAliases = ReadonlyMap<ts.Node, ReadonlyMap<string, StaticAliasBinding>>;

function emptyDecisionCounts(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

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

function staticPropertyName(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  if (!ts.isComputedPropertyName(name)) return null;
  const expression = unwrapTransparentExpression(name.expression);
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isNumericLiteral(expression)
  ) {
    return expression.text;
  }
  return null;
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
  return staticPropertyName(node.name) ?? "[computed]";
}

function callableScopes(owner: string, root: ts.Node): DecisionScope[] {
  type MutableDecisionScope = NamedScope & { readonly prunedNodes: Set<ts.Node> };
  const scopes: MutableDecisionScope[] = [];

  function visit(
    node: ts.Node,
    currentOwner: string,
    enclosingScope?: MutableDecisionScope,
    isRoot = false,
  ): void {
    const member = isRoot ? null : propertyName(node);
    const callableOwner = member ? `${currentOwner}.${member}` : currentOwner;
    const body = functionBody(node);
    if (body) {
      const scope: MutableDecisionScope = {
        name: callableOwner,
        node: body,
        prunedNodes: new Set(),
      };
      enclosingScope?.prunedNodes.add(body);
      scopes.push(scope);
      ts.forEachChild(node, (child) =>
        visit(child, callableOwner, child === body ? scope : enclosingScope),
      );
      return;
    }
    ts.forEachChild(node, (child) => visit(child, callableOwner, enclosingScope));
  }

  visit(root, owner, undefined, true);
  return scopes;
}

function declarationOwner(declaration: ts.VariableDeclaration): string {
  if (ts.isIdentifier(declaration.name)) return declaration.name.text;
  if (declaration.initializer && ts.isCallExpression(declaration.initializer)) {
    return calledName(declaration.initializer.expression) ?? "destructuredBinding";
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
    /^(?:chooseGateway|gateway[.]?State)$/i.test(identifier) ||
    GATEWAY_AFTER_LIFECYCLE.test(identifier) ||
    GATEWAY_BEFORE_LIFECYCLE_OR_STATE.test(identifier)
  );
}

function identifierCategories(
  identifier: string,
  aliases: StaticAliases,
  location?: ts.Node,
): ReadonlySet<OnboardDecisionCategory> {
  const categories = new Set<OnboardDecisionCategory>();
  const resolved = location ? resolveStaticAlias(identifier, aliases, location) : identifier;
  const candidates = new Set([identifier, resolved]);
  for (const candidate of [...candidates]) candidates.add(candidate.replaceAll(".", ""));
  for (const candidate of candidates) {
    if (isGatewayLifecycleIdentifier(candidate)) categories.add("gateway");
    if (/messaging|channel/i.test(candidate)) categories.add("messaging");
    if (/policy|preset/i.test(candidate)) categories.add("policy");
    if (/provider|inference|nim|ollama|routed|model/i.test(candidate)) categories.add("provider");
  }
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

function staticReferenceName(expression: ts.Expression): string | null {
  const reference = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(reference) || ts.isPrivateIdentifier(reference)) return reference.text;
  if (ts.isPropertyAccessExpression(reference)) {
    const receiver = staticReferenceName(reference.expression);
    return receiver ? `${receiver}.${reference.name.text}` : null;
  }
  if (ts.isElementAccessExpression(reference)) {
    const receiver = staticReferenceName(reference.expression);
    const member = staticElementName(reference);
    return receiver && member ? `${receiver}.${member}` : null;
  }
  if (ts.isCallExpression(reference) && calledName(reference.expression) === "bind") {
    const receiver = calledReceiver(reference.expression);
    return receiver ? staticReferenceName(receiver) : null;
  }
  return null;
}

function isAliasScope(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isFunctionLike(node)
  );
}

function nearestAliasScope(node: ts.Node, functionScoped = false): ts.Node {
  let candidate: ts.Node | undefined = node.parent;
  while (candidate) {
    if (
      ts.isSourceFile(candidate) ||
      (functionScoped ? ts.isFunctionLike(candidate) : isAliasScope(candidate))
    ) {
      return candidate;
    }
    candidate = candidate.parent;
  }
  return node.getSourceFile();
}

function collectStaticAliases(sourceFile: ts.SourceFile): StaticAliases {
  const aliases = new Map<ts.Node, Map<string, StaticAliasBinding>>();

  function record(
    scope: ts.Node,
    identifier: string,
    target: string | null,
    declaration: ts.Node,
  ): void {
    const bindings = aliases.get(scope) ?? new Map<string, StaticAliasBinding>();
    bindings.set(identifier, { target, declaration });
    aliases.set(scope, bindings);
  }

  function recordBindingName(
    name: ts.BindingName,
    target: string | null,
    declaration: ts.Node,
    scope: ts.Node,
  ): void {
    if (ts.isIdentifier(name)) {
      record(scope, name.text, target, declaration);
      return;
    }
    if (ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) {
          recordBindingName(element.name, null, declaration, scope);
        }
      }
      return;
    }
    for (const element of name.elements) {
      const member = element.propertyName
        ? staticPropertyName(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      recordBindingName(
        element.name,
        target && member && !element.dotDotDotToken ? `${target}.${member}` : null,
        declaration,
        scope,
      );
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclarationList(node)) {
      const isConst = (node.flags & ts.NodeFlags.Const) !== 0;
      const functionScoped = (node.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0;
      for (const declaration of node.declarations) {
        const target =
          isConst && declaration.initializer
            ? staticReferenceName(declaration.initializer)
            : null;
        recordBindingName(
          declaration.name,
          target,
          declaration,
          nearestAliasScope(declaration, functionScoped),
        );
      }
    }
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        recordBindingName(parameter.name, null, parameter, node);
      }
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      recordBindingName(
        node.variableDeclaration.name,
        null,
        node.variableDeclaration,
        node,
      );
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      record(nearestAliasScope(node), node.name.text, null, node);
    }
    if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      record(node, node.name.text, null, node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return aliases;
}

function findStaticAlias(
  identifier: string,
  aliases: StaticAliases,
  location: ts.Node,
): StaticAliasBinding | undefined {
  let scope: ts.Node | undefined = location;
  while (scope) {
    const binding = aliases.get(scope)?.get(identifier);
    if (binding) return binding;
    scope = scope.parent;
  }
  return undefined;
}

function resolveStaticAlias(identifier: string, aliases: StaticAliases, location: ts.Node): string {
  let resolved = identifier;
  let resolutionLocation = location;
  const visited = new Set<StaticAliasBinding>();
  while (true) {
    const separator = resolved.indexOf(".");
    const root = separator === -1 ? resolved : resolved.slice(0, separator);
    const suffix = separator === -1 ? "" : resolved.slice(separator);
    const binding = findStaticAlias(root, aliases, resolutionLocation);
    if (!binding?.target || visited.has(binding)) break;
    visited.add(binding);
    resolved = `${binding.target}${suffix}`;
    resolutionLocation = binding.declaration;
  }
  return resolved;
}

function resolvedStaticReferenceName(
  expression: ts.Expression,
  aliases: StaticAliases,
): string | null {
  const reference = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(reference)) {
    return resolveStaticAlias(reference.text, aliases, reference);
  }
  if (ts.isPrivateIdentifier(reference)) return reference.text;
  if (ts.isPropertyAccessExpression(reference)) {
    const receiver = resolvedStaticReferenceName(reference.expression, aliases);
    return receiver ? `${receiver}.${reference.name.text}` : null;
  }
  if (ts.isElementAccessExpression(reference)) {
    const receiver = resolvedStaticReferenceName(reference.expression, aliases);
    const member = staticElementName(reference);
    return receiver && member ? `${receiver}.${member}` : null;
  }
  return null;
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

function isRecoveryInvocation(node: ts.Node, aliases: StaticAliases): node is RecoveryInvocation {
  if (!ts.isCallExpression(node) && !ts.isTaggedTemplateExpression(node)) return false;
  const expression = recoveryInvocationExpression(node);
  const boundReceiver = immediatelyBoundReceiver(expression);
  const boundName = boundReceiver ? resolvedStaticReferenceName(boundReceiver, aliases) : null;
  if (boundName && RECOVERY_NAME.test(boundName)) return true;
  const callee = unwrapTransparentExpression(expression);
  const called = calledName(callee);
  const name =
    called && ts.isIdentifier(callee) ? resolveStaticAlias(called, aliases, callee) : called;
  if (name === null || (RECOVERY_FACTORY_NAME.test(name) && !RECOVERY_COMPOUND_ACTION.test(name))) {
    return false;
  }
  if (RECOVERY_NAME.test(name)) return true;
  const receiver = calledReceiver(expression);
  const receiverName = receiver ? resolvedStaticReferenceName(receiver, aliases) : null;
  return (
    receiverName !== null && RECOVERY_ACTION_METHOD.test(name) && RECOVERY_NAME.test(receiverName)
  );
}

function isCatchHandlerInvocation(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && calledName(node.expression) === "catch";
}

function hasOptionalAccess(expression: ts.Expression): boolean {
  const candidate = unwrapTransparentExpression(expression);
  if (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) {
    return candidate.questionDotToken !== undefined || hasOptionalAccess(candidate.expression);
  }
  return false;
}

function isOptionalCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    (node.questionDotToken !== undefined || hasOptionalAccess(node.expression))
  );
}

// Count branches, short-circuit operators, condition-controlled loops, try statements, and
// named recovery calls. Sequencing loops do not choose onboarding behavior.
function isDecisionNode(node: ts.Node, aliases: StaticAliases): boolean {
  return (
    ts.isIfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isConditionalExpression(node) ||
    isLogicalDecision(node) ||
    ts.isForStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isTryStatement(node) ||
    isRecoveryInvocation(node, aliases) ||
    isCatchHandlerInvocation(node) ||
    isOptionalCall(node)
  );
}

function decisionNodeCategories(
  node: ts.Node,
  aliases: StaticAliases,
): ReadonlySet<OnboardDecisionCategory> {
  const categories = new Set<OnboardDecisionCategory>();

  function addIdentifiers(candidate: ts.Node): void {
    if (ts.isIdentifier(candidate) || ts.isPrivateIdentifier(candidate)) {
      for (const category of identifierCategories(candidate.text, aliases, candidate)) {
        categories.add(category);
      }
      return;
    }
    if (ts.isElementAccessExpression(candidate)) {
      const name = staticElementName(candidate);
      if (name) {
        for (const category of identifierCategories(name, aliases)) categories.add(category);
        const reference = resolvedStaticReferenceName(candidate, aliases);
        for (const category of identifierCategories(reference ?? name, aliases)) {
          categories.add(category);
        }
      }
      addIdentifiers(candidate.expression);
      if (!name && candidate.argumentExpression) addIdentifiers(candidate.argumentExpression);
      return;
    }
    if (ts.isPropertyAccessExpression(candidate)) {
      const reference = resolvedStaticReferenceName(candidate, aliases);
      for (const category of identifierCategories(
        reference ?? `${candidate.expression.getText()}${candidate.name.text}`,
        aliases,
      )) {
        categories.add(category);
      }
      addIdentifiers(candidate.expression);
      return;
    }
    ts.forEachChild(candidate, addIdentifiers);
  }

  function scanCondition(candidate: ts.Node, root: boolean): void {
    if (!root && isDecisionNode(candidate, aliases)) return;
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
    if (!root && isDecisionNode(candidate, aliases)) return;
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
  } else if (isRecoveryInvocation(node, aliases)) {
    addIdentifiers(recoveryInvocationExpression(node));
  } else if (isCatchHandlerInvocation(node)) {
    for (const argument of node.arguments) scanActionArgument(argument);
  } else if (isOptionalCall(node)) {
    addIdentifiers(node.expression);
    for (const argument of node.arguments) scanActionArgument(argument);
  }
  return categories;
}

function decisionCounts(
  name: string,
  scope: ts.Node,
  aliases: StaticAliases,
  prunedNodes: ReadonlySet<ts.Node> = new Set(),
): Record<OnboardDecisionCategory, Record<string, number>> {
  const nameCategories = identifierCategories(name, aliases);
  const counts: Record<OnboardDecisionCategory, Record<string, number>> = {
    gateway: emptyDecisionCounts(),
    messaging: emptyDecisionCounts(),
    policy: emptyDecisionCounts(),
    provider: emptyDecisionCounts(),
  };

  function visit(node: ts.Node): void {
    if (prunedNodes.has(node)) return;
    if (isDecisionNode(node, aliases)) {
      const categories = new Set([...nameCategories, ...decisionNodeCategories(node, aliases)]);
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
  const aliases = collectStaticAliases(sourceFile);
  const decisions: Record<OnboardDecisionCategory, Record<string, number>> = {
    gateway: emptyDecisionCounts(),
    messaging: emptyDecisionCounts(),
    policy: emptyDecisionCounts(),
    provider: emptyDecisionCounts(),
  };

  for (const statement of sourceFile.statements) {
    for (const { name, node } of topLevelScopes(statement)) {
      const callables = callableScopes(name, node);
      const callableBodies = new Set(callables.map((scope) => scope.node));
      const scopes: DecisionScope[] = [{ name, node, prunedNodes: callableBodies }, ...callables];
      for (const scope of scopes) {
        const declarationCounts = decisionCounts(scope.name, scope.node, aliases, scope.prunedNodes);
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

export function combineOnboardEntryCompositionCeiling(
  baseBudget: OnboardEntryCompositionBudget,
  baseActual: OnboardEntryCompositionBudget,
): OnboardEntryCompositionCeiling {
  const declarations = Object.fromEntries(
    CATEGORIES.map((category) => {
      const names = new Set([
        ...Object.keys(baseBudget[category]),
        ...Object.keys(baseActual[category]),
      ]);
      return [
        category,
        sortCounts(
          Object.fromEntries(
            [...names].map((declaration) => [
              declaration,
              Math.max(
                baseBudget[category][declaration] ?? 0,
                baseActual[category][declaration] ?? 0,
              ),
            ]),
          ),
        ),
      ];
    }),
  ) as Record<OnboardDecisionCategory, OnboardDecisionCounts>;
  const categoryTotals = Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      Math.max(totalDecisions(baseBudget[category]), totalDecisions(baseActual[category])),
    ]),
  ) as Record<OnboardDecisionCategory, number>;
  const budgetTotal = CATEGORIES.reduce(
    (total, category) => total + totalDecisions(baseBudget[category]),
    0,
  );
  const actualTotal = CATEGORIES.reduce(
    (total, category) => total + totalDecisions(baseActual[category]),
    0,
  );
  return { declarations, categoryTotals, globalTotal: Math.max(budgetTotal, actualTotal) };
}

export function evaluateOnboardEntryCompositionBudgetExpansion(
  budget: OnboardEntryCompositionBudget,
  ceiling: OnboardEntryCompositionCeiling,
): OnboardEntryCompositionBudgetExpansion[] {
  const expansions: OnboardEntryCompositionBudgetExpansion[] = [];
  for (const category of CATEGORIES) {
    for (const [declaration, budgetCount] of Object.entries(budget[category])) {
      const baselineCount = ceiling.declarations[category][declaration] ?? 0;
      if (budgetCount <= baselineCount) continue;
      expansions.push({ kind: "declaration", category, declaration, budgetCount, baselineCount });
    }
    const budgetCount = totalDecisions(budget[category]);
    const baselineCount = ceiling.categoryTotals[category];
    if (budgetCount > baselineCount) {
      expansions.push({ kind: "category", category, budgetCount, baselineCount });
    }
  }
  const budgetTotal = CATEGORIES.reduce(
    (total, category) => total + totalDecisions(budget[category]),
    0,
  );
  if (budgetTotal > ceiling.globalTotal) {
    expansions.push({
      kind: "global",
      budgetCount: budgetTotal,
      baselineCount: ceiling.globalTotal,
    });
  }
  return expansions.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
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

function runGit(args: readonly string[]): CompositionGitResult {
  const result = spawnSync("git", [...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 5_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    error: result.error?.message ?? null,
  };
}

export function resolveCompositionMergeBase(
  git: CompositionGitRunner = runGit,
  baseBranch = process.env.GITHUB_BASE_REF?.trim(),
): string {
  const baseRef = baseBranch ? `origin/${baseBranch}` : "origin/main";
  const mergeBase = git(["merge-base", "HEAD", baseRef]);
  if (mergeBase.error) {
    throw new Error(
      `could not run git to resolve the composition merge base against ${baseRef} (${mergeBase.error})`,
    );
  }
  if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) {
    throw new Error(
      `could not resolve the composition merge base against ${baseRef}; fetch the base ref with sufficient history`,
    );
  }
  return mergeBase.stdout.trim();
}

export function mergeBaseCompositionCeiling(
  git: CompositionGitRunner = runGit,
  baseBranch = process.env.GITHUB_BASE_REF?.trim(),
): OnboardEntryCompositionCeiling {
  const revision = resolveCompositionMergeBase(git, baseBranch);
  function readBaseFile(relativePath: string): string {
    const source = git(["show", `${revision}:${relativePath}`]);
    if (source.error) {
      throw new Error(
        `could not run git to read ${relativePath} from composition merge base ${revision} (${source.error})`,
      );
    }
    if (source.status !== 0) {
      throw new Error(`could not read ${relativePath} from composition merge base ${revision}`);
    }
    return source.stdout;
  }

  const baseBudget = parseOnboardEntryCompositionBudget(
    readBaseFile("ci/onboard-entry-composition-budget.json"),
  );
  const baseActual = collectOnboardEntryDecisions(readBaseFile("src/lib/onboard.ts"));
  return combineOnboardEntryCompositionCeiling(baseBudget, baseActual);
}

function formatBudgetExpansions(
  expansions: readonly OnboardEntryCompositionBudgetExpansion[],
): string {
  return [
    "Onboarding entry composition budget must not expand relative to the merge base.",
    "",
    ...expansions.map((expansion) =>
      expansion.kind === "declaration"
        ? `- ${expansion.declaration}: ${expansion.category} budget increased from ${expansion.baselineCount} to ${expansion.budgetCount}.`
        : expansion.kind === "category"
          ? `- ${expansion.category}: total budget increased from ${expansion.baselineCount} to ${expansion.budgetCount}.`
          : `- all categories: total budget increased from ${expansion.baselineCount} to ${expansion.budgetCount}.`,
    ),
  ].join("\n");
}

function main(): void {
  const actual = collectOnboardEntryDecisions(readFileSync(ENTRY_PATH, "utf8"));
  const budget = parseOnboardEntryCompositionBudget(readFileSync(BUDGET_PATH, "utf8"));
  const baseline = mergeBaseCompositionCeiling();
  const expansions = evaluateOnboardEntryCompositionBudgetExpansion(budget, baseline);
  if (expansions.length > 0) {
    console.error(formatBudgetExpansions(expansions));
    process.exitCode = 1;
    return;
  }
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

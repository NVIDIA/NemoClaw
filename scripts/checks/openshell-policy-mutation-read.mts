// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prevent provider-composed OpenShell policy entries from entering mutation
 * paths.
 *
 * invalidState: a refactor introduces an unclassified policy read or changes a
 * mutation to consume provider-composed `--full` output.
 * sourceBoundary: typed command builders own argv construction; this audit owns
 * exhaustive discovery and classification of their production call sites.
 * whyNotSourceFix: TypeScript cannot distinguish a command array after it
 * crosses the process runner, so this defense-in-depth check intentionally uses
 * deterministic AST classifications plus repository-wide read-site discovery.
 * regressionTest: test/runtime/policy/policy-mutation-read-discovery.test.ts injects
 * unaccounted reads and requires this audit to fail.
 * removalCondition: replace the AST classification table when mutation and
 * diagnostic commands carry enforced tagged types through the runner boundary.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export type PolicyReadView = "base" | "full";
export type PolicyReadFailureHandling = "error-preserving" | "ignore-error" | "unclassified";

export interface DiscoveredPolicyRead {
  readonly site: string;
  readonly view: PolicyReadView;
  readonly failureHandling: PolicyReadFailureHandling;
}

interface AuditedPolicyReadFile {
  readonly relativePath: string;
  readonly expectedReads: readonly DiscoveredPolicyRead[];
}

function preservingBase(site: string): DiscoveredPolicyRead {
  return { site, view: "base", failureHandling: "error-preserving" };
}

function ignoredBase(site: string): DiscoveredPolicyRead {
  return { site, view: "base", failureHandling: "ignore-error" };
}

function unclassifiedBase(site: string): DiscoveredPolicyRead {
  return { site, view: "base", failureHandling: "unclassified" };
}

function ignoredFull(site: string): DiscoveredPolicyRead {
  return { site, view: "full", failureHandling: "ignore-error" };
}

export const MUTATION_READS: readonly AuditedPolicyReadFile[] = [
  {
    relativePath: "src/lib/actions/sandbox/policy-get.ts",
    expectedReads: [preservingBase("getSandboxPolicy")],
  },
  {
    relativePath: "src/lib/policy/index.ts",
    expectedReads: [
      ignoredBase("removePreset"),
      ignoredBase("readCurrentSandboxPolicy"),
      ignoredBase("applyPresetContent"),
      ignoredBase("applyPresets"),
      preservingBase("customPresetOwnsNetworkPolicyKey"),
      ignoredFull("getGatewayPresets/readPolicy"),
      preservingBase("getPresetContentGatewayState/readPolicy"),
    ],
  },
  {
    relativePath: "nemoclaw/src/blueprint/runner.ts",
    expectedReads: [unclassifiedBase("actionApply")],
  },
  {
    relativePath: "src/lib/shields/index.ts",
    expectedReads: [
      preservingBase("resolveExactManagedMcpPolicies"),
      ignoredBase("resolveProvableManagedMcpPoliciesForDeadline"),
      ignoredBase("shieldsDownWithoutHostLock"),
    ],
  },
];

const NON_MUTATION_POLICY_READS: readonly AuditedPolicyReadFile[] = [
  {
    relativePath: "src/lib/actions/sandbox/gateway-state.ts",
    expectedReads: [
      ignoredFull("getSandboxGatewayState"),
      ignoredFull("getSandboxGatewayStateForStatus"),
    ],
  },
  {
    relativePath: "src/lib/policy/commands.ts",
    expectedReads: [
      {
        site: "buildPolicyGetCommand",
        view: "base",
        failureHandling: "unclassified",
      },
      {
        site: "buildPolicyGetFullCommand",
        view: "full",
        failureHandling: "unclassified",
      },
    ],
  },
] as const;

export interface DiscoveredPolicyReadSite {
  readonly relativePath: string;
  readonly readCalls: number;
  readonly reads: readonly DiscoveredPolicyRead[];
}

const POLICY_GET_BUILDERS = new Map<string, PolicyReadView>([
  ["buildPolicyGetCommand", "base"],
  ["buildPolicyGetFullCommand", "full"],
]);

interface PolicyBuilderBindings {
  readonly identifiers: ReadonlyMap<ts.Symbol, PolicyReadView>;
  readonly namespaces: ReadonlySet<ts.Symbol>;
}

const POLICY_BUILDER_MODULE_PATHS = [
  "src/lib/policy",
  "src/lib/policy/index",
  "src/lib/policy/commands",
] as const;

function calledName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return null;
}

function isPolicyBuilderModule(
  fileName: string,
  moduleSpecifier: string,
  repoRoot: string,
): boolean {
  if (!moduleSpecifier.startsWith(".")) return false;
  const resolved = path
    .resolve(path.dirname(fileName), moduleSpecifier)
    .replace(/\.[cm]?[jt]sx?$/u, "");
  return POLICY_BUILDER_MODULE_PATHS.some(
    (relativePath) => resolved === path.resolve(repoRoot, relativePath),
  );
}

function requireModuleSpecifier(
  expression: ts.Expression | undefined,
  checker: ts.TypeChecker,
): string | null {
  if (
    !expression ||
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "require" ||
    expression.arguments.length !== 1 ||
    checker.getSymbolAtLocation(expression.expression)
  ) {
    return null;
  }
  const [moduleSpecifier] = expression.arguments;
  return moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier) ? moduleSpecifier.text : null;
}

function collectRequiredPolicyBindings(
  declaration: ts.VariableDeclaration,
  fileName: string,
  repoRoot: string,
  checker: ts.TypeChecker,
  identifiers: Map<ts.Symbol, PolicyReadView>,
  namespaces: Set<ts.Symbol>,
): void {
  const moduleSpecifier = requireModuleSpecifier(declaration.initializer, checker);
  if (!moduleSpecifier || !isPolicyBuilderModule(fileName, moduleSpecifier, repoRoot)) return;
  if (ts.isIdentifier(declaration.name)) {
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (symbol) namespaces.add(symbol);
    return;
  }
  if (!ts.isObjectBindingPattern(declaration.name)) return;
  collectPolicyBuilderObjectBindings(declaration.name, checker, identifiers, namespaces);
}

function collectPolicyBuilderObjectBindings(
  pattern: ts.ObjectBindingPattern,
  checker: ts.TypeChecker,
  identifiers: Map<ts.Symbol, PolicyReadView>,
  namespaces: Set<ts.Symbol>,
): void {
  for (const element of pattern.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    if (element.dotDotDotToken) {
      const symbol = checker.getSymbolAtLocation(element.name);
      if (symbol) namespaces.add(symbol);
      continue;
    }
    const importedName = element.propertyName ?? element.name;
    const view = POLICY_GET_BUILDERS.get(propertyNameText(importedName) ?? "");
    const symbol = checker.getSymbolAtLocation(element.name);
    if (symbol && view) identifiers.set(symbol, view);
  }
}

function collectPolicyBuilderBindings(
  sourceFile: ts.SourceFile,
  fileName: string,
  repoRoot: string,
  checker: ts.TypeChecker,
): PolicyBuilderBindings {
  const identifiers = new Map<ts.Symbol, PolicyReadView>();
  const namespaces = new Set<ts.Symbol>();
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.importClause &&
      !statement.importClause.isTypeOnly &&
      isPolicyBuilderModule(fileName, statement.moduleSpecifier.text, repoRoot)
    ) {
      const { namedBindings } = statement.importClause;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        const symbol = checker.getSymbolAtLocation(namedBindings.name);
        if (symbol) namespaces.add(symbol);
      } else if (namedBindings) {
        for (const element of namedBindings.elements) {
          if (element.isTypeOnly) continue;
          const importedName = element.propertyName?.text ?? element.name.text;
          const view = POLICY_GET_BUILDERS.get(importedName);
          if (!view) continue;
          const symbol = checker.getSymbolAtLocation(element.name);
          if (symbol) identifiers.set(symbol, view);
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectRequiredPolicyBindings(
          declaration,
          fileName,
          repoRoot,
          checker,
          identifiers,
          namespaces,
        );
      }
    }
  }

  const aliasDeclarations: ts.VariableDeclaration[] = [];
  function collectAliasDeclarations(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      aliasDeclarations.push(node);
    }
    ts.forEachChild(node, collectAliasDeclarations);
  }
  collectAliasDeclarations(sourceFile);

  for (let pass = 0; pass < aliasDeclarations.length; pass += 1) {
    const previousSize = identifiers.size + namespaces.size;
    for (const declaration of aliasDeclarations) {
      const { initializer } = declaration;
      if (!initializer) continue;
      const bindings = { identifiers, namespaces };
      if (ts.isIdentifier(declaration.name)) {
        const symbol = checker.getSymbolAtLocation(declaration.name);
        if (!symbol) continue;
        if (isPolicyNamespaceReference(initializer, bindings, fileName, repoRoot, checker)) {
          namespaces.add(symbol);
          continue;
        }
        const view = policyBuilderReferenceView(initializer, bindings, checker);
        if (view) identifiers.set(symbol, view);
        continue;
      }
      if (
        ts.isObjectBindingPattern(declaration.name) &&
        isPolicyNamespaceReference(initializer, bindings, fileName, repoRoot, checker)
      ) {
        collectPolicyBuilderObjectBindings(declaration.name, checker, identifiers, namespaces);
      }
    }
    if (identifiers.size + namespaces.size === previousSize) break;
  }
  return { identifiers, namespaces };
}

function isPolicyNamespaceReference(
  expression: ts.Expression,
  bindings: PolicyBuilderBindings,
  fileName: string,
  repoRoot: string,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return isPolicyNamespaceReference(expression.expression, bindings, fileName, repoRoot, checker);
  }
  const moduleSpecifier = requireModuleSpecifier(expression, checker);
  if (moduleSpecifier) return isPolicyBuilderModule(fileName, moduleSpecifier, repoRoot);
  if (!ts.isIdentifier(expression)) return false;
  const symbol = checker.getSymbolAtLocation(expression);
  return !!symbol && bindings.namespaces.has(symbol);
}

function policyBuilderReferenceView(
  expression: ts.Expression,
  bindings: PolicyBuilderBindings,
  checker: ts.TypeChecker,
): PolicyReadView | null {
  if (ts.isParenthesizedExpression(expression)) {
    return policyBuilderReferenceView(expression.expression, bindings, checker);
  }
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    return symbol ? (bindings.identifiers.get(symbol) ?? null) : null;
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return null;
  }
  const memberName = calledName(expression);
  const view = memberName ? POLICY_GET_BUILDERS.get(memberName) : undefined;
  if (!view) return null;
  const target = expression.expression;
  if (!ts.isIdentifier(target)) return null;
  const symbol = checker.getSymbolAtLocation(target);
  return symbol && bindings.namespaces.has(symbol) ? view : null;
}

function createBoundSourceFile(
  source: string,
  fileName: string,
): { readonly sourceFile: ts.SourceFile; readonly checker: ts.TypeChecker } {
  const absoluteFileName = path.resolve(fileName);
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(compilerOptions, true);
  host.fileExists = (candidate) => path.resolve(candidate) === absoluteFileName;
  host.readFile = (candidate) =>
    path.resolve(candidate) === absoluteFileName ? source : undefined;
  host.getSourceFile = (candidate, languageVersion) =>
    path.resolve(candidate) === absoluteFileName
      ? ts.createSourceFile(candidate, source, languageVersion, true)
      : undefined;
  const program = ts.createProgram([absoluteFileName], compilerOptions, host);
  const sourceFile = program.getSourceFile(absoluteFileName);
  if (!sourceFile) throw new Error(`Unable to parse policy read source: ${fileName}`);
  return { sourceFile, checker: program.getTypeChecker() };
}

function literalText(expression: ts.Expression): string | null {
  return ts.isStringLiteralLike(expression) ? expression.text : null;
}

function isCanonicalOpenshellResolverCall(
  expression: ts.Expression,
  fileName: string,
  repoRoot: string,
  checker: ts.TypeChecker,
): boolean {
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "resolveOpenshellBinary" ||
    expression.arguments.length !== 0 ||
    path.resolve(fileName) !== path.resolve(repoRoot, "src/lib/policy/commands.ts")
  ) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(expression.expression);
  return (
    symbol?.declarations?.some(
      (declaration) =>
        ts.isFunctionDeclaration(declaration) &&
        ts.isSourceFile(declaration.parent) &&
        declaration.name?.text === "resolveOpenshellBinary" &&
        path.resolve(declaration.getSourceFile().fileName) === path.resolve(fileName),
    ) === true
  );
}

function directPolicyReadView(
  expression: ts.ArrayLiteralExpression,
  fileName: string,
  repoRoot: string,
  checker: ts.TypeChecker,
): PolicyReadView | null {
  const first = expression.elements[0];
  if (!first || !ts.isExpression(first)) return null;
  const firstText = literalText(first);
  const offset =
    firstText === "policy"
      ? 0
      : firstText === "openshell" ||
          isCanonicalOpenshellResolverCall(first, fileName, repoRoot, checker)
        ? 1
        : -1;
  if (offset < 0) return null;
  const values = expression.elements.map((element) =>
    ts.isExpression(element) ? literalText(element) : null,
  );
  if (values[offset] !== "policy" || values[offset + 1] !== "get") return null;
  if (values[offset + 2] === "--base") return "base";
  if (values[offset + 2] === "--full") return "full";
  return null;
}

function declarationNameText(name: ts.DeclarationName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  return name.getText();
}

function functionScopeName(node: ts.FunctionLikeDeclaration): string {
  const ownName = "name" in node ? declarationNameText(node.name) : null;
  if (ownName) return ownName;
  const { parent } = node;
  if (ts.isVariableDeclaration(parent)) return declarationNameText(parent.name) ?? "<anonymous>";
  if (ts.isPropertyAssignment(parent)) return declarationNameText(parent.name) ?? "<anonymous>";
  return "<anonymous>";
}

function isFunctionScope(node: ts.Node): node is ts.FunctionLikeDeclaration {
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

function policyReadSite(node: ts.Node): string {
  const scopes: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionScope(current)) scopes.unshift(functionScopeName(current));
  }
  return scopes.join("/") || "<module>";
}

type IgnoreErrorOption = "absent" | "present" | "unclassified";

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return null;
}

function mergeIgnoreErrorOptions(
  left: IgnoreErrorOption,
  right: IgnoreErrorOption,
): IgnoreErrorOption {
  if (left === "unclassified" || right === "unclassified") return "unclassified";
  return left === "present" || right === "present" ? "present" : "absent";
}

function classifyIgnoreErrorOption(expression: ts.Expression): IgnoreErrorOption {
  if (ts.isParenthesizedExpression(expression)) {
    return classifyIgnoreErrorOption(expression.expression);
  }
  if (ts.isConditionalExpression(expression)) {
    return mergeIgnoreErrorOptions(
      classifyIgnoreErrorOption(expression.whenTrue),
      classifyIgnoreErrorOption(expression.whenFalse),
    );
  }
  if (!ts.isObjectLiteralExpression(expression)) return "unclassified";

  let result: IgnoreErrorOption = "absent";
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      result = mergeIgnoreErrorOptions(result, classifyIgnoreErrorOption(property.expression));
      continue;
    }
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      const name = "name" in property ? propertyNameText(property.name) : null;
      if (name === "ignoreError") result = "unclassified";
      continue;
    }
    const name = propertyNameText(property.name);
    if (name !== "ignoreError") continue;
    if (ts.isShorthandPropertyAssignment(property)) {
      result = "unclassified";
      continue;
    }
    if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      result = mergeIgnoreErrorOptions(result, "present");
      continue;
    }
    if (property.initializer.kind !== ts.SyntaxKind.FalseKeyword) result = "unclassified";
  }
  return result;
}

const POLICY_READ_RUNNERS = new Set([
  "captureOpenshell",
  "captureOpenshellForStatus",
  "runCapture",
  "runCmd",
]);

function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  return node.pos >= ancestor.pos && node.end <= ancestor.end;
}

function containsThrowOutsideNestedFunctions(node: ts.Node): boolean {
  let containsThrow = false;
  function visit(current: ts.Node): void {
    if (ts.isThrowStatement(current)) {
      containsThrow = true;
      return;
    }
    if (current !== node && isFunctionScope(current)) return;
    ts.forEachChild(current, visit);
  }
  visit(node);
  return containsThrow;
}

function catchGuaranteesDirectThrow(block: ts.Block): boolean {
  const finalStatement = block.statements[block.statements.length - 1];
  if (!finalStatement || !ts.isThrowStatement(finalStatement)) return false;
  return block.statements
    .slice(0, -1)
    .every((statement) => ts.isVariableStatement(statement) || ts.isEmptyStatement(statement));
}

function policyReadFailureHandling(node: ts.Node): PolicyReadFailureHandling {
  let runnerHandling: PolicyReadFailureHandling = "unclassified";
  for (let current = node.parent; current && !isFunctionScope(current); current = current.parent) {
    if (!ts.isCallExpression(current) || !ts.isIdentifier(current.expression)) continue;
    if (!POLICY_READ_RUNNERS.has(current.expression.text)) continue;
    const command = current.arguments[0];
    if (!command || !isWithin(node, command)) return "unclassified";
    if (current.arguments.length === 1) {
      runnerHandling = "error-preserving";
      break;
    }
    if (current.arguments.length !== 2) return "unclassified";
    const option = classifyIgnoreErrorOption(current.arguments[1]);
    runnerHandling =
      option === "present"
        ? "ignore-error"
        : option === "absent"
          ? "error-preserving"
          : "unclassified";
    break;
  }
  if (runnerHandling !== "error-preserving") return runnerHandling;

  for (let current = node.parent; current && !isFunctionScope(current); current = current.parent) {
    if (!ts.isTryStatement(current) || !current.catchClause || !isWithin(node, current.tryBlock)) {
      continue;
    }
    if (catchGuaranteesDirectThrow(current.catchClause.block)) continue;
    if (containsThrowOutsideNestedFunctions(current.catchClause.block)) return "unclassified";
    return "ignore-error";
  }
  return runnerHandling;
}

export function classifyPolicyReadCalls(
  source: string,
  fileName: string,
  repoRoot = REPO_ROOT,
): DiscoveredPolicyRead[] {
  const { sourceFile, checker } = createBoundSourceFile(source, fileName);
  const builderBindings = collectPolicyBuilderBindings(sourceFile, fileName, repoRoot, checker);
  const reads: DiscoveredPolicyRead[] = [];

  function record(node: ts.Node, view: PolicyReadView): void {
    reads.push({
      site: policyReadSite(node),
      view,
      failureHandling: policyReadFailureHandling(node),
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const view = policyBuilderReferenceView(node.expression, builderBindings, checker);
      if (view) record(node, view);
    } else if (ts.isArrayLiteralExpression(node)) {
      const view = directPolicyReadView(node, fileName, repoRoot, checker);
      if (view) record(node, view);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return reads;
}

export function countPolicyReadCalls(
  source: string,
  fileName: string,
  repoRoot = REPO_ROOT,
): number {
  return classifyPolicyReadCalls(source, fileName, repoRoot).length;
}

function productionTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(entryPath);
    if (
      !entry.isFile() ||
      !/\.[cm]?ts$/u.test(entry.name) ||
      /\.(?:test|spec)\.[cm]?ts$/u.test(entry.name)
    ) {
      return [];
    }
    return [entryPath];
  });
}

export function discoverPolicyReadSites(repoRoot: string): DiscoveredPolicyReadSite[] {
  return ["src", "nemoclaw/src"]
    .flatMap((sourceRoot) => productionTypeScriptFiles(path.join(repoRoot, sourceRoot)))
    .flatMap((sourcePath) => {
      const source = readFileSync(sourcePath, "utf8");
      const reads = classifyPolicyReadCalls(source, sourcePath, repoRoot);
      return reads.length > 0
        ? [
            {
              relativePath: path.relative(repoRoot, sourcePath).split(path.sep).join("/"),
              readCalls: reads.length,
              reads,
            },
          ]
        : [];
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function policyReadDescription(read: DiscoveredPolicyRead): string {
  return `${read.site} (${read.view}, ${read.failureHandling})`;
}

function policyReadDescriptions(reads: readonly DiscoveredPolicyRead[]): string[] {
  return reads.map(policyReadDescription).sort();
}

export function auditOpenShellPolicyMutationReads(repoRoot = REPO_ROOT): string[] {
  const violations: string[] = [];
  const discoveredReads = new Map(
    discoverPolicyReadSites(repoRoot).map((site) => [site.relativePath, site.reads]),
  );
  const auditedReads = [...MUTATION_READS, ...NON_MUTATION_POLICY_READS];
  for (const { relativePath, expectedReads } of auditedReads) {
    const sourcePath = path.join(repoRoot, relativePath);
    if (!existsSync(sourcePath)) {
      violations.push(`${relativePath}: audited policy read source is missing`);
      discoveredReads.delete(relativePath);
      continue;
    }
    const expected = policyReadDescriptions(expectedReads);
    const discovered = policyReadDescriptions(discoveredReads.get(relativePath) ?? []);
    if (expected.join("\n") !== discovered.join("\n")) {
      violations.push(
        `${relativePath}: expected audited policy reads [${expected.join("; ")}], found [${discovered.join("; ")}]`,
      );
    }
    discoveredReads.delete(relativePath);
  }
  for (const [relativePath, reads] of discoveredReads) {
    violations.push(
      `${relativePath}: found ${reads.length} unaccounted policy read call(s); classify every read before merge`,
    );
  }

  return violations;
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const violations = auditOpenShellPolicyMutationReads();
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }

  console.log(
    "OpenShell policy mutations use --base; read-only diagnostics isolate --full output.",
  );
}

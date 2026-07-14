#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Finds tests that read production source or shipped declarative configuration
// and assert on its raw shape. These tests tend to couple coverage to
// implementation details instead of behavior.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

type SourceRead = {
  readonly line: number;
  readonly column: number;
  readonly variable: string;
  readonly expression: string;
};

type Assertion = {
  readonly line: number;
  readonly column: number;
  readonly subject: string;
  readonly matcher: string;
  readonly text: string;
};

type SourceShapeCase = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly name: string;
  readonly assertions: readonly Assertion[];
  readonly sourceReads: readonly SourceRead[];
};

type ContractCategory = "compatibility" | "security";

type SourceShapeContractException = SourceShapeCase &
  Readonly<{ category: ContractCategory; reason: string }>;

type ContractExceptionAllowance = Readonly<{
  file: string;
  test: string;
  category: ContractCategory;
}>;

type InvalidContractException = Readonly<{ file: string; line: number; reason: string }>;

type Report = {
  readonly summary: {
    readonly source_shape_cases: number;
    readonly source_shape_assertions: number;
    readonly source_shape_files: number;
    readonly source_shape_max_cases_per_file: number;
    readonly source_shape_contract_exceptions: number;
    readonly source_shape_invalid_contract_exceptions: number;
  };
  readonly cases: readonly SourceShapeCase[];
  readonly contractExceptions: readonly SourceShapeContractException[];
  readonly invalidContractExceptions: readonly InvalidContractException[];
};

type FileReport = Pick<Report, "cases" | "contractExceptions" | "invalidContractExceptions">;

type VariableDecl = {
  readonly name: string;
  readonly initializer: ts.Expression;
};

type SourceFunction = {
  readonly name: string;
  readonly sourceRead: SourceRead;
  readonly parameterNames: readonly string[];
  readonly parameterizedPathRead: boolean;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_NAME_PATTERN = /\.(test|spec)\.(js|ts|mjs|mts|cjs|cts)$/;
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

function normalizePathText(text: string): string {
  return text.replaceAll("\\", "/");
}

function isSkippedPath(absPath: string): boolean {
  const rel = normalizePathText(relative(REPO_ROOT, absPath));
  return [...SKIP_DIRS].some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

function* walkFiles(dir: string): Generator<string> {
  if (!existsSync(dir) || isSkippedPath(dir)) return;

  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (isSkippedPath(abs)) continue;

    const stats = statSync(abs);
    if (stats.isDirectory()) {
      yield* walkFiles(abs);
    } else if (stats.isFile()) {
      yield abs;
    }
  }
}

function isTestFile(absPath: string): boolean {
  const rel = normalizePathText(relative(REPO_ROOT, absPath));
  return TEST_NAME_PATTERN.test(basename(rel));
}

const TEXT_IDENTIFIER_CACHE = new Map<string, ReadonlySet<string>>();

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return !(
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node)
  );
}

function identifiersInText(text: string): ReadonlySet<string> {
  const cached = TEXT_IDENTIFIER_CACHE.get(text);
  if (cached) return cached;
  const identifiers = new Set<string>();
  const sourceFile = ts.createSourceFile(
    "source-shape-fragment.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  TEXT_IDENTIFIER_CACHE.set(text, identifiers);
  return identifiers;
}

function textContainsIdentifier(text: string, identifier: string): boolean {
  return identifiersInText(text).has(identifier);
}

function nodeReferencesAnyIdentifier(root: ts.Node, identifiers: ReadonlySet<string>): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isIdentifier(node) && identifiers.has(node.text) && isReferenceIdentifier(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeTestFixturePath(text: string): boolean {
  const normalized = normalizePathText(text);
  return (
    /Dockerfile\.sandbox/.test(normalized) ||
    /(?:^|\/)fixtures?\//.test(normalized) ||
    /\.agents\/skills/.test(normalized) ||
    (/(?:^|["'`/])test\/e2e\//.test(normalized) &&
      /\.(?:[cm]?[jt]s|sh|py|md)(?:["'`),]|\s)/.test(normalized) &&
      !/vitest(?:\.[\w-]+)?\.config\.[cm]?[jt]s/.test(normalized))
  );
}

function isProductionPathExpression(
  text: string,
  productionPathVars: ReadonlySet<string>,
): boolean {
  const normalized = normalizePathText(text);
  if (looksLikeTestFixturePath(normalized)) {
    return false;
  }
  if ([...productionPathVars].some((name) => textContainsIdentifier(normalized, name))) return true;

  return hasDirectProductionPathHint(normalized);
}

function hasDirectProductionPathHint(text: string): boolean {
  return (
    /["'`](?:\.\.\/)*(?:\.github|agents|bin|dist|nemoclaw|nemoclaw-blueprint|scripts|src|test\/e2e)\//.test(
      text,
    ) ||
    /["'`](?:\.\.\/)*(?:package\.json|install\.sh|\.pre-commit-config\.yaml)["'`]/.test(text) ||
    /["'`](?:\.\.\/)+Dockerfile(?:\.base)?["'`]/.test(text) ||
    /["'`](?:\.\.\/)+bin\//.test(text) ||
    /["'`](?:\.\.\/)+agents\//.test(text) ||
    /["'`](?:\.\.\/)+scripts\//.test(text) ||
    /["'`](?:\.\.\/)+src\//.test(text) ||
    /["'`](?:\.\.\/)+dist\//.test(text) ||
    /["'`]\.\.\/["'`]\s*,\s*["'`](?:\.github|agents|bin|dist|nemoclaw|nemoclaw-blueprint|scripts|src|Dockerfile(?:\.base)?|install\.sh|package\.json)["'`]/.test(
      text,
    ) ||
    /["'`]\.\.["'`]\s*,\s*["'`](?:\.github|agents|bin|dist|nemoclaw|nemoclaw-blueprint|scripts|src|Dockerfile(?:\.base)?|install\.sh|package\.json)["'`]/.test(
      text,
    ) ||
    /join\(\s*["'`]\.\.["'`]\s*,\s*["'`](?:\.github|agents|bin|dist|nemoclaw|nemoclaw-blueprint|scripts|src|Dockerfile(?:\.base)?|install\.sh|package\.json)["'`]\s*\)/.test(
      text,
    ) ||
    /path\.join\(\s*process\.cwd\(\)\s*,\s*["'`](?:\.github|agents|bin|dist|nemoclaw|nemoclaw-blueprint|scripts|src|Dockerfile(?:\.base)?|install\.sh|package\.json)["'`]/.test(
      text,
    ) ||
    /(import\.meta\.dirname|import\.meta\.url)[\s\S]*["'`](?![\w.-]+\.test\.ts["'`])[\w.-]+\.ts["'`]/.test(
      text,
    ) ||
    /\b(?:START_SCRIPT|SCRIPT_PATH|DOCKERFILE(?:_[A-Z]+)?|HERMES_[A-Z_]+|CANONICAL_FIX|NEMOCLAW_START_SCRIPT)\b/.test(
      text,
    ) ||
    /["'`]nemoclaw["'`].*["'`]src["'`]/.test(text) ||
    /["'`](nemoclaw|nemohermes)\.js["'`]/.test(text)
  );
}

function isPathLikeVariableName(name: string): boolean {
  return (
    /^(REPO_ROOT|ROOT)$/.test(name) ||
    /(root|dir|path|file|files|script|source|src|dockerfile|payload|installer)/i.test(name)
  );
}

function isReadFileExpressionText(text: string): boolean {
  return /\b(?:readFileSync|readFile)\s*\(/.test(text);
}

function isReadFileCall(node: ts.CallExpression): boolean {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) {
    return expression.text === "readFileSync" || expression.text === "readFile";
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "readFileSync" || expression.name.text === "readFile";
  }
  return false;
}

function isCommandExecutionText(text: string): boolean {
  return /\b(?:spawn|spawnSync|exec|execFile|execFileSync|execSync|run(?:Logged|Docker|Bash|WithLib|Embedded|Patch|Hermes|Openclaw|Daemon|Fetch|Command)\w*)\b/.test(
    text,
  );
}

type DynamicFunctionBindings = {
  readonly constructors: ReadonlySet<string>;
  readonly functions: ReadonlySet<string>;
};

const DYNAMIC_FUNCTION_BINDING_CACHE = new WeakMap<ts.SourceFile, DynamicFunctionBindings>();

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isDynamicFunctionConstructorFactory(expression: ts.Expression): boolean {
  const current = unwrapTransparentExpression(expression);
  if (!ts.isPropertyAccessExpression(current) || current.name.text !== "constructor") return false;
  const prototypeCall = unwrapTransparentExpression(current.expression);
  if (
    !ts.isCallExpression(prototypeCall) ||
    !ts.isPropertyAccessExpression(prototypeCall.expression) ||
    !ts.isIdentifier(prototypeCall.expression.expression) ||
    prototypeCall.expression.expression.text !== "Object" ||
    prototypeCall.expression.name.text !== "getPrototypeOf"
  ) {
    return false;
  }
  const candidate = prototypeCall.arguments[0];
  return Boolean(
    candidate &&
      (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) &&
      candidate.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
  );
}

function dynamicFunctionBindings(sourceFile: ts.SourceFile): DynamicFunctionBindings {
  const cached = DYNAMIC_FUNCTION_BINDING_CACHE.get(sourceFile);
  if (cached) return cached;
  const variables = collectVariableDecls(sourceFile);
  const constructors = new Set<string>();
  for (const variable of variables) {
    if (isDynamicFunctionConstructorFactory(variable.initializer)) constructors.add(variable.name);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const variable of variables) {
      if (constructors.has(variable.name)) continue;
      const initializer = unwrapTransparentExpression(variable.initializer);
      if (ts.isIdentifier(initializer) && constructors.has(initializer.text)) {
        constructors.add(variable.name);
        changed = true;
      }
    }
  }

  const functions = new Set<string>();
  for (const variable of variables) {
    const initializer = unwrapTransparentExpression(variable.initializer);
    if (
      ts.isNewExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      constructors.has(initializer.expression.text)
    ) {
      functions.add(variable.name);
    }
  }
  const result = { constructors, functions };
  DYNAMIC_FUNCTION_BINDING_CACHE.set(sourceFile, result);
  return result;
}

function containsDynamicFunctionExecution(sourceFile: ts.SourceFile, root: ts.Node): boolean {
  const { constructors, functions } = dynamicFunctionBindings(sourceFile);
  let found = false;
  function isConstructorCall(expression: ts.Expression): boolean {
    const current = unwrapTransparentExpression(expression);
    return (
      (ts.isNewExpression(current) || ts.isCallExpression(current)) &&
      ts.isIdentifier(current.expression) &&
      constructors.has(current.expression.text)
    );
  }
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = unwrapTransparentExpression(node.expression);
      if ((ts.isIdentifier(callee) && functions.has(callee.text)) || isConstructorCall(callee)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function isExecutionResultDerivation(sourceFile: ts.SourceFile, root: ts.Node): boolean {
  return (
    isCommandExecutionText(root.getText(sourceFile)) ||
    containsDynamicFunctionExecution(sourceFile, root)
  );
}

function looksLikeSourceFileExtensionFilter(text: string): boolean {
  return /\.endsWith\(\s*["'`]\.(?:[cm]?[jt]sx?|mts|cts)["'`]\s*\)/.test(text);
}

function looksLikeSourceTreeEnumeration(text: string): boolean {
  return /\breaddirSync\s*\(/.test(text) && looksLikeSourceFileExtensionFilter(text);
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function collectVariableDecls(sourceFile: ts.SourceFile): VariableDecl[] {
  const variables: VariableDecl[] = [];

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      for (const name of bindingNames(node.name))
        variables.push({ name, initializer: node.initializer });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return variables;
}

function isDeclarativeImportPath(value: string): boolean {
  return (
    /\.(?:json|ya?ml|toml|lock)$/.test(value) ||
    /vitest(?:\.[\w-]+)?\.config(?:\.[cm]?[jt]s)?$/.test(value)
  );
}

function moduleLoadSpecifier(expression: ts.Expression): string | null {
  let current = expression;
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = current.expression;
  }
  if (!ts.isCallExpression(current) || current.arguments.length === 0) return null;
  const isRequire = ts.isIdentifier(current.expression) && current.expression.text === "require";
  const isDynamicImport = current.expression.kind === ts.SyntaxKind.ImportKeyword;
  const specifier = current.arguments[0];
  return (isRequire || isDynamicImport) && ts.isStringLiteralLike(specifier)
    ? specifier.text
    : null;
}

function containsShippedDeclarativeLoad(sourceFile: ts.SourceFile, root: ts.Node): boolean {
  let found = false;
  const sourcePath = resolve(REPO_ROOT, sourceFile.fileName);
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isExpression(node)) {
      const specifier = moduleLoadSpecifier(node);
      if (specifier?.startsWith(".")) {
        const importedPath = normalizePathText(
          relative(REPO_ROOT, resolve(dirname(sourcePath), specifier)),
        );
        if (isDeclarativeImportPath(importedPath) && !looksLikeTestFixturePath(importedPath)) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

type ImportBinding = {
  readonly local: string;
  readonly imported: string;
  readonly path: string;
  readonly sourceRead: SourceRead;
  readonly node: ts.Node;
};

function collectImportBindings(sourceFile: ts.SourceFile, relPath: string): ImportBinding[] {
  const result: ImportBinding[] = [];
  const add = (
    local: string,
    imported: string,
    specifier: string,
    node: ts.Node,
    expression: string,
  ): void => {
    if (!specifier.startsWith(".")) return;
    const path = normalizePathText(
      relative(REPO_ROOT, resolve(REPO_ROOT, dirname(relPath), specifier)),
    );
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    result.push({
      local,
      imported,
      path,
      node,
      sourceRead: {
        line: line + 1,
        column: character + 1,
        variable: local,
        expression,
      },
    });
  };

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        const specifier = node.moduleSpecifier.text;
        const expression = node.getText(sourceFile);
        if (clause.name) add(clause.name.text, "default", specifier, node, expression);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          add(bindings.name.text, "*", specifier, node, expression);
        }
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) {
              add(
                element.name.text,
                element.propertyName?.text ?? element.name.text,
                specifier,
                node,
                expression,
              );
            }
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const specifier = moduleLoadSpecifier(node.initializer);
      if (specifier) {
        for (const local of bindingNames(node.name)) {
          add(local, "*", specifier, node, node.initializer.getText(sourceFile));
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

function scopedImportBindings(
  sourceFile: ts.SourceFile,
  imports: readonly ImportBinding[],
  testCall: ts.CallExpression,
  body: ts.Node,
): ImportBinding[] {
  return imports.filter((binding) => {
    if (isAncestor(body, binding.node)) return true;
    const scope = nearestLexicalScope(binding.node);
    return scope === sourceFile || isAncestor(scope, testCall);
  });
}

function collectProductionConsumerNames(imports: readonly ImportBinding[]): Set<string> {
  return new Set(
    imports
      .filter(
        ({ path }) =>
          !isDeclarativeImportPath(path) &&
          !TEST_NAME_PATTERN.test(path) &&
          /^(?:agents|bin|nemoclaw\/src|scripts|src|tools)\//.test(path),
      )
      .map(({ local }) => local),
  );
}

function isProductionBehaviorDerivation(
  value: ts.Expression,
  productionConsumerNames: ReadonlySet<string>,
): boolean {
  let expression = value;
  while (
    ts.isCallExpression(expression) ||
    ts.isAwaitExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    expression = expression.expression;
  }
  return ts.isIdentifier(expression) && productionConsumerNames.has(expression.text);
}

function collectDeclarativeImports(imports: readonly ImportBinding[]): Map<string, SourceRead> {
  return new Map(
    imports
      .filter(({ path }) => isDeclarativeImportPath(path) && !looksLikeTestFixturePath(path))
      .map(({ local, sourceRead }) => [local, sourceRead]),
  );
}

const RAW_CONFIG_ACCESSORS: Readonly<Record<string, readonly string[]>> = {
  "test/helpers/e2e-workflow-contract": ["readWorkflow", "readYaml"],
  "test/e2e/registry/registry": ["getTarget", "listTargets", "requireTargets"],
  "test/e2e/registry/expected-states": [
    "getExpectedState",
    "listExpectedStates",
    "requireExpectedState",
  ],
};

function collectRawConfigAccessors(imports: readonly ImportBinding[]): Map<string, SourceFunction> {
  const accessors = new Map<string, SourceFunction>();
  for (const binding of imports) {
    const module = binding.path.replace(/\.[cm]?[jt]s$/, "");
    const exportedNames = RAW_CONFIG_ACCESSORS[module];
    if (!exportedNames) continue;
    const names = binding.imported === "*" ? exportedNames : [binding.imported];
    for (const imported of names) {
      if (!exportedNames.includes(imported)) continue;
      const name = binding.imported === "*" ? `${binding.local}.${imported}` : binding.local;
      accessors.set(name, {
        name,
        parameterNames: [],
        parameterizedPathRead: imported === "readYaml",
        sourceRead: binding.sourceRead,
      });
    }
  }
  return accessors;
}

function isAncestor(ancestor: ts.Node, node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function nearestLexicalScope(node: ts.Node): ts.Block | ts.SourceFile {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isBlock(current)) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

function scopedVariableDecls(
  sourceFile: ts.SourceFile,
  variables: readonly VariableDecl[],
  testCall: ts.CallExpression,
  body: ts.Node,
): VariableDecl[] {
  return variables.filter((variable) => {
    if (isAncestor(body, variable.initializer)) return true;
    const scope = nearestLexicalScope(variable.initializer);
    return scope === sourceFile || isAncestor(scope, testCall);
  });
}

function collectSetupHookAssignments(
  sourceFile: ts.SourceFile,
  testCall: ts.CallExpression,
): VariableDecl[] {
  const setupHookNames = new Set(["beforeAll", "beforeEach"]);
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "vitest" ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === "beforeAll" || imported === "beforeEach") {
        setupHookNames.add(element.name.text);
      }
    }
  }
  const functionLikes = collectFunctionLikes(sourceFile);
  const functionAliases = collectVariableDecls(sourceFile).filter((variable) =>
    ts.isIdentifier(variable.initializer),
  );
  const visibleBindings = new Set<string>();
  function collectVisibleBindings(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      const scope = nearestLexicalScope(node);
      if (scope === sourceFile || isAncestor(scope, testCall)) {
        for (const name of bindingNames(node.name)) visibleBindings.add(name);
      }
    }
    ts.forEachChild(node, collectVisibleBindings);
  }
  collectVisibleBindings(sourceFile);

  const assignments: VariableDecl[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      setupHookNames.has(node.expression.text)
    ) {
      const scope = nearestLexicalScope(node);
      const appliesToTest = scope === sourceFile || isAncestor(scope, testCall);
      const inlineCallback = node.arguments.find(
        (argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
          ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
      );
      const callbackReference = node.arguments.find(ts.isIdentifier);
      let callbackName = callbackReference?.text;
      const seenAliases = new Set<string>();
      while (callbackName && !seenAliases.has(callbackName)) {
        seenAliases.add(callbackName);
        const alias = functionAliases.find((candidate) => {
          if (candidate.name !== callbackName) return false;
          const aliasScope = nearestLexicalScope(candidate.initializer);
          return aliasScope === sourceFile || isAncestor(aliasScope, node);
        });
        if (!alias || !ts.isIdentifier(alias.initializer)) break;
        callbackName = alias.initializer.text;
      }
      const referencedCallback = callbackName
        ? functionLikes.find((candidate) => {
            if (candidate.name !== callbackName) return false;
            const callbackScope = nearestLexicalScope(candidate.node);
            return callbackScope === sourceFile || isAncestor(callbackScope, node);
          })
        : undefined;
      const callbackBody = inlineCallback?.body ?? referencedCallback?.body;
      if (appliesToTest && callbackBody) {
        function collectAssignments(child: ts.Node): void {
          if (child !== callbackBody && isNestedFunctionLike(child)) return;
          if (
            ts.isBinaryExpression(child) &&
            child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(child.left) &&
            visibleBindings.has(child.left.text)
          ) {
            assignments.push({ name: child.left.text, initializer: child.right });
          }
          ts.forEachChild(child, collectAssignments);
        }
        collectAssignments(callbackBody);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return assignments;
}

function collectProductionPathVars(
  sourceFile: ts.SourceFile,
  variables: readonly VariableDecl[],
): Set<string> {
  const pathVars = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    for (const variable of variables) {
      if (pathVars.has(variable.name)) continue;
      const initText = normalizePathText(variable.initializer.getText(sourceFile));
      const directlyNamesProductionPath = hasDirectProductionPathHint(initText);
      const isRepositoryRoot =
        /^(REPO_ROOT|ROOT)$/.test(variable.name) &&
        /(import\.meta\.dirname|import\.meta\.url|fileURLToPath|process\.cwd\(\))/.test(initText);
      const derivesNamedProductionPath =
        isPathLikeVariableName(variable.name) &&
        [...pathVars].some((name) => textContainsIdentifier(initText, name));
      if (
        !looksLikeTestFixturePath(initText) &&
        (isRepositoryRoot || directlyNamesProductionPath || derivesNamedProductionPath)
      ) {
        pathVars.add(variable.name);
        changed = true;
      }
    }
  }

  return pathVars;
}

function callTargetName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return `${expression.expression.text}.${expression.name.text}`;
  }
  return null;
}

function nestedSourceReadInNode(
  sourceFile: ts.SourceFile,
  root: ts.Node,
  productionPathVars: ReadonlySet<string>,
  sourceFunctions: ReadonlyMap<string, SourceFunction>,
): SourceRead | null {
  let sourceRead: SourceRead | null = null;

  function visit(node: ts.Node): void {
    if (sourceRead) return;
    if (isNestedFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const target = callTargetName(node.expression);
      const functionRead = target ? sourceFunctions.get(target) : undefined;
      const readsProductionFile =
        isReadFileCall(node) &&
        node.arguments.length > 0 &&
        isProductionPathExpression(node.arguments[0].getText(sourceFile), productionPathVars);
      const readsThroughFunction =
        functionRead &&
        (!functionRead.parameterizedPathRead ||
          node.arguments.some((argument) =>
            isProductionPathExpression(argument.getText(sourceFile), productionPathVars),
          ));
      if (readsProductionFile || readsThroughFunction) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        sourceRead = {
          line: line + 1,
          column: character + 1,
          variable: "<nested>",
          expression: functionRead
            ? `${node.getText(sourceFile)} -> ${functionRead.sourceRead.expression}`
            : node.getText(sourceFile),
        };
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(root);
  return sourceRead;
}

function sourceReadFromInitializer(
  sourceFile: ts.SourceFile,
  variable: VariableDecl,
  productionPathVars: ReadonlySet<string>,
  sourceFunctions: ReadonlyMap<string, SourceFunction>,
  productionConsumerNames: ReadonlySet<string>,
): SourceRead | null {
  const init = variable.initializer;
  if (
    isProductionBehaviorDerivation(init, productionConsumerNames) ||
    isExecutionResultDerivation(sourceFile, init)
  ) {
    return null;
  }
  if (containsShippedDeclarativeLoad(sourceFile, init)) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(init.getStart());
    return {
      line: line + 1,
      column: character + 1,
      variable: variable.name,
      expression: init.getText(sourceFile),
    };
  }
  const nestedRead = nestedSourceReadInNode(sourceFile, init, productionPathVars, sourceFunctions);
  return nestedRead ? { ...nestedRead, variable: variable.name } : null;
}

function isNestedFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function functionLikeNameAndBody(node: ts.Node): {
  name: string;
  body: ts.ConciseBody;
  node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
} | null {
  if (ts.isFunctionDeclaration(node) && node.name && node.body) {
    return { name: node.name.text, body: node.body, node };
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
    node.initializer.body
  ) {
    return { name: node.name.text, body: node.initializer.body, node: node.initializer };
  }
  return null;
}

function collectFunctionLikes(
  sourceFile: ts.SourceFile,
): NonNullable<ReturnType<typeof functionLikeNameAndBody>>[] {
  const result: NonNullable<ReturnType<typeof functionLikeNameAndBody>>[] = [];
  function visit(node: ts.Node): void {
    const candidate = functionLikeNameAndBody(node);
    if (candidate) result.push(candidate);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

function collectSourceTreeFunctionNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  function visit(node: ts.Node): void {
    const functionLike = functionLikeNameAndBody(node);
    if (functionLike && looksLikeSourceTreeEnumeration(functionLike.body.getText(sourceFile))) {
      names.add(functionLike.name);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return names;
}

function collectSourceFunctions(
  sourceFile: ts.SourceFile,
  productionPathVars: ReadonlySet<string>,
): Map<string, SourceFunction> {
  const sourceFunctions = new Map<string, SourceFunction>();

  function parameterNamesFor(node: {
    parameters: ts.NodeArray<ts.ParameterDeclaration>;
  }): string[] {
    return node.parameters
      .map((parameter) => (ts.isIdentifier(parameter.name) ? parameter.name.text : null))
      .filter((name): name is string => Boolean(name));
  }

  function sourceReadFromExpression(
    expression: ts.Expression,
    parameterNames: readonly string[],
  ): { sourceRead: SourceRead; parameterizedPathRead: boolean } | null {
    if (
      !ts.isCallExpression(expression) ||
      !isReadFileCall(expression) ||
      expression.arguments.length === 0
    ) {
      return null;
    }
    const targetText = expression.arguments[0].getText(sourceFile);
    const parameterizedPathRead = parameterNames.some((name) =>
      textContainsIdentifier(targetText, name),
    );
    if (!parameterizedPathRead && !isProductionPathExpression(targetText, productionPathVars)) {
      return null;
    }
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(expression.getStart());
    return {
      parameterizedPathRead,
      sourceRead: {
        line: line + 1,
        column: character + 1,
        variable: "<return>",
        expression: expression.getText(sourceFile),
      },
    };
  }

  function registerSourceFunction(
    name: string,
    node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  ): void {
    if (isExecutionResultDerivation(sourceFile, node)) return;

    let sourceRead: SourceRead | null = null;
    let parameterizedPathRead = false;
    const parameterNames = parameterNamesFor(node);

    function visitFunctionBody(child: ts.Node): void {
      if (sourceRead) return;
      if (child !== node && isNestedFunctionLike(child)) return;
      if (ts.isCallExpression(child)) {
        const result = sourceReadFromExpression(child, parameterNames);
        if (result) {
          sourceRead = result.sourceRead;
          parameterizedPathRead = result.parameterizedPathRead;
          return;
        }
      }
      ts.forEachChild(child, visitFunctionBody);
    }

    if (node.body) visitFunctionBody(node.body);
    if (sourceRead) {
      sourceFunctions.set(name, {
        name,
        sourceRead,
        parameterNames,
        parameterizedPathRead,
      });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      registerSourceFunction(node.name.text, node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      registerSourceFunction(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return sourceFunctions;
}

function collectRawProjectionFunctionNames(
  sourceFile: ts.SourceFile,
  candidates: readonly NonNullable<ReturnType<typeof functionLikeNameAndBody>>[],
  testCall: ts.CallExpression,
  testBodyNode: ts.Node,
  sourceVars: ReadonlySet<string>,
  rawHelperNames: ReadonlySet<string>,
  productionConsumerNames: ReadonlySet<string>,
): Set<string> {
  const projections = new Set<string>();
  const scopedCandidates = candidates.filter((candidate) => {
    const scope = nearestLexicalScope(candidate.node);
    return (
      isAncestor(testBodyNode, candidate.node) ||
      scope === sourceFile ||
      isAncestor(scope, testCall)
    );
  });
  for (let hop = 0; hop < 2; hop += 1) {
    for (const candidate of scopedCandidates) {
      if (projections.has(candidate.name)) continue;
      const returned = ts.isBlock(candidate.body)
        ? candidate.body.statements.find(ts.isReturnStatement)?.expression
        : candidate.body;
      if (
        !(returned && isProductionBehaviorDerivation(returned, productionConsumerNames)) &&
        !isExecutionResultDerivation(sourceFile, candidate.body) &&
        (nodeReferencesAnyIdentifier(candidate.body, new Set([...sourceVars, ...projections])) ||
          callsRawShapeHelper(candidate.body, rawHelperNames))
      ) {
        projections.add(candidate.name);
      }
    }
  }
  return projections;
}

function collectSourceTreeShapeVars(
  sourceFile: ts.SourceFile,
  body: ts.Node,
  variables: readonly VariableDecl[],
  productionPathVars: ReadonlySet<string>,
): { sourceVars: Set<string>; pathVars: Set<string>; sourceTreeFunctions: Set<string> } {
  const sourceTreeFunctions = collectSourceTreeFunctionNames(sourceFile);
  const sourceVars = new Set<string>();
  const pathVars = new Set<string>();
  const bodyText = body.getText(sourceFile);

  for (const variable of variables) {
    const init = variable.initializer;
    const helperRead =
      ts.isCallExpression(init) &&
      ts.isIdentifier(init.expression) &&
      sourceTreeFunctions.has(init.expression.text) &&
      init.arguments.some((argument) =>
        isProductionPathExpression(argument.getText(sourceFile), productionPathVars),
      );
    const localCollector =
      ts.isArrayLiteralExpression(init) &&
      textContainsIdentifier(bodyText, variable.name) &&
      looksLikeSourceTreeEnumeration(bodyText) &&
      new RegExp(`\\b${escapeRegExp(variable.name)}\\.push\\s*\\(`).test(bodyText);

    if (helperRead || localCollector) {
      sourceVars.add(variable.name);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const variable of variables) {
      if (sourceVars.has(variable.name)) continue;
      if (nodeReferencesAnyIdentifier(variable.initializer, sourceVars)) {
        sourceVars.add(variable.name);
        changed = true;
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isForOfStatement(node)) {
      const iteratesSourceTree = nodeReferencesAnyIdentifier(node.expression, sourceVars);
      if (iteratesSourceTree) {
        const initializer = node.initializer;
        if (ts.isVariableDeclarationList(initializer)) {
          for (const declaration of initializer.declarations) {
            if (ts.isIdentifier(declaration.name)) pathVars.add(declaration.name.text);
          }
        } else if (ts.isIdentifier(initializer)) {
          pathVars.add(initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(body);

  return { sourceVars, pathVars, sourceTreeFunctions };
}

function rootIdentifier(expression: ts.Expression): string | null {
  let current = expression;
  while (
    ts.isCallExpression(current) ||
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function propagateAccumulatorSourceVars(
  sourceFile: ts.SourceFile,
  root: ts.Node,
  sourceVars: Set<string>,
  sourceFunctions: ReadonlyMap<string, SourceFunction>,
): boolean {
  let changed = false;
  const functionNames = new Set(sourceFunctions.keys());
  const referencesSource = (node: ts.Node): boolean =>
    nodeReferencesAnyIdentifier(node, sourceVars) || callsRawShapeHelper(node, functionNames);
  const add = (name: string | null): void => {
    if (name && !sourceVars.has(name)) {
      sourceVars.add(name);
      changed = true;
    }
  };
  function visit(node: ts.Node): void {
    if (node !== root && isNestedFunctionLike(node)) return;
    if (ts.isForOfStatement(node) && referencesSource(node.expression)) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          for (const name of bindingNames(declaration.name)) add(name);
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      /^(?:add|push|set)$/.test(node.expression.name.text) &&
      node.arguments.some(referencesSource)
    ) {
      add(rootIdentifier(node.expression.expression));
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      referencesSource(node.right)
    ) {
      add(rootIdentifier(node.left));
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return changed;
}

function collectSourceVars(
  sourceFile: ts.SourceFile,
  root: ts.Node,
  variables: readonly VariableDecl[],
  productionPathVars: ReadonlySet<string>,
  sourceFunctions: ReadonlyMap<string, SourceFunction>,
  productionConsumerNames: ReadonlySet<string>,
  initialSourceVars: ReadonlySet<string> = new Set(),
  initialSourceReads: readonly SourceRead[] = [],
): { sourceVars: Set<string>; sourceReads: SourceRead[] } {
  const sourceVars = new Set(initialSourceVars);
  const sourceReads: SourceRead[] = [...initialSourceReads];

  for (const variable of variables) {
    const sourceRead = sourceReadFromInitializer(
      sourceFile,
      variable,
      productionPathVars,
      sourceFunctions,
      productionConsumerNames,
    );
    if (sourceRead) {
      sourceVars.add(variable.name);
      sourceReads.push(sourceRead);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const variable of variables) {
      if (sourceVars.has(variable.name)) continue;
      const initText = variable.initializer.getText(sourceFile);
      const referencesSource = nodeReferencesAnyIdentifier(variable.initializer, sourceVars);
      const readsProductionFileCollection =
        isReadFileExpressionText(initText) &&
        [...productionPathVars].some((name) => textContainsIdentifier(initText, name));
      if (
        (referencesSource || readsProductionFileCollection) &&
        !isExecutionResultDerivation(sourceFile, variable.initializer) &&
        !isProductionBehaviorDerivation(variable.initializer, productionConsumerNames)
      ) {
        sourceVars.add(variable.name);
        changed = true;
      }
    }
    if (propagateAccumulatorSourceVars(sourceFile, root, sourceVars, sourceFunctions))
      changed = true;
  }

  return { sourceVars, sourceReads };
}

function collectExecutionResultVars(
  sourceFile: ts.SourceFile,
  candidates: readonly NonNullable<ReturnType<typeof functionLikeNameAndBody>>[],
  variables: readonly VariableDecl[],
): Set<string> {
  const executionFunctionNames = new Set<string>();
  for (let hop = 0; hop < 2; hop += 1) {
    for (const candidate of candidates) {
      if (
        isExecutionResultDerivation(sourceFile, candidate.body) ||
        nodeReferencesAnyIdentifier(candidate.body, executionFunctionNames)
      ) {
        executionFunctionNames.add(candidate.name);
      }
    }
  }
  const executionVars = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const variable of variables) {
      if (executionVars.has(variable.name)) continue;
      const root = rootIdentifier(variable.initializer);
      if (
        isExecutionResultDerivation(sourceFile, variable.initializer) ||
        (root && (executionVars.has(root) || executionFunctionNames.has(root)))
      ) {
        executionVars.add(variable.name);
        changed = true;
      }
    }
  }
  return executionVars;
}

function getExpectBase(expression: ts.Expression): ts.CallExpression | null {
  if (ts.isCallExpression(expression)) {
    if (ts.isIdentifier(expression.expression) && expression.expression.text === "expect") {
      return expression;
    }
    return getExpectBase(expression.expression);
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return getExpectBase(expression.expression);
  }
  return null;
}

function matcherName(expression: ts.Expression): string {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (ts.isCallExpression(expression)) {
    return matcherName(expression.expression);
  }
  return expression.getText();
}

function callsRawShapeHelper(root: ts.Node, helperNames: ReadonlySet<string>): boolean {
  const target = ts.isCallExpression(root) ? callTargetName(root.expression) : null;
  if (target && helperNames.has(target)) return true;
  let found = false;
  ts.forEachChild(root, (child) => {
    found ||= callsRawShapeHelper(child, helperNames);
  });
  return found;
}

function assertionFromSubject(
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  subjectExpr: ts.Expression,
  matcher: string,
  sourceVars: ReadonlySet<string>,
  productionPathVars: ReadonlySet<string>,
  sourceTreeFunctions: ReadonlySet<string>,
  productionConsumerNames: ReadonlySet<string>,
): Assertion | null {
  if (isProductionBehaviorDerivation(subjectExpr, productionConsumerNames)) return null;
  const subject = subjectExpr.getText(sourceFile);
  if (/\bfs\.statSync\(/.test(subject)) {
    return null;
  }
  const referencesSource = nodeReferencesAnyIdentifier(subjectExpr, sourceVars);
  const directSourceRead =
    ts.isCallExpression(subjectExpr) &&
    isReadFileCall(subjectExpr) &&
    subjectExpr.arguments.length > 0 &&
    isProductionPathExpression(subjectExpr.arguments[0].getText(sourceFile), productionPathVars);
  const directDeclarativeLoad = containsShippedDeclarativeLoad(sourceFile, subjectExpr);
  if (
    !referencesSource &&
    !directSourceRead &&
    !directDeclarativeLoad &&
    !callsRawShapeHelper(subjectExpr, sourceTreeFunctions)
  ) {
    return null;
  }

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return {
    line: line + 1,
    column: character + 1,
    subject,
    matcher,
    text: node.getText(sourceFile).replace(/\s+/g, " "),
  };
}

const ASSERT_MATCHERS = new Set([
  "deepEqual",
  "deepStrictEqual",
  "doesNotMatch",
  "doesNotReject",
  "doesNotThrow",
  "equal",
  "fail",
  "ifError",
  "match",
  "notDeepEqual",
  "notDeepStrictEqual",
  "notEqual",
  "notStrictEqual",
  "ok",
  "partialDeepStrictEqual",
  "rejects",
  "strictEqual",
  "throws",
]);

type AssertBindings = {
  readonly namespaces: ReadonlySet<string>;
  readonly methods: ReadonlyMap<string, string>;
};

const ASSERT_BINDING_CACHE = new WeakMap<ts.SourceFile, AssertBindings>();
const NODE_ASSERT_MODULES = new Set([
  "assert",
  "assert/strict",
  "node:assert",
  "node:assert/strict",
]);

function nodeAssertBindings(sourceFile: ts.SourceFile): AssertBindings {
  const cached = ASSERT_BINDING_CACHE.get(sourceFile);
  if (cached) return cached;
  const namespaces = new Set(["assert"]);
  const methods = new Map<string, string>();
  const addNamedBinding = (local: string, imported: string): void => {
    if (imported === "strict") namespaces.add(local);
    else methods.set(local, imported);
  };

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      NODE_ASSERT_MODULES.has(node.moduleSpecifier.text)
    ) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) namespaces.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) {
              addNamedBinding(element.name.text, element.propertyName?.text ?? element.name.text);
            }
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrapTransparentExpression(node.initializer);
      const specifier = moduleLoadSpecifier(node.initializer);
      if (specifier && NODE_ASSERT_MODULES.has(specifier)) {
        if (ts.isIdentifier(node.name)) {
          const imported = ts.isPropertyAccessExpression(initializer)
            ? initializer.name.text
            : "strict";
          addNamedBinding(node.name.text, imported);
        }
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const imported =
              element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
            addNamedBinding(element.name.text, imported);
          }
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        const root = rootIdentifier(initializer);
        if (root && namespaces.has(root)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const imported = element.propertyName?.getText(sourceFile) ?? element.name.text;
            addNamedBinding(element.name.text, imported);
          }
        }
      } else if (ts.isIdentifier(node.name)) {
        if (ts.isIdentifier(initializer) && methods.has(initializer.text)) {
          methods.set(node.name.text, methods.get(initializer.text) ?? "");
        } else if (ts.isPropertyAccessExpression(initializer)) {
          const root = rootIdentifier(initializer);
          if (root && namespaces.has(root)) {
            addNamedBinding(node.name.text, initializer.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  const result = { namespaces, methods };
  ASSERT_BINDING_CACHE.set(sourceFile, result);
  return result;
}

const ASSERT_TWO_ARGUMENT_MATCHERS = new Set([
  "deepEqual",
  "deepStrictEqual",
  "doesNotMatch",
  "equal",
  "match",
  "notDeepEqual",
  "notDeepStrictEqual",
  "notEqual",
  "notStrictEqual",
  "partialDeepStrictEqual",
  "rejects",
  "strictEqual",
  "throws",
]);

function assertionFromAssertCall(
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  sourceVars: ReadonlySet<string>,
  productionPathVars: ReadonlySet<string>,
  sourceTreeFunctions: ReadonlySet<string>,
  productionConsumerNames: ReadonlySet<string>,
  executionResultVars: ReadonlySet<string>,
): Assertion | null {
  const expression = node.expression;
  const bindings = nodeAssertBindings(sourceFile);
  let method: string | null = null;
  if (ts.isIdentifier(expression)) {
    if (bindings.namespaces.has(expression.text)) method = "ok";
    else method = bindings.methods.get(expression.text) ?? null;
  } else if (ts.isPropertyAccessExpression(expression)) {
    const root = rootIdentifier(expression);
    if (root && bindings.namespaces.has(root)) {
      method = expression.name.text === "strict" ? "ok" : expression.name.text;
    }
  }
  if (!method || !ASSERT_MATCHERS.has(method) || node.arguments.length === 0) {
    return null;
  }

  const firstArgument = node.arguments[0];
  const firstRoot = firstArgument ? rootIdentifier(firstArgument) : null;
  const firstIsBehavior = Boolean(
    firstArgument &&
      (isProductionBehaviorDerivation(firstArgument, productionConsumerNames) ||
        isExecutionResultDerivation(sourceFile, firstArgument) ||
        (firstRoot && executionResultVars.has(firstRoot))),
  );
  const argumentCount = ASSERT_TWO_ARGUMENT_MATCHERS.has(method) && !firstIsBehavior ? 2 : 1;
  for (const argument of node.arguments.slice(0, argumentCount)) {
    const assertion = assertionFromSubject(
      sourceFile,
      node,
      argument,
      `assert.${method}`,
      sourceVars,
      productionPathVars,
      sourceTreeFunctions,
      productionConsumerNames,
    );
    if (assertion) return assertion;
  }
  return null;
}

function expressionReferencesSource(
  expression: ts.Expression,
  sourceVars: ReadonlySet<string>,
  productionPathVars: ReadonlySet<string>,
  sourceTreeFunctions: ReadonlySet<string>,
  productionConsumerNames: ReadonlySet<string>,
): boolean {
  if (isProductionBehaviorDerivation(expression, productionConsumerNames)) return false;
  const callsSourceTreeHelper = callsRawShapeHelper(expression, sourceTreeFunctions);
  return (
    nodeReferencesAnyIdentifier(expression, sourceVars) ||
    callsSourceTreeHelper ||
    containsShippedDeclarativeLoad(expression.getSourceFile(), expression) ||
    (ts.isCallExpression(expression) &&
      isReadFileCall(expression) &&
      expression.arguments.length > 0 &&
      isProductionPathExpression(expression.arguments[0].getText(), productionPathVars))
  );
}

function assertionFromExpectCall(
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  sourceVars: ReadonlySet<string>,
  productionPathVars: ReadonlySet<string>,
  sourceTreeFunctions: ReadonlySet<string>,
  productionConsumerNames: ReadonlySet<string>,
  executionResultVars: ReadonlySet<string>,
): Assertion | null {
  if (
    sourceVars.size > 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "unreachable" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "expect"
  ) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return {
      line: line + 1,
      column: character + 1,
      subject: "expect.unreachable",
      matcher: "unreachable",
      text: node.getText(sourceFile).replace(/\s+/g, " "),
    };
  }

  const expectBase = getExpectBase(node.expression);
  if (!expectBase || expectBase.arguments.length === 0) {
    return null;
  }
  const subjectRoot = rootIdentifier(expectBase.arguments[0]);
  if (subjectRoot && executionResultVars.has(subjectRoot)) return null;
  const subjectAssertion = assertionFromSubject(
    sourceFile,
    node,
    expectBase.arguments[0],
    matcherName(node.expression),
    sourceVars,
    productionPathVars,
    sourceTreeFunctions,
    productionConsumerNames,
  );
  if (subjectAssertion) return subjectAssertion;

  if (
    node.arguments.some((argument) =>
      expressionReferencesSource(
        argument,
        sourceVars,
        productionPathVars,
        sourceTreeFunctions,
        productionConsumerNames,
      ),
    )
  ) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return {
      line: line + 1,
      column: character + 1,
      subject: node.expression.getText(sourceFile),
      matcher: matcherName(node.expression),
      text: node.getText(sourceFile).replace(/\s+/g, " "),
    };
  }

  return null;
}

function assertionFromCall(
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  sourceVars: ReadonlySet<string>,
  productionPathVars: ReadonlySet<string>,
  sourceTreeFunctions: ReadonlySet<string>,
  productionConsumerNames: ReadonlySet<string>,
  executionResultVars: ReadonlySet<string>,
): Assertion | null {
  return (
    assertionFromExpectCall(
      sourceFile,
      node,
      sourceVars,
      productionPathVars,
      sourceTreeFunctions,
      productionConsumerNames,
      executionResultVars,
    ) ||
    assertionFromAssertCall(
      sourceFile,
      node,
      sourceVars,
      productionPathVars,
      sourceTreeFunctions,
      productionConsumerNames,
      executionResultVars,
    )
  );
}

function isTestCallee(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text === "it" || expression.text === "test";
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      expression.name.text === "it" ||
      expression.name.text === "test" ||
      isTestCallee(expression.expression)
    );
  }
  if (ts.isCallExpression(expression)) {
    return isTestCallee(expression.expression);
  }
  return false;
}

function isTestCall(node: ts.CallExpression): boolean {
  return isTestCallee(node.expression);
}

function testCaseName(sourceFile: ts.SourceFile, node: ts.CallExpression): string {
  const first = node.arguments[0];
  if (!first) return "<unnamed>";
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
    return first.text;
  }
  return first.getText(sourceFile).replace(/\s+/g, " ");
}

function testBody(node: ts.CallExpression): ts.Node | null {
  for (const arg of node.arguments) {
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      return arg.body;
    }
  }
  return null;
}

function collectAssertionsInNode(
  sourceFile: ts.SourceFile,
  root: ts.Node,
  sourceVars: ReadonlySet<string>,
  productionPathVars: ReadonlySet<string>,
  sourceTreeFunctions: ReadonlySet<string> = new Set(),
  productionConsumerNames: ReadonlySet<string> = new Set(),
  executionResultVars: ReadonlySet<string> = new Set(),
): Assertion[] {
  const assertions: Assertion[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const assertion = assertionFromCall(
        sourceFile,
        node,
        sourceVars,
        productionPathVars,
        sourceTreeFunctions,
        productionConsumerNames,
        executionResultVars,
      );
      if (assertion) assertions.push(assertion);
    }
    ts.forEachChild(node, visit);
  }

  visit(root);
  return assertions;
}

function dedupeAssertions(assertions: readonly Assertion[]): Assertion[] {
  const seen = new Set<string>();
  const uniqueAssertions: Assertion[] = [];

  for (const assertion of assertions) {
    const key = [
      assertion.line,
      assertion.column,
      assertion.subject,
      assertion.matcher,
      assertion.text,
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueAssertions.push(assertion);
  }

  return uniqueAssertions;
}

function fallbackLineScan(sourceFile: ts.SourceFile, root: ts.Node): Assertion[] {
  const rootText = root.getText(sourceFile);
  const sourceVars = new Set<string>();
  const assertions: Assertion[] = [];

  const sourceReadRe = /(?:const|let|var)\s+(\w+)\s*=\s*(?:\w+\.)?readFileSync\(([^\n;]+)/g;
  for (const match of rootText.matchAll(sourceReadRe)) {
    const [, variable, target] = match;
    if (variable && target && isProductionPathExpression(target, new Set())) {
      sourceVars.add(variable);
    }
  }

  if (sourceVars.size === 0) return assertions;

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const assertion = assertionFromCall(
        sourceFile,
        node,
        sourceVars,
        new Set(),
        new Set(),
        new Set(),
        new Set(),
      );
      if (assertion) assertions.push(assertion);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return assertions;
}

type ContractAnnotation = {
  readonly line: number;
  readonly category?: SourceShapeContractException["category"];
  readonly reason?: string;
  readonly error?: string;
};

const CONTRACT_CATEGORIES = new Set(["compatibility", "security"]);

function collectContractAnnotations(sourceFile: ts.SourceFile, text: string): ContractAnnotation[] {
  const annotations: ContractAnnotation[] = [];
  const commentRanges = new Map<number, ts.CommentRange>();
  function collectRanges(node: ts.Node): void {
    for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
      commentRanges.set(range.pos, range);
    }
    for (const range of ts.getTrailingCommentRanges(text, node.getEnd()) ?? []) {
      commentRanges.set(range.pos, range);
    }
    ts.forEachChild(node, collectRanges);
  }
  collectRanges(sourceFile);

  for (const range of commentRanges.values()) {
    if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
    const comment = text.slice(range.pos, range.end);
    if (!comment.includes("source-shape-contract:")) continue;
    const { line } = sourceFile.getLineAndCharacterOfPosition(range.pos);
    const match = comment.match(/^\/\/\s*source-shape-contract:\s*([a-z-]+)\s+--\s+(.+?)\s*$/);
    const category = match?.[1];
    const reason = match?.[2];
    const error = !match
      ? "invalid annotation syntax"
      : !category || !CONTRACT_CATEGORIES.has(category)
        ? "unsupported category"
        : !reason || reason.length < 24 || reason.trim().split(/\s+/).length < 4
          ? "reason is too short"
          : undefined;
    annotations.push({
      line: line + 1,
      ...(error
        ? { error }
        : { category: category as SourceShapeContractException["category"], reason }),
    });
  }
  return annotations;
}

function scanSourceTextReport(fileName: string, relPath: string, text: string): FileReport {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const functionLikes = collectFunctionLikes(sourceFile);
  const allVariables = collectVariableDecls(sourceFile);
  const imports = collectImportBindings(sourceFile, relPath);
  const annotations = collectContractAnnotations(sourceFile, text);
  const annotationsByLine = new Map(annotations.map((annotation) => [annotation.line, annotation]));
  const usedAnnotationLines = new Set<number>();

  const cases: SourceShapeCase[] = [];
  const contractExceptions: SourceShapeContractException[] = [];
  const invalidContractExceptions: InvalidContractException[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isTestCall(node)) {
      const body = testBody(node);
      if (body) {
        const scopedImports = scopedImportBindings(sourceFile, imports, node, body);
        const productionConsumerNames = collectProductionConsumerNames(scopedImports);
        const declarativeImports = collectDeclarativeImports(scopedImports);
        const rawConfigAccessors = collectRawConfigAccessors(scopedImports);
        const variables = [
          ...scopedVariableDecls(sourceFile, allVariables, node, body),
          ...collectSetupHookAssignments(sourceFile, node),
        ];
        const executionResultVars = collectExecutionResultVars(
          sourceFile,
          functionLikes,
          variables,
        );
        const productionPathVars = collectProductionPathVars(sourceFile, variables);
        const sourceTreeShapeVars = collectSourceTreeShapeVars(
          sourceFile,
          body,
          variables,
          productionPathVars,
        );
        const sourcePathVars = new Set([...productionPathVars, ...sourceTreeShapeVars.pathVars]);
        const sourceFunctions = collectSourceFunctions(sourceFile, sourcePathVars);
        for (const [name, accessor] of rawConfigAccessors) sourceFunctions.set(name, accessor);
        const initialSourceVars = new Set([
          ...sourceTreeShapeVars.sourceVars,
          ...declarativeImports.keys(),
        ]);
        const initialSourceReads = [...declarativeImports.values()];
        const sourceCollection = collectSourceVars(
          sourceFile,
          body,
          variables,
          sourcePathVars,
          sourceFunctions,
          productionConsumerNames,
          initialSourceVars,
          initialSourceReads,
        );
        const rawProjectionFunctions = collectRawProjectionFunctionNames(
          sourceFile,
          functionLikes,
          node,
          body,
          sourceCollection.sourceVars,
          new Set(sourceFunctions.keys()),
          productionConsumerNames,
        );
        const { sourceVars, sourceReads } = sourceCollection;
        const assertions = dedupeAssertions([
          ...collectAssertionsInNode(
            sourceFile,
            body,
            sourceVars,
            sourcePathVars,
            new Set([
              ...sourceTreeShapeVars.sourceTreeFunctions,
              ...rawProjectionFunctions,
              ...rawConfigAccessors.keys(),
            ]),
            productionConsumerNames,
            executionResultVars,
          ),
          ...fallbackLineScan(sourceFile, body),
        ]);
        if (assertions.length > 0) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          const entry: SourceShapeCase = {
            file: relPath,
            line: line + 1,
            column: character + 1,
            name: testCaseName(sourceFile, node),
            assertions,
            sourceReads,
          };
          const annotation = annotationsByLine.get(line);
          if (annotation) {
            usedAnnotationLines.add(annotation.line);
            if (annotation.category && annotation.reason) {
              contractExceptions.push({
                ...entry,
                category: annotation.category,
                reason: annotation.reason,
              });
            } else {
              invalidContractExceptions.push({
                file: relPath,
                line: annotation.line,
                reason: annotation.error ?? "invalid annotation",
              });
              cases.push(entry);
            }
          } else {
            cases.push(entry);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  for (const annotation of annotations) {
    if (usedAnnotationLines.has(annotation.line)) continue;
    invalidContractExceptions.push({
      file: relPath,
      line: annotation.line,
      reason: annotation.error ?? "annotation must be immediately above a detected test",
    });
  }
  return { cases, contractExceptions, invalidContractExceptions };
}

function scanSourceText(fileName: string, relPath: string, text: string): SourceShapeCase[] {
  return [...scanSourceTextReport(fileName, relPath, text).cases];
}

function scanFile(absPath: string): FileReport {
  const relPath = normalizePathText(relative(REPO_ROOT, absPath));
  const text = readFileSync(absPath, "utf-8");
  return scanSourceTextReport(absPath, relPath, text);
}

export function sourceShapeSummary(report: FileReport): Report["summary"] {
  const casesPerFile = new Map<string, number>();
  for (const entry of report.cases) {
    casesPerFile.set(entry.file, (casesPerFile.get(entry.file) ?? 0) + 1);
  }
  return {
    source_shape_cases: report.cases.length,
    source_shape_assertions: report.cases.reduce((sum, entry) => sum + entry.assertions.length, 0),
    source_shape_files: casesPerFile.size,
    source_shape_max_cases_per_file: Math.max(0, ...casesPerFile.values()),
    source_shape_contract_exceptions: report.contractExceptions.length,
    source_shape_invalid_contract_exceptions: report.invalidContractExceptions.length,
  };
}

function scan(): Report {
  const fileReports = [...walkFiles(REPO_ROOT)].filter(isTestFile).map(scanFile);
  const cases = fileReports.flatMap((report) => report.cases);
  const contractExceptions = fileReports.flatMap((report) => report.contractExceptions);
  const invalidContractExceptions = fileReports.flatMap(
    (report) => report.invalidContractExceptions,
  );
  return {
    summary: sourceShapeSummary({ cases, contractExceptions, invalidContractExceptions }),
    cases,
    contractExceptions,
    invalidContractExceptions,
  };
}

function printMetrics(report: Report): void {
  for (const [name, value] of Object.entries(report.summary)) {
    console.log(`METRIC ${name}=${value}`);
  }
}

function printHuman(report: Report): void {
  if (report.cases.length === 0) {
    console.log("No source-shape tests detected.");
  } else {
    console.log(`Detected ${report.summary.source_shape_cases} source-shape test cases:`);
    for (const testCase of report.cases) {
      console.log(`- ${testCase.file}:${testCase.line}:${testCase.column} ${testCase.name}`);
      for (const assertion of testCase.assertions) {
        console.log(
          `  - ${assertion.line}:${assertion.column} ${assertion.matcher} on ${assertion.subject}`,
        );
      }
    }
  }
  for (const exception of report.contractExceptions) {
    console.log(
      `EXCEPTION ${exception.file}:${exception.line} ${exception.category} -- ${exception.reason}`,
    );
  }
  for (const invalid of report.invalidContractExceptions) {
    console.log(`INVALID ${invalid.file}:${invalid.line} ${invalid.reason}`);
  }
  printMetrics(report);
}

function contractExceptionKey(file: string, test: string, category: ContractCategory): string {
  return `${file}\0${test}\0${category}`;
}

export function contractExceptionAllowlistErrors(
  actual: readonly Pick<SourceShapeContractException, "file" | "name" | "category">[],
  allowed: readonly ContractExceptionAllowance[],
): string[] {
  const actualKeyList = actual.map(({ file, name, category }) =>
    contractExceptionKey(file, name, category),
  );
  const actualKeys = new Set(actualKeyList);
  const allowedKeys = new Set(
    allowed.map(({ file, test, category }) => contractExceptionKey(file, test, category)),
  );
  return [
    ...[...actualKeys]
      .filter((key) => actualKeyList.filter((candidate) => candidate === key).length > 1)
      .map((key) => `duplicate source-shape exception identity: ${key.replaceAll("\0", " :: ")}`),
    ...[...actualKeys]
      .filter((key) => !allowedKeys.has(key))
      .map((key) => `unapproved source-shape exception: ${key.replaceAll("\0", " :: ")}`),
    ...[...allowedKeys]
      .filter((key) => !actualKeys.has(key))
      .map((key) => `unused source-shape exception allowance: ${key.replaceAll("\0", " :: ")}`),
  ];
}

function checkBudget(report: Report): void {
  const budgetPath = join(REPO_ROOT, "ci", "source-shape-test-budget.json");
  const budget = JSON.parse(readFileSync(budgetPath, "utf-8")) as {
    readonly maxSourceShapeCases?: unknown;
    readonly sourceShapeContractExceptions?: unknown;
  };
  if (
    typeof budget.maxSourceShapeCases !== "number" ||
    !Array.isArray(budget.sourceShapeContractExceptions)
  ) {
    throw new Error(
      `${budgetPath} must define numeric maxSourceShapeCases and sourceShapeContractExceptions[]`,
    );
  }
  const allowed = budget.sourceShapeContractExceptions as ContractExceptionAllowance[];
  for (const entry of allowed) {
    const keys = entry && typeof entry === "object" ? Object.keys(entry).sort() : [];
    if (
      keys.join(",") !== "category,file,test" ||
      typeof entry.file !== "string" ||
      typeof entry.test !== "string" ||
      !CONTRACT_CATEGORIES.has(entry.category)
    ) {
      throw new Error(`${budgetPath} has an invalid sourceShapeContractExceptions entry`);
    }
  }
  if (
    new Set(allowed.map(({ file, test, category }) => contractExceptionKey(file, test, category)))
      .size !== allowed.length
  ) {
    throw new Error(`${budgetPath} has duplicate sourceShapeContractExceptions entries`);
  }

  const actual = report.summary.source_shape_cases;
  if (actual > budget.maxSourceShapeCases) {
    console.error(
      `Source-shape test budget exceeded: ${actual} cases > ${budget.maxSourceShapeCases}.`,
    );
    console.error(
      "Replace raw source/config assertions with behavior tests, then ratchet the budget.",
    );
    process.exitCode = 1;
  }
  const allowlistErrors = contractExceptionAllowlistErrors(report.contractExceptions, allowed);
  if (allowlistErrors.length > 0) {
    for (const error of allowlistErrors) console.error(error);
    process.exitCode = 1;
  }
  if (report.invalidContractExceptions.length > 0) {
    console.error(`Invalid source-shape exceptions: ${report.invalidContractExceptions.length}.`);
    process.exitCode = 1;
  }
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const report = scan();

  if (args.has("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else if (args.has("--metrics")) {
    printMetrics(report);
  } else {
    printHuman(report);
  }

  if (args.has("--check")) {
    checkBudget(report);
  }
}

export function scanTextForTest(relPath: string, text: string): SourceShapeCase[] {
  return scanSourceText(relPath, normalizePathText(relPath), text);
}

export function scanTextForTestReport(relPath: string, text: string): FileReport {
  return scanSourceTextReport(relPath, normalizePathText(relPath), text);
}

function isDirectInvocation(): boolean {
  const invoked = process.argv[1];
  return Boolean(
    invoked &&
      (import.meta.url === `file://${invoked}` || invoked.endsWith("find-source-shape-tests.ts")),
  );
}

if (isDirectInvocation()) {
  main();
}

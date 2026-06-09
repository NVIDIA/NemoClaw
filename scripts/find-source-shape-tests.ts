#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Finds tests that read production source text and assert on its shape. These
// tests tend to couple coverage to implementation strings instead of behavior.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
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

type Report = {
  readonly summary: {
    readonly source_shape_cases: number;
    readonly source_shape_assertions: number;
    readonly source_shape_files: number;
    readonly source_shape_max_cases_per_file: number;
  };
  readonly cases: readonly SourceShapeCase[];
};

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

function stripStringLiterals(text: string): string {
  return text.replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, "");
}

function textContainsIdentifier(text: string, identifier: string): boolean {
  return new RegExp(`\\b${escapeRegExp(identifier)}\\b`).test(stripStringLiterals(text));
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
    // The isolated scenario suite under test/e2e-scenario/ is entirely test
    // assets and a self-contained runtime: scenario manifests, validation
    // suite YAMLs, expected-state YAMLs, and the suite's own runner. Reads of
    // these paths are not source-shape coupling to product code.
    /(?:^|["'`/])test\/e2e-scenario(?:["'`/]|$)/.test(normalized)
  );
}

function looksLikeDeclarativeConfigPath(text: string): boolean {
  const normalized = normalizePathText(text);
  // Declarative configs below have dedicated schema/resolver validation. Keep
  // this scanner focused on source-code shape assertions rather than treating
  // every schema-backed config invariant as source-text coupling.
  return (
    /nemoclaw-blueprint\/blueprint\.yaml/.test(normalized) ||
    /nemoclaw-blueprint\/policies\//.test(normalized) ||
    /nemoclaw-blueprint\/provider-profiles\//.test(normalized) ||
    /nemoclaw-blueprint\/router\/pool-config\.yaml/.test(normalized) ||
    /nemoclaw-blueprint\/model-specific-setup\//.test(normalized) ||
    /agents\/[^/]+\/policy-(?:additions|permissive)\.yaml/.test(normalized)
  );
}

function isProductionPathExpression(
  text: string,
  productionPathVars: ReadonlySet<string>,
): boolean {
  const normalized = normalizePathText(text);
  if (looksLikeTestFixturePath(normalized) || looksLikeDeclarativeConfigPath(normalized)) {
    return false;
  }
  if ([...productionPathVars].some((name) => textContainsIdentifier(normalized, name))) return true;

  return hasDirectProductionPathHint(normalized);
}

function hasDirectProductionPathHint(text: string): boolean {
  return (
    /["'`](?:\.\.\/)?(?:\.github|agents|bin|dist|nemoclaw|nemoclaw-blueprint|scripts|src|test\/e2e)\//.test(
      text,
    ) ||
    /["'`](?:package\.json|install\.sh|\.pre-commit-config\.yaml)["'`]/.test(text) ||
    /["'`]\.\.\/Dockerfile(?:\.base)?["'`]/.test(text) ||
    /["'`]\.\.\/bin\//.test(text) ||
    /["'`]\.\.\/agents\//.test(text) ||
    /["'`]\.\.\/scripts\//.test(text) ||
    /["'`]\.\.\/src\//.test(text) ||
    /["'`]\.\.\/dist\//.test(text) ||
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

function isExecutionResultDerivation(initText: string): boolean {
  return /\b(?:spawnSync|execFileSync|execSync|run(?:Logged|Docker|Bash|WithLib|Embedded|Patch|Hermes|Openclaw|Daemon|Fetch|Command)\w*)\b/.test(
    initText,
  );
}

function looksLikeSourceFileExtensionFilter(text: string): boolean {
  return /\.endsWith\(\s*["'`]\.(?:[cm]?[jt]sx?|mts|cts)["'`]\s*\)/.test(text);
}

function looksLikeSourceTreeEnumeration(text: string): boolean {
  return /\breaddirSync\s*\(/.test(text) && looksLikeSourceFileExtensionFilter(text);
}

function collectVariableDecls(sourceFile: ts.SourceFile): VariableDecl[] {
  const variables: VariableDecl[] = [];

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      variables.push({ name: node.name.text, initializer: node.initializer });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return variables;
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
        !looksLikeDeclarativeConfigPath(initText) &&
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
  return null;
}

function nestedSourceReadInNode(
  sourceFile: ts.SourceFile,
  root: ts.Node,
  productionPathVars: ReadonlySet<string>,
): SourceRead | null {
  let sourceRead: SourceRead | null = null;

  function visit(node: ts.Node): void {
    if (sourceRead) return;
    if (isNestedFunctionLike(node)) return;
    if (
      ts.isCallExpression(node) &&
      isReadFileCall(node) &&
      node.arguments.length > 0 &&
      isProductionPathExpression(node.arguments[0].getText(sourceFile), productionPathVars)
    ) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      sourceRead = {
        line: line + 1,
        column: character + 1,
        variable: "<nested>",
        expression: node.getText(sourceFile),
      };
      return;
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
): SourceRead | null {
  const init = variable.initializer;
  const nestedRead = nestedSourceReadInNode(sourceFile, init, productionPathVars);
  if (nestedRead) {
    return { ...nestedRead, variable: variable.name };
  }
  if (!ts.isCallExpression(init)) {
    return null;
  }

  if (isReadFileCall(init) && init.arguments.length > 0) {
    const targetText = init.arguments[0].getText(sourceFile);
    if (!isProductionPathExpression(targetText, productionPathVars)) {
      return null;
    }

    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      variable.initializer.getStart(),
    );
    return {
      line: line + 1,
      column: character + 1,
      variable: variable.name,
      expression: variable.initializer.getText(sourceFile),
    };
  }

  const targetName = callTargetName(init.expression);
  const functionSourceRead = targetName ? sourceFunctions.get(targetName) : undefined;
  if (!functionSourceRead) {
    return null;
  }
  if (
    functionSourceRead.parameterizedPathRead &&
    !init.arguments.some((argument) =>
      isProductionPathExpression(argument.getText(sourceFile), productionPathVars),
    )
  ) {
    return null;
  }

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    variable.initializer.getStart(),
  );
  return {
    line: line + 1,
    column: character + 1,
    variable: variable.name,
    expression: `${variable.initializer.getText(sourceFile)} -> ${functionSourceRead.sourceRead.expression}`,
  };
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
    const functionText = node.getText(sourceFile);
    if (isExecutionResultDerivation(functionText)) return;

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
      const initText = variable.initializer.getText(sourceFile);
      if ([...sourceVars].some((name) => textContainsIdentifier(initText, name))) {
        sourceVars.add(variable.name);
        changed = true;
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isForOfStatement(node)) {
      const expressionText = node.expression.getText(sourceFile);
      const iteratesSourceTree = [...sourceVars].some((name) =>
        textContainsIdentifier(expressionText, name),
      );
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

function collectSourceVars(
  sourceFile: ts.SourceFile,
  variables: readonly VariableDecl[],
  productionPathVars: ReadonlySet<string>,
  sourceFunctions: ReadonlyMap<string, SourceFunction>,
  initialSourceVars: ReadonlySet<string> = new Set(),
): { sourceVars: Set<string>; sourceReads: SourceRead[] } {
  const sourceVars = new Set(initialSourceVars);
  const sourceReads: SourceRead[] = [];

  for (const variable of variables) {
    const sourceRead = sourceReadFromInitializer(
      sourceFile,
      variable,
      productionPathVars,
      sourceFunctions,
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
      const referencesSource = [...sourceVars].some((name) =>
        textContainsIdentifier(initText, name),
      );
      const readsProductionFileCollection =
        isReadFileExpressionText(initText) &&
        [...productionPathVars].some((name) => textContainsIdentifier(initText, name));
      if (
        (referencesSource || readsProductionFileCollection) &&
        !isExecutionResultDerivation(initText)
      ) {
        sourceVars.add(variable.name);
        changed = true;
      }
    }
  }

  return { sourceVars, sourceReads };
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

function assertionFromSubject(
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  subjectExpr: ts.Expression,
  matcher: string,
  sourceVars: ReadonlySet<string>,
  productionPathVars: ReadonlySet<string>,
): Assertion | null {
  const subject = subjectExpr.getText(sourceFile);
  if (/\bfs\.statSync\(/.test(subject)) {
    return null;
  }
  const referencesSource = [...sourceVars].some((name) => textContainsIdentifier(subject, name));
  const directSourceRead =
    ts.isCallExpression(subjectExpr) &&
    isReadFileCall(subjectExpr) &&
    subjectExpr.arguments.length > 0 &&
    isProductionPathExpression(subjectExpr.arguments[0].getText(sourceFile), productionPathVars);
  if (!referencesSource && !directSourceRead) {
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
  "rejects",
  "strictEqual",
  "throws",
]);

function assertionFromAssertCall(
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  sourceVars: ReadonlySet<string>,
  productionPathVars: ReadonlySet<string>,
): Assertion | null {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) {
    return null;
  }
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "assert") {
    return null;
  }
  const method = expression.name.text;
  if (!ASSERT_MATCHERS.has(method) || node.arguments.length === 0) {
    return null;
  }

  return assertionFromSubject(
    sourceFile,
    node,
    node.arguments[0],
    `assert.${method}`,
    sourceVars,
    productionPathVars,
  );
}

function expressionReferencesSource(
  expression: ts.Expression,
  sourceVars: ReadonlySet<string>,
  productionPathVars: ReadonlySet<string>,
  sourceTreeFunctions: ReadonlySet<string>,
): boolean {
  const text = expression.getText();
  const callsSourceTreeHelper =
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    sourceTreeFunctions.has(expression.expression.text) &&
    (expression.arguments.length === 0 ||
      expression.arguments.some((argument) =>
        isProductionPathExpression(argument.getText(), productionPathVars),
      ));
  return (
    [...sourceVars].some((name) => textContainsIdentifier(text, name)) ||
    callsSourceTreeHelper ||
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

  const subjectAssertion = assertionFromSubject(
    sourceFile,
    node,
    expectBase.arguments[0],
    matcherName(node.expression),
    sourceVars,
    productionPathVars,
  );
  if (subjectAssertion) return subjectAssertion;

  if (
    node.arguments.some((argument) =>
      expressionReferencesSource(argument, sourceVars, productionPathVars, sourceTreeFunctions),
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
): Assertion | null {
  return (
    assertionFromExpectCall(
      sourceFile,
      node,
      sourceVars,
      productionPathVars,
      sourceTreeFunctions,
    ) || assertionFromAssertCall(sourceFile, node, sourceVars, productionPathVars)
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
      const assertion = assertionFromCall(sourceFile, node, sourceVars, new Set(), new Set());
      if (assertion) assertions.push(assertion);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return assertions;
}

function scanSourceText(fileName: string, relPath: string, text: string): SourceShapeCase[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const allVariables = collectVariableDecls(sourceFile);

  const cases: SourceShapeCase[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isTestCall(node)) {
      const body = testBody(node);
      if (body) {
        const variables = scopedVariableDecls(sourceFile, allVariables, node, body);
        const productionPathVars = collectProductionPathVars(sourceFile, variables);
        const sourceTreeShapeVars = collectSourceTreeShapeVars(
          sourceFile,
          body,
          variables,
          productionPathVars,
        );
        const sourcePathVars = new Set([...productionPathVars, ...sourceTreeShapeVars.pathVars]);
        const sourceFunctions = collectSourceFunctions(sourceFile, sourcePathVars);
        const { sourceVars, sourceReads } = collectSourceVars(
          sourceFile,
          variables,
          sourcePathVars,
          sourceFunctions,
          sourceTreeShapeVars.sourceVars,
        );
        const assertions = dedupeAssertions([
          ...collectAssertionsInNode(
            sourceFile,
            body,
            sourceVars,
            sourcePathVars,
            sourceTreeShapeVars.sourceTreeFunctions,
          ),
          ...fallbackLineScan(sourceFile, body),
        ]);
        if (assertions.length > 0) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          cases.push({
            file: relPath,
            line: line + 1,
            column: character + 1,
            name: testCaseName(sourceFile, node),
            assertions,
            sourceReads,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return cases;
}

function scanFile(absPath: string): SourceShapeCase[] {
  const relPath = normalizePathText(relative(REPO_ROOT, absPath));
  const text = readFileSync(absPath, "utf-8");
  return scanSourceText(absPath, relPath, text);
}

function scan(): Report {
  const cases = [...walkFiles(REPO_ROOT)].filter(isTestFile).flatMap(scanFile);
  const casesPerFile = new Map<string, number>();
  for (const entry of cases) {
    casesPerFile.set(entry.file, (casesPerFile.get(entry.file) ?? 0) + 1);
  }

  return {
    summary: {
      source_shape_cases: cases.length,
      source_shape_assertions: cases.reduce((sum, entry) => sum + entry.assertions.length, 0),
      source_shape_files: casesPerFile.size,
      source_shape_max_cases_per_file: Math.max(0, ...casesPerFile.values()),
    },
    cases,
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
    printMetrics(report);
    return;
  }

  console.log(`Detected ${report.summary.source_shape_cases} source-shape test cases:`);
  for (const testCase of report.cases) {
    console.log(`- ${testCase.file}:${testCase.line}:${testCase.column} ${testCase.name}`);
    for (const assertion of testCase.assertions) {
      console.log(
        `  - ${assertion.line}:${assertion.column} ${assertion.matcher} on ${assertion.subject}`,
      );
    }
  }
  printMetrics(report);
}

function checkBudget(report: Report): void {
  const budgetPath = join(REPO_ROOT, "ci", "source-shape-test-budget.json");
  const budget = JSON.parse(readFileSync(budgetPath, "utf-8")) as {
    readonly maxSourceShapeCases?: unknown;
  };
  if (typeof budget.maxSourceShapeCases !== "number") {
    throw new Error(`${budgetPath} must define numeric maxSourceShapeCases`);
  }

  const actual = report.summary.source_shape_cases;
  if (actual > budget.maxSourceShapeCases) {
    console.error(
      `Source-shape test budget exceeded: ${actual} cases > ${budget.maxSourceShapeCases}.`,
    );
    console.error("Replace source-text assertions with behavior tests, then ratchet the budget.");
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

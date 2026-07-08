// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export type Violation = { file: string; line: number; detail: string };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP_DIRS = new Set([".git", "coverage", "dist", "node_modules"]);
// These tests intentionally construct fake dist/lib trees; they do not load
// repository build output. The self-audit below prevents this list growing or
// retaining an exemption after the fixture no longer needs one.
const FIXTURE_EXCLUSIONS = new Set([
  "test/dist-sourcemaps.test.ts",
  "test/install-preflight.test.ts",
  "test/stale-dist-check.test.ts",
]);
const EXCLUDED_PREFIXES = [
  // Live/branch E2E validates installed artifacts rather than unit-test imports.
  "test/e2e/",
  "test/e2e/live/",
  // This is the sole non-live lane allowed to import compiled package artifacts.
  "test/package-contract/",
];

function repoPath(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
}

export function isScannedTestPath(relativePath: string): boolean {
  if (FIXTURE_EXCLUSIONS.has(relativePath)) return false;
  if (EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) return false;
  if (relativePath.startsWith("src/")) return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath);
  return relativePath.startsWith("test/") && /\.[cm]?[jt]sx?$/.test(relativePath);
}

function isScannedTestFile(absolutePath: string): boolean {
  return isScannedTestPath(repoPath(absolutePath));
}

function* walk(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolutePath = path.join(directory, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) yield* walk(absolutePath);
    else if (stats.isFile() && isScannedTestFile(absolutePath)) yield absolutePath;
  }
}

function isCompiledInternalSpecifier(specifier: string): boolean {
  const normalized = specifier.replaceAll("\\", "/");
  return (
    /(^|\/)dist\/(?:lib|commands)(?:\/|$)/.test(normalized) ||
    /(^|\/)dist\/nemoclaw(?:\.js)?$/.test(normalized)
  );
}

type Binding =
  | { kind: "create-require" }
  | { kind: "json-object" }
  | { kind: "module-namespace" }
  | { kind: "path" }
  | { kind: "path-builder"; method: "join" | "resolve" }
  | { kind: "require" }
  | { kind: "static-string"; value: string }
  | { kind: "string-constructor" }
  | { kind: "unknown" };

type ScopeKind = "block" | "function" | "root";

interface LexicalScope {
  bindings: Map<string, Binding>;
  kind: ScopeKind;
  parent: LexicalScope | null;
}

function resolveBinding(scope: LexicalScope, name: string): Binding | undefined {
  for (let current: LexicalScope | null = scope; current; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding) return binding;
  }
  return undefined;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticString(node: ts.Expression | undefined, scope: LexicalScope): string | undefined {
  if (!node) return undefined;
  const expression = unwrapExpression(node);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isIdentifier(expression)) {
    const binding = resolveBinding(scope, expression.text);
    return binding?.kind === "static-string" ? binding.value : undefined;
  }
  return undefined;
}

function accessedMember(
  node: ts.Expression,
  scope: LexicalScope,
): { name: string; target: ts.Expression } | undefined {
  const expression = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(expression)) {
    return { name: expression.name.text, target: expression.expression };
  }
  if (ts.isElementAccessExpression(expression)) {
    const name = staticString(expression.argumentExpression, scope);
    return name === undefined ? undefined : { name, target: expression.expression };
  }
  return undefined;
}

function isModuleNamespaceReference(node: ts.Expression, scope: LexicalScope): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return resolveBinding(scope, expression.text)?.kind === "module-namespace";
  }
  return (
    ts.isCallExpression(expression) &&
    isRequireReference(expression.expression, scope) &&
    ["module", "node:module"].includes(staticString(expression.arguments[0], scope) ?? "")
  );
}

function isCreateRequireReference(node: ts.Expression, scope: LexicalScope): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return resolveBinding(scope, expression.text)?.kind === "create-require";
  }
  const member = accessedMember(expression, scope);
  return member?.name === "createRequire" && isModuleNamespaceReference(member.target, scope);
}

function isRequireReference(node: ts.Expression, scope: LexicalScope): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return resolveBinding(scope, expression.text)?.kind === "require";
  }
  return ts.isCallExpression(expression) && isCreateRequireReference(expression.expression, scope);
}

function isPathReference(node: ts.Expression, scope: LexicalScope): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return resolveBinding(scope, expression.text)?.kind === "path";
  }
  return (
    ts.isCallExpression(expression) &&
    isRequireReference(expression.expression, scope) &&
    ["path", "node:path"].includes(staticString(expression.arguments[0], scope) ?? "")
  );
}

function pathBuilderMethod(
  node: ts.Expression,
  scope: LexicalScope,
): "join" | "resolve" | undefined {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    const binding = resolveBinding(scope, expression.text);
    return binding?.kind === "path-builder" ? binding.method : undefined;
  }
  const member = accessedMember(expression, scope);
  if (
    (member?.name === "join" || member?.name === "resolve") &&
    isPathReference(member.target, scope)
  ) {
    return member.name;
  }
  return undefined;
}

function normalizedPathParts(
  method: "join" | "resolve",
  args: ts.NodeArray<ts.Expression>,
  scope: LexicalScope,
): Array<string | null> {
  const parts: Array<string | null> = [];
  for (const argument of args) {
    const value = staticString(argument, scope);
    if (value === undefined) {
      parts.push(null);
      continue;
    }
    const normalizedValue = value.replaceAll("\\", "/");
    if (method === "resolve" && normalizedValue.startsWith("/")) parts.length = 0;
    for (const part of normalizedValue.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        const previous = parts.at(-1);
        if (previous !== undefined && previous !== null && previous !== "..") parts.pop();
        else parts.push(part);
      } else {
        parts.push(part);
      }
    }
  }
  return parts;
}

function compiledPathBuilderTarget(
  node: ts.CallExpression,
  scope: LexicalScope,
): string | undefined {
  const method = pathBuilderMethod(node.expression, scope);
  if (!method) return undefined;
  const parts = normalizedPathParts(method, node.arguments, scope);
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] !== "dist") continue;
    const compiledTarget = parts[index + 1];
    if (compiledTarget === "lib" || compiledTarget === "commands") {
      return `dist/${compiledTarget}`;
    }
    if (compiledTarget === "nemoclaw.js") return "dist/nemoclaw.js";
  }
  return undefined;
}

function isStringRawTag(node: ts.Expression, scope: LexicalScope): boolean {
  const member = accessedMember(node, scope);
  const target = member && unwrapExpression(member.target);
  return (
    member?.name === "raw" &&
    !!target &&
    ts.isIdentifier(target) &&
    resolveBinding(scope, target.text)?.kind === "string-constructor"
  );
}

function stringRawSubstitution(node: ts.Expression, scope: LexicalScope): string {
  const value = staticString(node, scope);
  if (value !== undefined) return value;

  const expression = unwrapExpression(node);
  if (ts.isCallExpression(expression)) {
    const member = accessedMember(expression.expression, scope);
    const target = member && unwrapExpression(member.target);
    if (
      member?.name === "stringify" &&
      target &&
      ts.isIdentifier(target) &&
      resolveBinding(scope, target.text)?.kind === "json-object"
    ) {
      const argument = staticString(expression.arguments[0], scope);
      if (argument !== undefined) return JSON.stringify(argument);
    }
  }

  return "undefined";
}

function templateSource(node: ts.TemplateLiteral, scope: LexicalScope): string {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.templateSpans.reduce(
    (source, span) =>
      `${source}${stringRawSubstitution(span.expression, scope)}${span.literal.text}`,
    node.head.text,
  );
}

export function findCompiledInternalViolations(file: string, source: string): Violation[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];

  function scan(scannedFile: ts.SourceFile, lineOffset = 0, scanTemplates = true): void {
    function createScope(parent: LexicalScope | null, kind: ScopeKind): LexicalScope {
      return { bindings: new Map(), kind, parent };
    }

    function declareBinding(scope: LexicalScope, name: string, binding: Binding): void {
      scope.bindings.set(name, binding);
    }

    function declareBindingName(scope: LexicalScope, name: ts.BindingName): void {
      if (ts.isIdentifier(name)) {
        declareBinding(scope, name.text, { kind: "unknown" });
        return;
      }
      for (const element of name.elements) {
        if (!ts.isOmittedExpression(element)) declareBindingName(scope, element.name);
      }
    }

    function isBlockScoped(declaration: ts.VariableDeclaration): boolean {
      return (
        ts.isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & ts.NodeFlags.BlockScoped) !== 0
      );
    }

    function collectVarBindings(node: ts.Node, scope: LexicalScope, root: ts.Node): void {
      if (
        node !== root &&
        (ts.isFunctionLike(node) ||
          ts.isModuleBlock(node) ||
          ts.isClassStaticBlockDeclaration(node))
      ) {
        return;
      }
      if (ts.isVariableDeclaration(node) && !isBlockScoped(node)) {
        declareBindingName(scope, node.name);
      }
      ts.forEachChild(node, (child) => collectVarBindings(child, scope, root));
    }

    function declareImportBindings(node: ts.ImportDeclaration, scope: LexicalScope): void {
      if (!node.importClause || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
      const moduleName = node.moduleSpecifier.text;
      const isModuleImport = moduleName === "module" || moduleName === "node:module";
      const isPathImport = moduleName === "path" || moduleName === "node:path";
      const { importClause } = node;
      if (importClause.name) {
        declareBinding(
          scope,
          importClause.name.text,
          isPathImport
            ? { kind: "path" }
            : isModuleImport
              ? { kind: "module-namespace" }
              : { kind: "unknown" },
        );
      }
      const namedBindings = importClause.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        declareBinding(
          scope,
          namedBindings.name.text,
          isPathImport
            ? { kind: "path" }
            : isModuleImport
              ? { kind: "module-namespace" }
              : { kind: "unknown" },
        );
      } else if (namedBindings) {
        for (const element of namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          declareBinding(
            scope,
            element.name.text,
            isModuleImport && importedName === "createRequire"
              ? { kind: "create-require" }
              : isPathImport && (importedName === "join" || importedName === "resolve")
                ? { kind: "path-builder", method: importedName }
                : { kind: "unknown" },
          );
        }
      }
    }

    function externalModuleSpecifier(
      node: ts.ImportEqualsDeclaration,
    ): ts.StringLiteralLike | undefined {
      const expression = ts.isExternalModuleReference(node.moduleReference)
        ? node.moduleReference.expression
        : undefined;
      return expression && ts.isStringLiteralLike(expression) ? expression : undefined;
    }

    function predeclareStatementBindings(
      statements: ts.NodeArray<ts.Statement>,
      scope: LexicalScope,
    ): void {
      for (const statement of statements) {
        if (ts.isVariableStatement(statement)) {
          if ((statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0) {
            for (const declaration of statement.declarationList.declarations) {
              declareBindingName(scope, declaration.name);
            }
          }
        } else if (
          (ts.isClassDeclaration(statement) ||
            ts.isEnumDeclaration(statement) ||
            ts.isFunctionDeclaration(statement)) &&
          statement.name
        ) {
          declareBinding(scope, statement.name.text, { kind: "unknown" });
        } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
          declareBinding(scope, statement.name.text, { kind: "unknown" });
        } else if (ts.isImportDeclaration(statement)) {
          declareImportBindings(statement, scope);
        } else if (ts.isImportEqualsDeclaration(statement)) {
          const moduleName = externalModuleSpecifier(statement)?.text ?? "";
          declareBinding(
            scope,
            statement.name.text,
            moduleName === "path" || moduleName === "node:path"
              ? { kind: "path" }
              : moduleName === "module" || moduleName === "node:module"
                ? { kind: "module-namespace" }
                : { kind: "unknown" },
          );
        }
      }
    }

    function constDeclarationsInStatements(
      statements: ts.NodeArray<ts.Statement>,
    ): ts.VariableDeclaration[] {
      return statements.flatMap((statement) =>
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
          ? [...statement.declarationList.declarations]
          : [],
      );
    }

    function constDeclarationsForScope(node: ts.Node): ts.VariableDeclaration[] {
      if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
        return constDeclarationsInStatements(node.statements);
      }
      if (ts.isCaseBlock(node)) {
        return node.clauses.flatMap((clause) => constDeclarationsInStatements(clause.statements));
      }
      if (
        (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
        node.initializer &&
        ts.isVariableDeclarationList(node.initializer) &&
        (node.initializer.flags & ts.NodeFlags.Const) !== 0
      ) {
        return [...node.initializer.declarations];
      }
      return [];
    }

    function inferConstBindings(node: ts.Node, scope: LexicalScope): void {
      const declarations = constDeclarationsForScope(node);
      for (let pass = 0; pass <= declarations.length; pass += 1) {
        let changed = false;
        for (const declaration of declarations) {
          for (const [name, inferred] of inferredConstBindings(declaration, scope)) {
            if (inferred.kind === "unknown") continue;
            const current = scope.bindings.get(name);
            if (
              current?.kind !== inferred.kind ||
              (current.kind === "static-string" &&
                inferred.kind === "static-string" &&
                current.value !== inferred.value)
            ) {
              declareBinding(scope, name, inferred);
              changed = true;
            }
          }
        }
        if (!changed) break;
      }
    }

    function predeclareScope(node: ts.Node, scope: LexicalScope): void {
      if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
        predeclareStatementBindings(node.statements, scope);
      }
      if (ts.isCaseBlock(node)) {
        for (const clause of node.clauses) {
          predeclareStatementBindings(clause.statements, scope);
        }
      }
      if (ts.isFunctionLike(node)) {
        for (const parameter of node.parameters) declareBindingName(scope, parameter.name);
        if (ts.isFunctionExpression(node) && node.name) {
          declareBinding(scope, node.name.text, { kind: "unknown" });
        }
      }
      if (ts.isClassExpression(node) && node.name) {
        declareBinding(scope, node.name.text, { kind: "unknown" });
      }
      if (ts.isCatchClause(node) && node.variableDeclaration) {
        declareBindingName(scope, node.variableDeclaration.name);
      }
      if (
        (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
        node.initializer &&
        ts.isVariableDeclarationList(node.initializer) &&
        (node.initializer.flags & ts.NodeFlags.BlockScoped) !== 0
      ) {
        for (const declaration of node.initializer.declarations) {
          declareBindingName(scope, declaration.name);
        }
      }
      if (scope.kind === "root" || scope.kind === "function") {
        collectVarBindings(node, scope, node);
      }
      inferConstBindings(node, scope);
    }

    function scopeKind(node: ts.Node): ScopeKind | null {
      if (
        ts.isFunctionLike(node) ||
        ts.isModuleBlock(node) ||
        ts.isClassStaticBlockDeclaration(node)
      ) {
        return "function";
      }
      if (
        ts.isBlock(node) ||
        ts.isCatchClause(node) ||
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isCaseBlock(node) ||
        ts.isClassExpression(node)
      ) {
        return "block";
      }
      return null;
    }

    function inferredConstBinding(
      declaration: ts.VariableDeclaration,
      scope: LexicalScope,
    ): Binding {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !ts.isVariableDeclarationList(declaration.parent) ||
        (declaration.parent.flags & ts.NodeFlags.Const) === 0
      ) {
        return { kind: "unknown" };
      }
      const initializer = unwrapExpression(declaration.initializer);
      const value = staticString(initializer, scope);
      if (value !== undefined) return { kind: "static-string", value };
      if (ts.isIdentifier(initializer)) {
        return resolveBinding(scope, initializer.text) ?? { kind: "unknown" };
      }
      if (isModuleNamespaceReference(initializer, scope)) return { kind: "module-namespace" };
      if (isPathReference(initializer, scope)) return { kind: "path" };
      if (isCreateRequireReference(initializer, scope)) return { kind: "create-require" };
      const method = pathBuilderMethod(initializer, scope);
      if (method) return { kind: "path-builder", method };
      if (isRequireReference(initializer, scope)) return { kind: "require" };
      return { kind: "unknown" };
    }

    function inferredConstBindings(
      declaration: ts.VariableDeclaration,
      scope: LexicalScope,
    ): Array<[string, Binding]> {
      if (ts.isIdentifier(declaration.name)) {
        return [[declaration.name.text, inferredConstBinding(declaration, scope)]];
      }
      if (!ts.isObjectBindingPattern(declaration.name) || !declaration.initializer) {
        return [];
      }
      const initializer = unwrapExpression(declaration.initializer);
      const isModuleNamespace = isModuleNamespaceReference(initializer, scope);
      const isPathNamespace = isPathReference(initializer, scope);
      if (!isModuleNamespace && !isPathNamespace) return [];

      return declaration.name.elements.flatMap((element): Array<[string, Binding]> => {
        if (element.dotDotDotToken || !ts.isIdentifier(element.name)) return [];
        const importedName = element.propertyName ?? element.name;
        if (!(ts.isIdentifier(importedName) || ts.isStringLiteralLike(importedName))) {
          return [];
        }
        if (isModuleNamespace && importedName.text === "createRequire") {
          return [[element.name.text, { kind: "create-require" }]];
        }
        if (isPathNamespace && (importedName.text === "join" || importedName.text === "resolve")) {
          return [[element.name.text, { kind: "path-builder", method: importedName.text }]];
        }
        return [];
      });
    }

    function add(node: ts.Node, detail: string): void {
      const position = scannedFile.getLineAndCharacterOfPosition(node.getStart(scannedFile));
      violations.push({ file, line: position.line + lineOffset + 1, detail });
    }

    function checkSpecifier(node: ts.Node, specifier: string): void {
      if (isCompiledInternalSpecifier(specifier)) {
        add(node, `imports compiled CLI internals from ${JSON.stringify(specifier)}`);
      }
    }

    function visit(node: ts.Node, parentScope: LexicalScope): void {
      const nestedKind = node === scannedFile ? null : scopeKind(node);
      const scope = nestedKind ? createScope(parentScope, nestedKind) : parentScope;
      if (nestedKind) predeclareScope(node, scope);

      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        checkSpecifier(node.moduleSpecifier, node.moduleSpecifier.text);
      } else if (ts.isImportEqualsDeclaration(node)) {
        const specifier = externalModuleSpecifier(node);
        if (specifier) checkSpecifier(specifier, specifier.text);
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        checkSpecifier(node.moduleSpecifier, node.moduleSpecifier.text);
      } else if (ts.isImportTypeNode(node)) {
        const argument = node.argument;
        if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
          checkSpecifier(argument.literal, argument.literal.text);
        }
      } else if (ts.isCallExpression(node)) {
        const isRequire = isRequireReference(node.expression, scope);
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequireResolve =
          ts.isPropertyAccessExpression(node.expression) &&
          isRequireReference(node.expression.expression, scope) &&
          node.expression.name.text === "resolve";
        const firstArgument = node.arguments[0];
        const specifier = staticString(firstArgument, scope);
        if ((isRequire || isDynamicImport || isRequireResolve) && firstArgument && specifier) {
          checkSpecifier(firstArgument, specifier);
        }

        const pathTarget = compiledPathBuilderTarget(node, scope);
        if (pathTarget === "dist/nemoclaw.js") {
          add(node, "constructs a path to dist/nemoclaw.js");
        } else if (pathTarget) {
          add(node, `constructs a path into ${pathTarget}`);
        }
      } else if (
        scanTemplates &&
        ts.isTaggedTemplateExpression(node) &&
        isStringRawTag(node.tag, scope)
      ) {
        const embeddedSource = ts.createSourceFile(
          `${file}.embedded.js`,
          templateSource(node.template, scope),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        const templateLine = scannedFile.getLineAndCharacterOfPosition(
          node.template.getStart(scannedFile),
        ).line;
        scan(embeddedSource, lineOffset + templateLine, false);
      }
      ts.forEachChild(node, (child) => {
        let childScope = scope;
        if (
          ts.isFunctionLike(node) &&
          (ts.isDecorator(child) ||
            (node.name && ts.isComputedPropertyName(node.name) && child === node.name))
        ) {
          childScope = parentScope;
        } else if (ts.isParameter(node) && ts.isDecorator(child)) {
          childScope = parentScope.parent ?? parentScope;
        }
        visit(child, childScope);
      });
    }

    const rootScope = createScope(null, "root");
    declareBinding(rootScope, "String", { kind: "string-constructor" });
    declareBinding(rootScope, "JSON", { kind: "json-object" });
    declareBinding(rootScope, "createRequire", { kind: "create-require" });
    declareBinding(rootScope, "path", { kind: "path" });
    declareBinding(rootScope, "require", { kind: "require" });
    predeclareScope(scannedFile, rootScope);
    visit(scannedFile, rootScope);
  }

  scan(sourceFile);
  return violations.filter(
    (violation, index, all) =>
      all.findIndex(
        (candidate) => candidate.file === violation.file && candidate.line === violation.line,
      ) === index,
  );
}

function findViolations(absolutePath: string): Violation[] {
  return findCompiledInternalViolations(repoPath(absolutePath), readFileSync(absolutePath, "utf8"));
}

function main(): void {
  const staleFixtureExclusions = [...FIXTURE_EXCLUSIONS].filter((relativePath) => {
    const absolutePath = path.join(REPO_ROOT, relativePath);
    return !existsSync(absolutePath) || findViolations(absolutePath).length === 0;
  });

  if (staleFixtureExclusions.length > 0) {
    console.error("Fixture exclusions must exist and still construct a compiled-internal path:");
    for (const relativePath of staleFixtureExclusions) console.error(`  ${relativePath}`);
    process.exit(1);
  }

  const violations = [
    ...walk(path.join(REPO_ROOT, "src")),
    ...walk(path.join(REPO_ROOT, "test")),
  ].flatMap(findViolations);

  if (violations.length > 0) {
    console.error(
      "Compiled CLI internals may only be imported by the package-contract test project:",
    );
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line} ${violation.detail}`);
    }
    console.error(
      "Import src/ instead, or move a genuine compiled-package contract under test/package-contract/.",
    );
    process.exit(1);
  }

  console.log("Test imports respect the source/package boundary.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}

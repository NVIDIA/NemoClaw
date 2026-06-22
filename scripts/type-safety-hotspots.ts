// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const DEFAULT_PROJECTS = Object.freeze(["tsconfig.cli.json", "nemoclaw/tsconfig.json"]);
const DEFAULT_TOP_FILES = 15;
const DEFAULT_TOP_FUNCTIONS = 15;
const DEFAULT_MIN_SCORE = 1;
const COMMENT_DIRECTIVE_RE = /@ts-ignore|@ts-expect-error/g;

type ProjectInfo = {
  name: string;
  compilerOptions: ts.CompilerOptions;
  fileNames: string[];
};

type PatternCounts = {
  explicitAnyCount: number;
  unknownTypeCount: number;
  recordStringUnknownCount: number;
  typeAssertionCount: number;
  nonNullAssertionCount: number;
  parserBoundaryCount: number;
  tsDirectiveCount: number;
  nullableUnionCount: number;
};

export type FileHotspot = PatternCounts & {
  filePath: string;
  project: string;
  loc: number;
  exportCount: number;
  weakExportCount: number;
  fanIn: number;
  importCount: number;
  noCheck: boolean;
  rawUnsafety: number;
  impactMultiplier: number;
  score: number;
  reasons: string[];
};

export type FunctionHotspot = PatternCounts & {
  displayName: string;
  filePath: string;
  line: number;
  loc: number;
  exported: boolean;
  weakParameterCount: number;
  weakReturnType: boolean;
  missingReturnType: boolean;
  fileFanIn: number;
  noCheck: boolean;
  rawUnsafety: number;
  impactMultiplier: number;
  score: number;
  reasons: string[];
};

export type NullableUnionOccurrence = {
  filePath: string;
  line: number;
  column: number;
  kind: "property" | "parameter" | "return" | "variable" | "type-alias" | "other";
  name: string | null;
  containerName: string | null;
  type: string;
  nonNullType: string;
};

export type NullableUnionTypeHotspot = {
  type: string;
  nonNullType: string;
  totalCount: number;
  fileCount: number;
  fanout: number;
  files: Array<{
    filePath: string;
    count: number;
    fanIn: number;
    examples: NullableUnionOccurrence[];
  }>;
};

export type NullableUnionFileHotspot = {
  filePath: string;
  count: number;
  fanIn: number;
  topTypes: Array<{ type: string; count: number }>;
};

export type NullableExportedTypeFanout = {
  name: string;
  declarationKind: "interface" | "type";
  filePath: string;
  line: number;
  nullableUnionCount: number;
  nullableTypes: Array<{ type: string; count: number }>;
  referenceCount: number;
  referencingFileCount: number;
  fanout: number;
};

export type NullableUnionReport = {
  totalCount: number;
  byType: NullableUnionTypeHotspot[];
  byFile: NullableUnionFileHotspot[];
  exportedTypes: NullableExportedTypeFanout[];
};

type ThemeSummary = {
  id: string;
  title: string;
  detail: string;
  count: number;
  examples: string[];
};

type ReportSummary = PatternCounts & {
  projectCount: number;
  fileCount: number;
  noCheckFileCount: number;
  exportCount: number;
  weakExportCount: number;
  totalLoc: number;
};

export type HotspotReport = {
  summary: ReportSummary;
  files: FileHotspot[];
  functions: FunctionHotspot[];
  nullableUnions: NullableUnionReport;
  themes: ThemeSummary[];
  scoring: {
    description: string;
  };
};

export type AnalyzeOptions = {
  rootDir?: string;
  projectPaths?: string[];
  includeTests?: boolean;
};

type CliOptions = {
  rootDir: string;
  projectPaths: string[];
  includeTests: boolean;
  topFiles: number;
  topFunctions: number;
  minScore: number;
  json: boolean;
};

type RawFunctionData = PatternCounts & {
  displayName: string;
  filePath: string;
  start: number;
  end: number;
  line: number;
  loc: number;
  exported: boolean;
  weakParameterCount: number;
  weakReturnType: boolean;
  missingReturnType: boolean;
  noCheck: boolean;
};

type RawNullableExportedType = {
  name: string;
  declarationKind: "interface" | "type";
  absPath: string;
  filePath: string;
  line: number;
  nullableTypes: string[];
};

type RawImportBinding = {
  specifier: string;
  importedName: string;
  localName: string;
};

type RawTypeReference = {
  name: string;
  qualifier: string | null;
};

type RawFileData = PatternCounts & {
  absPath: string;
  filePath: string;
  project: string;
  loc: number;
  exportCount: number;
  weakExportCount: number;
  importSpecifiers: string[];
  importBindings: RawImportBinding[];
  reExportBindings: RawImportBinding[];
  noCheck: boolean;
  functions: RawFunctionData[];
  nullableUnions: NullableUnionOccurrence[];
  exportedNullableTypes: RawNullableExportedType[];
  typeReferences: RawTypeReference[];
};

type CommentDirectiveOccurrence = {
  pos: number;
  end: number;
  count: number;
};

type ReportableFunctionNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;

function createPatternCounts(): PatternCounts {
  return {
    explicitAnyCount: 0,
    unknownTypeCount: 0,
    recordStringUnknownCount: 0,
    typeAssertionCount: 0,
    nonNullAssertionCount: 0,
    parserBoundaryCount: 0,
    tsDirectiveCount: 0,
    nullableUnionCount: 0,
  };
}

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function addPattern(target: PatternCounts, key: keyof PatternCounts, amount = 1): void {
  target[key] += amount;
}

function roundScore(value: number): number {
  return Math.round(value);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function toPosixRelative(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join(path.posix.sep);
}

function countNonEmptyLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

function collectDirectiveCommentOccurrences(text: string): CommentDirectiveOccurrence[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  const occurrences: CommentDirectiveOccurrence[] = [];

  while (true) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) {
      return occurrences;
    }
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const count = countMatches(scanner.getTokenText(), COMMENT_DIRECTIVE_RE);
      if (count > 0) {
        occurrences.push({
          pos: scanner.getTokenPos(),
          end: scanner.getTextPos(),
          count,
        });
      }
    }
  }
}

function countDirectiveComments(occurrences: readonly CommentDirectiveOccurrence[]): number {
  return occurrences.reduce((count, occurrence) => count + occurrence.count, 0);
}

function hasLeadingTsNoCheck(text: string): boolean {
  let offset = 0;
  if (text.startsWith("#!")) {
    const newline = text.indexOf("\n");
    offset = newline === -1 ? text.length : newline + 1;
  }

  const ranges = ts.getLeadingCommentRanges(text, offset) ?? [];
  return ranges.some((range) => text.slice(range.pos, range.end).includes("@ts-nocheck"));
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[], rootDir: string): string {
  return diagnostics
    .map((diagnostic) => {
      const prefix = diagnostic.file
        ? `${toPosixRelative(rootDir, diagnostic.file.fileName)}:${String(
            diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
          )}`
        : rootDir;
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      return `${prefix}: ${message}`;
    })
    .join("\n");
}

function loadProjectInfo(rootDir: string, projectPath: string): ProjectInfo {
  const absProjectPath = path.resolve(rootDir, projectPath);
  const loaded = ts.readConfigFile(absProjectPath, ts.sys.readFile);

  if (loaded.error) {
    throw new Error(
      `Failed to read ${projectPath}:\n${formatDiagnostics([loaded.error], rootDir)}`,
    );
  }

  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    path.dirname(absProjectPath),
    undefined,
    absProjectPath,
  );

  if (parsed.errors.length > 0) {
    throw new Error(
      `Failed to parse ${projectPath}:\n${formatDiagnostics(parsed.errors, rootDir)}`,
    );
  }

  return {
    name: toPosixRelative(rootDir, absProjectPath),
    compilerOptions: parsed.options,
    fileNames: parsed.fileNames.map((fileName) => path.resolve(fileName)),
  };
}

function shouldIncludeFile(filePath: string, includeTests: boolean): boolean {
  const normalized = filePath.split(path.sep).join(path.posix.sep);
  if (!/\.[cm]?tsx?$/.test(normalized)) return false;
  if (normalized.endsWith(".d.ts")) return false;
  if (normalized.includes("/node_modules/") || normalized.includes("/dist/")) return false;
  if (!includeTests && (/\.test\.[cm]?tsx?$/.test(normalized) || normalized.includes("/test/"))) {
    return false;
  }
  return true;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function countExports(sourceFile: ts.SourceFile): number {
  let count = 0;

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      count += 1;
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        count += statement.exportClause.elements.length;
      } else {
        count += 1;
      }
      continue;
    }

    if (!hasExportModifier(statement)) {
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      count += statement.declarationList.declarations.length;
      continue;
    }

    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      count += 1;
    }
  }

  return count;
}

function getPropertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function getEnclosingClassName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) && current.name) {
      return current.name.text;
    }
    current = current.parent;
  }
  return null;
}

function getFunctionDisplayName(node: ReportableFunctionNode): string | null {
  if (ts.isFunctionDeclaration(node)) {
    return node.name?.text ?? null;
  }

  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    const methodName = getPropertyNameText(node.name);
    if (!methodName) return null;
    const className = getEnclosingClassName(node);
    return className ? `${className}.${methodName}` : methodName;
  }

  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent)
  ) {
    return getPropertyNameText(node.parent.name);
  }

  return null;
}

function isReportableFunction(node: ts.Node): node is ReportableFunctionNode {
  if (
    !ts.isFunctionDeclaration(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node) &&
    !ts.isArrowFunction(node) &&
    !ts.isFunctionExpression(node)
  ) {
    return false;
  }

  return Boolean(getFunctionDisplayName(node));
}

function isNodeExported(node: ReportableFunctionNode): boolean {
  if (ts.isFunctionDeclaration(node)) {
    return hasExportModifier(node);
  }

  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return hasExportModifier(node.parent);
  }

  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent)
  ) {
    const maybeStatement = node.parent.parent?.parent;
    return Boolean(
      maybeStatement && ts.isVariableStatement(maybeStatement) && hasExportModifier(maybeStatement),
    );
  }

  return false;
}

function isNullTypeNode(node: ts.TypeNode): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword)
  );
}

function normalizeTypeText(node: ts.TypeNode, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, " ").trim();
}

function normalizeNullableUnionType(
  node: ts.UnionTypeNode,
  sourceFile: ts.SourceFile,
): { type: string; nonNullType: string } {
  const nonNullParts = node.types
    .filter((part) => !isNullTypeNode(part))
    .map((part) => normalizeTypeText(part, sourceFile))
    .sort((left, right) => left.localeCompare(right));
  const nonNullType = nonNullParts.join(" | ");
  return {
    type: [...nonNullParts, "null"].join(" | "),
    nonNullType,
  };
}

function nullableUnionType(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  if (!ts.isUnionTypeNode(node) || !node.types.some(isNullTypeNode)) {
    return null;
  }
  return normalizeNullableUnionType(node, sourceFile).type;
}

function getContainerName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) {
      return current.name.text;
    }
    if (ts.isClassDeclaration(current)) {
      return current.name?.text ?? null;
    }
    current = current.parent;
  }
  return null;
}

function getNullableUnionKindAndName(
  node: ts.UnionTypeNode,
): Pick<NullableUnionOccurrence, "kind" | "name" | "containerName"> {
  const parent = node.parent;

  if (ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent)) {
    return {
      kind: "property",
      name: getPropertyNameText(parent.name),
      containerName: getContainerName(parent.parent),
    };
  }

  if (ts.isParameter(parent)) {
    return {
      kind: "parameter",
      name: getPropertyNameText(parent.name),
      containerName: isReportableFunction(parent.parent)
        ? getFunctionDisplayName(parent.parent)
        : null,
    };
  }

  if (ts.isVariableDeclaration(parent)) {
    return { kind: "variable", name: getPropertyNameText(parent.name), containerName: null };
  }

  if (ts.isTypeAliasDeclaration(parent)) {
    return { kind: "type-alias", name: parent.name.text, containerName: null };
  }

  if (isReportableFunction(parent) && parent.type === node) {
    return { kind: "return", name: "return", containerName: getFunctionDisplayName(parent) };
  }

  return { kind: "other", name: null, containerName: getContainerName(parent) };
}

function createNullableUnionOccurrence(
  node: ts.UnionTypeNode,
  sourceFile: ts.SourceFile,
  filePath: string,
): NullableUnionOccurrence {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    filePath,
    line: position.line + 1,
    column: position.character + 1,
    ...getNullableUnionKindAndName(node),
    ...normalizeNullableUnionType(node, sourceFile),
  };
}

function collectNullableUnionTypes(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  const types: string[] = [];

  function visit(current: ts.Node): void {
    const type = nullableUnionType(current, sourceFile);
    if (type) {
      types.push(type);
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return types;
}

function getEntityNameParts(name: ts.EntityName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return [...getEntityNameParts(name.left), name.right.text];
}

function getTypeReference(node: ts.TypeReferenceNode): RawTypeReference {
  const parts = getEntityNameParts(node.typeName);
  return {
    name: requireDefined(parts[parts.length - 1], "Type reference name is missing"),
    qualifier: parts.length > 1 ? parts.slice(0, -1).join(".") : null,
  };
}

function buildTypeAliasMap(sourceFile: ts.SourceFile): Map<string, ts.TypeNode> {
  const aliases = new Map<string, ts.TypeNode>();

  function visit(node: ts.Node): void {
    if (ts.isTypeAliasDeclaration(node)) {
      aliases.set(node.name.text, node.type);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return aliases;
}

function isWeakKeywordType(typeNode: ts.TypeNode): boolean {
  return (
    typeNode.kind === ts.SyntaxKind.AnyKeyword ||
    typeNode.kind === ts.SyntaxKind.UnknownKeyword ||
    typeNode.kind === ts.SyntaxKind.ObjectKeyword
  );
}

function containsWeakTypeInNodeList(
  typeNodes: readonly ts.TypeNode[],
  aliases: Map<string, ts.TypeNode>,
  seen: ReadonlySet<string>,
): boolean {
  return typeNodes.some((typeNode) => containsWeakType(typeNode, aliases, new Set(seen)));
}

function containsWeakTypeInTupleType(
  tupleType: ts.TupleTypeNode,
  aliases: Map<string, ts.TypeNode>,
  seen: ReadonlySet<string>,
): boolean {
  return tupleType.elements.some((element) =>
    containsWeakType(
      ts.isNamedTupleMember(element) ? element.type : element,
      aliases,
      new Set(seen),
    ),
  );
}

function containsWeakTypeInTypeLiteral(
  typeLiteral: ts.TypeLiteralNode,
  aliases: Map<string, ts.TypeNode>,
  seen: ReadonlySet<string>,
): boolean {
  if (typeLiteral.members.length === 0) return true;

  return typeLiteral.members.some((member) => {
    if (
      ts.isPropertySignature(member) ||
      ts.isMethodSignature(member) ||
      ts.isIndexSignatureDeclaration(member) ||
      ts.isCallSignatureDeclaration(member) ||
      ts.isConstructSignatureDeclaration(member)
    ) {
      return containsWeakType(member.type, aliases, new Set(seen));
    }
    return false;
  });
}

function containsWeakTypeInIndexedAccessType(
  indexedAccessType: ts.IndexedAccessTypeNode,
  aliases: Map<string, ts.TypeNode>,
  seen: ReadonlySet<string>,
): boolean {
  return (
    containsWeakType(indexedAccessType.objectType, aliases, new Set(seen)) ||
    containsWeakType(indexedAccessType.indexType, aliases, new Set(seen))
  );
}

function containsWeakTypeInConditionalType(
  conditionalType: ts.ConditionalTypeNode,
  aliases: Map<string, ts.TypeNode>,
  seen: ReadonlySet<string>,
): boolean {
  return containsWeakTypeInNodeList(
    [
      conditionalType.checkType,
      conditionalType.extendsType,
      conditionalType.trueType,
      conditionalType.falseType,
    ],
    aliases,
    seen,
  );
}

function containsWeakTypeInSignatureType(
  signatureType: ts.FunctionTypeNode | ts.ConstructorTypeNode,
  aliases: Map<string, ts.TypeNode>,
  seen: ReadonlySet<string>,
): boolean {
  return (
    signatureType.parameters.some((parameter) =>
      containsWeakType(parameter.type, aliases, new Set(seen)),
    ) || containsWeakType(signatureType.type, aliases, new Set(seen))
  );
}

function containsWeakTypeInTypeArguments(
  typeArguments: readonly ts.TypeNode[] | undefined,
  aliases: Map<string, ts.TypeNode>,
  seen: ReadonlySet<string>,
): boolean {
  return typeArguments
    ? typeArguments.some((argument) => containsWeakType(argument, aliases, new Set(seen)))
    : false;
}

function containsWeakTypeInTypeReference(
  typeReference: ts.TypeReferenceNode,
  aliases: Map<string, ts.TypeNode>,
  seen: ReadonlySet<string>,
): boolean {
  if (isDirectRecordStringUnknown(typeReference, aliases)) {
    return true;
  }

  if (containsWeakTypeInTypeArguments(typeReference.typeArguments, aliases, seen)) {
    return true;
  }

  if (ts.isIdentifier(typeReference.typeName)) {
    const aliasName = typeReference.typeName.text;
    const aliasType = aliases.get(aliasName);
    if (aliasType && !seen.has(aliasName)) {
      const nextSeen = new Set(seen);
      nextSeen.add(aliasName);
      return containsWeakType(aliasType, aliases, nextSeen);
    }
  }

  return false;
}

function containsWeakType(
  typeNode: ts.TypeNode | undefined,
  aliases: Map<string, ts.TypeNode>,
  seen = new Set<string>(),
): boolean {
  if (!typeNode) return false;
  if (isWeakKeywordType(typeNode)) return true;

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return containsWeakType(typeNode.type, aliases, seen);
  }

  if (ts.isArrayTypeNode(typeNode)) {
    return containsWeakType(typeNode.elementType, aliases, seen);
  }

  if (ts.isTupleTypeNode(typeNode)) {
    return containsWeakTypeInTupleType(typeNode, aliases, seen);
  }

  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    return containsWeakTypeInNodeList(typeNode.types, aliases, seen);
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    return containsWeakTypeInTypeLiteral(typeNode, aliases, seen);
  }

  if (ts.isTypeOperatorNode(typeNode)) {
    return containsWeakType(typeNode.type, aliases, seen);
  }

  if (ts.isIndexedAccessTypeNode(typeNode)) {
    return containsWeakTypeInIndexedAccessType(typeNode, aliases, seen);
  }

  if (ts.isMappedTypeNode(typeNode)) {
    return Boolean(typeNode.type && containsWeakType(typeNode.type, aliases, seen));
  }

  if (ts.isConditionalTypeNode(typeNode)) {
    return containsWeakTypeInConditionalType(typeNode, aliases, seen);
  }

  if (ts.isFunctionTypeNode(typeNode) || ts.isConstructorTypeNode(typeNode)) {
    return containsWeakTypeInSignatureType(typeNode, aliases, seen);
  }

  if (ts.isTypePredicateNode(typeNode)) {
    return false;
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    return containsWeakTypeInTypeReference(typeNode, aliases, seen);
  }

  return false;
}

function isDirectRecordStringUnknown(
  node: ts.TypeReferenceNode,
  aliases: Map<string, ts.TypeNode>,
): boolean {
  if (!ts.isIdentifier(node.typeName) || node.typeName.text !== "Record") {
    return false;
  }

  if (!node.typeArguments || node.typeArguments.length !== 2) {
    return false;
  }

  return (
    node.typeArguments[0].kind === ts.SyntaxKind.StringKeyword &&
    containsWeakType(node.typeArguments[1], aliases)
  );
}

function isParserBoundaryCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }

  const owner = node.expression.expression;
  const member = node.expression.name.text;
  if (!ts.isIdentifier(owner)) {
    return false;
  }

  return (
    (owner.text === "JSON" && member === "parse") ||
    (owner.text === "JSON5" && member === "parse") ||
    ((owner.text === "YAML" || owner.text === "yaml") && (member === "parse" || member === "load"))
  );
}

function collectImportSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers = new Set<string>();

  function maybeAdd(specifier: ts.Expression | undefined): void {
    if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith(".")) {
      specifiers.add(specifier.text);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      maybeAdd(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      maybeAdd(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1
    ) {
      maybeAdd(node.arguments[0]);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      maybeAdd(node.arguments[0]);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...specifiers];
}

function collectImportBindings(sourceFile: ts.SourceFile): RawImportBinding[] {
  const bindings: RawImportBinding[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) {
      continue;
    }

    const importClause = statement.importClause;
    if (!importClause) {
      continue;
    }

    if (importClause.name) {
      bindings.push({
        specifier,
        importedName: "default",
        localName: importClause.name.text,
      });
    }

    const namedBindings = importClause.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      bindings.push({
        specifier,
        importedName: "*",
        localName: namedBindings.name.text,
      });
    }

    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        bindings.push({
          specifier,
          importedName: element.propertyName?.text ?? element.name.text,
          localName: element.name.text,
        });
      }
    }
  }

  return bindings;
}

function collectReExportBindings(sourceFile: ts.SourceFile): RawImportBinding[] {
  const bindings: RawImportBinding[] = [];

  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) {
      continue;
    }

    const exportClause = statement.exportClause;
    if (!exportClause) {
      bindings.push({ specifier, importedName: "*", localName: "*" });
      continue;
    }
    if (!ts.isNamedExports(exportClause)) {
      continue;
    }

    for (const element of exportClause.elements) {
      bindings.push({
        specifier,
        importedName: element.propertyName?.text ?? element.name.text,
        localName: element.name.text,
      });
    }
  }

  return bindings;
}

function collectLocalNamedExportNames(sourceFile: ts.SourceFile): Map<string, string[]> {
  const names = new Map<string, string[]>();

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier) {
      const exportClause = statement.exportClause;
      if (!exportClause || !ts.isNamedExports(exportClause)) {
        continue;
      }
      for (const element of exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        names.set(localName, [...(names.get(localName) ?? []), element.name.text]);
      }
    }
  }

  return names;
}

function resolveLocalImport(
  project: ProjectInfo,
  fromFile: string,
  specifier: string,
  analyzedFiles: Set<string>,
): string | null {
  const resolved = ts.resolveModuleName(specifier, fromFile, project.compilerOptions, ts.sys)
    .resolvedModule?.resolvedFileName;

  if (resolved) {
    const absResolved = path.resolve(resolved);
    if (analyzedFiles.has(absResolved)) {
      return absResolved;
    }
  }

  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = new Set<string>([
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.mts"),
    path.join(base, "index.cts"),
  ]);

  if (specifier.endsWith(".js") || specifier.endsWith(".mjs") || specifier.endsWith(".cjs")) {
    const withoutJs = base.replace(/\.[cm]?js$/, "");
    candidates.add(`${withoutJs}.ts`);
    candidates.add(`${withoutJs}.tsx`);
    candidates.add(`${withoutJs}.mts`);
    candidates.add(`${withoutJs}.cts`);
  }

  for (const candidate of candidates) {
    const absCandidate = path.resolve(candidate);
    if (analyzedFiles.has(absCandidate)) {
      return absCandidate;
    }
  }

  return null;
}

function createFunctionData(
  node: ReportableFunctionNode,
  sourceFile: ts.SourceFile,
  aliases: Map<string, ts.TypeNode>,
  filePath: string,
  noCheck: boolean,
): RawFunctionData {
  const displayName = getFunctionDisplayName(node) ?? "<anonymous>";
  const start = node.getStart(sourceFile);
  const end = node.end;
  const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
  const loc = countNonEmptyLines(sourceFile.text.slice(start, end));
  const weakParameterCount = node.parameters.reduce((count, parameter) => {
    return count + (containsWeakType(parameter.type, aliases) ? 1 : 0);
  }, 0);

  return {
    ...createPatternCounts(),
    displayName,
    filePath,
    start,
    end,
    line,
    loc,
    exported: isNodeExported(node),
    weakParameterCount,
    weakReturnType: containsWeakType(node.type, aliases),
    missingReturnType: isNodeExported(node) && !node.type,
    noCheck,
  };
}

function computeFileRawUnsafety(file: RawFileData): number {
  let raw = 0;
  if (file.noCheck) raw += 70;
  raw += file.tsDirectiveCount * 12;
  raw += file.explicitAnyCount * 12;
  raw += file.parserBoundaryCount * 9;
  raw += file.recordStringUnknownCount * 6;
  raw += file.typeAssertionCount * 3;
  raw += file.nonNullAssertionCount;
  raw += file.weakExportCount * 8;
  raw += file.unknownTypeCount * 0.25;
  return raw;
}

function computeFunctionRawUnsafety(fn: RawFunctionData): number {
  let raw = 0;
  if (fn.noCheck) raw += 8;
  raw += fn.tsDirectiveCount * 12;
  raw += fn.explicitAnyCount * 12;
  raw += fn.parserBoundaryCount * 12;
  raw += fn.recordStringUnknownCount * 6;
  raw += fn.typeAssertionCount * 3;
  raw += fn.nonNullAssertionCount;
  raw += fn.weakParameterCount * 7;
  raw += fn.weakReturnType ? 8 : 0;
  raw += fn.missingReturnType ? 2 : 0;
  raw += fn.unknownTypeCount * 0.25;
  return raw;
}

function appendReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function buildFileReasons(file: RawFileData, fanIn: number): string[] {
  const reasons: string[] = [];

  if (file.noCheck) appendReason(reasons, "@ts-nocheck disables the checker");
  if (fanIn > 0) appendReason(reasons, `fan-in ${String(fanIn)}`);
  if (file.parserBoundaryCount > 0) {
    appendReason(
      reasons,
      `${String(file.parserBoundaryCount)} JSON/YAML ${pluralize(file.parserBoundaryCount, "parse boundary", "parse boundaries")}`,
    );
  }
  if (file.recordStringUnknownCount > 0) {
    appendReason(reasons, `${String(file.recordStringUnknownCount)} Record<string, unknown>`);
  }
  if (file.nullableUnionCount > 0) {
    appendReason(
      reasons,
      `${String(file.nullableUnionCount)} nullable ${pluralize(file.nullableUnionCount, "union")}`,
    );
  }
  if (file.typeAssertionCount > 0) {
    appendReason(
      reasons,
      `${String(file.typeAssertionCount)} ${pluralize(file.typeAssertionCount, "cast")}`,
    );
  }
  if (file.weakExportCount > 0) {
    appendReason(
      reasons,
      `${String(file.weakExportCount)} weak exported ${pluralize(file.weakExportCount, "signature")}`,
    );
  }
  if (file.tsDirectiveCount > 0) {
    appendReason(
      reasons,
      `${String(file.tsDirectiveCount)} ${pluralize(file.tsDirectiveCount, "ts-ignore/expect-error")}`,
    );
  }
  if (file.explicitAnyCount > 0) {
    appendReason(
      reasons,
      `${String(file.explicitAnyCount)} explicit ${pluralize(file.explicitAnyCount, "any")}`,
    );
  }
  if (file.nonNullAssertionCount > 0) {
    appendReason(
      reasons,
      `${String(file.nonNullAssertionCount)} non-null ${pluralize(file.nonNullAssertionCount, "assertion")}`,
    );
  }

  return reasons.slice(0, 5);
}

function buildFunctionReasons(fn: RawFunctionData, fileFanIn: number): string[] {
  const reasons: string[] = [];

  if (fn.noCheck) appendReason(reasons, "enclosing file is @ts-nocheck");
  if (fn.exported) appendReason(reasons, "exported API");
  if (fileFanIn > 0) appendReason(reasons, `file fan-in ${String(fileFanIn)}`);
  if (fn.parserBoundaryCount > 0) {
    appendReason(
      reasons,
      `${String(fn.parserBoundaryCount)} JSON/YAML ${pluralize(fn.parserBoundaryCount, "parse boundary", "parse boundaries")}`,
    );
  }
  if (fn.recordStringUnknownCount > 0) {
    appendReason(reasons, `${String(fn.recordStringUnknownCount)} Record<string, unknown>`);
  }
  if (fn.nullableUnionCount > 0) {
    appendReason(
      reasons,
      `${String(fn.nullableUnionCount)} nullable ${pluralize(fn.nullableUnionCount, "union")}`,
    );
  }
  if (fn.typeAssertionCount > 0) {
    appendReason(
      reasons,
      `${String(fn.typeAssertionCount)} ${pluralize(fn.typeAssertionCount, "cast")}`,
    );
  }
  if (fn.weakParameterCount > 0) {
    appendReason(
      reasons,
      `${String(fn.weakParameterCount)} weak ${pluralize(fn.weakParameterCount, "parameter")}`,
    );
  }
  if (fn.weakReturnType) appendReason(reasons, "weak return type");
  if (fn.missingReturnType) appendReason(reasons, "exported with inferred return type");

  return reasons.slice(0, 5);
}

function findInnermostContainingFunction(
  functions: readonly RawFunctionData[],
  occurrence: CommentDirectiveOccurrence,
): RawFunctionData | null {
  let innermost: RawFunctionData | null = null;

  for (const fn of functions) {
    if (occurrence.pos < fn.start || occurrence.end > fn.end) {
      continue;
    }
    if (!innermost || fn.end - fn.start < innermost.end - innermost.start) {
      innermost = fn;
    }
  }

  return innermost;
}

function analyzeFile(absPath: string, rootDir: string, project: ProjectInfo): RawFileData {
  const text = fs.readFileSync(absPath, "utf8");
  const sourceFile = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true);
  const aliases = buildTypeAliasMap(sourceFile);
  const noCheck = hasLeadingTsNoCheck(text);
  const directiveOccurrences = collectDirectiveCommentOccurrences(text);
  const fileMetrics = createPatternCounts();
  const functions: RawFunctionData[] = [];
  const functionStack: RawFunctionData[] = [];
  const nullableUnions: NullableUnionOccurrence[] = [];
  const exportedNullableTypes: RawNullableExportedType[] = [];
  const typeReferences: RawTypeReference[] = [];
  const localNamedExportNames = collectLocalNamedExportNames(sourceFile);

  addPattern(fileMetrics, "tsDirectiveCount", countDirectiveComments(directiveOccurrences));

  function applyPattern(key: keyof PatternCounts, amount = 1): void {
    addPattern(fileMetrics, key, amount);
    const current = functionStack[functionStack.length - 1];
    if (current) {
      addPattern(current, key, amount);
    }
  }

  function visit(node: ts.Node): void {
    if (isReportableFunction(node)) {
      const fn = createFunctionData(
        node,
        sourceFile,
        aliases,
        toPosixRelative(rootDir, absPath),
        noCheck,
      );
      functions.push(fn);
      functionStack.push(fn);
      ts.forEachChild(node, visit);
      functionStack.pop();
      return;
    }

    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const exportedNames = new Set<string>(localNamedExportNames.get(node.name.text));
      if (hasExportModifier(node)) {
        exportedNames.add(node.name.text);
      }
      const nullableTypes = collectNullableUnionTypes(node, sourceFile);
      if (exportedNames.size > 0 && nullableTypes.length > 0) {
        for (const exportedName of exportedNames) {
          exportedNullableTypes.push({
            name: exportedName,
            declarationKind: ts.isInterfaceDeclaration(node) ? "interface" : "type",
            absPath,
            filePath: toPosixRelative(rootDir, absPath),
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            nullableTypes,
          });
        }
      }
    }

    if (ts.isUnionTypeNode(node) && node.types.some(isNullTypeNode)) {
      nullableUnions.push(
        createNullableUnionOccurrence(node, sourceFile, toPosixRelative(rootDir, absPath)),
      );
      applyPattern("nullableUnionCount");
    }

    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      applyPattern("explicitAnyCount");
    } else if (node.kind === ts.SyntaxKind.UnknownKeyword) {
      applyPattern("unknownTypeCount");
    }

    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      applyPattern("typeAssertionCount");
    }

    if (ts.isNonNullExpression(node)) {
      applyPattern("nonNullAssertionCount");
    }

    if (ts.isTypeReferenceNode(node)) {
      typeReferences.push(getTypeReference(node));
      if (isDirectRecordStringUnknown(node, aliases)) {
        applyPattern("recordStringUnknownCount");
      }
    }

    if (ts.isCallExpression(node) && isParserBoundaryCall(node)) {
      applyPattern("parserBoundaryCount");
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  for (const occurrence of directiveOccurrences) {
    const containingFunction = findInnermostContainingFunction(functions, occurrence);
    if (containingFunction) {
      addPattern(containingFunction, "tsDirectiveCount", occurrence.count);
    }
  }

  const weakExportCount = functions.filter(
    (fn) => fn.exported && (fn.weakParameterCount > 0 || fn.weakReturnType || fn.missingReturnType),
  ).length;

  return {
    ...fileMetrics,
    absPath,
    filePath: toPosixRelative(rootDir, absPath),
    project: project.name,
    loc: countNonEmptyLines(text),
    exportCount: countExports(sourceFile),
    weakExportCount,
    importSpecifiers: collectImportSpecifiers(sourceFile),
    importBindings: collectImportBindings(sourceFile),
    reExportBindings: collectReExportBindings(sourceFile),
    noCheck,
    functions,
    nullableUnions,
    exportedNullableTypes,
    typeReferences: typeReferences.sort((left, right) => {
      if (left.name !== right.name) return left.name.localeCompare(right.name);
      return (left.qualifier ?? "").localeCompare(right.qualifier ?? "");
    }),
  };
}

function countByValue(values: readonly string[]): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.type.localeCompare(right.type);
    });
}

function buildNullableUnionReport(
  rawFiles: readonly RawFileData[],
  fanInByFile: ReadonlyMap<string, number>,
  importBindingsByFile: ReadonlyMap<string, ReadonlyMap<string, readonly RawImportBinding[]>>,
  reExportBindingsByFile: ReadonlyMap<string, ReadonlyMap<string, readonly RawImportBinding[]>>,
): NullableUnionReport {
  const byType = new Map<
    string,
    {
      nonNullType: string;
      totalCount: number;
      files: Map<string, { count: number; fanIn: number; examples: NullableUnionOccurrence[] }>;
    }
  >();
  const byFile = new Map<string, { count: number; fanIn: number; types: string[] }>();

  for (const file of rawFiles) {
    for (const occurrence of file.nullableUnions) {
      const typeEntry = byType.get(occurrence.type) ?? {
        nonNullType: occurrence.nonNullType,
        totalCount: 0,
        files: new Map<
          string,
          { count: number; fanIn: number; examples: NullableUnionOccurrence[] }
        >(),
      };
      typeEntry.totalCount += 1;
      const typeFileEntry = typeEntry.files.get(file.filePath) ?? {
        count: 0,
        fanIn: fanInByFile.get(file.filePath) ?? 0,
        examples: [],
      };
      typeFileEntry.count += 1;
      if (typeFileEntry.examples.length < 3) {
        typeFileEntry.examples.push(occurrence);
      }
      typeEntry.files.set(file.filePath, typeFileEntry);
      byType.set(occurrence.type, typeEntry);

      const fileEntry = byFile.get(file.filePath) ?? {
        count: 0,
        fanIn: fanInByFile.get(file.filePath) ?? 0,
        types: [],
      };
      fileEntry.count += 1;
      fileEntry.types.push(occurrence.type);
      byFile.set(file.filePath, fileEntry);
    }
  }

  function exportedNamesByModuleForCandidate(
    candidateAbsPath: string,
    candidateName: string,
  ): Map<string, Set<string>> {
    const namesByModule = new Map<string, Set<string>>();
    const addName = (modulePath: string, exportedName: string): boolean => {
      const names = namesByModule.get(modulePath) ?? new Set<string>();
      const initialSize = names.size;
      names.add(exportedName);
      namesByModule.set(modulePath, names);
      return names.size !== initialSize;
    };

    addName(candidateAbsPath, candidateName);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [reExporterPath, reExportsBySource] of reExportBindingsByFile.entries()) {
        for (const [sourcePath, bindings] of reExportsBySource.entries()) {
          const sourceNames = namesByModule.get(sourcePath);
          if (!sourceNames) {
            continue;
          }
          for (const binding of bindings) {
            if (binding.importedName === "*") {
              for (const sourceName of sourceNames) {
                changed = addName(reExporterPath, sourceName) || changed;
              }
            } else if (sourceNames.has(binding.importedName)) {
              changed = addName(reExporterPath, binding.localName) || changed;
            }
          }
        }
      }
    }

    return namesByModule;
  }

  const exportedTypes = rawFiles
    .flatMap((file) => file.exportedNullableTypes)
    .map(({ absPath, ...candidate }): NullableExportedTypeFanout => {
      let referenceCount = 0;
      let referencingFileCount = 0;
      const exportedNamesByModule = exportedNamesByModuleForCandidate(absPath, candidate.name);
      for (const file of rawFiles) {
        if (file.absPath === absPath) {
          continue;
        }
        const importedBindingsByModule = importBindingsByFile.get(file.absPath);
        if (!importedBindingsByModule) {
          continue;
        }
        const localNames = new Set<string>();
        const namespaceExports = new Map<string, ReadonlySet<string>>();
        for (const [modulePath, importedBindings] of importedBindingsByModule.entries()) {
          const exportedNames = exportedNamesByModule.get(modulePath);
          if (!exportedNames) {
            continue;
          }
          for (const binding of importedBindings) {
            if (binding.importedName === "*") {
              namespaceExports.set(binding.localName, exportedNames);
            } else if (exportedNames.has(binding.importedName)) {
              localNames.add(binding.localName);
            }
          }
        }
        if (localNames.size === 0 && namespaceExports.size === 0) {
          continue;
        }
        const fileReferenceCount = file.typeReferences.filter((reference) => {
          if (reference.qualifier) {
            return namespaceExports.get(reference.qualifier)?.has(reference.name) ?? false;
          }
          return localNames.has(reference.name);
        }).length;
        if (fileReferenceCount > 0) {
          referenceCount += fileReferenceCount;
          referencingFileCount += 1;
        }
      }
      return {
        ...candidate,
        nullableUnionCount: candidate.nullableTypes.length,
        nullableTypes: countByValue(candidate.nullableTypes),
        referenceCount,
        referencingFileCount,
        fanout: referencingFileCount,
      };
    })
    .sort((left, right) => {
      if (right.fanout !== left.fanout) return right.fanout - left.fanout;
      if (right.referenceCount !== left.referenceCount)
        return right.referenceCount - left.referenceCount;
      if (right.nullableUnionCount !== left.nullableUnionCount) {
        return right.nullableUnionCount - left.nullableUnionCount;
      }
      return left.name.localeCompare(right.name);
    });

  return {
    totalCount: rawFiles.reduce((count, file) => count + file.nullableUnionCount, 0),
    byType: [...byType.entries()]
      .map(([type, entry]): NullableUnionTypeHotspot => {
        const files = [...entry.files.entries()]
          .map(([filePath, fileEntry]) => ({ filePath, ...fileEntry }))
          .sort((left, right) => {
            if (right.count !== left.count) return right.count - left.count;
            if (right.fanIn !== left.fanIn) return right.fanIn - left.fanIn;
            return left.filePath.localeCompare(right.filePath);
          });
        return {
          type,
          nonNullType: entry.nonNullType,
          totalCount: entry.totalCount,
          fileCount: entry.files.size,
          fanout: files.reduce((sum, file) => sum + file.fanIn, 0),
          files,
        };
      })
      .sort((left, right) => {
        if (right.totalCount !== left.totalCount) return right.totalCount - left.totalCount;
        if (right.fileCount !== left.fileCount) return right.fileCount - left.fileCount;
        if (right.fanout !== left.fanout) return right.fanout - left.fanout;
        return left.type.localeCompare(right.type);
      }),
    byFile: [...byFile.entries()]
      .map(
        ([filePath, entry]): NullableUnionFileHotspot => ({
          filePath,
          count: entry.count,
          fanIn: entry.fanIn,
          topTypes: countByValue(entry.types).slice(0, 5),
        }),
      )
      .sort((left, right) => {
        if (right.count !== left.count) return right.count - left.count;
        if (right.fanIn !== left.fanIn) return right.fanIn - left.fanIn;
        return left.filePath.localeCompare(right.filePath);
      }),
    exportedTypes,
  };
}

function buildThemes(files: FileHotspot[], summary: ReportSummary): ThemeSummary[] {
  const themes: ThemeSummary[] = [];
  const topNoCheck = files
    .filter((file) => file.noCheck)
    .slice(0, 3)
    .map((file) => file.filePath);
  if (summary.noCheckFileCount > 0) {
    themes.push({
      id: "no-check",
      title: "Remove @ts-nocheck from high-traffic helpers",
      detail: `${String(summary.noCheckFileCount)} files disable type checking entirely.`,
      count: summary.noCheckFileCount,
      examples: topNoCheck,
    });
  }

  const parseExamples = files
    .filter((file) => file.parserBoundaryCount > 0)
    .slice(0, 3)
    .map((file) => file.filePath);
  if (summary.parserBoundaryCount > 0) {
    themes.push({
      id: "parse-boundaries",
      title: "Type parsed JSON/YAML documents",
      detail: `${String(summary.parserBoundaryCount)} parse boundaries pair with ${String(
        summary.recordStringUnknownCount,
      )} weak map/object types.`,
      count: summary.parserBoundaryCount,
      examples: parseExamples,
    });
  }

  const exportExamples = files
    .filter((file) => file.weakExportCount > 0)
    .slice(0, 3)
    .map((file) => file.filePath);
  if (summary.weakExportCount > 0) {
    themes.push({
      id: "weak-exports",
      title: "Tighten public module surfaces first",
      detail: `${String(summary.weakExportCount)} exported functions still rely on weak signatures.`,
      count: summary.weakExportCount,
      examples: exportExamples,
    });
  }

  const nullableExamples = files
    .filter((file) => file.nullableUnionCount > 0)
    .sort((left, right) => {
      if (right.nullableUnionCount !== left.nullableUnionCount) {
        return right.nullableUnionCount - left.nullableUnionCount;
      }
      return left.filePath.localeCompare(right.filePath);
    })
    .slice(0, 3)
    .map((file) => file.filePath);
  if (summary.nullableUnionCount > 0) {
    themes.push({
      id: "nullable-unions",
      title: "Keep nullable unions at boundaries",
      detail: `${String(summary.nullableUnionCount)} nullable unions show where raw state can become constrained internal types.`,
      count: summary.nullableUnionCount,
      examples: nullableExamples,
    });
  }

  const castExamples = files
    .filter((file) => file.typeAssertionCount > 0)
    .slice(0, 3)
    .map((file) => file.filePath);
  if (summary.typeAssertionCount > 0) {
    themes.push({
      id: "cast-heavy",
      title: "Collapse repeated casts with one real type or guard",
      detail: `${String(summary.typeAssertionCount)} casts show where one interface or decoder can remove many assertions.`,
      count: summary.typeAssertionCount,
      examples: castExamples,
    });
  }

  return themes;
}

export function analyzeTypeSafetyHotspots(options: AnalyzeOptions = {}): HotspotReport {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const projectPaths = options.projectPaths?.length ? options.projectPaths : [...DEFAULT_PROJECTS];
  const includeTests = options.includeTests ?? false;
  const projects = projectPaths.map((projectPath) => loadProjectInfo(rootDir, projectPath));

  const projectByFile = new Map<string, ProjectInfo>();
  for (const project of projects) {
    for (const fileName of project.fileNames) {
      if (!shouldIncludeFile(fileName, includeTests)) {
        continue;
      }
      if (!projectByFile.has(fileName)) {
        projectByFile.set(fileName, project);
      }
    }
  }

  const analyzedFiles = new Set(projectByFile.keys());
  if (analyzedFiles.size === 0) {
    throw new Error("No TypeScript source files matched the selected projects.");
  }

  const rawFiles = [...analyzedFiles]
    .sort((left, right) => left.localeCompare(right))
    .map((absPath) =>
      analyzeFile(
        absPath,
        rootDir,
        requireDefined(projectByFile.get(absPath), `Missing project for ${absPath}`),
      ),
    );

  const importersByFile = new Map<string, Set<string>>();
  const importsFromFile = new Map<string, Set<string>>();
  const importBindingsByFile = new Map<string, Map<string, RawImportBinding[]>>();
  const reExportBindingsByFile = new Map<string, Map<string, RawImportBinding[]>>();
  for (const file of rawFiles) {
    importersByFile.set(file.absPath, new Set());
    importsFromFile.set(file.absPath, new Set());
    importBindingsByFile.set(file.absPath, new Map());
    reExportBindingsByFile.set(file.absPath, new Map());
  }

  for (const file of rawFiles) {
    const project = requireDefined(
      projectByFile.get(file.absPath),
      `Missing project for analyzed file ${file.absPath}`,
    );
    const resolvedImports = requireDefined(
      importsFromFile.get(file.absPath),
      `Missing import set for analyzed file ${file.absPath}`,
    );
    const resolvedBindings = requireDefined(
      importBindingsByFile.get(file.absPath),
      `Missing import binding map for analyzed file ${file.absPath}`,
    );
    const resolvedReExports = requireDefined(
      reExportBindingsByFile.get(file.absPath),
      `Missing re-export binding map for analyzed file ${file.absPath}`,
    );

    for (const specifier of file.importSpecifiers) {
      const resolved = resolveLocalImport(project, file.absPath, specifier, analyzedFiles);
      if (!resolved || resolved === file.absPath) {
        continue;
      }
      resolvedImports.add(resolved);
      importersByFile.get(resolved)?.add(file.absPath);
      const bindings = file.importBindings.filter((binding) => binding.specifier === specifier);
      if (bindings.length > 0) {
        resolvedBindings.set(resolved, [...(resolvedBindings.get(resolved) ?? []), ...bindings]);
      }
      const reExportBindings = file.reExportBindings.filter(
        (binding) => binding.specifier === specifier,
      );
      if (reExportBindings.length > 0) {
        resolvedReExports.set(resolved, [
          ...(resolvedReExports.get(resolved) ?? []),
          ...reExportBindings,
        ]);
      }
    }
  }

  const files: FileHotspot[] = rawFiles
    .map((file) => {
      const fanIn = importersByFile.get(file.absPath)?.size ?? 0;
      const importCount = importsFromFile.get(file.absPath)?.size ?? 0;
      const rawUnsafety = computeFileRawUnsafety(file);
      const impactMultiplier =
        1 + Math.min(fanIn, 8) * 0.12 + Math.min(file.exportCount, 10) * 0.04;
      const score = roundScore(
        (rawUnsafety * impactMultiplier * 10) / Math.sqrt(Math.max(file.loc, 1)),
      );

      return {
        ...file,
        fanIn,
        importCount,
        rawUnsafety,
        impactMultiplier,
        score,
        reasons: buildFileReasons(file, fanIn),
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.fanIn !== left.fanIn) return right.fanIn - left.fanIn;
      if (right.rawUnsafety !== left.rawUnsafety) return right.rawUnsafety - left.rawUnsafety;
      return left.filePath.localeCompare(right.filePath);
    });

  const fanInByFile = new Map(files.map((file) => [file.filePath, file.fanIn]));
  const nullableUnions = buildNullableUnionReport(
    rawFiles,
    fanInByFile,
    importBindingsByFile,
    reExportBindingsByFile,
  );
  const functions: FunctionHotspot[] = rawFiles
    .flatMap((file) => file.functions)
    .map((fn) => {
      const { start: _start, end: _end, ...functionData } = fn;
      const fileFanIn = fanInByFile.get(fn.filePath) ?? 0;
      const rawUnsafety = computeFunctionRawUnsafety(fn);
      const impactMultiplier = 1 + Math.min(fileFanIn, 8) * 0.1 + (fn.exported ? 0.35 : 0);
      const score = roundScore(
        (rawUnsafety * impactMultiplier * 10) / Math.sqrt(Math.max(fn.loc, 12)),
      );

      return {
        ...functionData,
        fileFanIn,
        rawUnsafety,
        impactMultiplier,
        score,
        reasons: buildFunctionReasons(fn, fileFanIn),
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.fileFanIn !== left.fileFanIn) return right.fileFanIn - left.fileFanIn;
      if (right.rawUnsafety !== left.rawUnsafety) return right.rawUnsafety - left.rawUnsafety;
      if (left.filePath !== right.filePath) return left.filePath.localeCompare(right.filePath);
      return left.line - right.line;
    });

  const summary = rawFiles.reduce<ReportSummary>(
    (acc, file) => {
      acc.fileCount += 1;
      acc.totalLoc += file.loc;
      acc.exportCount += file.exportCount;
      acc.weakExportCount += file.weakExportCount;
      if (file.noCheck) acc.noCheckFileCount += 1;
      acc.explicitAnyCount += file.explicitAnyCount;
      acc.unknownTypeCount += file.unknownTypeCount;
      acc.recordStringUnknownCount += file.recordStringUnknownCount;
      acc.typeAssertionCount += file.typeAssertionCount;
      acc.nonNullAssertionCount += file.nonNullAssertionCount;
      acc.parserBoundaryCount += file.parserBoundaryCount;
      acc.tsDirectiveCount += file.tsDirectiveCount;
      acc.nullableUnionCount += file.nullableUnionCount;
      return acc;
    },
    {
      ...createPatternCounts(),
      projectCount: projects.length,
      fileCount: 0,
      noCheckFileCount: 0,
      exportCount: 0,
      weakExportCount: 0,
      totalLoc: 0,
    },
  );

  return {
    summary,
    files,
    functions,
    nullableUnions,
    themes: buildThemes(files, summary),
    scoring: {
      description:
        "Heuristic score increases with type escapes (@ts-nocheck, parse boundaries, casts, weak signatures) and reuse (fan-in/exports), then discounts larger files/functions.",
    },
  };
}

function pickFunctionsForDisplay(
  functions: FunctionHotspot[],
  topFunctions: number,
  minScore: number,
): FunctionHotspot[] {
  const picked: FunctionHotspot[] = [];
  const fileCounts = new Map<string, number>();

  for (const fn of functions) {
    if (fn.score < minScore) {
      continue;
    }
    const seen = fileCounts.get(fn.filePath) ?? 0;
    if (seen >= 2) {
      continue;
    }
    picked.push(fn);
    fileCounts.set(fn.filePath, seen + 1);
    if (picked.length >= topFunctions) {
      break;
    }
  }

  return picked;
}

export function renderTextReport(
  report: HotspotReport,
  options: Pick<CliOptions, "topFiles" | "topFunctions" | "minScore"> = {
    topFiles: DEFAULT_TOP_FILES,
    topFunctions: DEFAULT_TOP_FUNCTIONS,
    minScore: DEFAULT_MIN_SCORE,
  },
): string {
  const topFiles = report.files
    .filter((file) => file.score >= options.minScore)
    .slice(0, options.topFiles);
  const topFunctions = pickFunctionsForDisplay(
    report.functions,
    options.topFunctions,
    options.minScore,
  );
  const lines: string[] = [];

  lines.push("Type-safety hotspots (bang-for-buck heuristic)");
  lines.push(
    `Analyzed ${String(report.summary.fileCount)} files across ${String(
      report.summary.projectCount,
    )} project${report.summary.projectCount === 1 ? "" : "s"}.`,
  );
  lines.push(
    `Totals: ${String(report.summary.noCheckFileCount)} @ts-nocheck file${
      report.summary.noCheckFileCount === 1 ? "" : "s"
    }, ${String(report.summary.typeAssertionCount)} casts, ${String(
      report.summary.recordStringUnknownCount,
    )} Record<string, unknown>, ${String(report.summary.parserBoundaryCount)} parse boundaries, ${String(
      report.summary.nullableUnionCount,
    )} nullable unions.`,
  );
  lines.push(`Heuristic: ${report.scoring.description}`);

  if (report.themes.length > 0) {
    lines.push("");
    lines.push("Repo-wide themes");
    for (const theme of report.themes.slice(0, 4)) {
      const examples = theme.examples.length > 0 ? ` Examples: ${theme.examples.join(", ")}.` : "";
      lines.push(`- ${theme.title}: ${theme.detail}${examples}`);
    }
  }

  lines.push("");
  lines.push("Top files");
  if (topFiles.length === 0) {
    lines.push(`- No files scored at least ${String(options.minScore)}.`);
  } else {
    topFiles.forEach((file, index) => {
      lines.push(`${String(index + 1)}. ${String(file.score)} — ${file.filePath}`);
      lines.push(
        `   loc ${String(file.loc)}, fan-in ${String(file.fanIn)}, exports ${String(
          file.exportCount,
        )}, raw ${formatNumber(file.rawUnsafety)}`,
      );
      lines.push(`   ${file.reasons.join("; ")}`);
    });
  }

  lines.push("");
  lines.push("Top functions");
  if (topFunctions.length === 0) {
    lines.push(`- No functions scored at least ${String(options.minScore)}.`);
  } else {
    topFunctions.forEach((fn, index) => {
      lines.push(
        `${String(index + 1)}. ${String(fn.score)} — ${fn.displayName} (${fn.filePath}:${String(fn.line)})`,
      );
      lines.push(
        `   loc ${String(fn.loc)}, file fan-in ${String(fn.fileFanIn)}, raw ${formatNumber(
          fn.rawUnsafety,
        )}`,
      );
      lines.push(`   ${fn.reasons.join("; ")}`);
    });
  }

  lines.push("");
  lines.push("Top nullable union types");
  const topNullableTypes = report.nullableUnions.byType.slice(0, Math.min(options.topFiles, 10));
  if (topNullableTypes.length === 0) {
    lines.push("- No nullable unions found.");
  } else {
    topNullableTypes.forEach((entry, index) => {
      lines.push(
        `${String(index + 1)}. ${entry.type} — ${String(entry.totalCount)} occurrence${
          entry.totalCount === 1 ? "" : "s"
        } in ${String(entry.fileCount)} file${entry.fileCount === 1 ? "" : "s"}, aggregate fan-in ${String(
          entry.fanout,
        )}`,
      );
      const fileSummary = entry.files
        .slice(0, 3)
        .map((file) => `${file.filePath} (${String(file.count)}, fan-in ${String(file.fanIn)})`)
        .join("; ");
      lines.push(`   ${fileSummary}`);
    });
  }

  lines.push("");
  lines.push("Top nullable union files");
  const topNullableFiles = report.nullableUnions.byFile.slice(0, Math.min(options.topFiles, 10));
  if (topNullableFiles.length === 0) {
    lines.push("- No files contain nullable unions.");
  } else {
    topNullableFiles.forEach((entry, index) => {
      lines.push(
        `${String(index + 1)}. ${entry.filePath} — ${String(entry.count)} nullable union${
          entry.count === 1 ? "" : "s"
        }, fan-in ${String(entry.fanIn)}`,
      );
      lines.push(
        `   ${entry.topTypes.map((type) => `${type.type} (${String(type.count)})`).join("; ")}`,
      );
    });
  }

  lines.push("");
  lines.push("Exported nullable types by fanout");
  const topExportedNullableTypes = report.nullableUnions.exportedTypes.slice(
    0,
    Math.min(options.topFiles, 10),
  );
  if (topExportedNullableTypes.length === 0) {
    lines.push("- No exported interfaces or type aliases contain nullable unions.");
  } else {
    topExportedNullableTypes.forEach((entry, index) => {
      lines.push(
        `${String(index + 1)}. ${entry.name} (${entry.filePath}:${String(entry.line)}) — ${String(
          entry.nullableUnionCount,
        )} nullable union${entry.nullableUnionCount === 1 ? "" : "s"}, referenced in ${String(
          entry.referencingFileCount,
        )} file${entry.referencingFileCount === 1 ? "" : "s"}`,
      );
      lines.push(
        `   ${entry.nullableTypes.map((type) => `${type.type} (${String(type.count)})`).join("; ")}`,
      );
    });
  }

  return lines.join("\n");
}

function requireCliValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseInteger(flag: string, value: string | undefined): number {
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer for ${flag}, got '${value}'`);
  }
  return parsed;
}

export function parseArgs(argv: string[]): CliOptions {
  const projectPaths: string[] = [];
  const options: CliOptions = {
    rootDir: process.cwd(),
    projectPaths,
    includeTests: false,
    topFiles: DEFAULT_TOP_FILES,
    topFunctions: DEFAULT_TOP_FUNCTIONS,
    minScore: DEFAULT_MIN_SCORE,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--root":
        options.rootDir = path.resolve(requireCliValue("--root", argv[index + 1]));
        index += 1;
        break;
      case "--project":
        projectPaths.push(requireCliValue("--project", argv[index + 1]));
        index += 1;
        break;
      case "--top-files":
        options.topFiles = parseInteger(arg, argv[index + 1]);
        index += 1;
        break;
      case "--top-functions":
        options.topFunctions = parseInteger(arg, argv[index + 1]);
        index += 1;
        break;
      case "--min-score":
        options.minScore = parseInteger(arg, argv[index + 1]);
        index += 1;
        break;
      case "--include-tests":
        options.includeTests = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (projectPaths.length === 0) {
    options.projectPaths = [...DEFAULT_PROJECTS];
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: npm run type-safety:hotspots -- [options]

Rank files and functions by a bang-for-buck heuristic for adding stronger types.

Options:
  --root <dir>             Repo root to analyze (default: cwd)
  --project <path>         Tsconfig to analyze (repeatable)
  --top-files <n>          Files to show in text output (default: ${String(DEFAULT_TOP_FILES)})
  --top-functions <n>      Functions to show in text output (default: ${String(DEFAULT_TOP_FUNCTIONS)})
  --min-score <n>          Minimum score to print in text output (default: ${String(DEFAULT_MIN_SCORE)})
  --include-tests          Include *.test.ts files
  --json                   Emit JSON instead of text
  -h, --help               Show this help`);
}

export function main(argv = process.argv.slice(2)): void {
  try {
    const options = parseArgs(argv);
    const report = analyzeTypeSafetyHotspots({
      rootDir: options.rootDir,
      projectPaths: options.projectPaths,
      includeTests: options.includeTests,
    });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(
      renderTextReport(report, {
        topFiles: options.topFiles,
        topFunctions: options.topFunctions,
        minScore: options.minScore,
      }),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

const THIS_FILE = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  main();
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const DEFAULT_PROJECTS = ["tsconfig.cli.json", "nemoclaw/tsconfig.json"] as const;
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

type RawFileData = PatternCounts & {
  absPath: string;
  filePath: string;
  project: string;
  loc: number;
  exportCount: number;
  weakExportCount: number;
  importSpecifiers: string[];
  noCheck: boolean;
  functions: RawFunctionData[];
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
  };
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
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
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

    if (ts.isTypeReferenceNode(node) && isDirectRecordStringUnknown(node, aliases)) {
      applyPattern("recordStringUnknownCount");
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
    noCheck,
    functions,
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
    .map((absPath) => analyzeFile(absPath, rootDir, projectByFile.get(absPath)!));

  const importersByFile = new Map<string, Set<string>>();
  const importsFromFile = new Map<string, Set<string>>();
  for (const file of rawFiles) {
    importersByFile.set(file.absPath, new Set());
    importsFromFile.set(file.absPath, new Set());
  }

  for (const file of rawFiles) {
    const project = projectByFile.get(file.absPath)!;
    const resolvedImports = importsFromFile.get(file.absPath)!;

    for (const specifier of file.importSpecifiers) {
      const resolved = resolveLocalImport(project, file.absPath, specifier, analyzedFiles);
      if (!resolved || resolved === file.absPath) {
        continue;
      }
      resolvedImports.add(resolved);
      importersByFile.get(resolved)?.add(file.absPath);
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
    )} Record<string, unknown>, ${String(report.summary.parserBoundaryCount)} parse boundaries.`,
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

  return lines.join("\n");
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
        if (!argv[index + 1]) {
          throw new Error("Missing value for --root");
        }
        options.rootDir = path.resolve(argv[index + 1]!);
        index += 1;
        break;
      case "--project":
        if (!argv[index + 1]) {
          throw new Error("Missing value for --project");
        }
        projectPaths.push(argv[index + 1]!);
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

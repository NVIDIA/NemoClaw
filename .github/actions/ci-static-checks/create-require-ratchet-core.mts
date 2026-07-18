// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type * as TypeScript from "typescript";

export type TypeScriptApi = typeof import("typescript");

export type TrustedCreateRequireAllowlists = Readonly<{
  cli: readonly string[];
  testSupport: readonly string[];
}>;

export type CreateRequireInventory = Readonly<{
  cli: readonly string[];
  production: readonly string[];
  testSupport: readonly string[];
}>;

export type GitResult = Readonly<{
  status: number | null;
  stderr: string;
  stdout: string;
}>;

export type GitRunner = (args: readonly string[], timeoutMs?: number) => GitResult;

export type PullRequestRevisions = Readonly<{
  base: string;
  head: string;
}>;

type PullRequestComparison = PullRequestRevisions &
  Readonly<{
    mergeBase: string;
  }>;

export const ALLOWLIST_PATHS = [
  "scripts/checks/test-create-require-budget.mts",
  "scripts/checks/test-create-require-budget.ts",
] as const;

const ALLOWLIST_EXPORTS = {
  CLI_CREATE_REQUIRE_FILES: "cli",
  TEST_SUPPORT_CREATE_REQUIRE_FILES: "testSupport",
} as const;

const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NODE_MODULE_SPECIFIERS = new Set(["module", "node:module"]);
const REGULAR_BLOB_MODES = new Set(["100644", "100755"]);
const TEST_FILE_PATTERN = /\.test\.(?:[cm]?ts|tsx)$/;
const TYPESCRIPT_PATTERN = /\.(?:[cm]?ts|tsx)$/;

function diagnosticPath(value: string): string {
  const serialized = JSON.stringify(value);
  const escaped = serialized
    .slice(1, -1)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return escaped.startsWith("::") ? `\\${escaped}` : escaped;
}

export function createGitRunner(repoRoot: string): GitRunner {
  return (args, timeoutMs = 5_000) => {
    const result = spawnSync("git", [...args], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: timeoutMs,
    });
    return {
      status: result.status,
      stderr: String(result.stderr),
      stdout: String(result.stdout),
    };
  };
}

function parseSourceFile(
  ts: TypeScriptApi,
  sourceText: string,
  fileName: string,
): TypeScript.SourceFile {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const diagnostics = (
    sourceFile as TypeScript.SourceFile & { parseDiagnostics: readonly TypeScript.Diagnostic[] }
  ).parseDiagnostics;
  if (diagnostics.length > 0) {
    const detail = diagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
      .join("; ");
    throw new Error(`${diagnosticPath(fileName)} has TypeScript parse diagnostics: ${detail}`);
  }
  return sourceFile;
}

function arrayLiteral(
  ts: TypeScriptApi,
  initializer: TypeScript.Expression | undefined,
): TypeScript.ArrayLiteralExpression | null {
  let expression = initializer;
  while (
    expression &&
    (ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isParenthesizedExpression(expression) ||
      ts.isTypeAssertionExpression(expression))
  ) {
    expression = expression.expression;
  }
  return expression && ts.isArrayLiteralExpression(expression) ? expression : null;
}

export function extractTrustedCreateRequireAllowlists(
  ts: TypeScriptApi,
  sourceText: string,
  fileName: string,
): TrustedCreateRequireAllowlists {
  const sourceFile = parseSourceFile(ts, sourceText, fileName);
  const values: Partial<Record<keyof TrustedCreateRequireAllowlists, string[]>> = {};
  const seen = new Set<keyof TrustedCreateRequireAllowlists>();

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isExported = Boolean(
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    );
    const isConst = Boolean(statement.declarationList.flags & ts.NodeFlags.Const);

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const exportName = declaration.name.text as keyof typeof ALLOWLIST_EXPORTS;
      const target = ALLOWLIST_EXPORTS[exportName];
      if (!target) continue;
      if (seen.has(target)) throw new Error(`${exportName} must be declared exactly once`);
      seen.add(target);
      if (!isExported || !isConst) {
        throw new Error(`${exportName} must be a top-level exported const`);
      }
      const array = arrayLiteral(ts, declaration.initializer);
      if (!array || array.elements.some((element) => !ts.isStringLiteralLike(element))) {
        throw new Error(`${exportName} must be a literal string array`);
      }
      const files = array.elements.map((element) => (element as TypeScript.StringLiteralLike).text);
      if (new Set(files).size !== files.length) {
        throw new Error(`${exportName} must not contain duplicate paths`);
      }
      values[target] = files;
    }
  }

  if (!values.cli || !values.testSupport) {
    throw new Error("createRequire allowlist source must declare both reviewed allowlists");
  }
  return { cli: values.cli, testSupport: values.testSupport };
}

export function requireSingleCurrentChecker(repoRoot: string): {
  path: (typeof ALLOWLIST_PATHS)[number];
  source: string;
} {
  const matches = ALLOWLIST_PATHS.filter((relativePath) =>
    existsSync(path.join(repoRoot, relativePath)),
  );
  if (matches.length !== 1) {
    throw new Error(
      `current checkout must contain exactly one createRequire budget checker; found ${matches.length}`,
    );
  }
  const relativePath = matches[0];
  return {
    path: relativePath,
    source: readFileSync(path.join(repoRoot, relativePath), "utf8"),
  };
}

function requireSingleRevisionChecker(
  runGit: GitRunner,
  revision: string,
  label: "pull-request head" | "trusted base",
): { path: (typeof ALLOWLIST_PATHS)[number]; source: string } {
  const matches = revisionCheckerEntries(runGit, revision, label);
  if (matches.length !== 1) {
    throw new Error(
      `${label} must contain exactly one createRequire budget checker; found ${matches.length}`,
    );
  }
  const relativePath = matches[0].path as (typeof ALLOWLIST_PATHS)[number];
  return {
    path: relativePath,
    source: revisionFileSource(
      runGit,
      revision,
      relativePath,
      `${label} createRequire budget checker`,
    ),
  };
}

export function requireSingleBaseChecker(
  runGit: GitRunner,
  revision: string,
): { path: (typeof ALLOWLIST_PATHS)[number]; source: string } {
  return requireSingleRevisionChecker(runGit, revision, "trusted base");
}

function parsePullRequestEvent(eventSource: string): {
  pull_request?: { base?: { sha?: unknown }; head?: { sha?: unknown } };
} {
  let event: unknown;
  try {
    event = JSON.parse(eventSource);
  } catch {
    throw new Error("pull-request event is not valid JSON");
  }
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new Error("pull-request event must be a JSON object");
  }
  return event as {
    pull_request?: { base?: { sha?: unknown }; head?: { sha?: unknown } };
  };
}

function requireCommitSha(value: unknown, label: "base" | "head"): string {
  if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
    throw new Error(`pull-request event does not contain a valid ${label} commit SHA`);
  }
  return value;
}

export function extractPullRequestBaseSha(eventSource: string): string {
  return requireCommitSha(parsePullRequestEvent(eventSource).pull_request?.base?.sha, "base");
}

export function extractPullRequestRevisions(eventSource: string): PullRequestRevisions {
  const pullRequest = parsePullRequestEvent(eventSource).pull_request;
  const revisions = {
    base: requireCommitSha(pullRequest?.base?.sha, "base"),
    head: requireCommitSha(pullRequest?.head?.sha, "head"),
  };
  if (revisions.base.length !== revisions.head.length) {
    throw new Error("pull-request head and base commits must use the same object format");
  }
  return revisions;
}

function revisionAvailable(runGit: GitRunner, revision: string): boolean {
  return runGit(["cat-file", "-e", `${revision}^{commit}`]).status === 0;
}

function repositoryIsShallow(runGit: GitRunner): boolean {
  const result = runGit(["rev-parse", "--is-shallow-repository"]);
  const value = result.stdout.trim();
  if (result.status !== 0 || (value !== "true" && value !== "false")) {
    throw new Error("could not determine whether the pull-request checkout is shallow");
  }
  return value === "true";
}

const FETCHED_BASE_REF = "refs/nemoclaw/create-require-ratchet/base";
const FETCHED_HEAD_REF = "refs/nemoclaw/create-require-ratchet/head";

function fetchedRevision(runGit: GitRunner, reference: string): string | null {
  const result = runGit(["rev-parse", "--verify", `${reference}^{commit}`]);
  const revision = result.stdout.trim();
  return result.status === 0 && COMMIT_SHA_PATTERN.test(revision) ? revision : null;
}

function fetchPullRequestHistory(
  runGit: GitRunner,
  revisions: PullRequestRevisions,
  shallow: boolean,
): void {
  const args = ["fetch", "--no-tags", "--no-recurse-submodules", "--force"];
  if (shallow) args.push("--unshallow");
  args.push(
    "origin",
    `${revisions.base}:${FETCHED_BASE_REF}`,
    `${revisions.head}:${FETCHED_HEAD_REF}`,
  );
  const fetch = runGit(args, 120_000);
  if (fetch.status !== 0) {
    throw new Error("could not fetch the exact pull-request head and base histories");
  }
  if (
    fetchedRevision(runGit, FETCHED_BASE_REF) !== revisions.base ||
    fetchedRevision(runGit, FETCHED_HEAD_REF) !== revisions.head
  ) {
    throw new Error("fetched pull-request refs do not match the event head and base commits");
  }
  if (shallow && repositoryIsShallow(runGit)) {
    throw new Error("pull-request checkout remained shallow after fetching complete history");
  }
}

function requireExactRevision(
  runGit: GitRunner,
  revision: string,
  label: "base" | "head" | "merge-base",
): void {
  if (!revisionAvailable(runGit, revision)) {
    throw new Error(`pull-request ${label} commit is unavailable after fetching history`);
  }
}

function uniqueMergeBase(runGit: GitRunner, revisions: PullRequestRevisions): string {
  const result = runGit(["merge-base", "--all", revisions.head, revisions.base]);
  if (result.status !== 0) {
    throw new Error("could not compute the pull-request head/base merge base");
  }
  const candidates = result.stdout.split(/\s+/).filter(Boolean);
  if (candidates.length !== 1 || !COMMIT_SHA_PATTERN.test(candidates[0])) {
    throw new Error("pull-request head and base must have exactly one valid merge base");
  }

  const revision = candidates[0];
  requireExactRevision(runGit, revision, "merge-base");
  for (const descendant of [revisions.head, revisions.base]) {
    if (runGit(["merge-base", "--is-ancestor", revision, descendant]).status !== 0) {
      throw new Error("computed merge base is not an ancestor of the pull-request head and base");
    }
  }
  return revision;
}

function resolvePullRequestComparison(
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  runGit: GitRunner = createGitRunner(repoRoot),
): PullRequestComparison | null {
  if (!environment.GITHUB_BASE_REF?.trim()) return null;

  const eventPath = environment.GITHUB_EVENT_PATH?.trim();
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required for pull-request ratchet checks");
  const revisions = extractPullRequestRevisions(readFileSync(eventPath, "utf8"));
  const shallow = repositoryIsShallow(runGit);
  if (
    shallow ||
    !revisionAvailable(runGit, revisions.base) ||
    !revisionAvailable(runGit, revisions.head)
  ) {
    fetchPullRequestHistory(runGit, revisions, shallow);
  }
  requireExactRevision(runGit, revisions.base, "base");
  requireExactRevision(runGit, revisions.head, "head");
  return { ...revisions, mergeBase: uniqueMergeBase(runGit, revisions) };
}

export function resolveBaseRevision(
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  runGit: GitRunner = createGitRunner(repoRoot),
): string | null {
  return resolvePullRequestComparison(repoRoot, environment, runGit)?.mergeBase ?? null;
}

function* walkTypeScriptFiles(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  if (lstatSync(directory).isSymbolicLink()) {
    throw new Error(
      `createRequire inventory does not permit scoped symbolic links: ${diagnosticPath(directory)}`,
    );
  }

  for (const entry of readdirSync(directory)) {
    const absolutePath = path.join(directory, entry);
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `createRequire inventory does not permit scoped symbolic links: ${diagnosticPath(absolutePath)}`,
      );
    }
    if (stats.isDirectory()) {
      yield* walkTypeScriptFiles(absolutePath);
    } else if (stats.isFile() && TYPESCRIPT_PATTERN.test(entry)) {
      yield absolutePath;
    }
  }
}

function staticStringValue(ts: TypeScriptApi, expression: TypeScript.Expression): string | null {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const substitution = staticStringValue(ts, span.expression);
      if (substitution === null) return null;
      value += substitution + span.literal.text;
    }
    return value;
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStringValue(ts, expression.left);
    const right = staticStringValue(ts, expression.right);
    return left === null || right === null ? null : left + right;
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return staticStringValue(ts, expression.expression);
  }
  return null;
}

function isComputedCreateRequireName(ts: TypeScriptApi, node: TypeScript.Node): boolean {
  if (ts.isElementAccessExpression(node)) {
    return staticStringValue(ts, node.argumentExpression) === "createRequire";
  }
  return (
    ts.isComputedPropertyName(node) && staticStringValue(ts, node.expression) === "createRequire"
  );
}

function isNodeModuleSpecifier(ts: TypeScriptApi, node: TypeScript.Node | undefined): boolean {
  return Boolean(node && ts.isStringLiteralLike(node) && NODE_MODULE_SPECIFIERS.has(node.text));
}

function createSingleFileTypeChecker(
  ts: TypeScriptApi,
  sourceFile: TypeScript.SourceFile,
): TypeScript.TypeChecker {
  const fileName = sourceFile.fileName;
  const host: TypeScript.CompilerHost = {
    fileExists: (candidate) => candidate === fileName,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => path.dirname(fileName),
    getDefaultLibFileName: () => "",
    getNewLine: () => "\n",
    getSourceFile: (candidate) => (candidate === fileName ? sourceFile : undefined),
    readFile: (candidate) => (candidate === fileName ? sourceFile.text : undefined),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined,
  };
  return ts
    .createProgram(
      [fileName],
      { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest },
      host,
    )
    .getTypeChecker();
}

function isNodeModuleObjectDeclaration(
  ts: TypeScriptApi,
  declaration: TypeScript.Declaration,
): boolean {
  if (ts.isNamespaceImport(declaration)) {
    return isNodeModuleSpecifier(ts, declaration.parent.parent.moduleSpecifier);
  }
  if (ts.isImportClause(declaration)) {
    return isNodeModuleSpecifier(ts, declaration.parent.moduleSpecifier);
  }
  return (
    ts.isImportEqualsDeclaration(declaration) &&
    ts.isExternalModuleReference(declaration.moduleReference) &&
    isNodeModuleSpecifier(ts, declaration.moduleReference.expression)
  );
}

function isNodeModuleObjectExpression(
  ts: TypeScriptApi,
  expression: TypeScript.Expression,
  checker: TypeScript.TypeChecker,
  seenSymbols: ReadonlySet<TypeScript.Symbol> = new Set(),
): boolean {
  let candidate = expression;
  while (
    ts.isAsExpression(candidate) ||
    ts.isSatisfiesExpression(candidate) ||
    ts.isParenthesizedExpression(candidate) ||
    ts.isTypeAssertionExpression(candidate) ||
    ts.isAwaitExpression(candidate)
  ) {
    candidate = candidate.expression;
  }
  if (ts.isIdentifier(candidate)) {
    const symbol = checker.getSymbolAtLocation(candidate);
    if (!symbol || seenSymbols.has(symbol)) return false;
    const nextSeen = new Set(seenSymbols).add(symbol);
    return (symbol.declarations ?? []).some((declaration) => {
      if (isNodeModuleObjectDeclaration(ts, declaration)) return true;
      return (
        ts.isVariableDeclaration(declaration) &&
        ts.isIdentifier(declaration.name) &&
        Boolean(
          declaration.initializer &&
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
            isNodeModuleObjectExpression(ts, declaration.initializer, checker, nextSeen),
        )
      );
    });
  }
  if (!ts.isCallExpression(candidate) || candidate.arguments.length !== 1) return false;
  if (!isNodeModuleSpecifier(ts, candidate.arguments[0])) return false;
  return (
    (ts.isIdentifier(candidate.expression) && candidate.expression.text === "require") ||
    candidate.expression.kind === ts.SyntaxKind.ImportKeyword
  );
}

function isNodeModuleStringNamedImport(ts: TypeScriptApi, node: TypeScript.Node): boolean {
  if (
    !ts.isImportSpecifier(node) ||
    !node.propertyName ||
    !ts.isStringLiteralLike(node.propertyName) ||
    node.propertyName.text !== "createRequire"
  ) {
    return false;
  }
  const namedImports = node.parent;
  const importClause = namedImports.parent;
  const declaration = importClause.parent;
  return (
    ts.isNamedImports(namedImports) &&
    ts.isImportClause(importClause) &&
    ts.isImportDeclaration(declaration) &&
    isNodeModuleSpecifier(ts, declaration.moduleSpecifier)
  );
}

function isNodeModuleStringBinding(
  ts: TypeScriptApi,
  node: TypeScript.Node,
  checker: TypeScript.TypeChecker,
): boolean {
  if (
    !ts.isBindingElement(node) ||
    !node.propertyName ||
    !ts.isStringLiteralLike(node.propertyName) ||
    node.propertyName.text !== "createRequire" ||
    !ts.isObjectBindingPattern(node.parent)
  ) {
    return false;
  }
  const declaration = node.parent.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    Boolean(
      declaration.initializer && isNodeModuleObjectExpression(ts, declaration.initializer, checker),
    )
  );
}

export function containsCreateRequireIdentifier(
  ts: TypeScriptApi,
  sourceText: string,
  fileName: string,
): boolean {
  const sourceFile = parseSourceFile(ts, sourceText, fileName);
  const checker = createSingleFileTypeChecker(ts, sourceFile);
  let found = false;

  function visit(node: TypeScript.Node): void {
    if (found) return;
    if (
      (ts.isIdentifier(node) && node.text === "createRequire") ||
      isComputedCreateRequireName(ts, node) ||
      isNodeModuleStringNamedImport(ts, node) ||
      isNodeModuleStringBinding(ts, node, checker)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function collectCreateRequireFiles(
  ts: TypeScriptApi,
  repoRoot: string,
  scanRoot: string,
  include: (absolutePath: string) => boolean,
): string[] {
  return [...walkTypeScriptFiles(scanRoot)]
    .filter(include)
    .filter((absolutePath) =>
      containsCreateRequireIdentifier(ts, readFileSync(absolutePath, "utf8"), absolutePath),
    )
    .map((absolutePath) => path.relative(repoRoot, absolutePath).split(path.sep).join("/"))
    .sort();
}

export function collectCreateRequireInventory(
  ts: TypeScriptApi,
  repoRoot: string,
): CreateRequireInventory {
  const sourceRoot = path.join(repoRoot, "src");
  const testRoot = path.join(repoRoot, "test");
  return {
    cli: collectCreateRequireFiles(ts, repoRoot, sourceRoot, (absolutePath) =>
      TEST_FILE_PATTERN.test(absolutePath),
    ),
    production: collectCreateRequireFiles(
      ts,
      repoRoot,
      sourceRoot,
      (absolutePath) => !TEST_FILE_PATTERN.test(absolutePath),
    ),
    testSupport: collectCreateRequireFiles(
      ts,
      repoRoot,
      testRoot,
      (absolutePath) => !TEST_FILE_PATTERN.test(absolutePath),
    ),
  };
}

type RevisionTreeEntry = Readonly<{
  mode: string;
  path: string;
  type: string;
}>;

function parseRevisionTreeEntries(source: string, label: string): RevisionTreeEntry[] {
  if (source && !source.endsWith("\0")) {
    throw new Error(`${label} contains an invalid Git entry`);
  }
  const records = source ? source.slice(0, -1).split("\0") : [];
  if (records.some((record) => !record)) {
    throw new Error(`${label} contains an invalid Git entry`);
  }
  return records.map((record) => {
    const match =
      /^(?<mode>[0-7]{6}) (?<type>blob|commit|tree) (?:[0-9a-f]{40}|[0-9a-f]{64})\t(?<path>[\s\S]+)$/u.exec(
        record,
      );
    if (!match?.groups) {
      throw new Error(`${label} contains an invalid Git entry`);
    }
    return {
      mode: match.groups.mode,
      path: match.groups.path,
      type: match.groups.type,
    };
  });
}

function revisionCheckerEntries(
  runGit: GitRunner,
  revision: string,
  label: "pull-request head" | "trusted base",
): RevisionTreeEntry[] {
  const result = runGit(["ls-tree", "-z", revision, "--", ...ALLOWLIST_PATHS]);
  if (result.status !== 0) {
    throw new Error(`could not enumerate the ${label} createRequire budget checkers`);
  }
  const entries = parseRevisionTreeEntries(result.stdout, `${label} checker tree`);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!(ALLOWLIST_PATHS as readonly string[]).includes(entry.path) || seen.has(entry.path)) {
      throw new Error(`${label} checker tree contains an invalid path`);
    }
    seen.add(entry.path);
    if (entry.type !== "blob" || !REGULAR_BLOB_MODES.has(entry.mode)) {
      throw new Error(
        `${label} createRequire budget checker must be a regular file: ${diagnosticPath(entry.path)}`,
      );
    }
  }
  return entries;
}

function revisionTreeEntries(runGit: GitRunner, revision: string): RevisionTreeEntry[] {
  const result = runGit(["ls-tree", "-r", "-z", revision, "--", "src", "test"]);
  if (result.status !== 0) {
    throw new Error("could not enumerate the pull-request head TypeScript tree");
  }
  return parseRevisionTreeEntries(result.stdout, "pull-request head tree").map((entry) => {
    if (!entry.path.startsWith("src/") && !entry.path.startsWith("test/")) {
      throw new Error("pull-request head tree contains an out-of-scope path");
    }
    if (entry.type !== "blob" || !REGULAR_BLOB_MODES.has(entry.mode)) {
      throw new Error(
        `createRequire inventory does not permit scoped symbolic links, submodules, or non-regular files: ${diagnosticPath(entry.path)}`,
      );
    }
    return entry;
  });
}

function revisionFileSource(
  runGit: GitRunner,
  revision: string,
  relativePath: string,
  label = "pull-request head file",
): string {
  const result = runGit(["show", `${revision}:${relativePath}`]);
  if (result.status !== 0) {
    throw new Error(`could not read ${label}: ${diagnosticPath(relativePath)}`);
  }
  return result.stdout;
}

function collectCreateRequireInventoryAtRevision(
  ts: TypeScriptApi,
  runGit: GitRunner,
  revision: string,
): CreateRequireInventory {
  const typeScriptFiles = revisionTreeEntries(runGit, revision)
    .map((entry) => entry.path)
    .filter((relativePath) => TYPESCRIPT_PATTERN.test(relativePath));
  const collect = (include: (relativePath: string) => boolean): string[] =>
    typeScriptFiles
      .filter(include)
      .filter((relativePath) =>
        containsCreateRequireIdentifier(
          ts,
          revisionFileSource(runGit, revision, relativePath),
          relativePath,
        ),
      )
      .sort();
  return {
    cli: collect(
      (relativePath) => relativePath.startsWith("src/") && TEST_FILE_PATTERN.test(relativePath),
    ),
    production: collect(
      (relativePath) => relativePath.startsWith("src/") && !TEST_FILE_PATTERN.test(relativePath),
    ),
    testSupport: collect(
      (relativePath) => relativePath.startsWith("test/") && !TEST_FILE_PATTERN.test(relativePath),
    ),
  };
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((entry) => !rightSet.has(entry)).sort();
}

export function createRequireInventoryFailure(
  actual: CreateRequireInventory,
  declared: TrustedCreateRequireAllowlists,
): string | null {
  const lines: string[] = [];
  if (actual.production.length > 0) {
    lines.push(
      "Production TypeScript must not introduce createRequire boundaries:",
      ...actual.production.map((file) => `- ${diagnosticPath(file)}`),
    );
  }

  for (const [label, actualFiles, declaredFiles] of [
    ["CLI_CREATE_REQUIRE_FILES", actual.cli, declared.cli],
    ["TEST_SUPPORT_CREATE_REQUIRE_FILES", actual.testSupport, declared.testSupport],
  ] as const) {
    const undeclared = difference(actualFiles, declaredFiles);
    const stale = difference(declaredFiles, actualFiles);
    if (undeclared.length > 0) {
      lines.push(
        `${label} omits actual createRequire use:`,
        ...undeclared.map((file) => `- ${diagnosticPath(file)}`),
      );
    }
    if (stale.length > 0) {
      lines.push(
        `${label} contains paths without actual createRequire use:`,
        ...stale.map((file) => `- ${diagnosticPath(file)}`),
      );
    }
  }
  return lines.length > 0
    ? ["Base-trusted createRequire inventory failed.", ...lines].join("\n")
    : null;
}

export function trustedCreateRequireExpansionFailure(
  current: TrustedCreateRequireAllowlists,
  baseline: TrustedCreateRequireAllowlists,
): string | null {
  const cliAdditions = difference(current.cli, baseline.cli);
  const supportAdditions = difference(current.testSupport, baseline.testSupport);
  if (cliAdditions.length === 0 && supportAdditions.length === 0) return null;

  return [
    "createRequire allowlists must not expand relative to the trusted base.",
    ...cliAdditions.map((file) => `- CLI_CREATE_REQUIRE_FILES: ${diagnosticPath(file)}`),
    ...supportAdditions.map(
      (file) => `- TEST_SUPPORT_CREATE_REQUIRE_FILES: ${diagnosticPath(file)}`,
    ),
  ].join("\n");
}

export function verifyTrustedCreateRequireRatchet(
  ts: TypeScriptApi,
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  runGit: GitRunner = createGitRunner(repoRoot),
): string | null {
  const comparison = resolvePullRequestComparison(repoRoot, environment, runGit);
  if (!comparison) return null;

  const currentChecker = requireSingleRevisionChecker(runGit, comparison.head, "pull-request head");
  const baselineChecker = requireSingleBaseChecker(runGit, comparison.mergeBase);
  const current = extractTrustedCreateRequireAllowlists(
    ts,
    currentChecker.source,
    currentChecker.path,
  );
  const baseline = extractTrustedCreateRequireAllowlists(
    ts,
    baselineChecker.source,
    baselineChecker.path,
  );
  const actual = collectCreateRequireInventoryAtRevision(ts, runGit, comparison.head);
  const failures = [
    createRequireInventoryFailure(actual, current),
    trustedCreateRequireExpansionFailure(current, baseline),
  ].filter((failure): failure is string => Boolean(failure));
  return failures.length > 0 ? failures.join("\n\n") : null;
}

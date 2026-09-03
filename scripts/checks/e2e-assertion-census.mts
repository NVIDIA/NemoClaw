// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export type AssertionMetrics = {
  readonly expectCalls: number;
  readonly matcherAssertions: number;
  readonly nodeAssertions: number;
  readonly namedAssertionHelpers: number;
  readonly failCalls: number;
  readonly throwGuards: number;
  readonly objectFieldAssertions: number;
  readonly assertionPoints: number;
  readonly generatedProbeBlocks: number;
  readonly generatedProbeConditions: number;
};

export type E2eAssertionFileReport = {
  readonly file: string;
  readonly direct: AssertionMetrics;
  readonly transitive: AssertionMetrics;
  readonly companions: readonly string[];
};

export type E2eAssertionCensus = {
  readonly schemaVersion: 1;
  readonly testFileCount: number;
  readonly liveFileCount: number;
  readonly direct: AssertionMetrics;
  readonly unique: AssertionMetrics;
  readonly files: readonly E2eAssertionFileReport[];
};

export type E2eAssertionBudget = {
  readonly $comment: string;
  readonly schemaVersion: 1;
  readonly issue: 10934;
  readonly epic: 10920;
  readonly reference: {
    readonly mainSha: string;
    readonly currentMainCollectedTests: number;
    readonly epicMainSha: string;
    readonly epicCollectedTests: number;
    readonly epicDirectExpectCalls: number;
    readonly epicLiveExpectCalls: number;
  };
  readonly limits: {
    readonly testFileCount: number;
    readonly liveFileCount: number;
    readonly direct: AssertionMetrics;
    readonly unique: AssertionMetrics;
    readonly fileMetricOrder: readonly [
      "directExpectCalls",
      "directAssertionPoints",
      "transitiveExpectCalls",
      "transitiveAssertionPoints",
      "transitiveGeneratedProbeBlocks",
    ];
    readonly files: Readonly<Record<string, readonly [number, number, number, number, number]>>;
  };
};

export type E2eAssertionBudgetViolation = {
  readonly scope: "suite" | "file";
  readonly file?: string;
  readonly view: "inventory" | "direct" | "unique" | "transitive";
  readonly metric: keyof AssertionMetrics | "testFileCount" | "liveFileCount";
  readonly actual: number | null;
  readonly limit: number;
  readonly kind: "growth" | "stale-budget" | "missing-budget" | "removed-file";
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_ROOT = "test/e2e/live";
const BUDGET_FILE = "ci/e2e-assertion-budget.json";
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/u;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const MATCHER = /^to[A-Z]/u;
const OBJECT_MATCHERS = new Set(["toContainEqual", "toEqual", "toMatchObject", "toStrictEqual"]);
const NAMED_ASSERTION = /^(?:assert|expect)[A-Z0-9_]/u;
const NODE_ASSERT_MODULES = new Set([
  "assert",
  "assert/strict",
  "node:assert",
  "node:assert/strict",
]);
const NODE_ASSERT_MEMBERS = new Set([
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
  "rejects",
  "strictEqual",
  "strict",
  "throws",
]);
const METRIC_KEYS = [
  "expectCalls",
  "matcherAssertions",
  "nodeAssertions",
  "namedAssertionHelpers",
  "failCalls",
  "throwGuards",
  "objectFieldAssertions",
  "assertionPoints",
  "generatedProbeBlocks",
  "generatedProbeConditions",
] as const satisfies readonly (keyof AssertionMetrics)[];
const FILE_METRIC_ORDER = [
  "directExpectCalls",
  "directAssertionPoints",
  "transitiveExpectCalls",
  "transitiveAssertionPoints",
  "transitiveGeneratedProbeBlocks",
] as const;
const GENERATED_PROBE_LINE =
  /(?:^|[;|&]\s*)(?:test\s|\[\[?|if\s)|\bthrow\s+new\b|\braise\s+(?:AssertionError|RuntimeError)\b|\bassert\s+|\|\|\s*(?:exit|fail|die)\b|process\.exit(?:Code\s*=|\s*\()/u;

function emptyMetrics(): AssertionMetrics {
  return {
    expectCalls: 0,
    matcherAssertions: 0,
    nodeAssertions: 0,
    namedAssertionHelpers: 0,
    failCalls: 0,
    throwGuards: 0,
    objectFieldAssertions: 0,
    assertionPoints: 0,
    generatedProbeBlocks: 0,
    generatedProbeConditions: 0,
  };
}

function sumMetrics(values: readonly AssertionMetrics[]): AssertionMetrics {
  const totals = { ...emptyMetrics() } as Record<keyof AssertionMetrics, number>;
  for (const value of values) {
    for (const key of METRIC_KEYS) totals[key] += value[key];
  }
  return totals;
}

function scriptKind(file: string): ts.ScriptKind {
  if (/\.[cm]?js$/iu.test(file)) return ts.ScriptKind.JS;
  if (/\.jsx$/iu.test(file)) return ts.ScriptKind.JSX;
  if (/\.tsx$/iu.test(file)) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

function parseSource(file: string, source: string): ts.SourceFile {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const options: ts.CompilerOptions = {
    allowJs: true,
    noLib: true,
    noResolve: true,
  };
  const host: ts.CompilerHost = {
    fileExists: (candidate) => candidate === file,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "lib.d.ts",
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile: (candidate) => (candidate === file ? parsed : undefined),
    readFile: (candidate) => (candidate === file ? source : undefined),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };
  const program = ts.createProgram({ rootNames: [file], options, host });
  const programSource = program.getSourceFile(file);
  if (!programSource) throw new Error(`${file}: TypeScript could not parse the source`);
  const diagnostics = program.getSyntacticDiagnostics(programSource);
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const position = first.start ?? 0;
    const { line, character } = programSource.getLineAndCharacterOfPosition(position);
    const message = ts.flattenDiagnosticMessageText(first.messageText, " ");
    throw new Error(`${file}:${line + 1}:${character + 1}: ${message}`);
  }
  return programSource;
}

function rootIdentifier(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootIdentifier(expression.expression);
  if (ts.isElementAccessExpression(expression)) return rootIdentifier(expression.expression);
  if (ts.isCallExpression(expression)) return rootIdentifier(expression.expression);
  if (ts.isAwaitExpression(expression)) return rootIdentifier(expression.expression);
  return null;
}

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

function hasExpectRoot(expression: ts.Expression): boolean {
  return rootIdentifier(expression) === "expect";
}

function isExpectRootCall(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression)) return node.expression.text === "expect";
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "expect"
  );
}

function isMatcherCall(node: ts.CallExpression): boolean {
  const name = calledName(node.expression);
  return Boolean(name && MATCHER.test(name) && hasExpectRoot(node.expression));
}

function countStaticLeaves(expression: ts.Expression): number {
  if (ts.isParenthesizedExpression(expression)) return countStaticLeaves(expression.expression);
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return countStaticLeaves(expression.expression);
  }
  if (
    ts.isCallExpression(expression) &&
    rootIdentifier(expression.expression) === "expect" &&
    expression.arguments[0]
  ) {
    return countStaticLeaves(expression.arguments[0]);
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return Math.max(
      1,
      expression.properties.reduce((total, property) => {
        if (ts.isPropertyAssignment(property))
          return total + countStaticLeaves(property.initializer);
        if (ts.isShorthandPropertyAssignment(property)) return total + 1;
        if (ts.isSpreadAssignment(property)) return total + 1;
        return total + 1;
      }, 0),
    );
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return Math.max(
      1,
      expression.elements.reduce(
        (total, element) => total + (ts.isSpreadElement(element) ? 1 : countStaticLeaves(element)),
        0,
      ),
    );
  }
  return 1;
}

function generatedProbeConditions(text: string): number {
  if (!text.includes("\n") && !text.includes(";") && !text.includes("||")) return 0;
  return text
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && GENERATED_PROBE_LINE.test(line)).length;
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map(({ literal }) => literal.text)].join("${}");
  }
  return null;
}

function isNodeAssertRequireCall(node: ts.Expression): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    Boolean(
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      NODE_ASSERT_MODULES.has(node.arguments[0].text),
    )
  );
}

function nodeAssertionBindings(parsed: ts.SourceFile): {
  readonly functions: ReadonlySet<string>;
  readonly roots: ReadonlySet<string>;
} {
  const functions = new Set<string>();
  const roots = new Set(["assert"]);

  function addNamedBinding(local: string, imported: string): void {
    if (imported === "strict") {
      roots.add(local);
      return;
    }
    if (NODE_ASSERT_MEMBERS.has(imported)) functions.add(local);
  }

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      NODE_ASSERT_MODULES.has(node.moduleSpecifier.text) &&
      node.importClause
    ) {
      if (node.importClause.name) roots.add(node.importClause.name.text);
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) roots.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          addNamedBinding(element.name.text, element.propertyName?.text ?? element.name.text);
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isNodeAssertRequireCall(node.initializer)
    ) {
      if (ts.isIdentifier(node.name)) roots.add(node.name.text);
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
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isPropertyAccessExpression(node.initializer) &&
      node.initializer.name.text === "strict" &&
      isNodeAssertRequireCall(node.initializer.expression)
    ) {
      roots.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return { functions, roots };
}

export function analyzeAssertionSource(file: string, source: string): AssertionMetrics {
  const parsed = parseSource(file, source);
  const nodeBindings = nodeAssertionBindings(parsed);
  let expectCalls = 0;
  let matcherAssertions = 0;
  let nodeAssertions = 0;
  let namedAssertionHelpers = 0;
  let failCalls = 0;
  let throwGuards = 0;
  let objectFieldAssertions = 0;
  let generatedProbeBlocks = 0;
  let generatedProbeConditionCount = 0;

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      if (isExpectRootCall(node)) {
        expectCalls += 1;
      }
      if (isMatcherCall(node)) {
        matcherAssertions += 1;
        if (name && OBJECT_MATCHERS.has(name)) {
          const expected = node.arguments.at(-1);
          if (expected) objectFieldAssertions += Math.max(0, countStaticLeaves(expected) - 1);
        }
      } else if (
        (ts.isIdentifier(node.expression) && nodeBindings.functions.has(node.expression.text)) ||
        nodeBindings.roots.has(rootIdentifier(node.expression) ?? "")
      ) {
        if (ts.isIdentifier(node.expression) || (name !== null && NODE_ASSERT_MEMBERS.has(name))) {
          nodeAssertions += 1;
        }
      } else if (name && NAMED_ASSERTION.test(name)) {
        namedAssertionHelpers += 1;
      } else if (name === "fail") {
        failCalls += 1;
      }
    } else if (ts.isThrowStatement(node)) {
      throwGuards += 1;
    }

    const text = literalText(node);
    if (text !== null) {
      const conditions = generatedProbeConditions(text);
      if (conditions > 0) {
        generatedProbeBlocks += 1;
        generatedProbeConditionCount += conditions;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return {
    expectCalls,
    matcherAssertions,
    nodeAssertions,
    namedAssertionHelpers,
    failCalls,
    throwGuards,
    objectFieldAssertions,
    assertionPoints:
      matcherAssertions +
      nodeAssertions +
      namedAssertionHelpers +
      failCalls +
      throwGuards +
      objectFieldAssertions,
    generatedProbeBlocks,
    generatedProbeConditions: generatedProbeConditionCount,
  };
}

function toRepoPath(repoRoot: string, file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function* walkSourceFiles(directory: string): Generator<string> {
  const rootStats = lstatSync(directory);
  if (rootStats.isSymbolicLink())
    throw new Error(`Live E2E root must not be a symlink: ${directory}`);
  if (!rootStats.isDirectory()) throw new Error(`Live E2E root must be a directory: ${directory}`);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Live E2E source must not be a symlink: ${file}`);
    if (entry.isDirectory()) yield* walkSourceFiles(file);
    else if (entry.isFile() && SOURCE_FILE.test(entry.name)) yield file;
  }
}

function hasRuntimeImportBindings(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function hasRuntimeExportBindings(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return true;
  return node.exportClause.elements.some((element) => !element.isTypeOnly);
}

function runtimeSpecifiers(parsed: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      hasRuntimeImportBindings(node)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      hasRuntimeExportBindings(node)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return specifiers;
}

function importCandidates(fromFile: string, specifier: string): string[] {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const extension = path.extname(base);
  if (extension) {
    const replacement =
      extension === ".js"
        ? [".ts", ".tsx"]
        : extension === ".mjs"
          ? [".mts"]
          : extension === ".cjs"
            ? [".cts"]
            : [];
    return [base, ...replacement.map((value) => base.slice(0, -extension.length) + value)];
  }
  return [
    ...SOURCE_EXTENSIONS.map((value) => `${base}${value}`),
    ...SOURCE_EXTENSIONS.map((value) => path.join(base, `index${value}`)),
  ];
}

function resolveLiveImport(
  fromFile: string,
  specifier: string,
  liveRoot: string,
  sourceFiles: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const lexical = path.resolve(path.dirname(fromFile), specifier);
  if (!isInside(liveRoot, lexical)) return null;
  let foundNonSourceFile = false;
  for (const candidate of importCandidates(fromFile, specifier)) {
    if (!existsSync(candidate)) continue;
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink())
      throw new Error(`Live E2E import must not use a symlink: ${candidate}`);
    if (!stats.isFile()) continue;
    const canonical = realpathSync(candidate);
    if (!isInside(liveRoot, canonical)) {
      throw new Error(`Live E2E import resolved outside its root: ${candidate}`);
    }
    if (sourceFiles.has(canonical)) return canonical;
    foundNonSourceFile = true;
  }
  if (foundNonSourceFile) return null;
  throw new Error(
    `Unresolved live E2E companion import ${JSON.stringify(specifier)} from ${fromFile}`,
  );
}

export function buildE2eAssertionCensus(
  repoRoot = REPO_ROOT,
  liveRootRelative = LIVE_ROOT,
): E2eAssertionCensus {
  const canonicalRepo = realpathSync(repoRoot);
  const liveRoot = path.join(canonicalRepo, liveRootRelative);
  if (!isInside(canonicalRepo, liveRoot))
    throw new Error("Live E2E root must be inside the repository");
  const files = [...walkSourceFiles(liveRoot)].map((file) => realpathSync(file)).sort();
  const sourceFiles = new Set(files);
  const metrics = new Map<string, AssertionMetrics>();
  const edges = new Map<string, readonly string[]>();

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    metrics.set(file, analyzeAssertionSource(toRepoPath(canonicalRepo, file), source));
    const parsed = parseSource(toRepoPath(canonicalRepo, file), source);
    const imports = runtimeSpecifiers(parsed)
      .map((specifier) => resolveLiveImport(file, specifier, liveRoot, sourceFiles))
      .filter((candidate): candidate is string => candidate !== null);
    edges.set(file, [...new Set(imports)].sort());
  }

  const testFiles = files.filter((file) => TEST_FILE.test(file));
  const reports = testFiles.map((testFile): E2eAssertionFileReport => {
    const reachable = new Set<string>();
    const pending = [testFile];
    while (pending.length > 0) {
      const file = pending.pop();
      if (!file || reachable.has(file)) continue;
      reachable.add(file);
      for (const dependency of edges.get(file) ?? []) pending.push(dependency);
    }
    const companions = [...reachable].filter((file) => file !== testFile).sort();
    return {
      file: toRepoPath(canonicalRepo, testFile),
      direct: metrics.get(testFile) ?? emptyMetrics(),
      transitive: sumMetrics([...reachable].map((file) => metrics.get(file) ?? emptyMetrics())),
      companions: companions.map((file) => toRepoPath(canonicalRepo, file)),
    };
  });

  return {
    schemaVersion: 1,
    testFileCount: reports.length,
    liveFileCount: files.length,
    direct: sumMetrics(reports.map(({ direct }) => direct)),
    unique: sumMetrics(files.map((file) => metrics.get(file) ?? emptyMetrics())),
    files: reports,
  };
}

function numberValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function parseMetrics(value: unknown, label: string): AssertionMetrics {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join("\n") !== [...METRIC_KEYS].sort().join("\n")) {
    throw new Error(`${label} must contain the complete assertion metric set`);
  }
  return Object.fromEntries(
    METRIC_KEYS.map((key) => [key, numberValue(record[key], `${label}.${key}`)]),
  ) as AssertionMetrics;
}

export function parseE2eAssertionBudget(source: string): E2eAssertionBudget {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.issue !== 10934 ||
    parsed.epic !== 10920 ||
    typeof parsed.$comment !== "string"
  ) {
    throw new Error("E2E assertion budget metadata is invalid");
  }
  const reference = parsed.reference as Record<string, unknown> | undefined;
  if (
    !reference ||
    typeof reference.mainSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(reference.mainSha) ||
    typeof reference.epicMainSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(reference.epicMainSha)
  ) {
    throw new Error("E2E assertion budget reference is invalid");
  }
  const limits = parsed.limits as Record<string, unknown> | undefined;
  if (!limits || !limits.files || typeof limits.files !== "object" || Array.isArray(limits.files)) {
    throw new Error("E2E assertion budget limits are invalid");
  }
  const fileMetricOrder = limits.fileMetricOrder;
  if (
    !Array.isArray(fileMetricOrder) ||
    fileMetricOrder.join("\n") !== FILE_METRIC_ORDER.join("\n")
  ) {
    throw new Error("E2E assertion budget file metric order is invalid");
  }
  const fileLimits: Record<string, [number, number, number, number, number]> = {};
  for (const [file, value] of Object.entries(limits.files as Record<string, unknown>).sort()) {
    if (
      !TEST_FILE.test(file) ||
      path.posix.normalize(file) !== file ||
      !file.startsWith(`${LIVE_ROOT}/`)
    ) {
      throw new Error(`E2E assertion budget has an invalid file: ${file}`);
    }
    if (!Array.isArray(value) || value.length !== FILE_METRIC_ORDER.length) {
      throw new Error(`E2E assertion budget file metrics are invalid: ${file}`);
    }
    fileLimits[file] = value.map((metric, index) =>
      numberValue(metric, `limits.files.${file}.${FILE_METRIC_ORDER[index]}`),
    ) as [number, number, number, number, number];
  }
  return {
    $comment: parsed.$comment,
    schemaVersion: 1,
    issue: 10934,
    epic: 10920,
    reference: {
      mainSha: reference.mainSha,
      currentMainCollectedTests: numberValue(
        reference.currentMainCollectedTests,
        "reference.currentMainCollectedTests",
      ),
      epicMainSha: reference.epicMainSha,
      epicCollectedTests: numberValue(reference.epicCollectedTests, "reference.epicCollectedTests"),
      epicDirectExpectCalls: numberValue(
        reference.epicDirectExpectCalls,
        "reference.epicDirectExpectCalls",
      ),
      epicLiveExpectCalls: numberValue(
        reference.epicLiveExpectCalls,
        "reference.epicLiveExpectCalls",
      ),
    },
    limits: {
      testFileCount: numberValue(limits.testFileCount, "limits.testFileCount"),
      liveFileCount: numberValue(limits.liveFileCount, "limits.liveFileCount"),
      direct: parseMetrics(limits.direct, "limits.direct"),
      unique: parseMetrics(limits.unique, "limits.unique"),
      fileMetricOrder: FILE_METRIC_ORDER,
      files: fileLimits,
    },
  };
}

function compareMetrics(
  violations: E2eAssertionBudgetViolation[],
  actual: AssertionMetrics,
  limit: AssertionMetrics,
  scope: "suite" | "file",
  view: "direct" | "unique" | "transitive",
  file?: string,
): void {
  for (const metric of METRIC_KEYS) {
    if (actual[metric] === limit[metric]) continue;
    violations.push({
      scope,
      ...(file ? { file } : {}),
      view,
      metric,
      actual: actual[metric],
      limit: limit[metric],
      kind: actual[metric] > limit[metric] ? "growth" : "stale-budget",
    });
  }
}

export function evaluateE2eAssertionBudget(
  census: E2eAssertionCensus,
  budget: E2eAssertionBudget,
): E2eAssertionBudgetViolation[] {
  const violations: E2eAssertionBudgetViolation[] = [];
  for (const metric of ["testFileCount", "liveFileCount"] as const) {
    if (census[metric] === budget.limits[metric]) continue;
    violations.push({
      scope: "suite",
      view: "inventory",
      metric,
      actual: census[metric],
      limit: budget.limits[metric],
      kind: census[metric] > budget.limits[metric] ? "growth" : "stale-budget",
    });
  }
  compareMetrics(violations, census.direct, budget.limits.direct, "suite", "direct");
  compareMetrics(violations, census.unique, budget.limits.unique, "suite", "unique");

  const actualByFile = new Map(census.files.map((entry) => [entry.file, entry]));
  for (const entry of census.files) {
    const limit = budget.limits.files[entry.file];
    if (!limit) {
      violations.push({
        scope: "file",
        file: entry.file,
        view: "inventory",
        metric: "assertionPoints",
        actual: entry.transitive.assertionPoints,
        limit: 0,
        kind: "missing-budget",
      });
      continue;
    }
    const comparisons = [
      ["direct", "expectCalls", entry.direct.expectCalls, limit[0]],
      ["direct", "assertionPoints", entry.direct.assertionPoints, limit[1]],
      ["transitive", "expectCalls", entry.transitive.expectCalls, limit[2]],
      ["transitive", "assertionPoints", entry.transitive.assertionPoints, limit[3]],
      ["transitive", "generatedProbeBlocks", entry.transitive.generatedProbeBlocks, limit[4]],
    ] as const;
    for (const [view, metric, actual, fileLimit] of comparisons) {
      if (actual === fileLimit) continue;
      violations.push({
        scope: "file",
        file: entry.file,
        view,
        metric,
        actual,
        limit: fileLimit,
        kind: actual > fileLimit ? "growth" : "stale-budget",
      });
    }
  }
  for (const file of Object.keys(budget.limits.files).sort()) {
    if (actualByFile.has(file)) continue;
    violations.push({
      scope: "file",
      file,
      view: "inventory",
      metric: "assertionPoints",
      actual: null,
      limit: budget.limits.files[file][3],
      kind: "removed-file",
    });
  }
  return violations;
}

export function formatE2eAssertionCensus(census: E2eAssertionCensus): string {
  const lines = [
    "Live E2E assertion census",
    `Test files: ${census.testFileCount}`,
    `Live source files: ${census.liveFileCount}`,
    `Direct expect calls: ${census.direct.expectCalls}`,
    `Unique live expect calls: ${census.unique.expectCalls}`,
    `Direct assertion points: ${census.direct.assertionPoints}`,
    `Unique live assertion points: ${census.unique.assertionPoints}`,
    `Generated probe blocks: ${census.unique.generatedProbeBlocks}`,
    "",
    "File | direct expect | transitive expect | direct points | transitive points | companions | generated probes",
  ];
  for (const entry of census.files) {
    lines.push(
      [
        entry.file,
        entry.direct.expectCalls,
        entry.transitive.expectCalls,
        entry.direct.assertionPoints,
        entry.transitive.assertionPoints,
        entry.companions.length,
        entry.transitive.generatedProbeBlocks,
      ].join(" | "),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatE2eAssertionBudgetViolations(
  violations: readonly E2eAssertionBudgetViolation[],
): string {
  return [
    "Live E2E assertion ratchet failed.",
    ...violations.map((violation) => {
      const target = violation.file ?? "suite";
      const actual = violation.actual === null ? "absent" : String(violation.actual);
      const numericDelta = violation.actual === null ? null : violation.actual - violation.limit;
      const delta = numericDelta === null ? "n/a" : `${numericDelta > 0 ? "+" : ""}${numericDelta}`;
      return `- ${target} ${violation.view}.${violation.metric}: current ${actual}; baseline ${violation.limit}; delta ${delta} (${violation.kind})`;
    }),
    "",
    "Reduce the assertion surface, then lower ci/e2e-assertion-budget.json in the same change.",
    "Do not move assertions into helpers, aggregate objects, or generated probes.",
  ].join("\n");
}

export function formatE2eAssertionBudget(budget: E2eAssertionBudget): string {
  const files = Object.entries(budget.limits.files).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const withoutFiles = {
    ...budget,
    limits: { ...budget.limits, files: {} },
  };
  const serialized = JSON.stringify(withoutFiles, null, 2);
  const fileLines = files
    .map(([file, metrics]) => `      ${JSON.stringify(file)}: ${JSON.stringify(metrics)}`)
    .join(",\n");
  return `${serialized.replace(
    '    "files": {}',
    `    "files": {${fileLines ? `\n${fileLines}\n    ` : ""}}`,
  )}\n`;
}

export function budgetForE2eAssertionCensus(
  current: E2eAssertionBudget,
  census: E2eAssertionCensus,
): E2eAssertionBudget {
  return {
    ...current,
    limits: {
      testFileCount: census.testFileCount,
      liveFileCount: census.liveFileCount,
      direct: census.direct,
      unique: census.unique,
      fileMetricOrder: FILE_METRIC_ORDER,
      files: Object.fromEntries(
        census.files.map((entry) => [
          entry.file,
          [
            entry.direct.expectCalls,
            entry.direct.assertionPoints,
            entry.transitive.expectCalls,
            entry.transitive.assertionPoints,
            entry.transitive.generatedProbeBlocks,
          ],
        ]),
      ),
    },
  };
}

function main(argv = process.argv.slice(2)): void {
  const census = buildE2eAssertionCensus();
  const budgetPath = path.join(REPO_ROOT, BUDGET_FILE);
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--report")) {
    process.stdout.write(formatE2eAssertionCensus(census));
    return;
  }
  if (argv.length === 1 && argv[0] === "--json") {
    process.stdout.write(`${JSON.stringify(census, null, 2)}\n`);
    return;
  }
  if (argv.length === 1 && argv[0] === "--write-budget") {
    const budget = parseE2eAssertionBudget(readFileSync(budgetPath, "utf8"));
    writeFileSync(
      budgetPath,
      formatE2eAssertionBudget(budgetForE2eAssertionCensus(budget, census)),
    );
    process.stdout.write(`Updated ${BUDGET_FILE} from the current live assertion census.\n`);
    return;
  }
  if (argv.length === 1 && argv[0] === "--check") {
    const budget = parseE2eAssertionBudget(readFileSync(budgetPath, "utf8"));
    const violations = evaluateE2eAssertionBudget(census, budget);
    if (violations.length > 0) {
      console.error(formatE2eAssertionBudgetViolations(violations));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Live E2E assertion ratchet passed: ${census.direct.expectCalls} direct expect calls across ${census.testFileCount} test files.\n`,
    );
    return;
  }
  throw new Error("Usage: e2e-assertion-census.mts [--report|--json|--check|--write-budget]");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

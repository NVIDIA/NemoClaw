// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type MetricBudget = {
  readonly defaultMax: number;
  readonly maxByFile?: Readonly<Record<string, number>>;
};

export type SourceArchitectureBudget = {
  readonly fanIn: MetricBudget;
  readonly fanOut: MetricBudget;
  readonly allowedCycles: readonly (readonly string[])[];
  readonly maxRootFiles: Readonly<Record<string, number>>;
};

export type SourceArchitectureReport = {
  readonly files: readonly string[];
  readonly edgeCount: number;
  readonly fanIn: Readonly<Record<string, number>>;
  readonly fanOut: Readonly<Record<string, number>>;
  readonly cycles: readonly (readonly string[])[];
  readonly rootFiles: Readonly<Record<string, number>>;
};

export type SourceArchitectureViolation =
  | {
      readonly kind: "metric-limit";
      readonly metric: "fan-in" | "fan-out";
      readonly file: string;
      readonly actual: number;
      readonly limit: number;
    }
  | {
      readonly kind: "metric-ratchet";
      readonly metric: "fan-in" | "fan-out";
      readonly file: string;
      readonly actual: number | null;
      readonly limit: number;
    }
  | {
      readonly kind: "new-cycle";
      readonly files: readonly string[];
    }
  | {
      readonly kind: "cycle-ratchet";
      readonly files: readonly string[];
    }
  | {
      readonly kind: "root-file-limit" | "root-file-ratchet";
      readonly directory: string;
      readonly actual: number;
      readonly limit: number;
    };

type AnalyzeOptions = {
  readonly scanRoots?: readonly string[];
  readonly rootFileDirectories?: readonly string[];
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUDGET_PATH = path.join(REPO_ROOT, "ci", "source-architecture-budget.json");
const DEFAULT_SCAN_ROOTS = [
  "src",
  "nemoclaw/src",
  "agents/hermes",
  "bin",
  "scripts",
  "tools",
  "nemoclaw-blueprint/scripts",
] as const;
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIP_DIRS = new Set([".git", "coverage", "dist", "node_modules"]);

function toRepoPath(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join("/");
}

function isProductionSource(absPath: string): boolean {
  return SOURCE_EXTENSION.test(absPath) && !TEST_FILE.test(absPath);
}

function* walkSourceFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  const rootStats = lstatSync(dir);
  if (rootStats.isSymbolicLink()) return;
  if (rootStats.isFile()) {
    if (isProductionSource(dir)) yield realpathSync(dir);
    return;
  }
  if (!rootStats.isDirectory()) return;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceFiles(absPath);
    } else if (entry.isFile() && isProductionSource(absPath)) {
      yield realpathSync(absPath);
    }
  }
}

function sourceFileFor(absPath: string): ts.SourceFile {
  const extension = path.extname(absPath);
  const scriptKind =
    extension === ".js" || extension === ".cjs" || extension === ".mjs"
      ? ts.ScriptKind.JS
      : extension === ".jsx"
        ? ts.ScriptKind.JSX
        : extension === ".tsx"
          ? ts.ScriptKind.TSX
          : ts.ScriptKind.TS;
  return ts.createSourceFile(
    absPath,
    readFileSync(absPath, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    scriptKind,
  );
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

function collectRuntimeSpecifiers(absPath: string): string[] {
  const sourceFile = sourceFileFor(absPath);
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      hasRuntimeImportBindings(node)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      hasRuntimeExportBindings(node)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function importCandidates(fromAbsPath: string, specifier: string): string[] {
  const base = path.resolve(path.dirname(fromAbsPath), specifier);
  const extension = path.extname(base);
  const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  if (extension) {
    const replacementExtensions =
      extension === ".js"
        ? [".ts", ".tsx"]
        : extension === ".mjs"
          ? [".mts"]
          : extension === ".cjs"
            ? [".cts"]
            : [];
    return [
      base,
      ...replacementExtensions.map((candidate) => base.slice(0, -extension.length) + candidate),
    ];
  }
  return [
    ...sourceExtensions.map((candidate) => `${base}${candidate}`),
    ...sourceExtensions.map((candidate) => path.join(base, `index${candidate}`)),
  ];
}

function resolveInternalImport(
  fromAbsPath: string,
  specifier: string,
  sourceFiles: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  for (const candidate of importCandidates(fromAbsPath, specifier)) {
    if (sourceFiles.has(candidate)) return candidate;
    if (!existsSync(candidate) || !lstatSync(candidate).isFile()) continue;
    const canonical = realpathSync(candidate);
    if (sourceFiles.has(canonical)) return canonical;
  }
  return null;
}

function findCycles(edges: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let nextIndex = 0;

  function connect(file: string): void {
    const index = nextIndex++;
    indices.set(file, index);
    lowLinks.set(file, index);
    stack.push(file);
    onStack.add(file);

    for (const target of edges.get(file) ?? []) {
      if (!indices.has(target)) {
        connect(target);
        lowLinks.set(file, Math.min(lowLinks.get(file) ?? index, lowLinks.get(target) ?? index));
      } else if (onStack.has(target)) {
        lowLinks.set(file, Math.min(lowLinks.get(file) ?? index, indices.get(target) ?? index));
      }
    }

    if (lowLinks.get(file) !== indices.get(file)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(member);
      if (member === file) break;
    }
    if (component.length > 1 || (edges.get(file)?.has(file) ?? false)) {
      cycles.push(component.sort());
    }
  }

  for (const file of [...edges.keys()].sort()) {
    if (!indices.has(file)) connect(file);
  }
  return cycles.sort((a, b) => a.join("\n").localeCompare(b.join("\n")));
}

function countRootFiles(repoRoot: string, directory: string): number {
  const absDirectory = path.join(repoRoot, directory);
  if (!existsSync(absDirectory) || !lstatSync(absDirectory).isDirectory()) return 0;
  return readdirSync(absDirectory, { withFileTypes: true }).filter(
    (entry) =>
      entry.isFile() &&
      !entry.isSymbolicLink() &&
      isProductionSource(path.join(absDirectory, entry.name)),
  ).length;
}

export function analyzeSourceArchitecture(
  repoRoot = REPO_ROOT,
  options: AnalyzeOptions = {},
): SourceArchitectureReport {
  const canonicalRepoRoot = realpathSync(repoRoot);
  const scanRoots = options.scanRoots ?? DEFAULT_SCAN_ROOTS;
  const rootFileDirectories = options.rootFileDirectories ?? [];
  const absoluteFiles = [
    ...new Set(
      scanRoots.flatMap((root) => [...walkSourceFiles(path.join(canonicalRepoRoot, root))]),
    ),
  ].sort();
  const sourceFiles = new Set(absoluteFiles);
  const edges = new Map<string, Set<string>>();

  for (const file of absoluteFiles) {
    const targets = new Set<string>();
    for (const specifier of collectRuntimeSpecifiers(file)) {
      const target = resolveInternalImport(file, specifier, sourceFiles);
      if (target) targets.add(target);
    }
    edges.set(file, targets);
  }

  const fanInByAbsolutePath = new Map(absoluteFiles.map((file) => [file, 0]));
  for (const targets of edges.values()) {
    for (const target of targets) {
      fanInByAbsolutePath.set(target, (fanInByAbsolutePath.get(target) ?? 0) + 1);
    }
  }

  const files = absoluteFiles.map((file) => toRepoPath(canonicalRepoRoot, file));
  const fanIn = Object.fromEntries(
    absoluteFiles.map((file) => [
      toRepoPath(canonicalRepoRoot, file),
      fanInByAbsolutePath.get(file) ?? 0,
    ]),
  );
  const fanOut = Object.fromEntries(
    absoluteFiles.map((file) => [toRepoPath(canonicalRepoRoot, file), edges.get(file)?.size ?? 0]),
  );
  const repoEdges = new Map(
    absoluteFiles.map((file) => [
      toRepoPath(canonicalRepoRoot, file),
      new Set([...(edges.get(file) ?? [])].map((target) => toRepoPath(canonicalRepoRoot, target))),
    ]),
  );
  const rootFiles = Object.fromEntries(
    rootFileDirectories.map((directory) => [
      directory,
      countRootFiles(canonicalRepoRoot, directory),
    ]),
  );

  return {
    files,
    edgeCount: [...edges.values()].reduce((sum, targets) => sum + targets.size, 0),
    fanIn,
    fanOut,
    cycles: findCycles(repoEdges),
    rootFiles,
  };
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetricBudget(value: unknown, label: string): MetricBudget {
  if (!isObjectRecord(value)) throw new Error(`${label} must be an object`);
  const defaultMax = assertNonNegativeInteger(value.defaultMax, `${label}.defaultMax`);
  if (value.maxByFile !== undefined && !isObjectRecord(value.maxByFile)) {
    throw new Error(`${label}.maxByFile must be an object when present`);
  }
  const maxByFile = Object.fromEntries(
    Object.entries(value.maxByFile ?? {}).map(([file, limit]) => [
      file,
      assertNonNegativeInteger(limit, `${label}.maxByFile.${file}`),
    ]),
  );
  return { defaultMax, maxByFile };
}

function cycleKey(files: readonly string[]): string {
  return [...files].sort().join("\n");
}

export function parseSourceArchitectureBudget(
  sourceText: string,
  filePath = BUDGET_PATH,
): SourceArchitectureBudget {
  const parsed = JSON.parse(sourceText) as Record<string, unknown>;
  if (!isObjectRecord(parsed)) throw new Error(`${filePath} must contain an object`);
  if (!Array.isArray(parsed.allowedCycles)) {
    throw new Error(`${filePath}.allowedCycles must be an array`);
  }
  if (!isObjectRecord(parsed.maxRootFiles)) {
    throw new Error(`${filePath}.maxRootFiles must be an object`);
  }

  const allowedCycles = parsed.allowedCycles.map((cycle, index) => {
    if (
      !Array.isArray(cycle) ||
      cycle.length === 0 ||
      cycle.some((file) => typeof file !== "string")
    ) {
      throw new Error(`${filePath}.allowedCycles[${index}] must contain source paths`);
    }
    return [...new Set(cycle as string[])].sort();
  });
  if (new Set(allowedCycles.map(cycleKey)).size !== allowedCycles.length) {
    throw new Error(`${filePath}.allowedCycles must not contain duplicates`);
  }

  const maxRootFiles = Object.fromEntries(
    Object.entries(parsed.maxRootFiles).map(([directory, limit]) => [
      directory,
      assertNonNegativeInteger(limit, `${filePath}.maxRootFiles.${directory}`),
    ]),
  );
  return {
    fanIn: parseMetricBudget(parsed.fanIn, `${filePath}.fanIn`),
    fanOut: parseMetricBudget(parsed.fanOut, `${filePath}.fanOut`),
    allowedCycles,
    maxRootFiles,
  };
}

function evaluateMetric(
  metric: "fan-in" | "fan-out",
  actualByFile: Readonly<Record<string, number>>,
  budget: MetricBudget,
): SourceArchitectureViolation[] {
  const violations: SourceArchitectureViolation[] = [];
  const maxByFile = budget.maxByFile ?? {};
  for (const [file, actual] of Object.entries(actualByFile)) {
    const limit = maxByFile[file] ?? budget.defaultMax;
    if (actual > limit) {
      violations.push({ kind: "metric-limit", metric, file, actual, limit });
    } else if (file in maxByFile && actual < limit) {
      violations.push({ kind: "metric-ratchet", metric, file, actual, limit });
    }
  }
  for (const [file, limit] of Object.entries(maxByFile)) {
    if (!(file in actualByFile)) {
      violations.push({ kind: "metric-ratchet", metric, file, actual: null, limit });
    }
  }
  return violations;
}

export function evaluateSourceArchitectureBudget(
  report: SourceArchitectureReport,
  budget: SourceArchitectureBudget,
): SourceArchitectureViolation[] {
  const violations = [
    ...evaluateMetric("fan-in", report.fanIn, budget.fanIn),
    ...evaluateMetric("fan-out", report.fanOut, budget.fanOut),
  ];
  const allowedCycleKeys = new Set(budget.allowedCycles.map(cycleKey));
  const actualCycleKeys = new Set(report.cycles.map(cycleKey));

  for (const cycle of report.cycles) {
    if (!allowedCycleKeys.has(cycleKey(cycle))) {
      violations.push({ kind: "new-cycle", files: cycle });
    }
  }
  for (const cycle of budget.allowedCycles) {
    if (!actualCycleKeys.has(cycleKey(cycle))) {
      violations.push({ kind: "cycle-ratchet", files: cycle });
    }
  }
  for (const [directory, limit] of Object.entries(budget.maxRootFiles)) {
    const actual = report.rootFiles[directory] ?? 0;
    if (actual > limit) {
      violations.push({ kind: "root-file-limit", directory, actual, limit });
    } else if (actual < limit) {
      violations.push({ kind: "root-file-ratchet", directory, actual, limit });
    }
  }
  return violations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function formatSourceArchitectureViolations(
  violations: readonly SourceArchitectureViolation[],
): string {
  const lines = [
    "Source architecture budget failed.",
    "",
    "Reduce the dependency debt, or lower a stale limit to the measured value.",
    "",
  ];
  for (const violation of violations) {
    if (violation.kind === "metric-limit") {
      lines.push(
        `- ${violation.file}: ${violation.metric} ${violation.actual} exceeds ${violation.limit}.`,
      );
    } else if (violation.kind === "metric-ratchet") {
      const actual = violation.actual === null ? "deleted" : String(violation.actual);
      lines.push(
        `- ${violation.file}: ${violation.metric} is ${actual}; lower or remove its ${violation.limit} limit.`,
      );
    } else if (violation.kind === "new-cycle") {
      lines.push(`- New runtime cycle contains: ${violation.files.join(", ")}.`);
    } else if (violation.kind === "cycle-ratchet") {
      lines.push(
        `- Removed runtime cycle contained: ${violation.files.join(", ")}. Remove its allowance.`,
      );
    } else if (violation.kind === "root-file-limit") {
      lines.push(
        `- ${violation.directory}: ${violation.actual} root files exceed ${violation.limit}.`,
      );
    } else {
      lines.push(
        `- ${violation.directory}: root files fell from ${violation.limit} to ${violation.actual}. Lower the limit.`,
      );
    }
  }
  return lines.join("\n");
}

function maxMetric(actualByFile: Readonly<Record<string, number>>): [string, number] {
  return Object.entries(actualByFile).reduce<[string, number]>(
    (max, entry) => (entry[1] > max[1] ? entry : max),
    ["none", 0],
  );
}

function main(): void {
  const budget = parseSourceArchitectureBudget(readFileSync(BUDGET_PATH, "utf8"), BUDGET_PATH);
  const report = analyzeSourceArchitecture(REPO_ROOT, {
    rootFileDirectories: Object.keys(budget.maxRootFiles),
  });
  const violations = evaluateSourceArchitectureBudget(report, budget);
  if (violations.length > 0) {
    console.error(formatSourceArchitectureViolations(violations));
    process.exitCode = 1;
    return;
  }

  const [fanInFile, fanIn] = maxMetric(report.fanIn);
  const [fanOutFile, fanOut] = maxMetric(report.fanOut);
  console.log(
    `Source architecture budget passed: ${report.files.length} files, ${report.edgeCount} edges, ${report.cycles.length} cycles; max fan-in ${fanIn} (${fanInFile}); max fan-out ${fanOut} (${fanOutFile}).`,
  );
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main();
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import ts from "typescript";

import { parseE2eAssertionBudget } from "../../scripts/checks/e2e-assertion-census.mts";
import type { GrowthGuardrailDiff, PullRequestFile } from "./growth-guardrail-diff";

const BUDGET_FILE = "ci/test-file-size-budget.json";
const E2E_ASSERTION_BUDGET_FILE = "ci/e2e-assertion-budget.json";
const FALLBACK_BUDGET = '{"defaultMaxLines":1500,"legacyMaxLines":{}}';
const JAVASCRIPT_FILE_RE = /\.(?:cjs|js|mjs)$/;
const TEST_FILE_RE = /^(?:test|src|nemoclaw\/src)\/.*\.(?:test|spec)\.(?:[cm]?[jt]s)$/;
const LIVE_E2E_TEST_RE = /^test\/e2e\/live\/.*\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
const ONBOARD_ENTRY = "src/lib/onboard.ts";
const STOCK_DOCKERFILE = "Dockerfile";

type TestFileSizeBudget = {
  readonly defaultMaxLines: number;
  readonly legacyMaxLines: Readonly<Record<string, number>>;
};

type TestChange = {
  readonly basePath: string;
  readonly headPath: string | null;
  readonly displayName: string;
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function countLines(text: string | null): number {
  if (text === null || text.length === 0) return 0;
  const newlineCount = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  return newlineCount + (/(?:\r\n|\r|\n)$/.test(text) ? 0 : 1);
}

/** Keep the line and byte ratchets independent so same-line growth cannot bypass the budget. */
function dockerfileBudget(source: string | null): { bytes: number; lines: number } {
  return {
    bytes: source === null ? 0 : Buffer.byteLength(source, "utf8"),
    lines: countLines(source),
  };
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function parseBudget(source: string, label: string): TestFileSizeBudget {
  const parsed = JSON.parse(source) as {
    readonly defaultMaxLines?: unknown;
    readonly legacyMaxLines?: unknown;
  };
  if (
    parsed.legacyMaxLines !== undefined &&
    (typeof parsed.legacyMaxLines !== "object" ||
      parsed.legacyMaxLines === null ||
      Array.isArray(parsed.legacyMaxLines))
  ) {
    throw new Error(`${label}: legacyMaxLines must be an object when present`);
  }

  const legacyMaxLines: Record<string, number> = {};
  for (const [file, value] of Object.entries(parsed.legacyMaxLines ?? {})) {
    legacyMaxLines[file] = positiveInteger(value, `${label}: legacyMaxLines.${file}`);
  }
  return {
    defaultMaxLines: positiveInteger(parsed.defaultMaxLines, `${label}: defaultMaxLines`),
    legacyMaxLines,
  };
}

function testChanges(files: readonly PullRequestFile[]): TestChange[] {
  return files
    .filter(
      ({ filename, previous_filename }) =>
        TEST_FILE_RE.test(filename) || TEST_FILE_RE.test(previous_filename ?? ""),
    )
    .map((file) => ({
      basePath: TEST_FILE_RE.test(file.previous_filename ?? "")
        ? (file.previous_filename as string)
        : file.filename,
      headPath:
        file.status === "removed" || !TEST_FILE_RE.test(file.filename) ? null : file.filename,
      displayName: file.filename,
    }));
}

function scriptKind(file: string): ts.ScriptKind {
  return /\.[cm]?js$/i.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

const parsedTestSources = new Map<string, Map<ts.ScriptKind, ts.SourceFile>>();

function parseTestSource(file: string, source: string): ts.SourceFile {
  const kind = scriptKind(file);
  const cached = parsedTestSources.get(source)?.get(kind);
  if (cached) return cached;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const byKind = parsedTestSources.get(source) ?? new Map();
  byKind.set(kind, sourceFile);
  parsedTestSources.set(source, byKind);
  return sourceFile;
}

function countIfStatements(file: string, source: string | null): number {
  if (source === null) return 0;
  const sourceFile = parseTestSource(file, source);
  let count = 0;
  function visit(node: ts.Node): void {
    if (ts.isIfStatement(node)) count += 1;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

function rootCallName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootCallName(expression.expression);
  if (ts.isCallExpression(expression)) return rootCallName(expression.expression);
  return null;
}

function containsTestDefinition(node: ts.Node): boolean {
  let found = false;
  function visit(child: ts.Node): void {
    if (found) return;
    if (
      ts.isCallExpression(child) &&
      ["it", "test"].includes(rootCallName(child.expression) ?? "")
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  }
  ts.forEachChild(node, visit);
  return found;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
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

function functionName(node: ts.FunctionLikeDeclaration): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  return ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
    ? node.parent.name.text
    : null;
}

type LoopStatement = ts.ForStatement | ts.ForInStatement | ts.ForOfStatement;

function isLoop(node: ts.Node): node is LoopStatement {
  return ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node);
}

function thinCallbackForwardingLoop(node: ts.FunctionLikeDeclaration): LoopStatement | null {
  if (!node.body || !ts.isBlock(node.body) || node.body.statements.length !== 1) return null;
  const statement = node.body.statements[0];
  if (!statement || !isLoop(statement)) return null;
  const parameters = new Set(
    node.parameters.flatMap(({ name }) => (ts.isIdentifier(name) ? [name.text] : [])),
  );
  let invokesParameter = false;
  function visit(child: ts.Node): void {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      parameters.has(child.expression.text)
    ) {
      invokesParameter = true;
      return;
    }
    ts.forEachChild(child, visit);
  }
  visit(statement);
  return invokesParameter ? statement : null;
}

function countTestLoops(file: string, source: string | null): number {
  if (source === null) return 0;
  const sourceFile = parseTestSource(file, source);
  type LexicalScope = ts.SourceFile | ts.Block;
  const localFunctions = new Map<LexicalScope, Map<string, ts.FunctionLikeDeclaration>>();
  function enclosingScope(node: ts.Node): LexicalScope | null {
    let current: ts.Node | undefined = node.parent;
    while (current && !ts.isSourceFile(current) && !ts.isBlock(current)) {
      current = current.parent;
    }
    return current ?? null;
  }
  function collectFunctions(node: ts.Node): void {
    if (isFunctionLike(node)) {
      const name = functionName(node);
      const scope = enclosingScope(node);
      if (name && scope) {
        const functions = localFunctions.get(scope) ?? new Map();
        functions.set(name, node);
        localFunctions.set(scope, functions);
      }
    }
    ts.forEachChild(node, collectFunctions);
  }
  collectFunctions(sourceFile);

  function resolveLocalFunction(name: string, node: ts.Node): ts.FunctionLikeDeclaration | null {
    let current: ts.Node | undefined = node;
    while (current) {
      if (ts.isSourceFile(current) || ts.isBlock(current)) {
        const helper = localFunctions.get(current)?.get(name);
        if (helper) return helper;
      }
      current = current.parent;
    }
    return null;
  }

  const callCounts = new Map<ts.FunctionLikeDeclaration, number>();
  function collectCalls(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const helper = resolveLocalFunction(node.expression.text, node);
      if (helper) callCounts.set(helper, (callCounts.get(helper) ?? 0) + 1);
    }
    ts.forEachChild(node, collectCalls);
  }
  collectCalls(sourceFile);

  const countedLoops = new Set<LoopStatement>();
  function visitTestContext(
    node: ts.Node,
    activeFunctions = new Set<ts.FunctionLikeDeclaration>(),
  ): void {
    if (isLoop(node)) countedLoops.add(node);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const helper = resolveLocalFunction(node.expression.text, node);
      if (
        helper &&
        !activeFunctions.has(helper) &&
        ((callCounts.get(helper) ?? 0) === 1 || thinCallbackForwardingLoop(helper) !== null)
      ) {
        visitTestContext(helper, new Set([...activeFunctions, helper]));
      }
    }
    ts.forEachChild(node, (child) => {
      if (isFunctionLike(child) && functionName(child)) return;
      visitTestContext(child, activeFunctions);
    });
  }

  function visit(node: ts.Node): void {
    if (isLoop(node) && containsTestDefinition(node)) countedLoops.add(node);
    if (ts.isCallExpression(node) && ["it", "test"].includes(rootCallName(node.expression) ?? "")) {
      for (const argument of node.arguments) {
        if (isFunctionLike(argument)) visitTestContext(argument);
        if (ts.isIdentifier(argument)) {
          const callback = resolveLocalFunction(argument.text, argument);
          if (callback) visitTestContext(callback, new Set([callback]));
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return countedLoops.size;
}

function formatList(heading: string, details: readonly string[], remediation: string): string {
  return [heading, ...details.map((detail) => `- ${detail}`), "", remediation].join("\n");
}

export function addedJavaScriptViolations(files: readonly PullRequestFile[]): string[] {
  return files
    .filter(
      ({ filename, previous_filename, status }) =>
        JAVASCRIPT_FILE_RE.test(filename) &&
        (status === "added" ||
          (status === "renamed" && !JAVASCRIPT_FILE_RE.test(previous_filename ?? ""))),
    )
    .map(({ filename }) => filename);
}

export async function onboardGrowthViolations(diff: GrowthGuardrailDiff): Promise<string[]> {
  const changed = diff.files.some(
    ({ filename, previous_filename }) =>
      filename === ONBOARD_ENTRY || previous_filename === ONBOARD_ENTRY,
  );
  if (!changed) return [];
  const [base, head] = await Promise.all([
    diff.readBase([ONBOARD_ENTRY]),
    diff.readHead([ONBOARD_ENTRY]),
  ]);
  const baseLines = countLines(base.get(ONBOARD_ENTRY) ?? null);
  const headLines = countLines(head.get(ONBOARD_ENTRY) ?? null);
  return headLines > baseLines ? [`${ONBOARD_ENTRY} grew by ${headLines - baseLines} line(s)`] : [];
}

/** Report root Dockerfile growth while its host-side stock onboarding fallback is deprecated. */
export async function dockerfileBudgetGrowthViolations(
  diff: GrowthGuardrailDiff,
): Promise<string[]> {
  const changed = diff.files.some(
    ({ filename, previous_filename }) =>
      filename === STOCK_DOCKERFILE || previous_filename === STOCK_DOCKERFILE,
  );
  if (!changed) return [];
  const [base, head] = await Promise.all([
    diff.readBase([STOCK_DOCKERFILE]),
    diff.readHead([STOCK_DOCKERFILE]),
  ]);
  const baseBudget = dockerfileBudget(base.get(STOCK_DOCKERFILE) ?? null);
  const headBudget = dockerfileBudget(head.get(STOCK_DOCKERFILE) ?? null);
  const violations: string[] = [];
  if (headBudget.lines > baseBudget.lines) {
    violations.push(
      `${STOCK_DOCKERFILE} line budget increased from ${baseBudget.lines} to ${headBudget.lines}`,
    );
  }
  if (headBudget.bytes > baseBudget.bytes) {
    violations.push(
      `${STOCK_DOCKERFILE} byte budget increased from ${baseBudget.bytes} to ${headBudget.bytes}`,
    );
  }
  return violations;
}

export async function testSizeViolations(diff: GrowthGuardrailDiff): Promise<string[]> {
  const budgetChanged = diff.files.some(
    ({ filename, previous_filename }) =>
      filename === BUDGET_FILE || previous_filename === BUDGET_FILE,
  );
  const changedTests = diff.files
    .filter(({ filename, status }) => status !== "removed" && TEST_FILE_RE.test(filename))
    .map(({ filename }) => filename);
  const baseBudgetBlob = await diff.readBase([BUDGET_FILE]);
  const baseBudget = parseBudget(baseBudgetBlob.get(BUDGET_FILE) ?? FALLBACK_BUDGET, "base budget");
  const headBudgetBlob = budgetChanged ? await diff.readHead([BUDGET_FILE]) : null;
  const headBudget = budgetChanged
    ? parseBudget(
        headBudgetBlob?.get(BUDGET_FILE) ??
          (() => {
            throw new Error(`${BUDGET_FILE} must remain present`);
          })(),
        "head budget",
      )
    : baseBudget;
  const renames = new Map(
    diff.files.flatMap(({ filename, previous_filename }) =>
      previous_filename && previous_filename !== filename ? [[filename, previous_filename]] : [],
    ),
  );
  const headPaths = unique([
    ...Object.keys(headBudget.legacyMaxLines),
    ...Object.keys(baseBudget.legacyMaxLines).filter(
      (file) => headBudget.legacyMaxLines[file] === undefined,
    ),
    ...changedTests,
  ]);
  const head = await diff.readHead(headPaths);
  const violations: string[] = [];

  if (headBudget.defaultMaxLines > baseBudget.defaultMaxLines) {
    violations.push(
      `defaultMaxLines increased from ${baseBudget.defaultMaxLines} to ${headBudget.defaultMaxLines}`,
    );
  }
  for (const [file, headMax] of Object.entries(headBudget.legacyMaxLines)) {
    const baseMax = baseBudget.legacyMaxLines[renames.get(file) ?? file];
    if (baseMax === undefined && headMax > headBudget.defaultMaxLines) {
      violations.push(`${file} adds a legacy budget above the default`);
    }
    if (baseMax !== undefined && headMax > baseMax) {
      violations.push(`${file} legacy budget increased from ${baseMax} to ${headMax}`);
    }
    const source = head.get(file);
    if (source === null || source === undefined) {
      violations.push(`${file} no longer exists; remove its legacy budget ${headMax}`);
      continue;
    }
    const lines = countLines(source);
    if (lines > headMax) violations.push(`${file} has ${lines} lines, above its budget ${headMax}`);
    if (lines < headMax) violations.push(`${file} has ${lines} lines; lower its budget ${headMax}`);
  }
  for (const file of Object.keys(baseBudget.legacyMaxLines)) {
    const carried = [...renames.entries()].some(
      ([headPath, basePath]) =>
        basePath === file && headBudget.legacyMaxLines[headPath] !== undefined,
    );
    if (
      headBudget.legacyMaxLines[file] === undefined &&
      !carried &&
      countLines(head.get(file) ?? null) > headBudget.defaultMaxLines
    ) {
      violations.push(`${file} removed its legacy budget while still above the default`);
    }
  }
  for (const file of changedTests) {
    if (headBudget.legacyMaxLines[file] !== undefined) continue;
    const source = head.get(file);
    if (source === null || source === undefined) {
      violations.push(`${file} was not found at the latest PR commit`);
      continue;
    }
    const lines = countLines(source);
    const max = headBudget.legacyMaxLines[file] ?? headBudget.defaultMaxLines;
    if (lines > max) violations.push(`${file} has ${lines} lines, above its budget ${max}`);
  }
  return violations;
}

export async function e2eAssertionBudgetGrowthViolations(
  diff: GrowthGuardrailDiff,
): Promise<string[]> {
  const changed = diff.files.some(
    ({ filename, previous_filename }) =>
      filename === E2E_ASSERTION_BUDGET_FILE || previous_filename === E2E_ASSERTION_BUDGET_FILE,
  );
  if (!changed) return [];
  const [baseBlob, headBlob] = await Promise.all([
    diff.readBase([E2E_ASSERTION_BUDGET_FILE]),
    diff.readHead([E2E_ASSERTION_BUDGET_FILE]),
  ]);
  const baseSource = baseBlob.get(E2E_ASSERTION_BUDGET_FILE);
  const headSource = headBlob.get(E2E_ASSERTION_BUDGET_FILE);
  if (headSource === null || headSource === undefined) {
    return [`${E2E_ASSERTION_BUDGET_FILE} must remain present`];
  }
  if (baseSource === null || baseSource === undefined) return [];

  const base = parseE2eAssertionBudget(baseSource);
  const head = parseE2eAssertionBudget(headSource);
  const violations: string[] = [];
  if (JSON.stringify(head.reference) !== JSON.stringify(base.reference)) {
    violations.push("live E2E assertion reference metadata changed");
  }
  for (const count of ["testFileCount", "liveFileCount"] as const) {
    if (head.limits[count] > base.limits[count]) {
      violations.push(`${count} increased from ${base.limits[count]} to ${head.limits[count]}`);
    }
  }
  for (const view of ["direct", "unique"] as const) {
    for (const metric of [
      "expectCalls",
      "assertionPoints",
      "generatedProbeBlocks",
      "generatedProbeConditions",
    ] as const) {
      const before = base.limits[view][metric];
      const after = head.limits[view][metric];
      if (after > before) violations.push(`${view}.${metric} increased from ${before} to ${after}`);
    }
  }
  const renames = new Map(
    diff.files.flatMap(({ filename, previous_filename, status }) =>
      status === "renamed" && previous_filename ? [[filename, previous_filename]] : [],
    ),
  );
  const renamedFrom = new Map([...renames].map(([filename, previous]) => [previous, filename]));
  const removed = new Set(
    diff.files.flatMap(({ filename, status }) => (status === "removed" ? [filename] : [])),
  );
  for (const [file, after] of Object.entries(head.limits.files)) {
    const before = base.limits.files[renames.get(file) ?? file];
    if (!before) {
      violations.push(`${file} added a live E2E assertion budget`);
      continue;
    }
    after.forEach((value, index) => {
      if (value > before[index]!) {
        violations.push(
          `${file} ${head.limits.fileMetricOrder[index]} increased from ${before[index]} to ${value}`,
        );
      }
    });
  }
  for (const file of Object.keys(base.limits.files)) {
    const renamedTo = renamedFrom.get(file);
    const carriedFile = renamedTo ?? file;
    if (head.limits.files[carriedFile]) continue;
    const genuinelyRemoved =
      removed.has(file) || (renamedTo !== undefined && !LIVE_E2E_TEST_RE.test(renamedTo));
    if (!genuinelyRemoved) {
      violations.push(`${carriedFile} omitted its live E2E assertion budget`);
    }
  }
  return violations;
}

async function syntaxGrowthViolations(
  diff: GrowthGuardrailDiff,
  count: (file: string, source: string | null) => number,
  label: string,
): Promise<string[]> {
  const changes = testChanges(diff.files);
  const basePaths = unique(changes.map(({ basePath }) => basePath));
  const headPaths = unique(
    changes.flatMap(({ headPath }) => (headPath === null ? [] : [headPath])),
  );
  const [base, head] = await Promise.all([diff.readBase(basePaths), diff.readHead(headPaths)]);
  return changes.flatMap(({ basePath, displayName, headPath }) => {
    const baseCount = count(basePath, base.get(basePath) ?? null);
    const headCount = headPath === null ? 0 : count(headPath, head.get(headPath) ?? null);
    return headCount > baseCount
      ? [`${headPath ?? displayName}: ${headCount} ${label}(s), up from ${baseCount}`]
      : [];
  });
}

export function conditionalGrowthViolations(diff: GrowthGuardrailDiff): Promise<string[]> {
  return syntaxGrowthViolations(diff, countIfStatements, "if statement");
}

export function loopGrowthViolations(diff: GrowthGuardrailDiff): Promise<string[]> {
  return syntaxGrowthViolations(diff, countTestLoops, "test loop");
}

/** Explain the intentional review boundary rather than treating active managed-image use as an exemption. */
function dockerfileBudgetDiagnostic(details: readonly string[]): string {
  return formatList(
    "The root Dockerfile budget grew.",
    details,
    "Host-side stock Dockerfile onboarding is deprecated. Keep the root Dockerfile at or below its existing line and byte budgets. Move new onboarding behavior to the managed-image startup profile, bootstrap, or runtime-provider path, or record a maintainer decision before increasing this budget.",
  );
}

export const diagnostics = {
  javascript: (details: readonly string[]) =>
    formatList(
      "This change adds JavaScript files.",
      details,
      "Use TypeScript for new source, test, and script files.",
    ),
  onboard: (details: readonly string[]) =>
    formatList(
      "The onboarding entry point grew.",
      details,
      "Move new behavior into a focused module under src/lib/onboard/.",
    ),
  dockerfileBudget: dockerfileBudgetDiagnostic,
  size: (details: readonly string[]) =>
    formatList(
      "The test file size budget was exceeded or weakened.",
      details,
      "Split oversized tests, and lower legacy budgets when files shrink.",
    ),
  e2eAssertions: (details: readonly string[]) =>
    formatList(
      "The live E2E assertion budget increased.",
      details,
      "Keep the baseline at or below the trusted base. Reduce assertions before updating the budget.",
    ),
  conditionals: (details: readonly string[]) =>
    formatList(
      "Changed test files add if statements.",
      details,
      "Split conditional behavior into separate tests, use it.skipIf or it.runIf for gates, or move setup branching into a non-test support module.",
    ),
  loops: (details: readonly string[]) =>
    formatList(
      "Changed test files add loops inside test callbacks, around test definitions, through one-use helpers, or through callback-forwarding helpers.",
      details,
      "Keep one-scenario setup, sequence, retry, polling, and aggregate loops direct. Use test.each for independent cases. Do not move one test's loop into a named callback or one-use helper.",
    ),
};

export const testOnly = { countIfStatements, countTestLoops };

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type ConsumerFindingKind =
  | "direct-argv"
  | "direct-executable"
  | "raw-helper-definition"
  | "raw-runtime-import";

export type ConsumerFinding = Readonly<{
  id: string;
  kinds: readonly ConsumerFindingKind[];
  operations: readonly string[];
  path: string;
}>;

export type ConsumerAllowance = Readonly<{
  kinds: readonly ConsumerFindingKind[];
  operations: readonly string[];
  path: string;
}>;

export type ConsumerGroup = Readonly<{
  capability: string;
  consumer: string;
  disposition: "dependency-deferral" | "executable-exception-candidate";
  evidence: string;
  id: string;
  owner: string;
  reason: string;
  removalCondition: string;
  sites: readonly ConsumerAllowance[];
}>;

export type HistoricalOperation = Readonly<{
  capability: string;
  consumer: string;
  disposition: "typed-cli-implementation" | "dependency-deferral" | "retired-path";
  evidence: string;
  id: string;
  operations: readonly string[];
  owner: string;
  reason: string;
  removalCondition: string;
}>;

export type OpenShellConsumerManifest = Readonly<{
  consumerGroups: readonly ConsumerGroup[];
  historicalOperations: readonly HistoricalOperation[];
  issue: number;
  schemaVersion: number;
}>;

export type ConsumerBoundaryViolation = Readonly<{
  id: string;
  kind: "invalid-manifest" | "stale-allowance" | "unknown-consumer";
  message: string;
}>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "ci", "openshell-consumer-boundary.json");
const SCAN_ROOTS = ["src", "nemoclaw/src"] as const;
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/u;
const TEST_SUPPORT_PATH =
  /(?:^|\/)(?:__test-helpers__|test-fixtures)(?:\/|$)|\.(?:test|spec|test-support|test-fixture)\.[cm]?[jt]sx?$/u;
const SKIP_DIRS = new Set(["coverage", "dist", "node_modules", "runner-dist"]);
const RAW_RUNTIME_MODULE = /(?:^|\/)adapters\/openshell\/runtime(?:\.[cm]?[jt]s)?$/u;
const RAW_HELPERS = new Set([
  "captureOpenShellOutput",
  "captureOpenshell",
  "captureResolvedOpenshell",
  "captureResolvedOpenshellAsync",
  "openshellArgv",
  "openshellShellCommand",
  "runCaptureOpenshell",
  "runOpenshell",
  "runQuietOpenshell",
]);
const DIRECT_EXECUTORS = new Set(["execFile", "execFileSync", "execa", "spawn", "spawnSync"]);
const ROOT_OPERATIONS = new Set([
  "--version",
  "doctor",
  "forward",
  "gateway",
  "inference",
  "logs",
  "policy",
  "provider",
  "sandbox",
  "settings",
  "status",
]);

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
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
    true,
    scriptKind,
  );
}

function* walkSourceFiles(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink()) return;
  if (stats.isFile()) {
    if (SOURCE_EXTENSION.test(directory) && !TEST_SUPPORT_PATH.test(normalizePath(directory))) {
      yield realpathSync(directory);
    }
    return;
  }
  if (!stats.isDirectory()) return;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
    const absPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceFiles(absPath);
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSION.test(entry.name) &&
      !TEST_SUPPORT_PATH.test(normalizePath(absPath))
    ) {
      yield realpathSync(absPath);
    }
  }
}

function stringValue(node: ts.Expression | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function operationFromTokens(tokens: readonly string[]): string | null {
  const offset = tokens[0] === "openshell" ? 1 : 0;
  const root = tokens[offset];
  if (!root || !ROOT_OPERATIONS.has(root)) return null;
  if (root === "--version" || root === "logs" || root === "status") return root;
  const second = tokens[offset + 1];
  if (!second || second.startsWith("-")) return root;
  if (root === "sandbox" && second === "provider") {
    return tokens[offset + 2] ? `sandbox provider ${tokens[offset + 2]}` : "sandbox provider";
  }
  if (root === "provider" && (second === "profile" || second === "refresh")) {
    return tokens[offset + 2] ? `provider ${second} ${tokens[offset + 2]}` : `provider ${second}`;
  }
  return `${root} ${second}`;
}

function operationFromArray(node: ts.ArrayLiteralExpression): string | null {
  const tokens: string[] = [];
  for (const element of node.elements) {
    if (!ts.isExpression(element)) break;
    const value = stringValue(element);
    if (value === null) break;
    tokens.push(value);
  }
  return operationFromTokens(tokens);
}

function calledName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function rawRuntimeSpecifier(node: ts.Node): string | null {
  if (ts.isImportDeclaration(node)) {
    if (node.importClause?.isTypeOnly) return null;
    const bindings = node.importClause?.namedBindings;
    if (
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.every((element) => element.isTypeOnly)
    ) {
      return null;
    }
    return stringValue(node.moduleSpecifier);
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require"
  ) {
    return stringValue(node.arguments[0]);
  }
  return null;
}

function scanSourceFile(repoPath: string, absPath: string): ConsumerFinding[] {
  if (repoPath.startsWith("src/lib/adapters/openshell/")) return [];
  const source = sourceFileFor(absPath);
  const kinds = new Set<ConsumerFindingKind>();
  const operations = new Set<string>();
  const candidateOperations = new Set<string>();

  function add(kind: ConsumerFindingKind, operation: string): void {
    kinds.add(kind);
    operations.add(operation);
  }

  function visit(node: ts.Node): void {
    const moduleSpecifier = rawRuntimeSpecifier(node);
    if (moduleSpecifier && RAW_RUNTIME_MODULE.test(moduleSpecifier)) {
      add("raw-runtime-import", "arbitrary argv");
    }

    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      RAW_HELPERS.has(node.name.text)
    ) {
      add("raw-helper-definition", "arbitrary argv");
    }

    if (ts.isArrayLiteralExpression(node)) {
      const operation = operationFromArray(node);
      if (operation) candidateOperations.add(operation);
      if (operation && stringValue(node.elements[0] as ts.Expression) === "openshell") {
        add("direct-argv", operation);
      }
    }

    if (ts.isCallExpression(node)) {
      const name = calledName(node);
      const first = node.arguments[0];
      const second = node.arguments[1];
      if (name && RAW_HELPERS.has(name) && first && ts.isArrayLiteralExpression(first)) {
        const operation = operationFromArray(first);
        if (operation) add("direct-argv", operation);
      }
      if (
        name &&
        (DIRECT_EXECUTORS.has(name) || name === "run") &&
        stringValue(first) === "openshell"
      ) {
        const operation =
          second && ts.isArrayLiteralExpression(second)
            ? operationFromArray(second)
            : operationFromTokens(["openshell"]);
        add("direct-executable", operation ?? "arbitrary argv");
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  if (
    kinds.has("raw-runtime-import") ||
    kinds.has("raw-helper-definition") ||
    kinds.has("direct-executable")
  ) {
    for (const operation of candidateOperations) operations.add(operation);
  }
  if (kinds.size === 0) return [];
  return [
    {
      id: `consumer:${repoPath}`,
      kinds: [...kinds].sort(),
      operations: [...operations].sort(),
      path: repoPath,
    },
  ];
}

export function scanOpenShellConsumers(
  repoRoot = REPO_ROOT,
  scanRoots: readonly string[] = SCAN_ROOTS,
): ConsumerFinding[] {
  const canonicalRoot = realpathSync(repoRoot);
  const findings = scanRoots.flatMap((root) =>
    [...walkSourceFiles(path.join(canonicalRoot, root))].flatMap((absPath) =>
      scanSourceFile(normalizePath(path.relative(canonicalRoot, absPath)), absPath),
    ),
  );
  return findings.sort((a, b) => a.id.localeCompare(b.id));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function metadataErrors(
  entries: readonly Record<string, unknown>[],
  label: string,
  requiredFields: readonly string[],
): ConsumerBoundaryViolation[] {
  const violations: ConsumerBoundaryViolation[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = nonEmptyString(entry.id) ? entry.id : `${label}:missing-id`;
    if (seen.has(id)) {
      violations.push({
        id,
        kind: "invalid-manifest",
        message: `${label} contains duplicate id '${id}'.`,
      });
    }
    seen.add(id);
    for (const field of requiredFields) {
      if (!nonEmptyString(entry[field]) && !Array.isArray(entry[field])) {
        violations.push({
          id,
          kind: "invalid-manifest",
          message: `${label} '${id}' requires non-empty ${field}.`,
        });
      }
    }
  }
  return violations;
}

export function parseOpenShellConsumerManifest(source: string): OpenShellConsumerManifest {
  const parsed = JSON.parse(source) as Partial<OpenShellConsumerManifest>;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.issue !== 9813 ||
    !Array.isArray(parsed.historicalOperations) ||
    !Array.isArray(parsed.consumerGroups)
  ) {
    throw new Error("OpenShell consumer manifest must use schema 1 for issue #9813");
  }
  return parsed as OpenShellConsumerManifest;
}

export function evaluateOpenShellConsumerBoundary(
  findings: readonly ConsumerFinding[],
  manifest: OpenShellConsumerManifest,
): ConsumerBoundaryViolation[] {
  const violations: ConsumerBoundaryViolation[] = [];
  const historicalOperationCount = manifest.historicalOperations.reduce(
    (total, group) => total + group.operations.length,
    0,
  );
  if (historicalOperationCount !== 44) {
    violations.push({
      id: "historical-operation-count",
      kind: "invalid-manifest",
      message: `Historical operation ledger must contain 44 operations; found ${historicalOperationCount}.`,
    });
  }
  violations.push(
    ...metadataErrors(
      manifest.historicalOperations as readonly Record<string, unknown>[],
      "historical operation",
      [
        "capability",
        "consumer",
        "disposition",
        "evidence",
        "id",
        "operations",
        "owner",
        "reason",
        "removalCondition",
      ],
    ),
    ...metadataErrors(
      manifest.consumerGroups as readonly Record<string, unknown>[],
      "consumer group",
      [
        "capability",
        "consumer",
        "disposition",
        "evidence",
        "id",
        "owner",
        "reason",
        "removalCondition",
        "sites",
      ],
    ),
  );

  const historicalIds = manifest.historicalOperations.flatMap((group) => group.operations);
  if (new Set(historicalIds).size !== historicalIds.length) {
    violations.push({
      id: "historical-operation-duplicates",
      kind: "invalid-manifest",
      message: "Historical operation ledger contains duplicate operations.",
    });
  }

  const consumers = manifest.consumerGroups.flatMap((group) =>
    group.sites.map((site) => ({ ...site, id: `consumer:${site.path}` })),
  );
  if (new Set(consumers.map((entry) => entry.id)).size !== consumers.length) {
    violations.push({
      id: "consumer-duplicates",
      kind: "invalid-manifest",
      message: "OpenShell consumer ledger contains duplicate paths.",
    });
  }
  for (const entry of consumers) {
    if (entry.kinds.length === 0 || entry.operations.length === 0) {
      violations.push({
        id: entry.id,
        kind: "invalid-manifest",
        message: `OpenShell consumer allowance '${entry.id}' has empty signals.`,
      });
    }
  }

  const actual = new Map(findings.map((entry) => [entry.id, entry]));
  const allowed = new Map(consumers.map((entry) => [entry.id, entry]));
  for (const entry of findings) {
    if (!allowed.has(entry.id)) {
      violations.push({
        id: entry.id,
        kind: "unknown-consumer",
        message: `Unclassified OpenShell consumer '${entry.id}'.`,
      });
    }
  }
  for (const entry of consumers) {
    const observed = actual.get(entry.id);
    if (!observed) {
      violations.push({
        id: entry.id,
        kind: "stale-allowance",
        message: `Stale OpenShell consumer allowance '${entry.id}'. Remove it or update the disposition.`,
      });
      continue;
    }
    if (
      observed.path !== entry.path ||
      JSON.stringify(observed.kinds) !== JSON.stringify(entry.kinds) ||
      JSON.stringify(observed.operations) !== JSON.stringify(entry.operations)
    ) {
      violations.push({
        id: entry.id,
        kind: "invalid-manifest",
        message: `OpenShell consumer allowance '${entry.id}' does not match its encoded identity.`,
      });
    }
  }
  return violations.sort((a, b) => a.id.localeCompare(b.id) || a.message.localeCompare(b.message));
}

export function formatOpenShellConsumerViolations(
  violations: readonly ConsumerBoundaryViolation[],
): string {
  return violations.map((entry) => `- ${entry.message}`).join("\n");
}

function run(): void {
  const findings = scanOpenShellConsumers();
  if (process.argv.includes("--report")) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }
  const manifest = parseOpenShellConsumerManifest(readFileSync(MANIFEST_PATH, "utf8"));
  const violations = evaluateOpenShellConsumerBoundary(findings, manifest);
  if (violations.length === 0) return;
  console.error("OpenShell consumer boundary check failed:");
  console.error(formatOpenShellConsumerViolations(violations));
  process.exitCode = 1;
}

const currentModule = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentModule) run();

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { createVitest } from "vitest/node";

import { REPO_ROOT } from "../../test/e2e/fixtures/paths.ts";
import { validateE2EPhasePlan } from "../../test/e2e/fixtures/progress.ts";
import {
  type CredentialFreeTestMatrixRow,
  type CredentialFreeTestProject,
} from "./credential-free-tests.mts";
import {
  type FreeStandingJobsInventory,
  readFreeStandingJobsInventory,
} from "./workflow-boundary.mts";
import { buildE2eWorkflowPlan } from "./workflow-plan.mts";

declare module "@vitest/runner" {
  interface TaskMeta {
    e2ePhases?: readonly string[];
  }
}

export interface SemanticPhaseCoverage {
  files: number;
  tests: number;
}

export interface PhaseCall {
  file: string;
  label: string | null;
  line: number;
}

export interface TestPhaseBody {
  file: string;
  line: number;
  phaseCalls: PhaseCall[];
  skipped?: boolean;
}

export interface DirectChildProcessCall {
  api: "exec" | "execFile" | "execFileSync" | "execSync" | "fork" | "spawn" | "spawnSync";
  boundary: string;
  file: string;
  hasBoundedTimeout: boolean;
  hasHardKillSignal: boolean;
  line: number;
  observesOutput: boolean;
  outputIgnored: boolean;
  tracksActivity: boolean;
  tracksLifecycle: boolean;
}

export interface ScopedPhasePlan {
  name: string;
  phases: readonly string[];
}

export interface SemanticPhaseSourceGraph {
  childProcessAuditFailures?: string[];
  directChildProcessCalls?: DirectChildProcessCall[];
  forwardedTestModules?: string[];
  importsDirectTest: boolean;
  importsSharedTest: boolean;
  importsWorkflowTest?: boolean;
  phaseCalls: PhaseCall[];
  testPhaseBodies: TestPhaseBody[];
}

export interface CollectedSemanticPhaseModule {
  relativeModuleId: string;
  project?: CredentialFreeTestProject;
  errors: readonly string[];
  tests: readonly {
    fullName: string;
    phases?: readonly string[];
  }[];
  source: SemanticPhaseSourceGraph;
}

export interface WorkflowSemanticPhaseModule {
  file: string;
  project: CredentialFreeTestProject;
}

const LIVE_ROOT = path.join(REPO_ROOT, "test", "e2e", "live");
const E2E_ROOT = path.join(REPO_ROOT, "test", "e2e");
const E2E_PROCESS_ROOTS = [E2E_ROOT, path.join(REPO_ROOT, "tools", "e2e")];
const E2E_RUNTIME_OBSERVABILITY_FILES = [path.join(E2E_ROOT, "risk-signal-reporter.ts")];
const REGISTRY_TARGET_TEST = "test/e2e/live/registry-targets.test.ts";
const LIVE_TEST_FORWARDERS = new Map([
  ["test/e2e/live/bootstrap-install-smoke.test.ts", "test/e2e/live/launchable-smoke.test.ts"],
]);
const LIVE_TEST_FIXTURE_SUFFIX = "/fixtures/e2e-test.ts";
const WORKFLOW_TEST_FIXTURE_SUFFIX = "/e2e/fixtures/workflow-e2e-test.ts";

type SemanticPhaseWorkflowPlan = {
  matrix: readonly unknown[];
  testMatrix: readonly CredentialFreeTestMatrixRow[];
};
type SemanticPhaseWorkflowInventory = Pick<FreeStandingJobsInventory, "liveTestToJobs">;

function credentialFreeProjectForWorkflowFile(
  file: string,
  testMatrix: readonly CredentialFreeTestMatrixRow[],
): CredentialFreeTestProject {
  if (file.startsWith("test/e2e/live/") && file.endsWith(".test.ts")) return "e2e-live";
  const plannedRow = testMatrix.find((row) => row.file === file);
  if (plannedRow) return plannedRow.project;
  throw new Error(
    `workflow-selected test is outside test/e2e/live and missing from the shared E2E planner: ${file}`,
  );
}

/**
 * Returns the complete semantic-phase coverage ledger. Every e2e-live module
 * remains covered, including files not selected by today's default workflow;
 * the workflow inventory and shared planner add project-aware integration tests
 * that execute through the credential-free shared job.
 */
export function semanticPhaseCoverageModules(
  plan: SemanticPhaseWorkflowPlan = buildE2eWorkflowPlan(),
  inventory: SemanticPhaseWorkflowInventory = readFreeStandingJobsInventory(),
  liveTestFiles: readonly string[] = fs
    .globSync("**/*.test.ts", { cwd: LIVE_ROOT })
    .map((file) => path.join("test/e2e/live", file).split(path.sep).join("/")),
): WorkflowSemanticPhaseModule[] {
  const selected = new Map<string, CredentialFreeTestProject>();

  function add(file: string, project: CredentialFreeTestProject): void {
    const existing = selected.get(file);
    if (existing && existing !== project) {
      throw new Error(
        `workflow-selected test belongs to conflicting Vitest projects: ${file} (${existing}, ${project})`,
      );
    }
    selected.set(file, project);
  }

  for (const file of liveTestFiles) add(file, "e2e-live");
  for (const row of plan.testMatrix) add(row.file, row.project);
  for (const file of inventory.liveTestToJobs.keys()) {
    add(file, credentialFreeProjectForWorkflowFile(file, plan.testMatrix));
  }
  if (plan.matrix.length > 0) add(REGISTRY_TARGET_TEST, "e2e-live");

  for (const [forwarder, target] of LIVE_TEST_FORWARDERS) {
    if (selected.has(forwarder)) add(target, "e2e-live");
  }

  return [...selected]
    .map(([file, project]) => ({ file, project }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

function resolveImportWithin(root: string, fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [resolved, `${resolved}.ts`, path.join(resolved, "index.ts")];
  const rootPrefix = `${root}${path.sep}`;
  return (
    candidates.find(
      (candidate) =>
        candidate.startsWith(rootPrefix) &&
        fs.existsSync(candidate) &&
        fs.statSync(candidate).isFile(),
    ) ?? null
  );
}

function resolveLiveImport(fromFile: string, specifier: string): string | null {
  return resolveImportWithin(LIVE_ROOT, fromFile, specifier);
}

function resolveE2EImport(fromFile: string, specifier: string): string | null {
  for (const root of E2E_PROCESS_ROOTS) {
    const resolved = resolveImportWithin(root, fromFile, specifier);
    if (resolved) return resolved;
  }
  return null;
}

function importsTestFrom(sourceFile: ts.SourceFile, moduleSuffix: string): boolean {
  return sourceFile.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.endsWith(moduleSuffix)
    ) {
      return false;
    }
    if (statement.importClause?.isTypeOnly) return false;
    const bindings = statement.importClause?.namedBindings;
    return (
      !!bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === "test",
      )
    );
  });
}

function importsSharedE2ETest(sourceFile: ts.SourceFile): boolean {
  return importsTestFrom(sourceFile, LIVE_TEST_FIXTURE_SUFFIX);
}

function importsWorkflowE2ETest(sourceFile: ts.SourceFile): boolean {
  return importsTestFrom(sourceFile, WORKFLOW_TEST_FIXTURE_SUFFIX);
}

function importsDirectVitestTest(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "vitest"
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      !!bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) =>
        ["it", "test"].includes((element.propertyName ?? element.name).text),
      )
    );
  });
}

const DIRECT_CHILD_PROCESS_APIS = new Set<DirectChildProcessCall["api"]>([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]);
const ASYNC_CHILD_PROCESS_APIS = new Set<DirectChildProcessCall["api"]>([
  "exec",
  "execFile",
  "fork",
  "spawn",
]);
const MAX_BLOCKING_CHILD_PROCESS_MS = 5 * 60_000;
const AUDITED_ASYNC_CHILD_PROCESS_BOUNDARY =
  "test/e2e/fixtures/observed-child-process.ts#spawnObservedChild";
const OBSERVED_CHILD_PROCESS_MODULE = path.join(E2E_ROOT, "fixtures", "observed-child-process.ts");
const TEST_PROGRESS_MODULE = path.join(E2E_ROOT, "fixtures", "progress.ts");

type ObservedChildProgressPolicy = { kind: "path"; path: string };

// This closed-world list is intentionally conservative. A new asynchronous
// process boundary must be reviewed here, and its progress expression must
// retain the unforgeable TestProgress capability enforced by TypeScript.
const OBSERVED_CHILD_PROGRESS_POLICIES = new Map<string, ObservedChildProgressPolicy>([
  [
    "test/e2e/fixtures/fake-openai-compatible.ts#startFakeOpenAiCompatibleServer",
    { kind: "path", path: "options.progress" },
  ],
  ["test/e2e/fixtures/shell-probe.ts#run", { kind: "path", path: "this.progress" }],
  ["test/e2e/fixtures/docker-probe.ts#run", { kind: "path", path: "this.progress" }],
  [
    "test/e2e/live/openshell-gateway-auth-source-contract-helpers.ts#runOpenShellGatewayAuthSourceContractScenarioUnchecked",
    { kind: "path", path: "progress" },
  ],
  [
    "test/e2e/live/mcp-bridge-servers.ts#startPublicMcpHttpsTunnel",
    { kind: "path", path: "options.progress" },
  ],
  [
    "test/e2e/live/bedrock-runtime-compatible-anthropic-raw-command.ts#runRawCommand",
    { kind: "path", path: "options.progress" },
  ],
  ["test/e2e/live/ollama-auth-proxy.test.ts#spawnLogged", { kind: "path", path: "progress" }],
  [
    "test/gateway-drift-preflight.test.ts#runLiveHostProcessCase",
    { kind: "path", path: "progress" },
  ],
]);

interface DirectChildProcessBindings {
  values: Map<string, ProcessProvenance>;
}

type ProcessProvenance =
  | {
      kind: "api";
      api: DirectChildProcessCall["api"];
      invocation: "direct" | "indirect";
    }
  | { kind: "binder"; api: DirectChildProcessCall["api"] }
  | { kind: "builtin-loader" }
  | { kind: "create-require" }
  | { kind: "namespace" }
  | { kind: "promisify" }
  | { kind: "require" }
  | { kind: "module-namespace" }
  | { kind: "util-namespace" };

const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const MODULE_MODULES = new Set(["module", "node:module"]);
const UTIL_MODULES = new Set(["util", "node:util"]);

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function memberName(expression: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
  if (
    ts.isElementAccessExpression(unwrapped) &&
    unwrapped.argumentExpression &&
    ts.isStringLiteralLike(unwrapped.argumentExpression)
  ) {
    return unwrapped.argumentExpression.text;
  }
  return null;
}

function memberReceiver(expression: ts.Expression): ts.Expression | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return unwrapped.expression;
  }
  return null;
}

function expressionProvenance(
  expression: ts.Expression | undefined,
  bindings: DirectChildProcessBindings,
): ProcessProvenance | null {
  if (!expression) return null;
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return (
      bindings.values.get(unwrapped.text) ??
      (unwrapped.text === "require" ? { kind: "require" } : null)
    );
  }
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    if (
      memberName(unwrapped) === "getBuiltinModule" &&
      expressionPath(unwrapped.expression) === "process"
    ) {
      return { kind: "builtin-loader" };
    }
    const receiver = expressionProvenance(unwrapped.expression, bindings);
    const name = memberName(unwrapped);
    if (
      receiver?.kind === "namespace" &&
      name &&
      DIRECT_CHILD_PROCESS_APIS.has(name as DirectChildProcessCall["api"])
    ) {
      return {
        kind: "api",
        api: name as DirectChildProcessCall["api"],
        invocation: "direct",
      };
    }
    if (receiver?.kind === "util-namespace" && name === "promisify") {
      return { kind: "promisify" };
    }
    if (receiver?.kind === "module-namespace" && name === "createRequire") {
      return { kind: "create-require" };
    }
    if (receiver?.kind === "api" && name === "bind") {
      return { kind: "binder", api: receiver.api };
    }
    if (receiver?.kind === "api" && (name === "call" || name === "apply")) {
      return { ...receiver, invocation: "indirect" };
    }
    return null;
  }
  if (ts.isCallExpression(unwrapped)) {
    if (unwrapped.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = unwrapped.arguments[0];
      if (unwrapped.arguments.length !== 1 || !specifier || !ts.isStringLiteralLike(specifier)) {
        return null;
      }
      if (CHILD_PROCESS_MODULES.has(specifier.text)) return { kind: "namespace" };
      if (UTIL_MODULES.has(specifier.text)) return { kind: "util-namespace" };
      if (MODULE_MODULES.has(specifier.text)) return { kind: "module-namespace" };
      return null;
    }
    const callee = expressionProvenance(unwrapped.expression, bindings);
    if (callee?.kind === "builtin-loader") {
      const specifier = unwrapped.arguments[0];
      if (unwrapped.arguments.length !== 1 || !specifier || !ts.isStringLiteralLike(specifier)) {
        return null;
      }
      if (CHILD_PROCESS_MODULES.has(specifier.text)) return { kind: "namespace" };
      if (UTIL_MODULES.has(specifier.text)) return { kind: "util-namespace" };
      if (MODULE_MODULES.has(specifier.text)) return { kind: "module-namespace" };
      return null;
    }
    if (callee?.kind === "require") {
      const specifier = unwrapped.arguments[0];
      if (unwrapped.arguments.length !== 1 || !specifier || !ts.isStringLiteralLike(specifier)) {
        return null;
      }
      if (CHILD_PROCESS_MODULES.has(specifier.text)) return { kind: "namespace" };
      if (UTIL_MODULES.has(specifier.text)) return { kind: "util-namespace" };
      if (MODULE_MODULES.has(specifier.text)) return { kind: "module-namespace" };
      return null;
    }
    if (callee?.kind === "create-require") return { kind: "require" };
    if (callee?.kind === "binder") {
      return { kind: "api", api: callee.api, invocation: "indirect" };
    }
    if (callee?.kind === "promisify") {
      const wrapped = expressionProvenance(unwrapped.arguments[0], bindings);
      if (wrapped?.kind === "api") {
        return { ...wrapped, invocation: "indirect" };
      }
    }
  }
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return expressionProvenance(unwrapped.right, bindings);
  }
  if (ts.isConditionalExpression(unwrapped)) {
    const provenance =
      expressionProvenance(unwrapped.whenTrue, bindings) ??
      expressionProvenance(unwrapped.whenFalse, bindings);
    return provenance?.kind === "api" ? { ...provenance, invocation: "indirect" } : provenance;
  }
  if (
    ts.isBinaryExpression(unwrapped) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(unwrapped.operatorToken.kind)
  ) {
    const provenance =
      expressionProvenance(unwrapped.left, bindings) ??
      expressionProvenance(unwrapped.right, bindings);
    return provenance?.kind === "api" ? { ...provenance, invocation: "indirect" } : provenance;
  }
  return null;
}

function directChildProcessBindings(sourceFile: ts.SourceFile): DirectChildProcessBindings {
  const bindings: DirectChildProcessBindings = { values: new Map() };
  const bindIdentifier = (name: string, provenance: ProcessProvenance | null): boolean => {
    if (!provenance) return false;
    const existing = bindings.values.get(name);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(provenance)) return false;
      if (existing.kind === "api" && existing.invocation === "direct") {
        bindings.values.set(name, { ...existing, invocation: "indirect" });
        return true;
      }
      // Provenance only grows. Retaining the first conflicting capability is
      // conservative and, unlike overwriting it, guarantees fixed-point
      // convergence for variables reassigned between process APIs.
      return false;
    }
    bindings.values.set(name, provenance);
    return true;
  };
  const bindObjectPattern = (
    pattern: ts.ObjectBindingPattern,
    provenance: ProcessProvenance | null,
  ): boolean => {
    if (
      !provenance ||
      !["namespace", "util-namespace", "module-namespace"].includes(provenance.kind)
    ) {
      return false;
    }
    let changed = false;
    for (const element of pattern.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const imported = propertyNameText(element.propertyName) ?? element.name.text;
      if (
        provenance.kind === "namespace" &&
        DIRECT_CHILD_PROCESS_APIS.has(imported as DirectChildProcessCall["api"])
      ) {
        changed =
          bindIdentifier(element.name.text, {
            kind: "api",
            api: imported as DirectChildProcessCall["api"],
            invocation: "direct",
          }) || changed;
      } else if (provenance.kind === "util-namespace" && imported === "promisify") {
        changed = bindIdentifier(element.name.text, { kind: "promisify" }) || changed;
      } else if (provenance.kind === "module-namespace" && imported === "createRequire") {
        changed = bindIdentifier(element.name.text, { kind: "create-require" }) || changed;
      }
    }
    return changed;
  };
  const bindAssignmentPattern = (
    pattern: ts.ObjectLiteralExpression,
    provenance: ProcessProvenance | null,
  ): boolean => {
    if (
      !provenance ||
      !["namespace", "util-namespace", "module-namespace"].includes(provenance.kind)
    ) {
      return false;
    }
    let changed = false;
    for (const property of pattern.properties) {
      const imported = propertyNameText(property.name);
      const target =
        ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name)
          ? property.name
          : ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)
            ? property.initializer
            : null;
      if (!imported || !target) continue;
      if (
        provenance.kind === "namespace" &&
        DIRECT_CHILD_PROCESS_APIS.has(imported as DirectChildProcessCall["api"])
      ) {
        changed =
          bindIdentifier(target.text, {
            kind: "api",
            api: imported as DirectChildProcessCall["api"],
            invocation: "direct",
          }) || changed;
      } else if (provenance.kind === "util-namespace" && imported === "promisify") {
        changed = bindIdentifier(target.text, { kind: "promisify" }) || changed;
      } else if (provenance.kind === "module-namespace" && imported === "createRequire") {
        changed = bindIdentifier(target.text, { kind: "create-require" }) || changed;
      }
    }
    return changed;
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      (CHILD_PROCESS_MODULES.has(statement.moduleSpecifier.text) ||
        UTIL_MODULES.has(statement.moduleSpecifier.text) ||
        MODULE_MODULES.has(statement.moduleSpecifier.text))
    ) {
      const isChildProcess = CHILD_PROCESS_MODULES.has(statement.moduleSpecifier.text);
      const isUtil = UTIL_MODULES.has(statement.moduleSpecifier.text);
      const importClause = statement.importClause;
      if (importClause?.isTypeOnly) continue;
      if (importClause?.name) {
        bindIdentifier(importClause.name.text, {
          kind: isChildProcess ? "namespace" : isUtil ? "util-namespace" : "module-namespace",
        });
      }
      const namedBindings = importClause?.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        bindIdentifier(namedBindings.name.text, {
          kind: isChildProcess ? "namespace" : isUtil ? "util-namespace" : "module-namespace",
        });
      }
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const binding of namedBindings.elements) {
          if (binding.isTypeOnly) continue;
          const imported = (binding.propertyName ?? binding.name).text;
          if (
            isChildProcess &&
            DIRECT_CHILD_PROCESS_APIS.has(imported as DirectChildProcessCall["api"])
          ) {
            bindIdentifier(binding.name.text, {
              kind: "api",
              api: imported as DirectChildProcessCall["api"],
              invocation: "direct",
            });
          } else if (isUtil && imported === "promisify") {
            bindIdentifier(binding.name.text, { kind: "promisify" });
          } else if (!isChildProcess && !isUtil && imported === "createRequire") {
            bindIdentifier(binding.name.text, { kind: "create-require" });
          }
        }
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    function inspect(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
        const provenance = expressionProvenance(node.initializer, bindings);
        if (ts.isIdentifier(node.name)) {
          changed = bindIdentifier(node.name.text, provenance) || changed;
        } else if (ts.isObjectBindingPattern(node.name)) {
          changed = bindObjectPattern(node.name, provenance) || changed;
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const provenance = expressionProvenance(node.right, bindings);
        const left = unwrapExpression(node.left);
        if (ts.isIdentifier(left)) {
          changed = bindIdentifier(left.text, provenance) || changed;
        } else if (ts.isObjectLiteralExpression(left)) {
          changed = bindAssignmentPattern(left, provenance) || changed;
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(sourceFile);
  }
  return bindings;
}

function directChildProcessApi(
  expression: ts.LeftHandSideExpression,
  bindings: DirectChildProcessBindings,
): Extract<ProcessProvenance, { kind: "api" }> | null {
  const provenance = expressionProvenance(expression, bindings);
  return provenance?.kind === "api" ? provenance : null;
}

function isChildProcessWrapperCreation(
  node: ts.CallExpression,
  bindings: DirectChildProcessBindings,
): boolean {
  const receiver = memberReceiver(node.expression);
  if (memberName(node.expression) === "bind" && receiver) {
    return expressionProvenance(receiver, bindings)?.kind === "api";
  }
  const callee = expressionProvenance(node.expression, bindings);
  return (
    (callee?.kind === "promisify" &&
      expressionProvenance(node.arguments[0], bindings)?.kind === "api") ||
    callee?.kind === "binder"
  );
}

function objectProperty(
  object: ts.ObjectLiteralExpression | undefined,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  let resolved: ts.ObjectLiteralElementLike | undefined;
  for (const property of object?.properties ?? []) {
    if (
      ts.isSpreadAssignment(property) ||
      (ts.isComputedPropertyName(property.name) &&
        !ts.isStringLiteralLike(property.name.expression))
    ) {
      resolved = undefined;
      continue;
    }
    if (propertyNameText(property.name) === name) resolved = property;
  }
  return resolved;
}

function childProcessOptions(
  node: ts.CallExpression,
  provenance: Extract<ProcessProvenance, { kind: "api" }>,
): ts.ObjectLiteralExpression | undefined {
  // Indirect invocations (`bind`, `call`, `apply`, or `promisify`) can shift or
  // pre-apply arguments. They cannot prove where the options object reaches
  // Node, even if a later argument happens to look safe.
  if (provenance.invocation !== "direct") return undefined;

  const args = [...node.arguments];
  const objectAt = (index: number): ts.ObjectLiteralExpression | undefined => {
    const argument = args[index];
    return argument && ts.isObjectLiteralExpression(argument) ? argument : undefined;
  };
  switch (provenance.api) {
    case "exec":
      if (args.length < 1 || args.length > 3) return undefined;
      return objectAt(1);
    case "execSync":
      if (args.length < 1 || args.length > 2) return undefined;
      return objectAt(1);
    case "execFile":
      if (args.length < 1 || args.length > 4) return undefined;
      if (args.length >= 3 && objectAt(1)) {
        return args.length === 3 && !ts.isObjectLiteralExpression(args[2] as ts.Expression)
          ? objectAt(1)
          : undefined;
      }
      if (args.length >= 3 && objectAt(2)) return objectAt(2);
      return objectAt(1);
    case "execFileSync":
    case "fork":
    case "spawn":
    case "spawnSync":
      if (args.length < 1 || args.length > 3) return undefined;
      if (args.length === 3 && objectAt(1)) return undefined;
      return args.length === 3 ? objectAt(2) : objectAt(1);
  }
}

function numericConstantInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer ?? null;
      }
    }
  }
  return null;
}

function numericExpressionValue(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  seen = new Set<string>(),
): number | null {
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (ts.isParenthesizedExpression(expression)) {
    return numericExpressionValue(expression.expression, sourceFile, seen);
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    const value = numericExpressionValue(expression.operand, sourceFile, seen);
    if (value === null) return null;
    if (expression.operator === ts.SyntaxKind.PlusToken) return value;
    if (expression.operator === ts.SyntaxKind.MinusToken) return -value;
    return null;
  }
  if (ts.isBinaryExpression(expression)) {
    const left = numericExpressionValue(expression.left, sourceFile, seen);
    const right = numericExpressionValue(expression.right, sourceFile, seen);
    if (left === null || right === null) return null;
    if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
    if (expression.operatorToken.kind === ts.SyntaxKind.MinusToken) return left - right;
    if (expression.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
    if (expression.operatorToken.kind === ts.SyntaxKind.SlashToken && right !== 0) {
      return left / right;
    }
    return null;
  }
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = numericExpressionValue(expression.whenTrue, sourceFile, seen);
    const whenFalse = numericExpressionValue(expression.whenFalse, sourceFile, seen);
    return whenTrue === null || whenFalse === null ? null : Math.max(whenTrue, whenFalse);
  }
  if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
    const initializer = numericConstantInitializer(sourceFile, expression.text);
    if (!initializer) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(expression.text);
    return numericExpressionValue(initializer, sourceFile, nextSeen);
  }
  return null;
}

function hasBoundedChildProcessTimeout(
  options: ts.ObjectLiteralExpression | undefined,
  sourceFile: ts.SourceFile,
): boolean {
  const property = objectProperty(options, "timeout");
  if (!property || !ts.isPropertyAssignment(property)) return false;
  const timeoutMs = numericExpressionValue(property.initializer, sourceFile);
  return timeoutMs !== null && timeoutMs > 0 && timeoutMs < MAX_BLOCKING_CHILD_PROCESS_MS;
}

function hasHardChildProcessKillSignal(options: ts.ObjectLiteralExpression | undefined): boolean {
  const property = objectProperty(options, "killSignal");
  return (
    !!property &&
    ts.isPropertyAssignment(property) &&
    ts.isStringLiteralLike(property.initializer) &&
    property.initializer.text === "SIGKILL"
  );
}

function ignoresChildOutput(options: ts.ObjectLiteralExpression | undefined): boolean {
  const property = objectProperty(options, "stdio");
  if (!property || !ts.isPropertyAssignment(property)) return false;
  const value = property.initializer;
  if (ts.isStringLiteralLike(value)) return value.text === "ignore";
  if (!ts.isArrayLiteralExpression(value)) return false;
  const stdout = value.elements[1];
  const stderr = value.elements[2];
  return (
    !!stdout &&
    !!stderr &&
    ts.isStringLiteralLike(stdout) &&
    stdout.text === "ignore" &&
    ts.isStringLiteralLike(stderr) &&
    stderr.text === "ignore"
  );
}

function childProcessObservationScope(node: ts.CallExpression, sourceFile: ts.SourceFile): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== sourceFile) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return sourceFile;
}

function expressionPath(expression: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const receiver = expressionPath(unwrapped.expression);
    return receiver ? `${receiver}.${unwrapped.name.text}` : null;
  }
  return null;
}

function isUnconditionalBoundaryNode(node: ts.Node, scope: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current && current !== scope) {
    if (
      ts.isIfStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isSwitchStatement(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current)
    ) {
      return false;
    }
    if (current !== node && ts.isFunctionLike(current)) return false;
    current = current.parent;
  }
  return current === scope;
}

function assignedIdentifierForCall(node: ts.CallExpression, scope: ts.Node): string | null {
  let current: ts.Node = node;
  while (current.parent && current.parent !== scope) {
    const parent = current.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      return ts.isIdentifier(parent.name) ? parent.name.text : null;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === current
    ) {
      return ts.isIdentifier(parent.left) ? parent.left.text : null;
    }
    if (ts.isStatement(parent) || ts.isFunctionLike(parent)) return null;
    current = parent;
  }
  return null;
}

function childBindingForCall(node: ts.CallExpression, scope: ts.Node): string | null {
  const parent = node.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node &&
    ts.isIdentifier(parent.left) &&
    isUnconditionalBoundaryNode(node, scope)
  ) {
    return parent.left.text;
  }
  return null;
}

function inlineCallback(
  node: ts.Expression | undefined,
): ts.ArrowFunction | ts.FunctionExpression | null {
  return node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) ? node : null;
}

function protectedCallFromStatement(statement: ts.Statement): ts.CallExpression | null {
  if (
    !ts.isTryStatement(statement) ||
    statement.finallyBlock ||
    !statement.catchClause ||
    statement.catchClause.variableDeclaration ||
    statement.catchClause.block.statements.length !== 0 ||
    statement.tryBlock.statements.length !== 1
  ) {
    return null;
  }
  const expressionStatement = statement.tryBlock.statements[0];
  if (!expressionStatement || !ts.isExpressionStatement(expressionStatement)) return null;
  const expression = unwrapExpression(expressionStatement.expression);
  return ts.isCallExpression(expression) ? expression : null;
}

function callbackProtectedCall(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): ts.CallExpression | null {
  if (
    callback.parameters.length !== 0 ||
    !ts.isBlock(callback.body) ||
    callback.body.statements.length !== 1
  ) {
    return null;
  }
  const statement = callback.body.statements[0];
  return statement ? protectedCallFromStatement(statement) : null;
}

function childLifecycleListener(
  call: ts.CallExpression,
  childBinding: string,
  scope: ts.Node,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!isUnconditionalBoundaryNode(call, scope)) return null;
  const expression = call.expression;
  if (!ts.isPropertyAccessExpression(expression)) return null;
  if (!["on", "once", "addListener"].includes(expression.name.text)) return null;
  if (expressionPath(expression.expression) !== childBinding) return null;
  const event = call.arguments[0];
  if (!event || !ts.isStringLiteralLike(event) || event.text !== "close") {
    return null;
  }
  return inlineCallback(call.arguments[1]);
}

function childLaunchErrorListener(
  call: ts.CallExpression,
  childBinding: string,
  scope: ts.Node,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!isUnconditionalBoundaryNode(call, scope)) return null;
  const expression = call.expression;
  if (!ts.isPropertyAccessExpression(expression)) return null;
  if (!["on", "once", "addListener"].includes(expression.name.text)) return null;
  if (expressionPath(expression.expression) !== childBinding) return null;
  const event = call.arguments[0];
  if (!event || !ts.isStringLiteralLike(event) || event.text !== "error") return null;
  return inlineCallback(call.arguments[1]);
}

function childSpawnListener(
  call: ts.CallExpression,
  childBinding: string,
  scope: ts.Node,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!isUnconditionalBoundaryNode(call, scope)) return null;
  const expression = call.expression;
  if (!ts.isPropertyAccessExpression(expression)) return null;
  if (!["on", "once", "addListener"].includes(expression.name.text)) return null;
  if (expressionPath(expression.expression) !== childBinding) return null;
  const event = call.arguments[0];
  if (!event || !ts.isStringLiteralLike(event) || event.text !== "spawn") return null;
  return inlineCallback(call.arguments[1]);
}

function callInvokesIdentifier(
  call: ts.CallExpression | null,
  identifiers: ReadonlySet<string>,
  argument?: string,
): boolean {
  if (!call || !ts.isIdentifier(call.expression) || !identifiers.has(call.expression.text)) {
    return false;
  }
  if (argument === undefined) return call.arguments.length === 0;
  return (
    call.arguments.length === 1 &&
    ts.isStringLiteralLike(call.arguments[0] as ts.Expression) &&
    (call.arguments[0] as ts.StringLiteralLike).text === argument
  );
}

function closeTerminalOutcome(
  expression: ts.Expression,
  codeBinding: string,
  signalBinding: string,
  launchFailedBinding: string,
): boolean {
  const launchFailed = unwrapExpression(expression);
  if (
    !ts.isConditionalExpression(launchFailed) ||
    expressionPath(launchFailed.condition) !== launchFailedBinding ||
    !ts.isStringLiteralLike(launchFailed.whenTrue) ||
    launchFailed.whenTrue.text !== "spawn-failed"
  ) {
    return false;
  }

  const signaled = unwrapExpression(launchFailed.whenFalse);
  if (!ts.isConditionalExpression(signaled)) return false;
  if (
    !ts.isBinaryExpression(signaled.condition) ||
    signaled.condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    expressionPath(signaled.condition.left) !== signalBinding ||
    signaled.condition.right.kind !== ts.SyntaxKind.NullKeyword ||
    !ts.isStringLiteralLike(signaled.whenTrue) ||
    signaled.whenTrue.text !== "signaled"
  ) {
    return false;
  }

  const exitedZero = unwrapExpression(signaled.whenFalse);
  if (
    !ts.isConditionalExpression(exitedZero) ||
    !ts.isBinaryExpression(exitedZero.condition) ||
    exitedZero.condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
    expressionPath(exitedZero.condition.left) !== codeBinding ||
    !ts.isNumericLiteral(exitedZero.condition.right) ||
    exitedZero.condition.right.text !== "0" ||
    !ts.isStringLiteralLike(exitedZero.whenTrue) ||
    exitedZero.whenTrue.text !== "exited-zero"
  ) {
    return false;
  }

  const unknown = unwrapExpression(exitedZero.whenFalse);
  return (
    ts.isConditionalExpression(unknown) &&
    ts.isBinaryExpression(unknown.condition) &&
    unknown.condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    expressionPath(unknown.condition.left) === codeBinding &&
    unknown.condition.right.kind === ts.SyntaxKind.NullKeyword &&
    ts.isStringLiteralLike(unknown.whenTrue) &&
    unknown.whenTrue.text === "closed-unknown" &&
    ts.isStringLiteralLike(unknown.whenFalse) &&
    unknown.whenFalse.text === "exited-nonzero"
  );
}

function closeCallbackEvidence(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  activityHandles: ReadonlySet<string>,
  lifecycleHandles: ReadonlySet<string>,
  launchFailedBinding: string,
): { finishesActivity: boolean; reportsLifecycle: boolean } {
  if (
    callback.parameters.length !== 2 ||
    !ts.isIdentifier(callback.parameters[0]?.name) ||
    !ts.isIdentifier(callback.parameters[1]?.name) ||
    !ts.isBlock(callback.body) ||
    callback.body.statements.length !== 2
  ) {
    return { finishesActivity: false, reportsLifecycle: false };
  }
  const activityCall = protectedCallFromStatement(callback.body.statements[0] as ts.Statement);
  const terminalCall = protectedCallFromStatement(callback.body.statements[1] as ts.Statement);
  return {
    finishesActivity: callInvokesIdentifier(activityCall, activityHandles),
    reportsLifecycle:
      !!terminalCall &&
      ts.isIdentifier(terminalCall.expression) &&
      lifecycleHandles.has(terminalCall.expression.text) &&
      terminalCall.arguments.length === 1 &&
      closeTerminalOutcome(
        terminalCall.arguments[0] as ts.Expression,
        callback.parameters[0].name.text,
        callback.parameters[1].name.text,
        launchFailedBinding,
      ),
  };
}

function spawnConfirmationBinding(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): string | null {
  if (
    callback.parameters.length !== 0 ||
    !ts.isBlock(callback.body) ||
    callback.body.statements.length !== 1
  ) {
    return null;
  }
  const statement = callback.body.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return null;
  const assignment = unwrapExpression(statement.expression);
  return ts.isBinaryExpression(assignment) &&
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(assignment.left) &&
    assignment.right.kind === ts.SyntaxKind.TrueKeyword
    ? assignment.left.text
    : null;
}

function launchFailureBindings(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): { launchFailed: string; spawned: string } | null {
  if (
    callback.parameters.length !== 0 ||
    !ts.isBlock(callback.body) ||
    callback.body.statements.length !== 1
  ) {
    return null;
  }
  const statement = callback.body.statements[0];
  if (
    !statement ||
    !ts.isIfStatement(statement) ||
    statement.elseStatement ||
    !ts.isPrefixUnaryExpression(statement.expression) ||
    statement.expression.operator !== ts.SyntaxKind.ExclamationToken ||
    !ts.isIdentifier(statement.expression.operand)
  ) {
    return null;
  }
  const assignmentStatement = ts.isBlock(statement.thenStatement)
    ? statement.thenStatement.statements.length === 1
      ? statement.thenStatement.statements[0]
      : undefined
    : statement.thenStatement;
  if (!assignmentStatement || !ts.isExpressionStatement(assignmentStatement)) return null;
  const assignment = unwrapExpression(assignmentStatement.expression);
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isIdentifier(assignment.left) ||
    assignment.right.kind !== ts.SyntaxKind.TrueKeyword
  ) {
    return null;
  }
  return {
    launchFailed: assignment.left.text,
    spawned: statement.expression.operand.text,
  };
}

function hasSingleFalseBooleanBinding(scope: ts.Node, binding: string): boolean {
  let declarations = 0;
  function inspect(node: ts.Node): void {
    if (node !== scope && ts.isFunctionLike(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === binding &&
      node.initializer?.kind === ts.SyntaxKind.FalseKeyword
    ) {
      declarations += 1;
    }
    ts.forEachChild(node, inspect);
  }
  inspect(scope);
  return declarations === 1;
}

function syncSpawnFailureEvidence(
  node: ts.CallExpression,
  activityHandles: ReadonlySet<string>,
  lifecycleHandles: ReadonlySet<string>,
): { finishesActivity: boolean; reportsLifecycle: boolean } {
  let current: ts.Node | undefined = node;
  while (current && !ts.isTryStatement(current)) current = current.parent;
  const catchClause = current && ts.isTryStatement(current) ? current.catchClause : undefined;
  const catchBinding = catchClause?.variableDeclaration?.name;
  const statements = catchClause?.block.statements;
  if (
    !catchClause ||
    !catchBinding ||
    !ts.isIdentifier(catchBinding) ||
    !statements ||
    statements.length !== 3
  ) {
    return { finishesActivity: false, reportsLifecycle: false };
  }
  const activityCall = protectedCallFromStatement(statements[0] as ts.Statement);
  const lifecycleCall = protectedCallFromStatement(statements[1] as ts.Statement);
  const thrown = statements[2];
  if (
    !thrown ||
    !ts.isThrowStatement(thrown) ||
    !thrown.expression ||
    expressionPath(thrown.expression) !== catchBinding.text
  ) {
    return { finishesActivity: false, reportsLifecycle: false };
  }
  return {
    finishesActivity: callInvokesIdentifier(activityCall, activityHandles),
    reportsLifecycle: callInvokesIdentifier(lifecycleCall, lifecycleHandles, "spawn-failed"),
  };
}

function exactTimestampOutputCall(node: ts.CallExpression, stream: "stdout" | "stderr"): boolean {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "onOutput" ||
    expressionPath(node.expression.expression) !== "options.progress"
  ) {
    return false;
  }
  const event = node.arguments[0];
  if (!event || !ts.isObjectLiteralExpression(event) || event.properties.length !== 2) return false;
  const streamProperty = objectProperty(event, "stream");
  const atMsProperty = objectProperty(event, "atMs");
  if (
    !streamProperty ||
    !ts.isPropertyAssignment(streamProperty) ||
    !ts.isStringLiteralLike(streamProperty.initializer) ||
    streamProperty.initializer.text !== stream ||
    !atMsProperty ||
    !ts.isPropertyAssignment(atMsProperty) ||
    !ts.isCallExpression(atMsProperty.initializer) ||
    atMsProperty.initializer.arguments.length !== 0 ||
    !ts.isPropertyAccessExpression(atMsProperty.initializer.expression) ||
    expressionPath(atMsProperty.initializer.expression.expression) !== "Date" ||
    atMsProperty.initializer.expression.name.text !== "now"
  ) {
    return false;
  }
  return true;
}

function callbackReportsExactOutput(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stream: "stdout" | "stderr",
): boolean {
  const call = callbackProtectedCall(callback);
  return !!call && exactTimestampOutputCall(call, stream);
}

function childOutputListener(
  call: ts.CallExpression,
  childBinding: string,
  stream: "stdout" | "stderr",
  scope: ts.Node,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!isUnconditionalBoundaryNode(call, scope)) return null;
  const expression = call.expression;
  if (
    !ts.isPropertyAccessExpression(expression) ||
    !["addListener", "on", "once", "prependListener", "prependOnceListener"].includes(
      expression.name.text,
    )
  ) {
    return null;
  }
  if (expressionPath(expression.expression) !== `${childBinding}.${stream}`) return null;
  const event = call.arguments[0];
  if (!event || !ts.isStringLiteralLike(event) || event.text !== "data") return null;
  return inlineCallback(call.arguments[1]);
}

function observedChildProcessEvidence(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
): { observesOutput: boolean; tracksActivity: boolean; tracksLifecycle: boolean } {
  const scope = childProcessObservationScope(node, sourceFile);
  const childBinding = childBindingForCall(node, scope);
  if (!childBinding || !isUnconditionalBoundaryNode(node, scope)) {
    return { observesOutput: false, tracksActivity: false, tracksLifecycle: false };
  }
  const observedChildBinding = childBinding;
  const activityHandles = new Set<string>();
  const lifecycleHandles = new Set<string>();
  let closeListeners = 0;
  let validActivityCloseListeners = 0;
  let validLifecycleCloseListeners = 0;
  let spawnListeners = 0;
  let validSpawnListeners = 0;
  let errorListeners = 0;
  let validLaunchFailureListeners = 0;
  let spawnedBinding: string | null = null;
  let launchFailedBinding: string | null = null;
  let childBindingReassigned = false;
  let activityHandleReassigned = false;
  let lifecycleHandleReassigned = false;
  let unsafeChildOperation = false;
  const outputListeners = new Map<"stdout" | "stderr", number>([
    ["stdout", 0],
    ["stderr", 0],
  ]);
  const validOutputListeners = new Map<"stdout" | "stderr", number>([
    ["stdout", 0],
    ["stderr", 0],
  ]);
  let unsafeOutputOperation = false;

  function inspect(candidate: ts.Node): void {
    if (candidate !== scope && ts.isFunctionLike(candidate)) return;
    if (
      candidate.getStart(sourceFile) > node.getStart(sourceFile) &&
      ts.isBinaryExpression(candidate) &&
      candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(candidate.left)
    ) {
      if (candidate.left.text === observedChildBinding) childBindingReassigned = true;
      if (activityHandles.has(candidate.left.text)) activityHandleReassigned = true;
      if (lifecycleHandles.has(candidate.left.text)) lifecycleHandleReassigned = true;
    }
    if (
      candidate.getStart(sourceFile) > node.getStart(sourceFile) &&
      ts.isVariableDeclaration(candidate) &&
      candidate.initializer &&
      [
        observedChildBinding,
        `${observedChildBinding}.stdout`,
        `${observedChildBinding}.stderr`,
      ].includes(expressionPath(candidate.initializer) ?? "")
    ) {
      unsafeChildOperation = true;
    }
    if (ts.isCallExpression(candidate)) {
      if (
        candidate.getStart(sourceFile) < node.getStart(sourceFile) &&
        isUnconditionalBoundaryNode(candidate, scope) &&
        ts.isPropertyAccessExpression(candidate.expression) &&
        candidate.expression.name.text === "activity" &&
        expressionPath(candidate.expression.expression) === "options.progress"
      ) {
        const handle = assignedIdentifierForCall(candidate, scope);
        if (handle) activityHandles.add(handle);
      }
      if (
        candidate.getStart(sourceFile) < node.getStart(sourceFile) &&
        isUnconditionalBoundaryNode(candidate, scope) &&
        candidate.arguments.length === 0 &&
        expressionPath(candidate.expression) === "options.progress.beginChildLifecycle"
      ) {
        const handle = assignedIdentifierForCall(candidate, scope);
        if (handle) lifecycleHandles.add(handle);
      }
      if (candidate.getStart(sourceFile) > node.getStart(sourceFile)) {
        const spawnListener = childSpawnListener(candidate, observedChildBinding, scope);
        if (spawnListener) {
          spawnListeners += 1;
          const binding = spawnConfirmationBinding(spawnListener);
          if (binding) {
            validSpawnListeners += 1;
            spawnedBinding = binding;
          }
        }
        const errorListener = childLaunchErrorListener(candidate, observedChildBinding, scope);
        if (errorListener) {
          errorListeners += 1;
          const bindings = launchFailureBindings(errorListener);
          if (bindings && bindings.spawned === spawnedBinding) {
            validLaunchFailureListeners += 1;
            launchFailedBinding = bindings.launchFailed;
          }
        }
        const closeListener = childLifecycleListener(candidate, observedChildBinding, scope);
        if (closeListener) {
          closeListeners += 1;
          const evidence = launchFailedBinding
            ? closeCallbackEvidence(
                closeListener,
                activityHandles,
                lifecycleHandles,
                launchFailedBinding,
              )
            : { finishesActivity: false, reportsLifecycle: false };
          if (evidence.finishesActivity) validActivityCloseListeners += 1;
          if (evidence.reportsLifecycle) validLifecycleCloseListeners += 1;
        }
        for (const stream of ["stdout", "stderr"] as const) {
          const callback = childOutputListener(candidate, observedChildBinding, stream, scope);
          if (callback) {
            outputListeners.set(stream, (outputListeners.get(stream) ?? 0) + 1);
            if (callbackReportsExactOutput(callback, stream)) {
              validOutputListeners.set(stream, (validOutputListeners.get(stream) ?? 0) + 1);
            }
          } else {
            const callPath = expressionPath(candidate.expression);
            if (callPath?.startsWith(`${observedChildBinding}.${stream}.`)) {
              unsafeOutputOperation = true;
            }
            if (
              candidate.arguments.some(
                (argument) => expressionPath(argument) === `${observedChildBinding}.${stream}`,
              )
            ) {
              unsafeOutputOperation = true;
            }
          }
        }
        const callPath = expressionPath(candidate.expression);
        if (
          callPath?.startsWith(`${observedChildBinding}.`) &&
          !closeListener &&
          !errorListener &&
          !spawnListener &&
          !(["stdout", "stderr"] as const).some((stream) =>
            childOutputListener(candidate, observedChildBinding, stream, scope),
          )
        ) {
          unsafeChildOperation = true;
        }
      }
    }
    ts.forEachChild(candidate, inspect);
  }
  inspect(scope);
  const synchronousFailure = syncSpawnFailureEvidence(node, activityHandles, lifecycleHandles);
  return {
    observesOutput:
      !childBindingReassigned &&
      !unsafeChildOperation &&
      !unsafeOutputOperation &&
      (["stdout", "stderr"] as const).every(
        (stream) => outputListeners.get(stream) === 1 && validOutputListeners.get(stream) === 1,
      ),
    tracksActivity:
      !childBindingReassigned &&
      !activityHandleReassigned &&
      !unsafeChildOperation &&
      activityHandles.size === 1 &&
      closeListeners === 1 &&
      validActivityCloseListeners === 1 &&
      synchronousFailure.finishesActivity,
    tracksLifecycle:
      !childBindingReassigned &&
      !lifecycleHandleReassigned &&
      !unsafeChildOperation &&
      lifecycleHandles.size === 1 &&
      spawnListeners === 1 &&
      validSpawnListeners === 1 &&
      !!spawnedBinding &&
      hasSingleFalseBooleanBinding(scope, spawnedBinding) &&
      closeListeners === 1 &&
      validLifecycleCloseListeners === 1 &&
      errorListeners === 1 &&
      validLaunchFailureListeners === 1 &&
      !!launchFailedBinding &&
      hasSingleFalseBooleanBinding(scope, launchFailedBinding) &&
      synchronousFailure.reportsLifecycle,
  };
}

function childProcessBoundaryName(node: ts.CallExpression, sourceFile: ts.SourceFile): string {
  const scope = childProcessObservationScope(node, sourceFile);
  if (
    (ts.isFunctionDeclaration(scope) ||
      ts.isFunctionExpression(scope) ||
      ts.isMethodDeclaration(scope)) &&
    scope.name
  ) {
    return propertyNameText(scope.name) ?? "<anonymous>";
  }
  if (
    (ts.isArrowFunction(scope) || ts.isFunctionExpression(scope)) &&
    ts.isVariableDeclaration(scope.parent) &&
    ts.isIdentifier(scope.parent.name)
  ) {
    return scope.parent.name.text;
  }
  return "<anonymous>";
}

interface ObservedChildProcessBindings {
  calls: Set<string>;
  namespaces: Set<string>;
}

function observedChildProcessBindings(
  file: string,
  sourceFile: ts.SourceFile,
): ObservedChildProcessBindings {
  const bindings: ObservedChildProcessBindings = { calls: new Set(), namespaces: new Set() };
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      resolveE2EImport(file, statement.moduleSpecifier.text) !== OBSERVED_CHILD_PROCESS_MODULE ||
      statement.importClause?.isTypeOnly
    ) {
      continue;
    }
    const namedBindings = statement.importClause?.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      bindings.namespaces.add(namedBindings.name.text);
    }
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        if (
          !element.isTypeOnly &&
          (element.propertyName ?? element.name).text === "spawnObservedChild"
        ) {
          bindings.calls.add(element.name.text);
        }
      }
    }
  }

  const isObservedNamespaceReference = (expression: ts.Expression | undefined): boolean => {
    if (!expression) return false;
    const unwrapped = unwrapExpression(expression);
    return ts.isIdentifier(unwrapped) && bindings.namespaces.has(unwrapped.text);
  };
  const isObservedCallReference = (expression: ts.Expression | undefined): boolean => {
    if (!expression) return false;
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) return bindings.calls.has(unwrapped.text);
    if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) {
      return false;
    }
    const receiver = unwrapExpression(unwrapped.expression);
    return (
      ts.isIdentifier(receiver) &&
      bindings.namespaces.has(receiver.text) &&
      memberName(unwrapped) === "spawnObservedChild"
    );
  };

  let changed = true;
  while (changed) {
    changed = false;
    function inspect(node: ts.Node): void {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        isObservedNamespaceReference(node.initializer) &&
        !bindings.namespaces.has(node.name.text)
      ) {
        bindings.namespaces.add(node.name.text);
        changed = true;
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        isObservedNamespaceReference(node.initializer)
      ) {
        for (const element of node.name.elements) {
          const imported =
            propertyNameText(element.propertyName) ??
            (ts.isIdentifier(element.name) ? element.name.text : undefined);
          if (
            imported === "spawnObservedChild" &&
            ts.isIdentifier(element.name) &&
            !bindings.calls.has(element.name.text)
          ) {
            bindings.calls.add(element.name.text);
            changed = true;
          }
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        isObservedCallReference(node.initializer) &&
        !bindings.calls.has(node.name.text)
      ) {
        bindings.calls.add(node.name.text);
        changed = true;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        isObservedNamespaceReference(node.right) &&
        !bindings.namespaces.has(node.left.text)
      ) {
        bindings.namespaces.add(node.left.text);
        changed = true;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        isObservedCallReference(node.right) &&
        !bindings.calls.has(node.left.text)
      ) {
        bindings.calls.add(node.left.text);
        changed = true;
      }
      ts.forEachChild(node, inspect);
    }
    inspect(sourceFile);
  }
  return bindings;
}

function observedChildReference(
  expression: ts.Expression,
  bindings: ObservedChildProcessBindings,
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return bindings.calls.has(unwrapped.text);
  if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) {
    return false;
  }
  const receiver = unwrapExpression(unwrapped.expression);
  return (
    ts.isIdentifier(receiver) &&
    bindings.namespaces.has(receiver.text) &&
    memberName(unwrapped) === "spawnObservedChild"
  );
}

function auditObservedChildProcessCall(
  node: ts.CallExpression,
  file: string,
  sourceFile: ts.SourceFile,
  reportUnsupported: (node: ts.Node, message: string) => void,
): void {
  const relativeFile = path.relative(REPO_ROOT, file).split(path.sep).join("/");
  const boundary = childProcessBoundaryName(node, sourceFile);
  const boundaryId = `${relativeFile}#${boundary}`;
  const policy = OBSERVED_CHILD_PROGRESS_POLICIES.get(boundaryId);
  if (!policy) {
    reportUnsupported(
      node,
      `spawnObservedChild must use a reviewed progress-capability callsite (found ${boundary})`,
    );
    return;
  }
  if (node.arguments.length !== 3) {
    reportUnsupported(node, "spawnObservedChild must use its exact three-argument overload");
    return;
  }
  const options = node.arguments[2];
  if (!options || !ts.isObjectLiteralExpression(options)) {
    reportUnsupported(node, "spawnObservedChild options must be a reviewable object literal");
    return;
  }
  const progress = objectProperty(options, "progress");
  if (!progress) {
    reportUnsupported(node, "spawnObservedChild must receive the reviewed TestProgress capability");
    return;
  }
  const validProgress =
    (ts.isPropertyAssignment(progress) && expressionPath(progress.initializer) === policy.path) ||
    (ts.isShorthandPropertyAssignment(progress) && progress.name.text === policy.path);
  if (!validProgress) {
    reportUnsupported(
      progress,
      "spawnObservedChild progress must retain the reviewed TestProgress capability",
    );
  }
}

function interfaceExtends(node: ts.InterfaceDeclaration, name: string): boolean {
  return (node.heritageClauses ?? []).some((clause) =>
    clause.types.some((type) => ts.isIdentifier(type.expression) && type.expression.text === name),
  );
}

function compactSource(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/gu, "");
}

function auditTestProgressCapabilityContract(
  file: string,
  sourceFile: ts.SourceFile,
  reportUnsupported: (node: ts.Node, message: string) => void,
): void {
  if (file === TEST_PROGRESS_MODULE) {
    const capabilityStatement = sourceFile.statements.find(
      (statement): statement is ts.VariableStatement =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (declaration) =>
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === "TEST_PROGRESS_CAPABILITY",
        ),
    );
    const capabilityDeclaration = capabilityStatement?.declarationList.declarations.find(
      (declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === "TEST_PROGRESS_CAPABILITY",
    );
    const privateUniqueSymbol =
      !!capabilityStatement &&
      !(capabilityStatement.modifiers ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) &&
      !!capabilityDeclaration?.type &&
      ts.isTypeOperatorNode(capabilityDeclaration.type) &&
      capabilityDeclaration.type.operator === ts.SyntaxKind.UniqueKeyword &&
      !!capabilityDeclaration.initializer &&
      ts.isCallExpression(capabilityDeclaration.initializer) &&
      ts.isIdentifier(capabilityDeclaration.initializer.expression) &&
      capabilityDeclaration.initializer.expression.text === "Symbol";
    if (!privateUniqueSymbol) {
      reportUnsupported(
        capabilityStatement ?? sourceFile,
        "TestProgress capability must be backed by a module-private unique symbol",
      );
    }

    const instancesStatement = sourceFile.statements.find(
      (statement): statement is ts.VariableStatement =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (declaration) =>
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === "TEST_PROGRESS_INSTANCES",
        ),
    );
    const instancesDeclaration = instancesStatement?.declarationList.declarations.find(
      (declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === "TEST_PROGRESS_INSTANCES",
    );
    if (
      !instancesStatement ||
      (instancesStatement.modifiers ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) ||
      !instancesDeclaration?.initializer ||
      !ts.isNewExpression(instancesDeclaration.initializer) ||
      !ts.isIdentifier(instancesDeclaration.initializer.expression) ||
      instancesDeclaration.initializer.expression.text !== "WeakSet"
    ) {
      reportUnsupported(
        instancesStatement ?? sourceFile,
        "TestProgress instances must be registered in a module-private WeakSet",
      );
    }

    const capabilityInterface = sourceFile.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === "TestProgressCapability",
    );
    const brandMember = capabilityInterface?.members.find(
      (member): member is ts.PropertySignature =>
        ts.isPropertySignature(member) &&
        !!member.name &&
        ts.isComputedPropertyName(member.name) &&
        ts.isIdentifier(member.name.expression) &&
        member.name.expression.text === "TEST_PROGRESS_CAPABILITY",
    );
    if (
      !brandMember ||
      capabilityInterface?.members.length !== 1 ||
      !(brandMember.modifiers ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
      ) ||
      !brandMember.type ||
      brandMember.type.kind !== ts.SyntaxKind.LiteralType ||
      !ts.isLiteralTypeNode(brandMember.type) ||
      brandMember.type.literal.kind !== ts.SyntaxKind.TrueKeyword
    ) {
      reportUnsupported(
        capabilityInterface ?? sourceFile,
        "TestProgressCapability must expose only the private readonly true brand",
      );
    }

    const capabilityValidator = sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "isTestProgressCapability",
    );
    const expectedValidatorBody =
      '{if(typeofvalue!=="object"||value===null||!TEST_PROGRESS_INSTANCES.has(value)){returnfalse;}constdescriptor=Object.getOwnPropertyDescriptor(value,TEST_PROGRESS_CAPABILITY);return(Object.isFrozen(value)&&descriptor?.value===true&&descriptor.enumerable===false&&descriptor.configurable===false&&descriptor.writable===false);}';
    if (
      !capabilityValidator?.body ||
      compactSource(capabilityValidator.body, sourceFile) !== expectedValidatorBody
    ) {
      reportUnsupported(
        capabilityValidator ?? sourceFile,
        "isTestProgressCapability must exactly validate the private registry, own brand, and frozen object",
      );
    }

    const progressInterface = sourceFile.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === "TestProgress",
    );
    if (!progressInterface || !interfaceExtends(progressInterface, "TestProgressCapability")) {
      reportUnsupported(
        progressInterface ?? sourceFile,
        "TestProgress must retain the private progress capability",
      );
    }
    const childLifecycleMember = progressInterface?.members.find(
      (member) => propertyNameText(member.name) === "beginChildLifecycle",
    );
    const validChildLifecycleMember =
      !!childLifecycleMember &&
      ts.isPropertySignature(childLifecycleMember) &&
      !childLifecycleMember.questionToken &&
      !!childLifecycleMember.type &&
      ts.isFunctionTypeNode(childLifecycleMember.type) &&
      childLifecycleMember.type.parameters.length === 0 &&
      ts.isTypeReferenceNode(childLifecycleMember.type.type) &&
      ts.isIdentifier(childLifecycleMember.type.type.typeName) &&
      childLifecycleMember.type.type.typeName.text === "ChildLifecycleTerminalReporter";
    if (!validChildLifecycleMember) {
      reportUnsupported(
        childLifecycleMember ?? progressInterface ?? sourceFile,
        "TestProgress must expose the non-optional zero-argument child lifecycle capability",
      );
    }

    const outcomeType = sourceFile.statements.find(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === "ChildLifecycleOutcome",
    );
    const lifecycleOutcomes =
      outcomeType && ts.isUnionTypeNode(outcomeType.type)
        ? outcomeType.type.types
            .filter(
              (type): type is ts.LiteralTypeNode =>
                ts.isLiteralTypeNode(type) && ts.isStringLiteralLike(type.literal),
            )
            .map((type) => (type.literal as ts.StringLiteralLike).text)
            .sort()
        : [];
    const expectedLifecycleOutcomes = [
      "closed-unknown",
      "exited-nonzero",
      "exited-zero",
      "signaled",
      "spawn-failed",
    ];
    if (
      !outcomeType ||
      !ts.isUnionTypeNode(outcomeType.type) ||
      outcomeType.type.types.length !== expectedLifecycleOutcomes.length ||
      JSON.stringify(lifecycleOutcomes) !== JSON.stringify(expectedLifecycleOutcomes)
    ) {
      reportUnsupported(
        outcomeType ?? sourceFile,
        "ChildLifecycleOutcome must remain the fixed content-free terminal vocabulary",
      );
    }

    const reporterType = sourceFile.statements.find(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) &&
        statement.name.text === "ChildLifecycleTerminalReporter",
    );
    const validReporterType =
      !!reporterType &&
      ts.isFunctionTypeNode(reporterType.type) &&
      reporterType.type.parameters.length === 1 &&
      !!reporterType.type.parameters[0]?.type &&
      ts.isTypeReferenceNode(reporterType.type.parameters[0].type) &&
      ts.isIdentifier(reporterType.type.parameters[0].type.typeName) &&
      reporterType.type.parameters[0].type.typeName.text === "ChildLifecycleOutcome" &&
      reporterType.type.type.kind === ts.SyntaxKind.VoidKeyword;
    if (!validReporterType) {
      reportUnsupported(
        reporterType ?? sourceFile,
        "ChildLifecycleTerminalReporter must accept only one fixed lifecycle outcome",
      );
    }

    const factory = sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "startTestProgress",
    );
    let initializesBrand = false;
    let childLifecycleImplementation: ts.MethodDeclaration | undefined;
    if (factory) {
      function inspectFactory(node: ts.Node): void {
        if (
          ts.isPropertyAssignment(node) &&
          ts.isComputedPropertyName(node.name) &&
          ts.isIdentifier(node.name.expression) &&
          node.name.expression.text === "TEST_PROGRESS_CAPABILITY" &&
          node.initializer.kind === ts.SyntaxKind.TrueKeyword
        ) {
          initializesBrand = true;
        }
        if (ts.isMethodDeclaration(node) && propertyNameText(node.name) === "beginChildLifecycle") {
          childLifecycleImplementation = node;
        }
        ts.forEachChild(node, inspectFactory);
      }
      inspectFactory(factory);
    }
    const factoryStatements = factory?.body?.statements ?? [];
    const factoryTail = factoryStatements
      .slice(-3)
      .map((statement) => compactSource(statement, sourceFile));
    const expectedFactoryTail = [
      "Object.defineProperty(progress,TEST_PROGRESS_CAPABILITY,{configurable:false,enumerable:false,value:true,writable:false,});",
      "TEST_PROGRESS_INSTANCES.add(progress);",
      "returnObject.freeze(progress);",
    ];
    if (
      !factory ||
      !initializesBrand ||
      JSON.stringify(factoryTail) !== JSON.stringify(expectedFactoryTail)
    ) {
      reportUnsupported(
        factory ?? sourceFile,
        "startTestProgress must privately brand, register, and freeze the canonical capability",
      );
    }
    let frozenLifecycleReporterReturns = 0;
    let logsSynchronousLifecycleStart = false;
    let hasIdempotentLifecycleTerminal = false;
    if (childLifecycleImplementation) {
      function inspectChildLifecycle(node: ts.Node): void {
        if (node !== childLifecycleImplementation && ts.isFunctionLike(node)) return;
        if (
          ts.isReturnStatement(node) &&
          node.expression &&
          ts.isCallExpression(node.expression) &&
          expressionPath(node.expression.expression) === "Object.freeze" &&
          node.expression.arguments.length === 1
        ) {
          frozenLifecycleReporterReturns += 1;
        }
        if (
          ts.isCallExpression(node) &&
          expressionPath(node.expression) === "logChildLifecycleBestEffort" &&
          node.arguments.length === 2 &&
          ts.isStringLiteralLike(node.arguments[1] as ts.Expression) &&
          (node.arguments[1] as ts.StringLiteralLike).text === "started"
        ) {
          logsSynchronousLifecycleStart = true;
        }
        ts.forEachChild(node, inspectChildLifecycle);
      }
      inspectChildLifecycle(childLifecycleImplementation);

      const methodStatements = childLifecycleImplementation.body?.statements ?? [];
      const methodDeclarations: ts.VariableDeclaration[] = [];
      for (const statement of methodStatements) {
        if (ts.isVariableStatement(statement)) {
          methodDeclarations.push(...statement.declarationList.declarations);
        }
      }
      const terminalFlag = methodDeclarations.find(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.initializer?.kind === ts.SyntaxKind.FalseKeyword,
      );
      const terminalReporter = methodDeclarations.find(
        (declaration) => declaration.initializer && ts.isArrowFunction(declaration.initializer),
      );
      const terminalFlagName =
        terminalFlag && ts.isIdentifier(terminalFlag.name) ? terminalFlag.name.text : null;
      if (
        terminalFlagName &&
        terminalReporter?.initializer &&
        ts.isArrowFunction(terminalReporter.initializer) &&
        ts.isBlock(terminalReporter.initializer.body)
      ) {
        const reporterStatements: readonly ts.Statement[] =
          terminalReporter.initializer.body.statements;
        const guard = reporterStatements[0];
        const assignments = reporterStatements.filter(
          (statement) =>
            ts.isExpressionStatement(statement) &&
            ts.isBinaryExpression(statement.expression) &&
            statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            expressionPath(statement.expression.left) === terminalFlagName &&
            statement.expression.right.kind === ts.SyntaxKind.TrueKeyword,
        );
        hasIdempotentLifecycleTerminal =
          !!guard &&
          ts.isIfStatement(guard) &&
          expressionPath(guard.expression) === terminalFlagName &&
          ts.isReturnStatement(guard.thenStatement) &&
          !guard.thenStatement.expression &&
          assignments.length === 1;
      }
    }
    if (
      !childLifecycleImplementation ||
      childLifecycleImplementation.parameters.length !== 0 ||
      frozenLifecycleReporterReturns !== 2 ||
      !logsSynchronousLifecycleStart ||
      !hasIdempotentLifecycleTerminal
    ) {
      reportUnsupported(
        childLifecycleImplementation ?? factory ?? sourceFile,
        "startTestProgress must synchronously start and freeze idempotent child lifecycle reporters",
      );
    }
  }

  if (file === OBSERVED_CHILD_PROCESS_MODULE) {
    const childProgress = sourceFile.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === "ChildProcessProgress",
    );
    const outputMember = childProgress?.members.find(
      (member) =>
        (ts.isMethodSignature(member) || ts.isPropertySignature(member)) &&
        propertyNameText(member.name) === "onOutput",
    );
    if (!childProgress || !interfaceExtends(childProgress, "TestProgressCapability")) {
      reportUnsupported(
        childProgress ?? sourceFile,
        "ChildProcessProgress must require the private TestProgress capability",
      );
    }
    if (!outputMember || outputMember.questionToken) {
      reportUnsupported(
        childProgress ?? sourceFile,
        "ChildProcessProgress must require timestamp-only output observation",
      );
    }
    const boundary = sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "spawnObservedChild",
    );
    const guard = boundary?.body?.statements[0];
    const validGuard =
      !!guard &&
      ts.isIfStatement(guard) &&
      ts.isPrefixUnaryExpression(guard.expression) &&
      guard.expression.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isCallExpression(guard.expression.operand) &&
      ts.isIdentifier(guard.expression.operand.expression) &&
      guard.expression.operand.expression.text === "isTestProgressCapability" &&
      guard.expression.operand.arguments.length === 1 &&
      expressionPath(guard.expression.operand.arguments[0] as ts.Expression) ===
        "options.progress" &&
      ts.isBlock(guard.thenStatement) &&
      guard.thenStatement.statements.length === 1 &&
      ts.isThrowStatement(guard.thenStatement.statements[0]);
    if (!validGuard) {
      reportUnsupported(
        boundary ?? sourceFile,
        "spawnObservedChild must reject non-canonical progress before spawning",
      );
    }
  }
}

function collectDirectChildProcessCalls(
  file: string,
  sourceFile: ts.SourceFile,
  auditFailures: string[],
): DirectChildProcessCall[] {
  const bindings = directChildProcessBindings(sourceFile);
  const observedBindings = observedChildProcessBindings(file, sourceFile);
  const calls: DirectChildProcessCall[] = [];
  const relativeFile = path.relative(REPO_ROOT, file).split(path.sep).join("/");
  const reportUnsupported = (node: ts.Node, message: string): void => {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    auditFailures.push(`${relativeFile}:${location.line + 1}: ${message}`);
  };
  const isEscapingProcessCapability = (provenance: ProcessProvenance | null): boolean =>
    !!provenance &&
    [
      "api",
      "binder",
      "builtin-loader",
      "create-require",
      "namespace",
      "promisify",
      "require",
      "module-namespace",
    ].includes(provenance.kind);
  auditTestProgressCapabilityContract(file, sourceFile, reportUnsupported);

  function auditStoredCapability(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      !(
        ts.isObjectLiteralExpression(node.parent) &&
        ts.isBinaryExpression(node.parent.parent) &&
        node.parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.parent.parent.left === node.parent
      )
    ) {
      const provenance = expressionProvenance(node.initializer, bindings);
      if (isEscapingProcessCapability(provenance)) {
        reportUnsupported(node, "child-process APIs must not be stored in object properties");
      }
      if (observedChildReference(node.initializer, observedBindings)) {
        reportUnsupported(node, "spawnObservedChild must not be stored in object properties");
      }
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      const provenance = expressionProvenance(node.name, bindings);
      if (isEscapingProcessCapability(provenance)) {
        reportUnsupported(node, "child-process APIs must not be stored in object properties");
      }
      if (observedChildReference(node.name, observedBindings)) {
        reportUnsupported(node, "spawnObservedChild must not be stored in object properties");
      }
    }
    if (ts.isSpreadAssignment(node)) {
      const provenance = expressionProvenance(node.expression, bindings);
      if (isEscapingProcessCapability(provenance)) {
        reportUnsupported(node, "child-process APIs must not be spread into object properties");
      }
      if (observedChildReference(node.expression, observedBindings)) {
        reportUnsupported(node, "spawnObservedChild must not be spread into object properties");
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (!ts.isExpression(element)) continue;
        const provenance = expressionProvenance(element, bindings);
        if (isEscapingProcessCapability(provenance)) {
          reportUnsupported(element, "child-process APIs must not be stored in array elements");
        }
        if (observedChildReference(element, observedBindings)) {
          reportUnsupported(element, "spawnObservedChild must not be stored in array elements");
        }
      }
    }
    if (ts.isParameter(node)) {
      const provenance = expressionProvenance(node.initializer, bindings);
      if (isEscapingProcessCapability(provenance)) {
        reportUnsupported(node, "child-process APIs must not be stored in parameter defaults");
      }
      if (node.initializer && observedChildReference(node.initializer, observedBindings)) {
        reportUnsupported(node, "spawnObservedChild must not be stored in parameter defaults");
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    ) {
      const provenance = expressionProvenance(node.right, bindings);
      if (isEscapingProcessCapability(provenance)) {
        reportUnsupported(node, "child-process APIs must not be stored in object properties");
      }
      if (observedChildReference(node.right, observedBindings)) {
        reportUnsupported(node, "spawnObservedChild must not be stored in object properties");
      }
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        if (CHILD_PROCESS_MODULES.has(node.moduleSpecifier.text)) {
          reportUnsupported(node, "child-process APIs must not be re-exported");
        }
        if (resolveE2EImport(file, node.moduleSpecifier.text) === OBSERVED_CHILD_PROCESS_MODULE) {
          reportUnsupported(node, "spawnObservedChild must not be re-exported");
        }
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const provenance = expressionProvenance(element.propertyName ?? element.name, bindings);
          if (isEscapingProcessCapability(provenance)) {
            reportUnsupported(element, "child-process APIs must not be exported");
          }
          if (observedChildReference(element.propertyName ?? element.name, observedBindings)) {
            reportUnsupported(element, "spawnObservedChild must not be exported");
          }
        }
      }
    }
  }

  function inspect(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (observedChildReference(node.expression, observedBindings)) {
        auditObservedChildProcessCall(node, file, sourceFile, reportUnsupported);
      }
      const apiProvenance = directChildProcessApi(node.expression, bindings);
      if (apiProvenance && !isChildProcessWrapperCreation(node, bindings)) {
        const options = childProcessOptions(node, apiProvenance);
        const boundary = childProcessBoundaryName(node, sourceFile);
        const boundaryId = `${relativeFile}#${boundary}`;
        const evidence =
          boundaryId === AUDITED_ASYNC_CHILD_PROCESS_BOUNDARY
            ? observedChildProcessEvidence(node, sourceFile)
            : { observesOutput: false, tracksActivity: false, tracksLifecycle: false };
        const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        calls.push({
          api: apiProvenance.api,
          boundary,
          file: relativeFile,
          hasBoundedTimeout: hasBoundedChildProcessTimeout(options, sourceFile),
          hasHardKillSignal: hasHardChildProcessKillSignal(options),
          line: location.line + 1,
          observesOutput: evidence.observesOutput,
          outputIgnored: ignoresChildOutput(options),
          tracksActivity: evidence.tracksActivity,
          tracksLifecycle: evidence.tracksLifecycle,
        });
      }
      const wrapperCreation = isChildProcessWrapperCreation(node, bindings);
      if (!wrapperCreation) {
        for (const argument of node.arguments) {
          const provenance = expressionProvenance(argument, bindings);
          if (isEscapingProcessCapability(provenance)) {
            reportUnsupported(
              argument,
              "child-process APIs must not be passed to an unaudited higher-order function",
            );
          }
          if (observedChildReference(argument, observedBindings)) {
            reportUnsupported(
              argument,
              "spawnObservedChild must not be passed to an unaudited higher-order function",
            );
          }
        }
      }
    }
    if (ts.isNewExpression(node)) {
      for (const argument of node.arguments ?? []) {
        const provenance = expressionProvenance(argument, bindings);
        if (isEscapingProcessCapability(provenance)) {
          reportUnsupported(
            argument,
            "child-process APIs must not be passed to an unaudited constructor",
          );
        }
        if (observedChildReference(argument, observedBindings)) {
          reportUnsupported(argument, "spawnObservedChild must not be passed to a constructor");
        }
      }
    }
    if (ts.isElementAccessExpression(node)) {
      const receiver = expressionProvenance(node.expression, bindings);
      if (receiver?.kind === "namespace" && memberName(node) === null) {
        reportUnsupported(
          node,
          "child-process namespace access must use a statically known audited API",
        );
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = expressionProvenance(node.expression, bindings);
      const name = memberName(node);
      if (name === "beginChildLifecycle") {
        const invocation =
          ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : null;
        const isCanonicalBoundaryUse =
          file === OBSERVED_CHILD_PROCESS_MODULE &&
          !!invocation &&
          invocation.arguments.length === 0 &&
          childProcessBoundaryName(invocation, sourceFile) === "spawnObservedChild";
        const isSupportOnlyUse = relativeFile.startsWith("test/e2e/support/");
        if (!isCanonicalBoundaryUse && !isSupportOnlyUse && file !== TEST_PROGRESS_MODULE) {
          reportUnsupported(
            node,
            "beginChildLifecycle is reserved for the canonical observed-child boundary",
          );
        }
      }
      if (
        receiver?.kind === "namespace" &&
        name !== null &&
        !DIRECT_CHILD_PROCESS_APIS.has(name as DirectChildProcessCall["api"])
      ) {
        reportUnsupported(
          node,
          `unsupported child-process namespace member must not escape the audit: ${name}`,
        );
      }
      const observedReceiver = memberReceiver(node);
      if (observedReceiver && observedChildReference(observedReceiver, observedBindings)) {
        reportUnsupported(
          node,
          "spawnObservedChild must be invoked directly without member indirection",
        );
      }
    }
    if (ts.isBindingElement(node)) {
      const boundName =
        propertyNameText(node.propertyName) ??
        (ts.isIdentifier(node.name) ? node.name.text : undefined);
      if (
        boundName === "beginChildLifecycle" &&
        file !== OBSERVED_CHILD_PROCESS_MODULE &&
        file !== TEST_PROGRESS_MODULE &&
        !relativeFile.startsWith("test/e2e/support/")
      ) {
        reportUnsupported(
          node,
          "beginChildLifecycle is reserved for the canonical observed-child boundary",
        );
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      expressionProvenance(node.initializer, bindings)?.kind === "namespace"
    ) {
      for (const element of node.name.elements) {
        const imported =
          propertyNameText(element.propertyName) ??
          (ts.isIdentifier(element.name) ? element.name.text : undefined);
        if (
          !imported ||
          !DIRECT_CHILD_PROCESS_APIS.has(imported as DirectChildProcessCall["api"])
        ) {
          reportUnsupported(
            element,
            "child-process namespace destructuring must use a statically known audited API",
          );
        }
      }
    }
    if (ts.isReturnStatement(node) || ts.isExportAssignment(node)) {
      const provenance = expressionProvenance(node.expression, bindings);
      if (isEscapingProcessCapability(provenance)) {
        reportUnsupported(node, "child-process APIs must not escape an audited source module");
      }
      if (node.expression && observedChildReference(node.expression, observedBindings)) {
        reportUnsupported(node, "spawnObservedChild must not escape an audited source module");
      }
    }
    auditStoredCapability(node);
    ts.forEachChild(node, inspect);
  }
  inspect(sourceFile);
  return calls;
}

export function scanDirectChildProcessSource(
  file: string,
  source: string,
): { auditFailures: string[]; calls: DirectChildProcessCall[] } {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const auditFailures: string[] = [];
  return {
    auditFailures,
    calls: collectDirectChildProcessCalls(file, sourceFile, auditFailures),
  };
}

function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

function hasE2EPhaseMetadata(node: ts.CallExpression): boolean {
  return node.arguments.some(
    (argument) =>
      ts.isObjectLiteralExpression(argument) &&
      argument.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          propertyNameText(property.name) === "meta" &&
          ts.isObjectLiteralExpression(property.initializer) &&
          property.initializer.properties.some(
            (metaProperty) =>
              ts.isPropertyAssignment(metaProperty) &&
              propertyNameText(metaProperty.name) === "e2ePhases",
          ),
      ),
  );
}

function phaseCallFromNode(
  node: ts.Node,
  file: string,
  sourceFile: ts.SourceFile,
): PhaseCall | null {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "phase"
  ) {
    return null;
  }
  const argument = node.arguments[0];
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    file: path.relative(REPO_ROOT, file),
    label: argument && ts.isStringLiteralLike(argument) ? argument.text : null,
    line: location.line + 1,
  };
}

function dynamicLiveImportFromNode(node: ts.Node, file: string): string | null {
  const specifier = ts.isCallExpression(node) ? node.arguments[0] : undefined;
  if (
    !ts.isCallExpression(node) ||
    node.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    !specifier ||
    !ts.isStringLiteral(specifier)
  ) {
    return null;
  }
  return resolveLiveImport(file, specifier.text);
}

function dynamicE2EImportFromNode(node: ts.Node, file: string): string | null {
  const specifier = ts.isCallExpression(node) ? node.arguments[0] : undefined;
  if (
    !ts.isCallExpression(node) ||
    node.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    !specifier ||
    !ts.isStringLiteral(specifier)
  ) {
    return null;
  }
  return resolveE2EImport(file, specifier.text);
}

function forwardedLiveTestFromNode(node: ts.Node, file: string): string | null {
  const resolved = dynamicLiveImportFromNode(node, file);
  if (!resolved?.endsWith(".test.ts")) return null;
  return path.relative(REPO_ROOT, resolved).split(path.sep).join("/");
}

function collectTestPhaseBodies(file: string, sourceFile: ts.SourceFile): TestPhaseBody[] {
  const bodies: TestPhaseBody[] = [];

  function inspect(node: ts.Node): void {
    if (ts.isCallExpression(node) && hasE2EPhaseMetadata(node)) {
      const callback = [...node.arguments]
        .reverse()
        .find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
      const phaseCalls: PhaseCall[] = [];
      if (callback) {
        function inspectCallback(callbackNode: ts.Node): void {
          const call = phaseCallFromNode(callbackNode, file, sourceFile);
          if (call) phaseCalls.push(call);
          ts.forEachChild(callbackNode, inspectCallback);
        }
        inspectCallback(callback);
      }
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      bodies.push({
        file: path.relative(REPO_ROOT, file),
        line: location.line + 1,
        phaseCalls,
        skipped:
          ts.isPropertyAccessExpression(node.expression) &&
          ["skip", "todo"].includes(node.expression.name.text),
      });
      return;
    }
    ts.forEachChild(node, inspect);
  }

  inspect(sourceFile);
  return bodies;
}

export function validateTestScopedPhaseCalls(
  plans: readonly ScopedPhasePlan[],
  bodies: readonly TestPhaseBody[],
): string[] {
  if (plans.length !== bodies.length) {
    return [
      `cannot pair ${plans.length} collected tests with ${bodies.length} source test bodies for per-test phase validation`,
    ];
  }

  const failures: string[] = [];
  for (const [index, plan] of plans.entries()) {
    const body = bodies[index];
    const declaredLabels = new Set(plan.phases);
    const calledLabels = new Set<string>();
    for (const call of body.phaseCalls) {
      if (call.label !== null && !declaredLabels.has(call.label)) {
        failures.push(
          `${call.file}:${call.line}: semantic phase is not declared by its test (${plan.name}): ${call.label}`,
        );
      }
      if (call.label !== null) calledLabels.add(call.label);
    }
    for (const label of plan.phases.slice(1)) {
      if (!calledLabels.has(label)) {
        failures.push(
          `${body.file}:${body.line}: semantic phase is never entered by its test (${plan.name}): ${label}`,
        );
      }
    }
  }
  return failures;
}

export function scanLiveSourceGraph(entryFile: string): SemanticPhaseSourceGraph {
  const visited = new Set<string>();
  const processVisited = new Set<string>();
  const forwardedTestModules: string[] = [];
  const phaseCalls: PhaseCall[] = [];
  const directChildProcessCalls: DirectChildProcessCall[] = [];
  const childProcessAuditFailures: string[] = [];
  let testPhaseBodies: TestPhaseBody[] = [];
  let importsDirectTest = false;
  let importsSharedTest = false;
  let importsWorkflowTest = false;

  function visit(file: string): void {
    if (visited.has(file)) return;
    visited.add(file);
    const sourceFile = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    if (file === entryFile) {
      importsDirectTest = importsDirectVitestTest(sourceFile);
      importsSharedTest = importsSharedE2ETest(sourceFile);
      importsWorkflowTest = importsWorkflowE2ETest(sourceFile);
      testPhaseBodies = collectTestPhaseBodies(file, sourceFile);
    }
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const importedFile = resolveLiveImport(file, statement.moduleSpecifier.text);
        if (importedFile) visit(importedFile);
      }
    }

    function inspect(node: ts.Node): void {
      const dynamicImport = dynamicLiveImportFromNode(node, file);
      if (dynamicImport) visit(dynamicImport);
      if (file === entryFile) {
        const forwardedTest = forwardedLiveTestFromNode(node, file);
        if (forwardedTest) forwardedTestModules.push(forwardedTest);
      }
      const call = phaseCallFromNode(node, file, sourceFile);
      if (call) phaseCalls.push(call);
      ts.forEachChild(node, inspect);
    }
    inspect(sourceFile);
  }

  function visitProcessBoundaries(file: string): void {
    if (processVisited.has(file)) return;
    processVisited.add(file);
    const sourceFile = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    directChildProcessCalls.push(
      ...collectDirectChildProcessCalls(file, sourceFile, childProcessAuditFailures),
    );

    for (const statement of sourceFile.statements) {
      const moduleSpecifier =
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
      if (!moduleSpecifier) continue;
      const importedFile = resolveE2EImport(file, moduleSpecifier);
      if (importedFile) visitProcessBoundaries(importedFile);
    }

    function inspect(node: ts.Node): void {
      const dynamicImport = dynamicE2EImportFromNode(node, file);
      if (dynamicImport) visitProcessBoundaries(dynamicImport);
      ts.forEachChild(node, inspect);
    }
    inspect(sourceFile);
  }

  visit(entryFile);
  visitProcessBoundaries(entryFile);
  for (const runtimeFile of E2E_RUNTIME_OBSERVABILITY_FILES) {
    visitProcessBoundaries(runtimeFile);
  }
  return {
    childProcessAuditFailures,
    directChildProcessCalls,
    forwardedTestModules,
    importsDirectTest,
    importsSharedTest,
    importsWorkflowTest,
    phaseCalls,
    testPhaseBodies,
  };
}

function validateDirectChildProcessCalls(calls: readonly DirectChildProcessCall[]): string[] {
  const failures: string[] = [];
  const auditedCalls = calls.filter(
    (call) => `${call.file}#${call.boundary}` === AUDITED_ASYNC_CHILD_PROCESS_BOUNDARY,
  );
  if (auditedCalls.length > 1) {
    failures.push(
      `${AUDITED_ASYNC_CHILD_PROCESS_BOUNDARY}: audited boundary must contain exactly one direct asynchronous child-process call (found ${auditedCalls.length})`,
    );
  }
  for (const call of calls) {
    if (call.api.endsWith("Sync") && !call.hasBoundedTimeout) {
      failures.push(
        `${call.file}:${call.line}: blocking child-process call ${call.api} must declare a positive timeout shorter than the first E2E heartbeat`,
      );
    }
    if (call.api.endsWith("Sync") && !call.hasHardKillSignal) {
      failures.push(
        `${call.file}:${call.line}: blocking child-process call ${call.api} must declare killSignal: "SIGKILL" so its timeout cannot be ignored`,
      );
    }
    if (!ASYNC_CHILD_PROCESS_APIS.has(call.api)) continue;
    const boundary = `${call.file}#${call.boundary}`;
    if (boundary !== AUDITED_ASYNC_CHILD_PROCESS_BOUNDARY) {
      failures.push(
        `${call.file}:${call.line}: asynchronous child-process call ${call.api} must use an audited progress-aware boundary (found ${call.boundary})`,
      );
      continue;
    }
    if (!call.tracksActivity) {
      failures.push(
        `${call.file}:${call.line}: audited child-process boundary must register a content-free progress activity`,
      );
    }
    if (!call.tracksLifecycle) {
      failures.push(
        `${call.file}:${call.line}: audited child-process boundary must emit canonical content-free lifecycle checkpoints`,
      );
    }
    if (!call.outputIgnored && !call.observesOutput) {
      failures.push(
        `${call.file}:${call.line}: audited child-process boundary with child output must forward timestamp-only output observations`,
      );
    }
  }
  return failures;
}

export function validateCollectedSemanticPhaseModule(
  collectedModule: CollectedSemanticPhaseModule,
): string[] {
  const failures = collectedModule.errors.map(
    (error) => `${collectedModule.relativeModuleId}: ${error}`,
  );
  const phasePlans: string[][] = [];
  const scopedPhasePlans: ScopedPhasePlan[] = [];
  const moduleTests = collectedModule.tests.length;
  const forwardingTarget = LIVE_TEST_FORWARDERS.get(collectedModule.relativeModuleId);
  const project =
    collectedModule.project ??
    (collectedModule.relativeModuleId.startsWith("test/e2e/live/") ? "e2e-live" : "integration");
  failures.push(
    ...(collectedModule.source.childProcessAuditFailures ?? []),
    ...validateDirectChildProcessCalls(collectedModule.source.directChildProcessCalls ?? []),
  );

  if (forwardingTarget) {
    if (moduleTests !== 0) {
      failures.push(
        `${collectedModule.relativeModuleId}: forwarding module must collect zero tests`,
      );
    }
    const forwardedTestModules = collectedModule.source.forwardedTestModules ?? [];
    if (forwardedTestModules.length !== 1 || forwardedTestModules[0] !== forwardingTarget) {
      failures.push(
        `${collectedModule.relativeModuleId}: forwarding module must import exactly ${forwardingTarget}`,
      );
    }
    return failures;
  }

  for (const test of collectedModule.tests) {
    const phasePlan = test.phases;
    if (!phasePlan) {
      failures.push(
        `${collectedModule.relativeModuleId} > ${test.fullName}: missing e2ePhases metadata`,
      );
      continue;
    }
    try {
      validateE2EPhasePlan(phasePlan);
      phasePlans.push([...phasePlan]);
      scopedPhasePlans.push({ name: test.fullName, phases: [...phasePlan] });
    } catch (error) {
      failures.push(
        `${collectedModule.relativeModuleId} > ${test.fullName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (moduleTests === 0) {
    failures.push(`${collectedModule.relativeModuleId}: collected zero tests`);
  }

  const { source } = collectedModule;
  if (project === "e2e-live") {
    if (!source.importsSharedTest) {
      failures.push(
        `${collectedModule.relativeModuleId}: live E2E tests must import test from the shared e2e-test fixture`,
      );
    }
  } else if (!source.importsWorkflowTest) {
    failures.push(
      `${collectedModule.relativeModuleId}: workflow-selected integration E2E tests must import test from the workflow-e2e-test fixture`,
    );
  }
  if (source.importsDirectTest) {
    failures.push(
      `${collectedModule.relativeModuleId}: workflow-selected E2E tests must not import test or it directly from Vitest`,
    );
  }
  const declaredLabels = new Set(phasePlans.flat());
  const calledLabels = new Set<string>();
  for (const call of source.phaseCalls) {
    if (call.label === null) {
      failures.push(`${call.file}:${call.line}: semantic phase transitions must use literals`);
    } else if (!declaredLabels.has(call.label)) {
      failures.push(`${call.file}:${call.line}: undeclared semantic phase: ${call.label}`);
    } else {
      calledLabels.add(call.label);
    }
  }
  const uniquePlans = new Map(phasePlans.map((plan) => [JSON.stringify(plan), plan]));
  if (moduleTests > 1 && scopedPhasePlans.length === moduleTests) {
    if (uniquePlans.size === 1) {
      const sharedPlan = [...uniquePlans.values()][0] as string[];
      const sourcePairs = source.testPhaseBodies.flatMap((body, index) =>
        body.skipped
          ? []
          : [
              {
                body,
                plan: {
                  name:
                    source.testPhaseBodies.length === moduleTests
                      ? (collectedModule.tests[index]?.fullName ??
                        `source test at line ${body.line}`)
                      : `source test at line ${body.line}`,
                  phases: sharedPlan,
                },
              },
            ],
      );
      failures.push(
        ...validateTestScopedPhaseCalls(
          sourcePairs.map(({ plan }) => plan),
          sourcePairs.map(({ body }) => body),
        ),
      );
    } else if (source.testPhaseBodies.length === moduleTests) {
      const sourcePairs = source.testPhaseBodies.flatMap((body, index) =>
        body.skipped ? [] : [{ body, plan: scopedPhasePlans[index] as ScopedPhasePlan }],
      );
      failures.push(
        ...validateTestScopedPhaseCalls(
          sourcePairs.map(({ plan }) => plan),
          sourcePairs.map(({ body }) => body),
        ),
      );
    }
  }
  for (const phasePlan of uniquePlans.values()) {
    for (const label of phasePlan.slice(1)) {
      if (!calledLabels.has(label)) {
        failures.push(
          `${collectedModule.relativeModuleId}: semantic phase is never entered: ${label}`,
        );
      }
    }
  }
  return failures;
}

function quietStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

export async function checkSemanticPhaseCoverage(): Promise<SemanticPhaseCoverage> {
  process.env.NEMOCLAW_RUN_LIVE_E2E = "1";
  process.env.NEMOCLAW_E2E_PHASE_COLLECTION = "1";
  const workflowModules = semanticPhaseCoverageModules();
  const expectedProjects = [...new Set(workflowModules.map(({ project }) => project))];
  const projectByFile = new Map(workflowModules.map(({ file, project }) => [file, project]));
  const vitest = await createVitest(
    "test",
    {
      root: REPO_ROOT,
      config: `${REPO_ROOT}/vitest.config.ts`,
      project: expectedProjects,
      run: true,
      watch: false,
      silent: true,
      // Collection only imports test modules; it does not execute stateful live
      // bodies, so the live project's execution-time serialization is not needed.
      fileParallelism: true,
      maxWorkers: 8,
      reporters: [],
    },
    {},
    { stderr: quietStream(), stdout: quietStream() },
  );

  try {
    const result = await vitest.collect(workflowModules.map(({ file }) => file));
    const failures: string[] = [];
    let tests = 0;
    const expectedModules = new Set(workflowModules.map(({ file }) => file));
    const collectedModules = new Set(
      result.testModules.map((module) => module.relativeModuleId.split(path.sep).join("/")),
    );

    if (expectedModules.size === 0) {
      failures.push("no semantic E2E phase modules were discovered");
    }
    for (const expected of expectedModules) {
      if (!collectedModules.has(expected)) {
        failures.push(`${expected}: not collected by its semantic-phase Vitest project`);
      }
    }
    for (const collected of collectedModules) {
      if (!expectedModules.has(collected))
        failures.push(`${collected}: unexpected semantic E2E phase module`);
    }

    for (const error of result.unhandledErrors) failures.push(String(error));
    for (const module of result.testModules) {
      const relativeModuleId = module.relativeModuleId.split(path.sep).join("/");
      const collectedTests = [...module.children.allTests()].map((test) => ({
        fullName: test.fullName,
        phases: test.meta().e2ePhases,
      }));
      tests += collectedTests.length;
      failures.push(
        ...validateCollectedSemanticPhaseModule({
          relativeModuleId,
          project: projectByFile.get(relativeModuleId),
          errors: [...module.errors()].map((error) => error.message),
          tests: collectedTests,
          source: scanLiveSourceGraph(path.resolve(REPO_ROOT, module.relativeModuleId)),
        }),
      );
    }

    const uniqueFailures = [...new Set(failures)];
    if (uniqueFailures.length > 0) {
      throw new Error(`semantic E2E phase coverage failed:\n${uniqueFailures.join("\n")}`);
    }
    return { files: result.testModules.length, tests };
  } finally {
    await vitest.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === path.resolve(invokedPath)) {
  checkSemanticPhaseCoverage()
    .then(({ files, tests }) => {
      process.stdout.write(`semantic E2E phase coverage: ${tests} tests across ${files} files\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}

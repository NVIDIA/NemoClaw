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

export interface ScopedPhasePlan {
  name: string;
  phases: readonly string[];
}

export interface SemanticPhaseSourceGraph {
  forwardedTestModules?: string[];
  importsDirectTest: boolean;
  importsSharedTest: boolean;
  phaseCalls: PhaseCall[];
  testPhaseBodies: TestPhaseBody[];
}

export interface CollectedSemanticPhaseModule {
  relativeModuleId: string;
  errors: readonly string[];
  tests: readonly {
    fullName: string;
    phases?: readonly string[];
  }[];
  source: SemanticPhaseSourceGraph;
}

const LIVE_ROOT = path.join(REPO_ROOT, "test", "e2e", "live");
const LIVE_TEST_FORWARDERS = new Map([
  ["test/e2e/live/bootstrap-install-smoke.test.ts", "test/e2e/live/launchable-smoke.test.ts"],
]);

function resolveLiveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [resolved, `${resolved}.ts`, path.join(resolved, "index.ts")];
  const livePrefix = `${LIVE_ROOT}${path.sep}`;
  return (
    candidates.find(
      (candidate) =>
        candidate.startsWith(livePrefix) &&
        fs.existsSync(candidate) &&
        fs.statSync(candidate).isFile(),
    ) ?? null
  );
}

function importsSharedE2ETest(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.endsWith("/fixtures/e2e-test.ts")
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

function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
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

function forwardedLiveTestFromNode(node: ts.Node, file: string): string | null {
  const specifier = ts.isCallExpression(node) ? node.arguments[0] : undefined;
  if (
    !ts.isCallExpression(node) ||
    node.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    !specifier ||
    !ts.isStringLiteral(specifier)
  ) {
    return null;
  }
  const resolved = resolveLiveImport(file, specifier.text);
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
  const forwardedTestModules: string[] = [];
  const phaseCalls: PhaseCall[] = [];
  let testPhaseBodies: TestPhaseBody[] = [];
  let importsDirectTest = false;
  let importsSharedTest = false;

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
      testPhaseBodies = collectTestPhaseBodies(file, sourceFile);
    }

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const importedFile = resolveLiveImport(file, statement.moduleSpecifier.text);
        if (importedFile) visit(importedFile);
      }
    }

    function inspect(node: ts.Node): void {
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

  visit(entryFile);
  return {
    forwardedTestModules,
    importsDirectTest,
    importsSharedTest,
    phaseCalls,
    testPhaseBodies,
  };
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
  if (!source.importsSharedTest) {
    failures.push(
      `${collectedModule.relativeModuleId}: live E2E tests must import test from the shared e2e-test fixture`,
    );
  }
  if (source.importsDirectTest) {
    failures.push(
      `${collectedModule.relativeModuleId}: live E2E tests must not import test or it directly from Vitest`,
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
  const vitest = await createVitest(
    "test",
    {
      root: REPO_ROOT,
      config: `${REPO_ROOT}/vitest.config.ts`,
      project: ["e2e-live"],
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
    const result = await vitest.collect();
    const failures: string[] = [];
    let tests = 0;
    const expectedModules = new Set(
      fs
        .globSync("**/*.test.ts", { cwd: LIVE_ROOT })
        .map((file) => path.join("test/e2e/live", file).split(path.sep).join("/")),
    );
    const collectedModules = new Set(
      result.testModules.map((module) => module.relativeModuleId.split(path.sep).join("/")),
    );

    if (expectedModules.size === 0) failures.push("no live E2E test files were discovered");
    for (const expected of expectedModules) {
      if (!collectedModules.has(expected)) failures.push(`${expected}: not collected by e2e-live`);
    }
    for (const collected of collectedModules) {
      if (!expectedModules.has(collected))
        failures.push(`${collected}: unexpected live E2E module`);
    }

    for (const error of result.unhandledErrors) failures.push(String(error));
    for (const module of result.testModules) {
      const collectedTests = [...module.children.allTests()].map((test) => ({
        fullName: test.fullName,
        phases: test.meta().e2ePhases,
      }));
      tests += collectedTests.length;
      failures.push(
        ...validateCollectedSemanticPhaseModule({
          relativeModuleId: module.relativeModuleId,
          errors: [...module.errors()].map((error) => error.message),
          tests: collectedTests,
          source: scanLiveSourceGraph(path.resolve(REPO_ROOT, module.relativeModuleId)),
        }),
      );
    }

    if (failures.length > 0) {
      throw new Error(`semantic E2E phase coverage failed:\n${failures.join("\n")}`);
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

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { getDockerGpuSupervisorReconnectTimeoutSecs } from "../../../src/lib/onboard/docker-gpu-supervisor-reconnect.ts";
import {
  INFERENCE_ROUTING_TARGET_TIMEOUT_MINUTES,
  INFERENCE_ROUTING_TEST_TIMEOUT_MS,
  ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS,
  ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
  ONBOARD_RESUME_TEST_TIMEOUT_MS,
} from "../../../tools/e2e/onboard-timeout-contract.mts";
import {
  buildLiveVitestArgs,
  INFERENCE_ROUTING_TEST_PATH,
} from "../../../tools/e2e/live-vitest-invocation.mts";
import {
  catalogueTarget,
  catalogueTargetsForChangedFiles,
} from "../../../tools/e2e/target-catalogue.mts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const MINUTE_MS = 60_000;
const finalHandoffTimeoutMs = getDockerGpuSupervisorReconnectTimeoutSecs(1, {}) * 1_000;
const affectedTargetIds = ["inference-routing", "onboard-resume"] as const;
const timeoutContractPath = "tools/e2e/onboard-timeout-contract.mts";
const commandDiagnosticHeadroomMs = 10 * MINUTE_MS;
const testHeadroomMs = 10 * MINUTE_MS;
const jobHeadroomMs = 20 * MINUTE_MS;
const timeoutContractNames = [
  "INFERENCE_ROUTING_TEST_TIMEOUT_MS",
  "ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
  "ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS",
  "ONBOARD_RESUME_TEST_TIMEOUT_MS",
] as const;

type TimeoutContractName = (typeof timeoutContractNames)[number];
type TestRegistration = readonly [title: string | null, timeout: TimeoutContractName | null];

interface ImportBinding {
  readonly importedName: string;
  readonly moduleName: string;
  readonly symbol: ts.Symbol;
}

interface SourceBinding {
  readonly checker: ts.TypeChecker;
  readonly imports: readonly ImportBinding[];
  readonly nodes: readonly ts.Node[];
}

interface TimeoutBoundaryUsage {
  readonly onboardCommandTimeouts: (TimeoutContractName | null)[];
  readonly onboardSandboxTimeouts: (TimeoutContractName | null)[];
  readonly testRegistrations: TestRegistration[];
}

function throwError(message: string): never {
  throw new Error(message);
}

function required<T>(value: T | null | undefined, message: string): T {
  return value ?? throwError(message);
}

function nestedExpression(expression: ts.Expression): ts.Expression | null {
  return ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isParenthesizedExpression(expression)
    ? expression.expression
    : null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  const nested = nestedExpression(expression);
  return nested === null ? expression : unwrapExpression(nested);
}

function flattenNodes(node: ts.Node): ts.Node[] {
  const children: ts.Node[] = [];
  node.forEachChild((child) => void children.push(child));
  return [node, ...children.flatMap(flattenNodes)];
}

function bindSource(file: string, source?: string): SourceBinding {
  const absoluteFile = path.resolve(REPO_ROOT, file);
  const sourceFile = ts.createSourceFile(
    absoluteFile,
    source ?? fs.readFileSync(absoluteFile, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.ESNext,
  };
  const compilerHost = ts.createCompilerHost(options, true);
  const getSourceFile = compilerHost.getSourceFile.bind(compilerHost);
  compilerHost.getSourceFile = (
    requestedFile,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    path.resolve(requestedFile) === absoluteFile
      ? sourceFile
      : getSourceFile(requestedFile, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([absoluteFile], options, compilerHost);
  const checkedSource = required(
    program.getSourceFile(absoluteFile),
    `could not inspect timeout boundaries in ${file}`,
  );
  const checker = program.getTypeChecker();
  const nodes = flattenNodes(checkedSource);
  const imports = nodes.filter(ts.isImportDeclaration).flatMap((declaration) => {
    const bindings = declaration.importClause?.namedBindings;
    const moduleName = ts.isStringLiteral(declaration.moduleSpecifier)
      ? declaration.moduleSpecifier.text
      : null;
    return moduleName && bindings && ts.isNamedImports(bindings)
      ? bindings.elements.map((specifier) => ({
          importedName: specifier.propertyName?.text ?? specifier.name.text,
          moduleName,
          symbol: required(
            checker.getSymbolAtLocation(specifier.name),
            `could not bind import ${specifier.name.text} in ${file}`,
          ),
        }))
      : [];
  });
  return { checker, imports, nodes };
}

function resolveConstInitializer(
  binding: SourceBinding,
  expression: ts.Expression,
  seen: ReadonlySet<ts.Symbol> = new Set(),
): ts.Expression {
  const unwrapped = unwrapExpression(expression);
  const symbol = ts.isIdentifier(unwrapped)
    ? binding.checker.getSymbolAtLocation(unwrapped)
    : undefined;
  const declaration = symbol?.valueDeclaration;
  const next: readonly [ts.Expression, ts.Symbol] | null =
    symbol &&
    !seen.has(symbol) &&
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    ts.isVariableDeclarationList(declaration.parent) &&
    Boolean(ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const)
      ? [declaration.initializer, symbol]
      : null;
  return next === null
    ? unwrapped
    : resolveConstInitializer(binding, next[0], new Set([...seen, next[1]]));
}

function importedName(
  binding: SourceBinding,
  expression: ts.Expression,
  moduleSuffix: string,
): string | null {
  const resolved = resolveConstInitializer(binding, expression);
  const symbol = ts.isIdentifier(resolved)
    ? binding.checker.getSymbolAtLocation(resolved)
    : undefined;
  return (
    binding.imports.find(
      (candidate) => candidate.symbol === symbol && candidate.moduleName.endsWith(moduleSuffix),
    )?.importedName ?? null
  );
}

function timeoutContractName(
  binding: SourceBinding,
  expression: ts.Expression | undefined,
  allowed: readonly TimeoutContractName[],
): TimeoutContractName | null {
  const name = expression ? importedName(binding, expression, timeoutContractPath) : null;
  return allowed.find((candidate) => candidate === name) ?? null;
}

function propertyNameText(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

function propertyValue(
  binding: SourceBinding,
  expression: ts.Expression | undefined,
  propertyName: string,
): ts.Expression | undefined {
  const resolved = expression ? resolveConstInitializer(binding, expression) : null;
  const property =
    resolved && ts.isObjectLiteralExpression(resolved)
      ? resolved.properties.find(
          (candidate) =>
            (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
            propertyNameText(candidate.name) === propertyName,
        )
      : undefined;
  return property && ts.isPropertyAssignment(property)
    ? property.initializer
    : property && ts.isShorthandPropertyAssignment(property)
      ? property.name
      : undefined;
}

function stringValue(binding: SourceBinding, expression: ts.Expression | undefined): string | null {
  const resolved = expression ? resolveConstInitializer(binding, expression) : null;
  return resolved && ts.isStringLiteralLike(resolved) ? resolved.text : null;
}

function rootIdentifier(expression: ts.Expression): ts.Identifier | null {
  const unwrapped = unwrapExpression(expression);
  return ts.isIdentifier(unwrapped)
    ? unwrapped
    : ts.isPropertyAccessExpression(unwrapped)
      ? rootIdentifier(unwrapped.expression)
      : ts.isCallExpression(unwrapped)
        ? rootIdentifier(unwrapped.expression)
        : null;
}

function testTableFactory(call: ts.CallExpression): ts.CallExpression | null {
  const callee = unwrapExpression(call.expression);
  const factoryCall = ts.isCallExpression(callee) ? callee : null;
  const factoryExpression = factoryCall ? unwrapExpression(factoryCall.expression) : null;
  return factoryExpression &&
    ts.isPropertyAccessExpression(factoryExpression) &&
    ["each", "for"].includes(factoryExpression.name.text)
    ? factoryCall
    : null;
}

function isTestRegistration(binding: SourceBinding, call: ts.CallExpression): boolean {
  const callee = unwrapExpression(call.expression);
  const factory = testTableFactory(call);
  const factoryExpression = factory ? unwrapExpression(factory.expression) : null;
  const root =
    factoryExpression && ts.isPropertyAccessExpression(factoryExpression)
      ? rootIdentifier(factoryExpression.expression)
      : null;
  return (
    (ts.isIdentifier(callee) && importedName(binding, callee, "fixtures/e2e-test.ts") === "test") ||
    (root !== null && importedName(binding, root, "fixtures/e2e-test.ts") === "test")
  );
}

function tableRows(
  binding: SourceBinding,
  registration: ts.CallExpression,
): readonly (ts.Expression | null | undefined)[] {
  const table = testTableFactory(registration)?.arguments[0];
  const resolved = table ? resolveConstInitializer(binding, table) : null;
  return table === undefined
    ? [null]
    : resolved && ts.isArrayLiteralExpression(resolved)
      ? resolved.elements.map((element) =>
          ts.isOmittedExpression(element) || ts.isSpreadElement(element) ? undefined : element,
        )
      : [undefined];
}

function tableTitle(
  binding: SourceBinding,
  template: string | null,
  row: ts.Expression | null | undefined,
): string | null {
  const resolved = row ? resolveConstInitializer(binding, row) : null;
  const placeholderCount = template?.match(/%s/gu)?.length ?? 0;
  const values =
    resolved && ts.isArrayLiteralExpression(resolved)
      ? resolved.elements
          .slice(0, placeholderCount)
          .map((element) =>
            ts.isOmittedExpression(element) || ts.isSpreadElement(element)
              ? null
              : stringValue(binding, element),
          )
      : [];
  return row === null
    ? template
    : template !== null &&
        values.length === placeholderCount &&
        values.every((value) => value !== null)
      ? values.reduce((title, value) => title.replace("%s", value ?? ""), template)
      : null;
}

function isFunctionExpression(
  expression: ts.Expression,
): expression is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

function fixtureHostSymbols(binding: SourceBinding, call: ts.CallExpression): ts.Symbol[] {
  const callback = call.arguments.find(isFunctionExpression);
  return callback
    ? callback.parameters.flatMap((parameter) =>
        ts.isObjectBindingPattern(parameter.name)
          ? parameter.name.elements
              .filter(
                (element): element is ts.BindingElement & { name: ts.Identifier } =>
                  ts.isIdentifier(element.name) &&
                  propertyNameText(element.propertyName ?? element.name) === "host",
              )
              .map((element) => binding.checker.getSymbolAtLocation(element.name))
              .filter((symbol): symbol is ts.Symbol => symbol !== undefined)
          : [],
      )
    : [];
}

function arrayExpressionElement(
  array: ts.ArrayLiteralExpression,
  index: number,
): ts.Expression | undefined {
  const element = array.elements[index];
  return element && !ts.isOmittedExpression(element) && !ts.isSpreadElement(element)
    ? element
    : undefined;
}

function isOnboardHostCommand(
  binding: SourceBinding,
  call: ts.CallExpression,
  fixtureHosts: ReadonlySet<ts.Symbol>,
): boolean {
  const callee = unwrapExpression(call.expression);
  const receiver = ts.isPropertyAccessExpression(callee)
    ? unwrapExpression(callee.expression)
    : null;
  const receiverSymbol =
    receiver && ts.isIdentifier(receiver)
      ? binding.checker.getSymbolAtLocation(receiver)
      : undefined;
  const commandArguments = call.arguments[1]
    ? resolveConstInitializer(binding, call.arguments[1])
    : null;
  const argumentArray =
    commandArguments && ts.isArrayLiteralExpression(commandArguments) ? commandArguments : null;
  const entrypoint = argumentArray ? arrayExpressionElement(argumentArray, 0) : undefined;
  const command = argumentArray ? arrayExpressionElement(argumentArray, 1) : undefined;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "command" &&
    receiverSymbol !== undefined &&
    fixtureHosts.has(receiverSymbol) &&
    stringValue(binding, call.arguments[0]) === "node" &&
    entrypoint !== undefined &&
    importedName(binding, entrypoint, "fixtures/paths.ts") === "CLI_ENTRYPOINT" &&
    stringValue(binding, command) === "onboard"
  );
}

function containsNode(node: ts.Node, ancestor: ts.Node): boolean {
  return node === ancestor ? true : node.parent ? containsNode(node.parent, ancestor) : false;
}

function enclosingNamedFunction(node: ts.Node): ts.FunctionDeclaration | null {
  const parent = node.parent;
  return parent === undefined
    ? null
    : ts.isFunctionDeclaration(parent) && parent.name
      ? parent
      : enclosingNamedFunction(parent);
}

function callSymbol(binding: SourceBinding, call: ts.CallExpression): ts.Symbol | undefined {
  const callee = unwrapExpression(call.expression);
  return ts.isIdentifier(callee) ? binding.checker.getSymbolAtLocation(callee) : undefined;
}

function realizationCount(
  binding: SourceBinding,
  boundary: ts.CallExpression,
  calls: readonly ts.CallExpression[],
  registrations: readonly ts.CallExpression[],
): number {
  const containingRegistration = registrations.find((registration) =>
    containsNode(boundary, registration),
  );
  const helper = containingRegistration ? null : enclosingNamedFunction(boundary);
  const helperSymbol = helper?.name ? binding.checker.getSymbolAtLocation(helper.name) : undefined;
  const helperRealizations = helperSymbol
    ? registrations.reduce(
        (total, registration) =>
          total +
          calls.filter(
            (call) =>
              containsNode(call, registration) && callSymbol(binding, call) === helperSymbol,
          ).length *
            tableRows(binding, registration).length,
        0,
      )
    : 0;
  return containingRegistration
    ? tableRows(binding, containingRegistration).length
    : Math.max(1, helperRealizations);
}

function inspectTimeoutBoundaries(
  file: string,
  registrationTimeout: TimeoutContractName,
  source?: string,
): TimeoutBoundaryUsage {
  const binding = bindSource(file, source);
  const calls = binding.nodes.filter(ts.isCallExpression);
  const registrations = calls.filter((call) => isTestRegistration(binding, call));
  const fixtureHosts = new Set(
    registrations.flatMap((registration) => fixtureHostSymbols(binding, registration)),
  );
  return {
    onboardCommandTimeouts: calls
      .filter((call) => isOnboardHostCommand(binding, call, fixtureHosts))
      .flatMap((call) =>
        Array.from({ length: realizationCount(binding, call, calls, registrations) }, () =>
          timeoutContractName(binding, propertyValue(binding, call.arguments[2], "timeoutMs"), [
            "ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
            "ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS",
          ]),
        ),
      ),
    onboardSandboxTimeouts: calls
      .filter((call) => {
        const callee = unwrapExpression(call.expression);
        return (
          ts.isIdentifier(callee) &&
          importedName(binding, callee, "inference-routing-helpers.ts") === "onboardSandbox"
        );
      })
      .flatMap((call) =>
        Array.from({ length: realizationCount(binding, call, calls, registrations) }, () =>
          timeoutContractName(binding, call.arguments[6], [
            "ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
          ]),
        ),
      ),
    testRegistrations: registrations.flatMap((call) => {
      const title = stringValue(binding, call.arguments[0]);
      const timeout = timeoutContractName(
        binding,
        propertyValue(binding, call.arguments[1], "timeout"),
        [registrationTimeout],
      );
      return tableRows(binding, call).map((row): TestRegistration => [
        tableTitle(binding, title, row),
        timeout,
      ]);
    }),
  };
}

describe("onboard final-handoff timeout contract", () => {
  it("keeps the command alive through both reconnect waits and the failure diagnostic", () => {
    expect(ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(
      finalHandoffTimeoutMs * 2 + commandDiagnosticHeadroomMs,
    );
  });

  it("binds the inference-routing callers to the single-command deadline", () => {
    const usage = inspectTimeoutBoundaries(
      "test/e2e/live/inference-routing.test.ts",
      "INFERENCE_ROUTING_TEST_TIMEOUT_MS",
    );
    expect(usage).toEqual({
      onboardCommandTimeouts: [],
      onboardSandboxTimeouts: [
        null,
        null,
        "ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
        "ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
        "ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
        "ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
      ],
      testRegistrations: [
        ["TC-INF-06 invalid API key fails with credential classification and cleanup", null],
        ["TC-INF-07 unreachable endpoint fails with transport classification and cleanup", null],
        [
          "TC-INF-10 DNS-backed HTTPS blueprint endpoint fails closed before OpenShell runtime handoff",
          null,
        ],
        [
          "TC-INF-12 runtime identity refreshes and injects a delegated bearer through real OpenShell",
          "INFERENCE_ROUTING_TEST_TIMEOUT_MS",
        ],
        [
          "TC-INF-13 Entra Graph runtime identity refreshes and injects a delegated bearer through real OpenShell",
          "INFERENCE_ROUTING_TEST_TIMEOUT_MS",
        ],
        [
          "TC-INF-09 Deep Agents Code uses a local compatible endpoint through inference.local (#5744)",
          "INFERENCE_ROUTING_TEST_TIMEOUT_MS",
        ],
        [
          "TC-INF-11 DNS-backed HTTPS custom endpoint routes through the local pinning adapter (#6141)",
          "INFERENCE_ROUTING_TEST_TIMEOUT_MS",
        ],
      ],
    });
    expect(INFERENCE_ROUTING_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS + testHeadroomMs,
    );
  });

  it("stops inference-routing after the first completed failure", () => {
    expect(buildLiveVitestArgs({ testPath: INFERENCE_ROUTING_TEST_PATH })).toContain("--bail=1");
    expect(buildLiveVitestArgs({ testPath: "test/e2e/live/onboard-resume.test.ts" })).not.toContain(
      "--bail=1",
    );
  });

  it("encloses all six sequential onboard-resume command deadlines", () => {
    const usage = inspectTimeoutBoundaries(
      "test/e2e/live/onboard-resume.test.ts",
      "ONBOARD_RESUME_TEST_TIMEOUT_MS",
    );
    expect(usage).toEqual({
      onboardCommandTimeouts: [
        "ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
        "ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
        "ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS",
        "ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS",
        "ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS",
        "ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS",
      ],
      onboardSandboxTimeouts: [],
      testRegistrations: [
        [
          "onboard-resume: interrupted onboard then --resume can recreate with cached setup",
          "ONBOARD_RESUME_TEST_TIMEOUT_MS",
        ],
      ],
    });
    expect(ONBOARD_RESUME_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      usage.onboardCommandTimeouts.filter(
        (timeout) => timeout === "ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
      ).length *
        ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS +
        usage.onboardCommandTimeouts.filter(
          (timeout) => timeout === "ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS",
        ).length *
          ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS +
        testHeadroomMs,
    );
  });

  it("rejects inference-routing timeout decoys and expands table rows (#9622)", () => {
    const source = `
      import {
        INFERENCE_ROUTING_TEST_TIMEOUT_MS as testDeadline,
        ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS as commandDeadline,
      } from "../../../tools/e2e/onboard-timeout-contract.mts";
      import { test as liveTest } from "../fixtures/e2e-test.ts";
      import { onboardSandbox as onboard } from "./inference-routing-helpers.ts";
      const INFERENCE_ROUTING_TEST_TIMEOUT_MS = 300_000;
      const ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS = 120_000;
      const test = (...values: unknown[]) => values;
      const onboardSandbox = (...values: unknown[]) => values;
      const scenarios = [["12", ""], ["13", "Entra Graph "]] as const;
      // ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS is not command wiring.
      const note = "INFERENCE_ROUTING_TEST_TIMEOUT_MS is not a test deadline";
      async function runScenario() {
        await onboard(a, b, c, d, e, f, commandDeadline);
      }
      liveTest.for(scenarios)(
        "TC-INF-%s %sruntime identity",
        { timeout: testDeadline },
        async (_row) => runScenario(),
      );
      liveTest("wrong", { timeout: INFERENCE_ROUTING_TEST_TIMEOUT_MS }, async () => {
        await onboard(a, b, c, d, e, f, ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS);
      });
      liveTest("null", { timeout: null }, async () => {
        await onboard(a, b, c, d, e, f, null);
      });
      liveTest("missing", async () => onboard(a, b, c, d, e, f));
      liveTest("non-contract", { timeout: 30_000 }, async () => {
        await onboard(a, b, c, d, e, f, 45_000);
      });
      test("lookalike", { timeout: INFERENCE_ROUTING_TEST_TIMEOUT_MS }, async () => {
        onboardSandbox(a, b, c, d, e, f, ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS);
        observe(note);
      });
    `;
    const usage = inspectTimeoutBoundaries(
      "test/e2e/live/inference-routing.synthetic.ts",
      "INFERENCE_ROUTING_TEST_TIMEOUT_MS",
      source,
    );

    expect(usage).toEqual({
      onboardCommandTimeouts: [],
      onboardSandboxTimeouts: [
        "ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
        "ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
        null,
        null,
        null,
        null,
      ],
      testRegistrations: [
        ["TC-INF-12 runtime identity", "INFERENCE_ROUTING_TEST_TIMEOUT_MS"],
        ["TC-INF-13 Entra Graph runtime identity", "INFERENCE_ROUTING_TEST_TIMEOUT_MS"],
        ["wrong", null],
        ["null", null],
        ["missing", null],
        ["non-contract", null],
      ],
    });
  });

  it("rejects onboard-resume decoys outside fixture command boundaries (#9622)", () => {
    const source = `
      import {
        ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS as finalDeadline,
        ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS as reuseDeadline,
        ONBOARD_RESUME_TEST_TIMEOUT_MS as testDeadline,
        INFERENCE_ROUTING_TEST_TIMEOUT_MS as wrongDeadline,
      } from "../../../tools/e2e/onboard-timeout-contract.mts";
      import { test as liveTest } from "../fixtures/e2e-test.ts";
      import { CLI_ENTRYPOINT as entrypoint } from "../fixtures/paths.ts";
      const CLI_ENTRYPOINT = "/lookalike";
      const ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS = 120_000;
      const ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS = 120_000;
      const ONBOARD_RESUME_TEST_TIMEOUT_MS = 300_000;
      const onboardArgs = [entrypoint, "onboard"] as const;
      const resumeArgs = [entrypoint, "onboard", "--resume"] as const;
      const statusArgs = [entrypoint, "status"] as const;
      const lookalikeArgs = [CLI_ENTRYPOINT, "onboard"] as const;
      const finalOptions = { timeoutMs: finalDeadline } as const;
      const wrongOptions = { timeoutMs: wrongDeadline } as const;
      const fakeHost = { command() {} };
      const host = fakeHost;
      host.command("node", onboardArgs, finalOptions);
      // timeoutMs: ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS is not fixture wiring.
      const note = "timeout: ONBOARD_RESUME_TEST_TIMEOUT_MS";
      liveTest.for([["case"]])(
        "resume",
        { timeout: testDeadline },
        async (_row, { host: fixtureHost }) => {
          await fixtureHost.command("node", onboardArgs, finalOptions);
          await fixtureHost.command("node", [entrypoint, "onboard", "--resume"], {
            timeoutMs: reuseDeadline,
          });
          await fixtureHost.command("node", resumeArgs, wrongOptions);
          await fixtureHost.command("node", onboardArgs, { timeoutMs: 45_000 });
          await fixtureHost.command("node", onboardArgs, { timeoutMs: null });
          await fixtureHost.command("node", onboardArgs);
          await fixtureHost.command("node", lookalikeArgs, finalOptions);
          await fixtureHost.command("node", statusArgs, { timeoutMs: reuseDeadline });
          await host.command("node", onboardArgs, finalOptions);
          observe(note);
        },
      );
      liveTest("wrong", { timeout: ONBOARD_RESUME_TEST_TIMEOUT_MS }, async () => {});
      liveTest("null", { timeout: null }, async () => {});
      liveTest("missing", async () => {});
      liveTest("non-contract", { timeout: 30_000 }, async () => {});
    `;
    const usage = inspectTimeoutBoundaries(
      "test/e2e/live/onboard-resume.synthetic.ts",
      "ONBOARD_RESUME_TEST_TIMEOUT_MS",
      source,
    );

    expect(usage).toEqual({
      onboardCommandTimeouts: [
        "ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
        "ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS",
        null,
        null,
        null,
        null,
      ],
      onboardSandboxTimeouts: [],
      testRegistrations: [
        ["resume", "ONBOARD_RESUME_TEST_TIMEOUT_MS"],
        ["wrong", null],
        ["null", null],
        ["missing", null],
        ["non-contract", null],
      ],
    });
  });

  it("pins the reviewed command, test, and target timeout values", () => {
    expect({
      finalHandoffCommandMinutes: ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS / MINUTE_MS,
      inferenceRoutingTestMinutes: INFERENCE_ROUTING_TEST_TIMEOUT_MS / MINUTE_MS,
      inferenceRoutingTargetMinutes: INFERENCE_ROUTING_TARGET_TIMEOUT_MINUTES,
      noRecreateCommandMinutes: ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS / MINUTE_MS,
      onboardResumeTestMinutes: ONBOARD_RESUME_TEST_TIMEOUT_MS / MINUTE_MS,
      onboardResumeTargetMinutes: ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
    }).toEqual({
      finalHandoffCommandMinutes: 40,
      inferenceRoutingTestMinutes: 50,
      inferenceRoutingTargetMinutes: 75,
      noRecreateCommandMinutes: 15,
      onboardResumeTestMinutes: 150,
      onboardResumeTargetMinutes: 170,
    });
  });

  it.each([
    ["inference-routing", INFERENCE_ROUTING_TEST_TIMEOUT_MS],
    ["onboard-resume", ONBOARD_RESUME_TEST_TIMEOUT_MS],
  ] as const)("keeps the %s job alive through test cleanup", (targetId, testTimeoutMs) => {
    expect(catalogueTarget(targetId).timeoutMinutes * 60_000).toBeGreaterThanOrEqual(
      testTimeoutMs + jobHeadroomMs,
    );
    expect(catalogueTarget(targetId).timeoutMinutes).toBe(
      targetId === "inference-routing"
        ? INFERENCE_ROUTING_TARGET_TIMEOUT_MINUTES
        : ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
    );
  });

  it("selects both affected targets when the shared timeout contract changes", () => {
    expect(
      catalogueTargetsForChangedFiles([timeoutContractPath])
        .map((target) => target.id)
        .sort(),
    ).toEqual([...affectedTargetIds].sort());
  });

  it.each([
    INFERENCE_ROUTING_TARGET_TIMEOUT_MINUTES,
    INFERENCE_ROUTING_TEST_TIMEOUT_MS,
    ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
    ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS,
    ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
    ONBOARD_RESUME_TEST_TIMEOUT_MS,
  ])("uses positive whole numbers for timeout contract values [case %#]", (value) => {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  });
});

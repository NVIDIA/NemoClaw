// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keep direct OpenShell sandbox observation sites classified while the typed
 * adapter migration proceeds.
 *
 * invalidState: a production source adds an unclassified `sandbox list` or
 * `sandbox get` command, or adds another binding to a legacy raw-output parser.
 * sourceBoundary: the CLI adapter owns command construction and parsing;
 * capability issues own each temporary production exception.
 * whyNotSourceFix: TypeScript cannot prevent callers from constructing an
 * equivalent string array for a generic process runner.
 * regressionTest: test/repository/openshell-sandbox-observation-boundary.test.ts.
 * removalCondition: remove this ledger after #9813 verifies that every
 * production consumer uses a typed adapter or an accepted executable-level
 * exception.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_ROOTS = ["src", "nemoclaw/src"] as const;
const SKIP_DIRECTORIES = new Set(["coverage", "dist", "node_modules"]);
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const TEST_SOURCE =
  /(?:^|\/)(?:__test-helpers__\/|.*(?:\.test|-test-fixture)\.(?:[cm]?[jt]s|[jt]sx)$)/u;

const LEGACY_PARSER_NAMES = new Set([
  "getSandboxFailurePhase",
  "hasSandboxListEntry",
  "isOpenShellProtobufSchemaMismatch",
  "isSandboxReady",
  "parseCliOpenShellSandboxInventory",
  "parseCliOpenShellSandboxPhase",
  "parseLiveSandboxEntries",
  "parseLiveSandboxNames",
  "parseReadySandboxNames",
  "parseSandboxRow",
  "parseSandboxStatus",
  "stripAnsi",
  "stripOpenShellCliAnsi",
]);

const LEGACY_PARSER_MODULE_SUFFIXES = [
  "/adapters/openshell/sandbox-observer-cli",
  "/runtime-recovery",
  "/state/gateway",
] as const;

export type OpenShellSandboxObservationDisposition = Readonly<{
  directCommands: number;
  legacyParserSites: number;
  ownerIssues: readonly number[];
  disposition: "adapter-boundary" | "follow-up";
  reason: string;
}>;

export type OpenShellSandboxObservationUsage = Readonly<{
  directCommands: number;
  legacyParserSites: number;
}>;

export const OPEN_SHELL_SANDBOX_OBSERVATION_DISPOSITIONS: Readonly<
  Record<string, OpenShellSandboxObservationDisposition>
> = {
  "nemoclaw/src/blueprint/runner.ts": {
    directCommands: 1,
    legacyParserSites: 0,
    ownerIssues: [9813],
    disposition: "follow-up",
    reason: "The final Phase 1 sweep owns plugin and blueprint-runner consumers.",
  },
  "src/commands/debug.ts": {
    directCommands: 2,
    legacyParserSites: 1,
    ownerIssues: [9812],
    disposition: "follow-up",
    reason: "PR #10537 migrates liveness; the diagnostics slice owns remaining observation.",
  },
  "src/lib/actions/sandbox/destroy-gateway-cleanup.ts": {
    directCommands: 1,
    legacyParserSites: 0,
    ownerIssues: [9807],
    disposition: "follow-up",
    reason: "The gateway lifecycle slice owns final-destroy gateway cleanup observation.",
  },
  "src/lib/actions/sandbox/destroy-preflight.ts": {
    directCommands: 1,
    legacyParserSites: 0,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns destructive preflight observation.",
  },
  "src/lib/actions/sandbox/doctor.ts": {
    directCommands: 0,
    legacyParserSites: 1,
    ownerIssues: [9807],
    disposition: "follow-up",
    reason: "The gateway lifecycle slice owns raw lifecycle status classification.",
  },
  "src/lib/actions/sandbox/gateway-state.ts": {
    directCommands: 1,
    legacyParserSites: 1,
    ownerIssues: [9807, 9811],
    disposition: "follow-up",
    reason: "Gateway lifecycle and sandbox stop ownership still share this compatibility path.",
  },
  "src/lib/actions/sandbox/rebuild-destroy-phase.ts": {
    directCommands: 2,
    legacyParserSites: 0,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns rebuild destruction observation.",
  },
  "src/lib/actions/sandbox/snapshot.ts": {
    directCommands: 7,
    legacyParserSites: 2,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns snapshot and restore observation.",
  },
  "src/lib/actions/sandbox/stop.ts": {
    directCommands: 0,
    legacyParserSites: 1,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns sibling phase observation during stop.",
  },
  "src/lib/actions/sandbox/vm-dns-monkeypatch.ts": {
    directCommands: 1,
    legacyParserSites: 0,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns VM sandbox inspection before mutation.",
  },
  "src/lib/actions/uninstall/run-plan.ts": {
    directCommands: 1,
    legacyParserSites: 0,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns absence verification during uninstall.",
  },
  "src/lib/adapters/openshell/client.ts": {
    directCommands: 1,
    legacyParserSites: 0,
    ownerIssues: [9803],
    disposition: "adapter-boundary",
    reason: "The OpenShell CLI adapter owns this compatibility command construction.",
  },
  "src/lib/adapters/openshell/gateway-drift.ts": {
    directCommands: 0,
    legacyParserSites: 1,
    ownerIssues: [9807],
    disposition: "adapter-boundary",
    reason: "The gateway lifecycle adapter owns gateway status compatibility parsing.",
  },
  "src/lib/adapters/openshell/policy-authority.ts": {
    directCommands: 2,
    legacyParserSites: 0,
    ownerIssues: [9805, 10514],
    disposition: "adapter-boundary",
    reason: "The accepted policy source-of-truth cutover owns these typed policy inspections.",
  },
  "src/lib/adapters/openshell/sandbox-identity.ts": {
    directCommands: 3,
    legacyParserSites: 0,
    ownerIssues: [9811],
    disposition: "adapter-boundary",
    reason: "The sandbox lifecycle adapter owns immutable identity inspection.",
  },
  "src/lib/adapters/openshell/sandbox-observer-cli.ts": {
    directCommands: 0,
    legacyParserSites: 3,
    ownerIssues: [9803],
    disposition: "adapter-boundary",
    reason: "The CLI sandbox observer owns table, ANSI, phase, and error parsing.",
  },
  "src/lib/diagnostics/debug.ts": {
    directCommands: 4,
    legacyParserSites: 0,
    ownerIssues: [9812],
    disposition: "follow-up",
    reason: "The diagnostics slice owns migration or an accepted executable-level exception.",
  },
  "src/lib/domain/sandbox/destroy.ts": {
    directCommands: 0,
    legacyParserSites: 1,
    ownerIssues: [9807],
    disposition: "follow-up",
    reason: "The gateway lifecycle slice owns final-destroy live-sandbox classification.",
  },
  "src/lib/onboard/docker-gpu-patch-diagnostics.ts": {
    directCommands: 2,
    legacyParserSites: 0,
    ownerIssues: [9812],
    disposition: "follow-up",
    reason: "The diagnostics slice owns migration or an accepted executable-level exception.",
  },
  "src/lib/onboard/docker-gpu-patch.ts": {
    directCommands: 2,
    legacyParserSites: 1,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns Docker GPU phase decisions.",
  },
  "src/lib/onboard/docker-gpu-sandbox-create.ts": {
    directCommands: 1,
    legacyParserSites: 1,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns create failure observation.",
  },
  "src/lib/onboard/docker-gpu-supervisor-reconnect.ts": {
    directCommands: 2,
    legacyParserSites: 1,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns supervisor reconnect phase decisions.",
  },
  "src/lib/onboard/experimental/hermes-portable-lifecycle.ts": {
    directCommands: 4,
    legacyParserSites: 0,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns Hermes portable lifecycle observation.",
  },
  "src/lib/onboard/experimental/hermes-portable-onboarding.ts": {
    directCommands: 6,
    legacyParserSites: 0,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns Hermes portable onboarding observation.",
  },
  "src/lib/onboard/managed-bootstrap/docker.ts": {
    directCommands: 1,
    legacyParserSites: 0,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns managed bootstrap deletion observation.",
  },
  "src/lib/onboard/runtime-provider/snapshot.ts": {
    directCommands: 2,
    legacyParserSites: 0,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns runtime-provider snapshot inspection.",
  },
  "src/lib/onboard.ts": {
    directCommands: 0,
    legacyParserSites: 1,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns the onboarding legacy parser binding.",
  },
  "src/lib/onboard/sandbox-create-step.ts": {
    directCommands: 1,
    legacyParserSites: 0,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns create readiness observation.",
  },
  "src/lib/onboard/sandbox-gpu-create-attempt.ts": {
    directCommands: 1,
    legacyParserSites: 1,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns failed-create presence observation.",
  },
  "src/lib/onboard/sandbox-gpu-create-run-attempt.ts": {
    directCommands: 4,
    legacyParserSites: 2,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns create, readiness, and cleanup observation.",
  },
  "src/lib/onboard/sandbox-lifecycle.ts": {
    directCommands: 1,
    legacyParserSites: 0,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns sandbox lookup before start or stop.",
  },
  "src/lib/onboard/sandbox-readiness-tracing.ts": {
    directCommands: 2,
    legacyParserSites: 0,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns create readiness trace observation.",
  },
  "src/lib/onboard/sandbox-recreate-probe.ts": {
    directCommands: 2,
    legacyParserSites: 0,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns recreate presence observation.",
  },
  "src/lib/onboard/sandbox-reuse.ts": {
    directCommands: 5,
    legacyParserSites: 0,
    ownerIssues: [9811],
    disposition: "follow-up",
    reason: "The sandbox lifecycle slice owns onboarding reuse and identity observation.",
  },
  "src/lib/runtime-recovery.ts": {
    directCommands: 0,
    legacyParserSites: 6,
    ownerIssues: [9807, 9811],
    disposition: "follow-up",
    reason: "Gateway and sandbox lifecycle slices own removal of legacy parser projections.",
  },
  "src/lib/shields/index.ts": {
    directCommands: 1,
    legacyParserSites: 1,
    ownerIssues: [9805, 10514],
    disposition: "follow-up",
    reason: "The policy source-of-truth cutover owns Shields phase observation during mutation.",
  },
  "src/lib/state/gateway.ts": {
    directCommands: 0,
    legacyParserSites: 6,
    ownerIssues: [9807],
    disposition: "follow-up",
    reason: "The gateway lifecycle slice owns the legacy sandbox and gateway classifiers.",
  },
} as const;

function moduleCarriesLegacyParsers(moduleSpecifier: string): boolean {
  const normalized = moduleSpecifier.replace(/\\/gu, "/").replace(/\.(?:[cm]?[jt]s|[jt]sx)$/u, "");
  return LEGACY_PARSER_MODULE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function importedName(element: ts.ImportSpecifier): string {
  return element.propertyName?.text ?? element.name.text;
}

function requireModuleSpecifier(expression: ts.Expression | undefined): string | null {
  if (
    !expression ||
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "require" ||
    expression.arguments.length !== 1
  ) {
    return null;
  }
  const [specifier] = expression.arguments;
  return specifier && ts.isStringLiteralLike(specifier) ? specifier.text : null;
}

function directObservationCommands(node: ts.ArrayLiteralExpression): number {
  let commands = 0;
  for (let index = 0; index < node.elements.length - 1; index += 1) {
    const first = node.elements[index];
    const second = node.elements[index + 1];
    if (
      first &&
      second &&
      ts.isStringLiteralLike(first) &&
      first.text === "sandbox" &&
      ts.isStringLiteralLike(second) &&
      (second.text === "get" || second.text === "list")
    ) {
      commands += 1;
    }
  }
  return commands;
}

export function findOpenShellSandboxObservationUsage(
  sourceText: string,
  filePath: string,
): OpenShellSandboxObservationUsage {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  let directCommands = 0;
  let legacyParserSites = 0;

  function visit(node: ts.Node): void {
    if (ts.isArrayLiteralExpression(node)) {
      directCommands += directObservationCommands(node);
    } else if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      moduleCarriesLegacyParsers(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings
    ) {
      const bindings = node.importClause.namedBindings;
      legacyParserSites += ts.isNamespaceImport(bindings)
        ? 1
        : bindings.elements.filter((element) => LEGACY_PARSER_NAMES.has(importedName(element)))
            .length;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const moduleSpecifier = requireModuleSpecifier(node.initializer);
      if (moduleSpecifier && moduleCarriesLegacyParsers(moduleSpecifier)) {
        legacyParserSites += 1;
      }
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      const moduleSpecifier = requireModuleSpecifier(node.initializer);
      if (moduleSpecifier && moduleCarriesLegacyParsers(moduleSpecifier)) {
        legacyParserSites += node.name.elements.filter((element) => {
          const name = element.propertyName ?? element.name;
          return ts.isIdentifier(name) && LEGACY_PARSER_NAMES.has(name.text);
        }).length;
      }
    } else if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      LEGACY_PARSER_NAMES.has(node.name.text) &&
      (filePath.endsWith("/runtime-recovery.ts") ||
        filePath.endsWith("/state/gateway.ts") ||
        filePath.endsWith("/adapters/openshell/sandbox-observer-cli.ts"))
    ) {
      legacyParserSites += 1;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { directCommands, legacyParserSites };
}

function isProductionSource(relativePath: string): boolean {
  return SOURCE_EXTENSION.test(relativePath) && !TEST_SOURCE.test(relativePath);
}

function* walkProductionSources(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkProductionSources(absolutePath);
    } else if (entry.isFile()) {
      const relativePath = path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
      if (isProductionSource(relativePath)) yield absolutePath;
    }
  }
}

export function collectOpenShellSandboxObservationSources(): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const root of SCAN_ROOTS) {
    for (const absolutePath of walkProductionSources(path.join(REPO_ROOT, root))) {
      const relativePath = path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
      sources.set(relativePath, readFileSync(absolutePath, "utf8"));
    }
  }
  return sources;
}

export function auditOpenShellSandboxObservationSources(
  sources: ReadonlyMap<string, string>,
  dispositions: Readonly<
    Record<string, OpenShellSandboxObservationDisposition>
  > = OPEN_SHELL_SANDBOX_OBSERVATION_DISPOSITIONS,
): void {
  const actual = new Map<string, OpenShellSandboxObservationUsage>();
  for (const [filePath, sourceText] of sources) {
    const usage = findOpenShellSandboxObservationUsage(sourceText, filePath);
    if (usage.directCommands > 0 || usage.legacyParserSites > 0) actual.set(filePath, usage);
  }

  const failures: string[] = [];
  for (const [filePath, usage] of actual) {
    const disposition = dispositions[filePath];
    if (!disposition) {
      failures.push(
        `${filePath}: unclassified observation usage ` +
          `(commands=${usage.directCommands}, legacyParsers=${usage.legacyParserSites})`,
      );
      continue;
    }
    if (
      disposition.directCommands !== usage.directCommands ||
      disposition.legacyParserSites !== usage.legacyParserSites
    ) {
      failures.push(
        `${filePath}: observation usage changed; expected commands=${disposition.directCommands}, ` +
          `legacyParsers=${disposition.legacyParserSites}; found commands=${usage.directCommands}, ` +
          `legacyParsers=${usage.legacyParserSites}`,
      );
    }
    if (disposition.ownerIssues.length === 0 || disposition.reason.trim().length === 0) {
      failures.push(`${filePath}: disposition must name an owner issue and reason`);
    }
  }

  for (const filePath of Object.keys(dispositions)) {
    if (!actual.has(filePath)) {
      failures.push(`${filePath}: stale disposition has no observation usage`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      [
        "OpenShell sandbox observation boundary changed.",
        "Move the consumer to a typed adapter or update its owned follow-on disposition.",
        ...failures.sort(),
      ].join("\n"),
    );
  }
}

function main(): void {
  try {
    auditOpenShellSandboxObservationSources(collectOpenShellSandboxObservationSources());
    process.stdout.write(
      `Verified ${Object.keys(OPEN_SHELL_SANDBOX_OBSERVATION_DISPOSITIONS).length} ` +
        "OpenShell sandbox observation dispositions.\n",
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main();
}

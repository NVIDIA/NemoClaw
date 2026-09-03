// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

type Violation = {
  file: string;
  line: number;
  column: number;
  rule: string;
  detail: string;
};

type ImportRef = {
  specifier: string;
  line: number;
  column: number;
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const SKIP_DIRS = new Set([".git", "coverage", "dist", "node_modules"]);
const PROVIDER_NEUTRAL_MANAGED_RUNTIME_MODULES = [
  "src/lib/actions/sandbox/connect.ts",
  "src/lib/actions/sandbox/destroy-presence.ts",
  "src/lib/actions/sandbox/launch-readiness.ts",
  "src/lib/actions/sandbox/process-recovery.ts",
  "src/lib/actions/sandbox/snapshot/backup-authority.ts",
  "src/lib/actions/sandbox/rebuild-flow-helpers.ts",
  "src/lib/actions/sandbox/sandbox-gateway-routing.ts",
  "src/lib/actions/sandbox/status-preflight.ts",
  "src/lib/actions/sandbox/status-snapshot.ts",
  "src/lib/actions/sandbox/stopped-sandbox-backup.ts",
  "src/lib/actions/sandbox/supervisor-relaunch.ts",
  "src/lib/actions/sandbox/terminal-runtime-health.ts",
  "src/lib/onboard/compute/plan.ts",
  "src/lib/onboard/docker-driver-gateway-env.ts",
  "src/lib/onboard/docker-driver-gateway-config.ts",
  "src/lib/onboard/docker-driver-gateway-local-tls.ts",
  "src/lib/onboard/docker-driver-gateway-process-identity.ts",
  "src/lib/onboard/docker-driver-gateway-runtime.ts",
  "src/lib/onboard/fatal-runtime-preflight.ts",
  "src/lib/onboard/gateway-sandbox-reachability.ts",
  "src/lib/onboard/host-gateway-process.ts",
  "src/lib/onboard/host-service-reachability.ts",
  "src/lib/onboard/managed-workload/hermes-state-volume.ts",
  "src/lib/onboard/sandbox-create/orchestration.ts",
  "src/lib/adapters/sandbox/command-transport.ts",
  "src/lib/sandbox/config.ts",
  "src/lib/sandbox/privileged-exec.ts",
  "src/lib/state/registry/lifecycle-generation.ts",
] as const;
const MANAGED_STATE_ROOT_PROVIDER_MODULES = [
  "src/lib/onboard/managed-bootstrap/docker.ts",
  "src/lib/onboard/managed-bootstrap/podman-runtime.ts",
] as const;
const MANAGED_AGENT_IDS = new Set(["openclaw", "hermes", "langchain-deepagents-code", "pi"]);

function toRepoPath(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

function isProductionTsFile(absPath: string): boolean {
  return (
    /\.(?:cts|mts|ts|tsx)$/.test(absPath) && !/\.(?:test|spec)\.(?:cts|mts|ts|tsx)$/.test(absPath)
  );
}

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  const rootStats = lstatSync(dir);
  if (rootStats.isSymbolicLink()) return;
  if (rootStats.isFile()) {
    if (isProductionTsFile(dir)) yield dir;
    return;
  }
  if (!rootStats.isDirectory()) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(absPath);
    } else if (entry.isFile() && isProductionTsFile(absPath)) {
      yield absPath;
    }
  }
}

function sourceFileFor(absPath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    absPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function position(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: pos.line + 1, column: pos.character + 1 };
}

function collectImportRefs(sourceFile: ts.SourceFile): ImportRef[] {
  const refs: ImportRef[] = [];

  function add(specifier: string, node: ts.Node): void {
    const pos = position(sourceFile, node);
    refs.push({ specifier, ...pos });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text, node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      add(node.arguments[0].text, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return refs;
}

function collectPreprocessedImportRefs(source: string): ImportRef[] {
  let line = 1;
  let lineStart = 0;
  let searchStart = 0;
  return ts.preProcessFile(source, true, true).importedFiles.map((ref) => {
    let newline = source.indexOf("\n", searchStart);
    while (newline >= 0 && newline < ref.pos) {
      line += 1;
      lineStart = newline + 1;
      searchStart = lineStart;
      newline = source.indexOf("\n", searchStart);
    }
    return {
      specifier: ref.fileName,
      line,
      column: ref.pos - lineStart + 1,
    };
  });
}

function resolveInternalImport(fromAbsPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromAbsPath), specifier);
  const extensions = [".ts", ".tsx", ".mts", ".cts"];
  const extension = path.extname(base);
  const replacementExtensions =
    extension === ".js"
      ? [".ts", ".tsx"]
      : extension === ".mjs"
        ? [".mts"]
        : extension === ".cjs"
          ? [".cts"]
          : [];
  const candidates = extension
    ? [
        base,
        ...replacementExtensions.map(
          (replacement) => base.slice(0, -extension.length) + replacement,
        ),
      ]
    : [
        ...extensions.map((candidate) => `${base}${candidate}`),
        ...extensions.map((candidate) => path.join(base, `index${candidate}`)),
      ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    const replacement = replacementExtensions[0];
    return toRepoPath(
      replacement
        ? base.slice(0, -extension.length) + replacement
        : extension
          ? base
          : `${base}.ts`,
    );
  }
  try {
    return toRepoPath(realpathSync(found));
  } catch {
    return toRepoPath(found);
  }
}

function isDomainFile(repoPath: string): boolean {
  return repoPath.startsWith("src/lib/domain/");
}

function isAdapterFile(repoPath: string): boolean {
  return repoPath.startsWith("src/lib/adapters/");
}

function isCommandFile(repoPath: string): boolean {
  return repoPath.startsWith("src/commands/");
}

function isMessagingManifestFile(repoPath: string): boolean {
  return repoPath.startsWith("src/lib/messaging/manifest/");
}

function isActionFile(repoPath: string): boolean {
  if (repoPath.startsWith("src/lib/actions/")) return true;
  return /(^|\/)[^/]+-actions?\.(?:cts|mts|ts|tsx)$/.test(repoPath);
}

function importTargetsForbiddenLayer(
  fromAbsPath: string,
  ref: ImportRef,
  forbiddenPrefixes: readonly string[],
  forbiddenActionFiles = false,
): string | null {
  const target = resolveInternalImport(fromAbsPath, ref.specifier);
  if (!target) return null;
  if (forbiddenPrefixes.some((prefix) => target.startsWith(prefix))) return target;
  if (forbiddenActionFiles && isActionFile(target)) return target;
  return null;
}

function addViolation(
  violations: Violation[],
  file: string,
  line: number,
  column: number,
  rule: string,
  detail: string,
): void {
  violations.push({ file, line, column, rule, detail });
}

function checkDomainFile(
  absPath: string,
  repoPath: string,
  sourceFile: ts.SourceFile,
  imports: readonly ImportRef[],
  violations: Violation[],
): void {
  for (const ref of imports) {
    if (ref.specifier === "@oclif/core") {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "domain-purity",
        "domain must not import @oclif/core",
      );
    }
    if (ref.specifier === "node:child_process" || ref.specifier === "child_process") {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "domain-purity",
        "domain must not spawn child processes",
      );
    }
    const target = importTargetsForbiddenLayer(
      absPath,
      ref,
      ["src/lib/adapters/", "src/commands/", "src/lib/cli/"],
      true,
    );
    if (target) {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "domain-purity",
        `domain must not import ${target}`,
      );
    }
  }
  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "exit"
    ) {
      const pos = position(sourceFile, node);
      addViolation(
        violations,
        repoPath,
        pos.line,
        pos.column,
        "domain-purity",
        "domain must not call process.exit",
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function checkActionFile(
  repoPath: string,
  imports: readonly ImportRef[],
  violations: Violation[],
): void {
  for (const ref of imports) {
    if (ref.specifier === "@oclif/core") {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "actions-no-oclif",
        "actions must not import @oclif/core",
      );
    }
  }
}

function checkAdapterFile(
  absPath: string,
  repoPath: string,
  imports: readonly ImportRef[],
  violations: Violation[],
): void {
  for (const ref of imports) {
    const target = importTargetsForbiddenLayer(absPath, ref, ["src/commands/"], true);
    if (target) {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "adapters-no-workflows",
        `adapters must not import command/action layer module ${target}`,
      );
    }
  }
}

function checkNoBinLibShimImport(
  absPath: string,
  repoPath: string,
  imports: readonly ImportRef[],
  violations: Violation[],
): void {
  for (const ref of imports) {
    const target = resolveInternalImport(absPath, ref.specifier);
    if (target?.startsWith("bin/lib/") && !target.endsWith(".json")) {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "src-no-bin-lib-shims",
        `src must import implementation modules directly instead of packaged shim ${target}`,
      );
    }
  }
}

function checkMessagingManifestFile(
  absPath: string,
  repoPath: string,
  imports: readonly ImportRef[],
  violations: Violation[],
): void {
  const forbiddenFragments = [
    "gateway",
    "state/registry",
    "credentials",
    "node:fs",
    "node:child_process",
    "child_process",
    "adapters/openshell",
    "src/commands",
    "lib/actions",
  ];

  for (const ref of imports) {
    if (ref.specifier === "fs" || ref.specifier.startsWith("fs/")) {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "messaging-manifest-purity",
        "messaging manifest modules must not import fs",
      );
      continue;
    }
    const target = resolveInternalImport(absPath, ref.specifier);
    const haystack = `${ref.specifier}\n${target ?? ""}`;
    const fragment = forbiddenFragments.find((candidate) => haystack.includes(candidate));
    if (fragment) {
      addViolation(
        violations,
        repoPath,
        ref.line,
        ref.column,
        "messaging-manifest-purity",
        `messaging manifest modules must not import ${fragment}`,
      );
    }
  }
}

function checkCommandFile(
  absPath: string,
  repoPath: string,
  sourceFile: ts.SourceFile,
  violations: Violation[],
): void {
  const identifierBases = new Set<string>();
  const namespaceBases = new Map<string, ReadonlySet<string>>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly
    ) {
      continue;
    }

    const moduleSpecifier = statement.moduleSpecifier.text;
    const exportedBases =
      moduleSpecifier === "@oclif/core"
        ? new Set(["Command"])
        : resolveInternalImport(absPath, moduleSpecifier) ===
            "src/lib/cli/nemoclaw-oclif-command.ts"
          ? new Set(["NemoClawCommand"])
          : null;
    if (!exportedBases) continue;

    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (binding.isTypeOnly) continue;
        const importedName = binding.propertyName?.text ?? binding.name.text;
        if (exportedBases.has(importedName)) identifierBases.add(binding.name.text);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaceBases.set(bindings.name.text, exportedBases);
    }
  }

  function isCommandBase(expression: ts.ExpressionWithTypeArguments): boolean {
    const base = expression.expression;
    if (ts.isIdentifier(base)) return identifierBases.has(base.text);
    return (
      ts.isPropertyAccessExpression(base) &&
      ts.isIdentifier(base.expression) &&
      namespaceBases.get(base.expression.text)?.has(base.name.text) === true
    );
  }

  const commandClassCount = sourceFile.statements.filter(
    (statement) =>
      ts.isClassDeclaration(statement) &&
      statement.heritageClauses?.some(
        (clause) =>
          clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.some(isCommandBase),
      ),
  ).length;
  if (commandClassCount !== 1) {
    addViolation(
      violations,
      repoPath,
      1,
      1,
      "one-command-per-file",
      `command files must define exactly one registered oclif command class; found ${commandClassCount}`,
    );
  }
}

export function findLayerImportBoundaryViolations(root = SRC_ROOT): Violation[] {
  const violations: Violation[] = [];
  for (const absPath of walk(root)) {
    const repoPath = toRepoPath(absPath);
    const domainFile = isDomainFile(repoPath);
    const actionFile = isActionFile(repoPath);
    const adapterFile = isAdapterFile(repoPath);
    const messagingManifestFile = isMessagingManifestFile(repoPath);
    const commandFile = isCommandFile(repoPath);
    const source = readFileSync(absPath, "utf8");
    if (!domainFile && !actionFile && !adapterFile && !messagingManifestFile && !commandFile) {
      checkNoBinLibShimImport(absPath, repoPath, collectPreprocessedImportRefs(source), violations);
      continue;
    }
    const sourceFile = sourceFileFor(absPath, source);
    const imports = collectImportRefs(sourceFile);
    checkNoBinLibShimImport(absPath, repoPath, imports, violations);
    if (domainFile) {
      checkDomainFile(absPath, repoPath, sourceFile, imports, violations);
    }
    if (actionFile) checkActionFile(repoPath, imports, violations);
    if (adapterFile) checkAdapterFile(absPath, repoPath, imports, violations);
    if (messagingManifestFile) {
      checkMessagingManifestFile(absPath, repoPath, imports, violations);
    }
    if (commandFile) checkCommandFile(absPath, repoPath, sourceFile, violations);
  }
  return violations;
}

export function findManagedRuntimeBoundaryViolations(): Violation[] {
  const violations: Violation[] = [];
  const isProviderImplementationImport = (specifier: string): boolean =>
    /(?:^|\/)runtime-provider\/(?:docker|podman)(?:[-/.]|$)/.test(specifier);
  const isProviderName = (node: ts.Node): boolean =>
    ts.isStringLiteralLike(node) && (node.text === "docker" || node.text === "podman");
  const isEqualityOperator = (kind: ts.SyntaxKind): boolean =>
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;

  for (const repoPath of PROVIDER_NEUTRAL_MANAGED_RUNTIME_MODULES) {
    const absPath = path.join(REPO_ROOT, repoPath);
    const sourceFile = sourceFileFor(absPath, readFileSync(absPath, "utf8"));
    const isProviderIdentity = (node: ts.Node): boolean => {
      const expression = node.getText(sourceFile);
      // OPENSHELL_DRIVERS is the upstream gateway driver's configuration,
      // not NemoClaw's opaque runtime-provider identity.
      return (
        !/OPENSHELL_DRIVERS/.test(expression) &&
        /(?:provider|engine|openshellDriver|sandboxDriver|driver)/i.test(expression)
      );
    };
    const report = (node: ts.Node, detail: string): void => {
      const pos = position(sourceFile, node);
      addViolation(
        violations,
        repoPath,
        pos.line,
        pos.column,
        "managed-runtime-neutrality",
        detail,
      );
    };
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        isProviderImplementationImport(node.moduleSpecifier.text)
      ) {
        report(
          node.moduleSpecifier,
          "generic managed runtime code must not import a provider implementation",
        );
      }
      if (
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) &&
          node.expression.text === "isPodmanGatewayRuntimeEnabled") ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "isPodmanGatewayRuntimeEnabled"))
      ) {
        report(node.expression, "generic managed runtime code must not branch on native Podman");
      }
      if (
        ts.isBinaryExpression(node) &&
        isEqualityOperator(node.operatorToken.kind) &&
        ((isProviderName(node.left) && isProviderIdentity(node.right)) ||
          (isProviderName(node.right) && isProviderIdentity(node.left)))
      ) {
        report(node, "generic managed runtime code must not compare an opaque provider identity");
      }
      if (
        ts.isCaseClause(node) &&
        isProviderName(node.expression) &&
        ts.isSwitchStatement(node.parent.parent) &&
        isProviderIdentity(node.parent.parent.expression)
      ) {
        report(
          node.expression,
          "generic managed runtime code must not switch on an opaque provider identity",
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const managedBootstrapFiles = [
    ...walk(path.join(SRC_ROOT, "lib/onboard/managed-bootstrap")),
  ].filter((absPath) => !path.basename(absPath).includes("test-fixture"));
  const podmanProviderFiles = [...walk(path.join(SRC_ROOT, "lib/onboard/runtime-provider"))].filter(
    (absPath) => path.basename(absPath).startsWith("podman"),
  );
  for (const absPath of [...managedBootstrapFiles, ...podmanProviderFiles]) {
    const repoPath = toRepoPath(absPath);
    const sourceFile = sourceFileFor(absPath, readFileSync(absPath, "utf8"));
    const report = (node: ts.Node, detail: string): void => {
      const pos = position(sourceFile, node);
      addViolation(
        violations,
        repoPath,
        pos.line,
        pos.column,
        "managed-state-root-neutrality",
        detail,
      );
    };
    for (const ref of collectImportRefs(sourceFile)) {
      const target = resolveInternalImport(absPath, ref.specifier);
      if (
        podmanProviderFiles.includes(absPath) &&
        target &&
        /(?:^|\/)(?:hermes|openclaw)(?:[-/.]|$)/u.test(target)
      ) {
        addViolation(
          violations,
          repoPath,
          ref.line,
          ref.column,
          "managed-state-root-neutrality",
          `Podman provider code must not import agent implementation ${target}`,
        );
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && MANAGED_AGENT_IDS.has(node.text)) {
        report(node, "managed bootstrap and Podman provider code must not encode agent IDs");
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  for (const repoPath of MANAGED_STATE_ROOT_PROVIDER_MODULES) {
    const absPath = path.join(REPO_ROOT, repoPath);
    const sourceFile = sourceFileFor(absPath, readFileSync(absPath, "utf8"));
    const ownsGenericStateRootPreparation = collectImportRefs(sourceFile).some(
      (ref) =>
        resolveInternalImport(absPath, ref.specifier) ===
        "src/lib/onboard/managed-bootstrap/state-root-authority.ts",
    );
    if (!ownsGenericStateRootPreparation) {
      addViolation(
        violations,
        repoPath,
        1,
        1,
        "managed-state-root-neutrality",
        "managed provider bootstrap must consume the generic state-root authority operation",
      );
    }
  }
  return violations;
}

function main(): void {
  const violations = [
    ...findLayerImportBoundaryViolations(),
    ...findManagedRuntimeBoundaryViolations(),
  ];
  if (violations.length > 0) {
    const formatted = violations
      .map(
        (violation) =>
          `${violation.file}:${String(violation.line)}:${String(violation.column)} ${violation.rule}: ${violation.detail}`,
      )
      .join("\n");
    console.error(`Layer import boundary violations:\n${formatted}`);
    process.exit(1);
  }
  console.log("Layer import boundaries passed.");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  main();
}

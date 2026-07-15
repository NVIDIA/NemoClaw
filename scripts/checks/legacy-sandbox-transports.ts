// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Freezes the statically recognizable direct host-to-sandbox transport surface
 * and the reviewed gRPC-to-CLI read-only fallback importers while NemoClaw
 * moves to OpenShell's gRPC API. Literal calls, same-file immutable aliases,
 * and fallback importers must be removed or re-reviewed explicitly. This check
 * is a review tripwire, not a general-purpose data-flow analysis.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type LegacySandboxTransportKind =
  | "docker-exec-command"
  | "docker-exec-builder"
  | "grpc-cli-read-only-fallback"
  | "openshell-ssh-config"
  | "privileged-sandbox-exec"
  | "ssh-command"
  | "ssh-temp-config"
  | "sshfs-command";

export interface LegacySandboxTransportSite {
  relativePath: string;
  kind: LegacySandboxTransportKind;
  calls: number;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type ReviewedSiteTuple = readonly [string, LegacySandboxTransportKind, number];

const REVIEWED_SITE_TUPLES = [
  ["src/lib/actions/sandbox/sessions/passthrough.ts", "grpc-cli-read-only-fallback", 1],
  ["src/lib/actions/sandbox/process-recovery.ts", "grpc-cli-read-only-fallback", 1],
  ["src/lib/actions/sandbox/process-recovery.ts", "privileged-sandbox-exec", 2],
  ["src/lib/actions/sandbox/snapshot.ts", "grpc-cli-read-only-fallback", 1],
  ["src/lib/diagnostics/debug.ts", "grpc-cli-read-only-fallback", 1],
  ["src/lib/sandbox/config.ts", "privileged-sandbox-exec", 2],
  ["src/lib/sandbox/version.ts", "grpc-cli-read-only-fallback", 1],
  ["src/lib/share-command-deps.ts", "grpc-cli-read-only-fallback", 1],
  ["src/lib/share-command-deps.ts", "openshell-ssh-config", 1],
  ["src/lib/share-command.ts", "sshfs-command", 1],
  ["src/lib/shields/index.ts", "privileged-sandbox-exec", 4],
  ["src/lib/shields/mutable-config-repair.ts", "privileged-sandbox-exec", 2],
  ["src/lib/state/openclaw-plugin-restore.ts", "grpc-cli-read-only-fallback", 1],
  ["src/lib/state/sandbox.ts", "grpc-cli-read-only-fallback", 1],
  ["src/lib/state/user-managed-files-probe.ts", "grpc-cli-read-only-fallback", 1],
] as const satisfies readonly ReviewedSiteTuple[];

export const REVIEWED_LEGACY_SANDBOX_TRANSPORT_SITES: readonly LegacySandboxTransportSite[] =
  REVIEWED_SITE_TUPLES.map(([relativePath, kind, calls]) => ({ relativePath, kind, calls }));

const HELPER_KINDS = new Map<string, LegacySandboxTransportKind>([
  ["captureSandboxSshConfig", "openshell-ssh-config"],
  ["captureSandboxSshConfigCommand", "openshell-ssh-config"],
  ["createTempSshConfig", "ssh-temp-config"],
  ["dockerExecArgv", "docker-exec-builder"],
  ["privilegedSandboxExecArgv", "privileged-sandbox-exec"],
]);

const COMMAND_CALLS = new Set([
  "execFile",
  "execFileSync",
  "run",
  "runCapture",
  "runCaptureImpl",
  "runSync",
  "spawn",
  "spawnSync",
]);

const DOCKER_COMMAND_CALLS = new Set([
  "dockerCapture",
  "dockerExecFileSync",
  "dockerRun",
  "dockerSpawn",
  "dockerSpawnSync",
  "runDocker",
]);

const NON_SANDBOX_SSH_ROOTS = ["src/lib/deploy/"] as const;

function productionTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(entryPath);
    if (
      !entry.isFile() ||
      !/\.[cm]?ts$/u.test(entry.name) ||
      /\.(?:test|spec)\.[cm]?ts$/u.test(entry.name)
    ) {
      return [];
    }
    return [entryPath];
  });
}

function repoPath(repoRoot: string, sourcePath: string): string {
  return path.relative(repoRoot, sourcePath).split(path.sep).join("/");
}

function expressionName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

type ConstBindings = ReadonlyMap<string, ts.Expression | null>;

function collectConstBindings(sourceFile: ts.SourceFile): ConstBindings {
  const bindings = new Map<string, ts.Expression | null>();

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const name = node.name.text;
      bindings.set(name, bindings.has(name) ? null : node.initializer);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return bindings;
}

function resolveAlias(
  expression: ts.Expression,
  bindings: ConstBindings,
  seen = new Set<string>(),
): ts.Expression {
  if (!ts.isIdentifier(expression) || seen.has(expression.text)) return expression;
  const binding = bindings.get(expression.text);
  if (!binding) return expression;
  seen.add(expression.text);
  return resolveAlias(binding, bindings, seen);
}

function resolvedExpressionName(expression: ts.Expression, bindings: ConstBindings): string | null {
  return expressionName(resolveAlias(expression, bindings));
}

function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function commandFromArgument(
  argument: ts.Expression | undefined,
  bindings: ConstBindings,
): string | null {
  if (!argument) return null;
  const resolved = resolveAlias(argument, bindings);
  const direct = literalText(resolved);
  if (direct) return direct;
  if (!ts.isArrayLiteralExpression(resolved)) return null;
  const first = resolved.elements[0];
  return first && ts.isExpression(first) ? literalText(resolveAlias(first, bindings)) : null;
}

function increment(
  counts: Map<LegacySandboxTransportKind, number>,
  kind: LegacySandboxTransportKind,
) {
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}

function isSandboxControlRoutingModule(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    ts.isStringLiteralLike(node) &&
    /(?:^|\/)sandbox-control-routing(?:\.js)?$/u.test(node.text)
  );
}

function scanSource(
  relativePath: string,
  sourceText: string,
): Map<LegacySandboxTransportKind, number> {
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const counts = new Map<LegacySandboxTransportKind, number>();
  const bindings = collectConstBindings(sourceFile);

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      isSandboxControlRoutingModule(node.moduleSpecifier) &&
      node.importClause &&
      !node.importClause.isTypeOnly &&
      ((node.importClause.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) ||
        (node.importClause.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.some(
            (specifier) =>
              !specifier.isTypeOnly &&
              (specifier.propertyName?.text ?? specifier.name.text) ===
                "execSandboxReadOnlyWithGrpcFallback",
          )))
    ) {
      increment(counts, "grpc-cli-read-only-fallback");
    }

    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      isSandboxControlRoutingModule(node.moduleSpecifier) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.some(
        (specifier) =>
          !specifier.isTypeOnly &&
          (specifier.propertyName?.text ?? specifier.name.text) ===
            "execSandboxReadOnlyWithGrpcFallback",
      )
    ) {
      increment(counts, "grpc-cli-read-only-fallback");
    }

    if (ts.isArrayLiteralExpression(node)) {
      const first = literalText(node.elements[0]);
      const second = literalText(node.elements[1]);
      if (first === "docker" && second === "exec") {
        increment(counts, "docker-exec-command");
      }
      const openshellCommandIndex =
        first === "--gateway" ? 2 : first?.startsWith("--gateway=") ? 1 : 0;
      if (
        literalText(node.elements[openshellCommandIndex]) === "sandbox" &&
        literalText(node.elements[openshellCommandIndex + 1]) === "ssh-config"
      ) {
        increment(counts, "openshell-ssh-config");
      }
    }

    if (ts.isCallExpression(node)) {
      const name = resolvedExpressionName(node.expression, bindings);
      if (name === "require" && isSandboxControlRoutingModule(node.arguments[0])) {
        increment(counts, "grpc-cli-read-only-fallback");
      }
      const helperKind = name ? HELPER_KINDS.get(name) : undefined;
      if (helperKind) increment(counts, helperKind);
      if (name !== null && DOCKER_COMMAND_CALLS.has(name)) {
        const firstDockerArg = commandFromArgument(node.arguments[0], bindings);
        if (firstDockerArg === "exec") increment(counts, "docker-exec-command");
      }

      const commandArgumentIndex = name === "collect" ? 2 : 0;
      if (name === "collect" || (name !== null && COMMAND_CALLS.has(name))) {
        const command = commandFromArgument(node.arguments[commandArgumentIndex], bindings);
        const scansSandboxSsh = !NON_SANDBOX_SSH_ROOTS.some((root) =>
          relativePath.startsWith(root),
        );
        if (scansSandboxSsh && command === "ssh") increment(counts, "ssh-command");
        if (command === "sshfs") increment(counts, "sshfs-command");
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return counts;
}

export function discoverLegacySandboxTransportSites(
  repoRoot: string,
): LegacySandboxTransportSite[] {
  return ["src", "nemoclaw/src"]
    .flatMap((sourceRoot) => productionTypeScriptFiles(path.join(repoRoot, sourceRoot)))
    .flatMap((sourcePath) => {
      const relativePath = repoPath(repoRoot, sourcePath);
      return [...scanSource(relativePath, readFileSync(sourcePath, "utf8"))].map(
        ([kind, calls]) => ({ relativePath, kind, calls }),
      );
    })
    .sort(
      (left, right) =>
        left.relativePath.localeCompare(right.relativePath) || left.kind.localeCompare(right.kind),
    );
}

function siteKey(site: Pick<LegacySandboxTransportSite, "relativePath" | "kind">): string {
  return `${site.relativePath}:${site.kind}`;
}

export function auditLegacySandboxTransports(
  repoRoot = REPO_ROOT,
  reviewedSites: readonly LegacySandboxTransportSite[] = REVIEWED_LEGACY_SANDBOX_TRANSPORT_SITES,
): string[] {
  const violations: string[] = [];
  const discovered = new Map(
    discoverLegacySandboxTransportSites(repoRoot).map((site) => [siteKey(site), site]),
  );

  for (const reviewed of reviewedSites) {
    const key = siteKey(reviewed);
    const current = discovered.get(key);
    if (!current) {
      violations.push(`${key}: reviewed transport use is gone; remove this allowlist entry`);
    } else if (current.calls !== reviewed.calls) {
      violations.push(`${key}: expected ${reviewed.calls} reviewed use(s), found ${current.calls}`);
    }
    discovered.delete(key);
  }

  for (const site of discovered.values()) {
    violations.push(`${siteKey(site)}: found ${site.calls} unreviewed transport use(s)`);
  }

  return violations;
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const violations = auditLegacySandboxTransports();
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }

  console.log(
    "Legacy sandbox transports and gRPC-to-CLI fallback importers match the reviewed inventory.",
  );
}

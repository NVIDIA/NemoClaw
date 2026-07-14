// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Freezes the direct host-to-sandbox transport surface while NemoClaw moves to
 * OpenShell's gRPC API. Every reviewed site must be removed or re-reviewed
 * explicitly; new SSH, SSHFS, or Docker-exec bypasses fail repository checks.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type LegacySandboxTransportKind =
  | "docker-exec-command"
  | "docker-exec-builder"
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
  ["src/lib/actions/sandbox/process-recovery.ts", "privileged-sandbox-exec", 2],
  ["src/lib/sandbox/config.ts", "privileged-sandbox-exec", 2],
  ["src/lib/share-command-deps.ts", "openshell-ssh-config", 1],
  ["src/lib/share-command.ts", "sshfs-command", 1],
  ["src/lib/shields/index.ts", "privileged-sandbox-exec", 4],
  ["src/lib/shields/mutable-config-repair.ts", "privileged-sandbox-exec", 2],
] as const satisfies readonly ReviewedSiteTuple[];

export const REVIEWED_LEGACY_SANDBOX_TRANSPORT_SITES: readonly LegacySandboxTransportSite[] =
  REVIEWED_SITE_TUPLES.map(([relativePath, kind, calls]) => ({ relativePath, kind, calls }));

const HELPER_KINDS = new Map<string, LegacySandboxTransportKind>([
  ["createTempSshConfig", "ssh-temp-config"],
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

function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function commandFromArgument(argument: ts.Expression | undefined): string | null {
  if (!argument) return null;
  const direct = literalText(argument);
  if (direct) return direct;
  if (!ts.isArrayLiteralExpression(argument)) return null;
  return literalText(argument.elements[0]);
}

function increment(
  counts: Map<LegacySandboxTransportKind, number>,
  kind: LegacySandboxTransportKind,
) {
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
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

  function visit(node: ts.Node): void {
    if (ts.isArrayLiteralExpression(node)) {
      const first = literalText(node.elements[0]);
      const second = literalText(node.elements[1]);
      if (first === "docker" && second === "exec") {
        increment(counts, "docker-exec-command");
      }
      if (first === "sandbox" && second === "ssh-config") {
        increment(counts, "openshell-ssh-config");
      }
    }

    if (ts.isCallExpression(node)) {
      const name = expressionName(node.expression);
      const helperKind = name ? HELPER_KINDS.get(name) : undefined;
      if (helperKind) increment(counts, helperKind);
      if (name !== null && DOCKER_COMMAND_CALLS.has(name)) {
        const firstDockerArg = commandFromArgument(node.arguments[0]);
        if (firstDockerArg === "exec") increment(counts, "docker-exec-command");
      }

      const commandArgumentIndex = name === "collect" ? 2 : 0;
      if (name === "collect" || (name !== null && COMMAND_CALLS.has(name))) {
        const command = commandFromArgument(node.arguments[commandArgumentIndex]);
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
      violations.push(`${key}: reviewed legacy transport is gone; remove this allowlist entry`);
    } else if (current.calls !== reviewed.calls) {
      violations.push(
        `${key}: expected ${reviewed.calls} reviewed call(s), found ${current.calls}`,
      );
    }
    discovered.delete(key);
  }

  for (const site of discovered.values()) {
    violations.push(`${siteKey(site)}: found ${site.calls} unreviewed legacy transport call(s)`);
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

  console.log("Legacy sandbox SSH, SSHFS, and Docker-exec sites match the reviewed inventory.");
}

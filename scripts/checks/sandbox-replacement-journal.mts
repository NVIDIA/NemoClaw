// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface AuditedDeleteSite {
  readonly relativePath: string;
  readonly expectedCalls: number;
  readonly reason: string;
}

export const SANDBOX_DELETE_SITES: readonly AuditedDeleteSite[] = [
  {
    relativePath: "src/lib/actions/sandbox/destroy-execution.ts",
    expectedCalls: 1,
    reason: "explicit destroy; removes the sandbox rather than replacing it",
  },
  {
    relativePath: "src/lib/actions/sandbox/rebuild-destroy-phase.ts",
    expectedCalls: 1,
    reason: "rebuild replacement; journaled by the recreate transaction",
  },
  {
    relativePath: "src/lib/actions/sandbox/snapshot.ts",
    expectedCalls: 1,
    reason: "snapshot restore; destination-only teardown",
  },
  {
    relativePath: "src/lib/actions/uninstall/run-plan.ts",
    expectedCalls: 2,
    reason: "uninstall; removes every sandbox rather than replacing one",
  },
  {
    relativePath: "src/lib/onboard.ts",
    expectedCalls: 1,
    reason: "onboard replacement; guarded by recreateRuntime.beginDelete",
  },
  {
    relativePath: "src/lib/onboard/cancel-rollback.ts",
    expectedCalls: 1,
    reason: "compensation for a sandbox this run created",
  },
  {
    relativePath: "src/lib/onboard/dashboard.ts",
    expectedCalls: 1,
    reason: "compensation for a sandbox this run created",
  },
  {
    relativePath: "src/lib/onboard/hermes-dashboard.ts",
    expectedCalls: 1,
    reason: "compensation for a sandbox this run created",
  },
  {
    relativePath: "src/lib/onboard/messaging-host-forward.ts",
    expectedCalls: 1,
    reason: "compensation for a sandbox this run created",
  },
  {
    relativePath: "src/lib/onboard/sandbox-gpu-create-attempt.ts",
    expectedCalls: 1,
    reason: "compensation for a failed GPU create attempt",
  },
  {
    relativePath: "src/lib/onboard/sandbox-gpu-create-run-attempt.ts",
    expectedCalls: 1,
    reason: "compensation for a failed GPU create attempt",
  },
  {
    relativePath: "src/lib/onboard/sandbox-reuse.ts",
    expectedCalls: 1,
    reason: "resume repair; refused without a recreate transaction",
  },
];

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
      found.push(full);
    }
  };
  walk(root);
  return found;
}

function literalText(node: ts.Expression): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function countSandboxDeleteCalls(source: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const words = node.elements.map(literalText);
      const sandboxIndex = words.indexOf("sandbox");
      if (sandboxIndex >= 0 && words[sandboxIndex + 1] === "delete") count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

export function auditSandboxDeleteSites(repoRoot: string = REPO_ROOT): string[] {
  const expected = new Map(SANDBOX_DELETE_SITES.map((site) => [site.relativePath, site]));
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const file of sourceFiles(path.join(repoRoot, "src", "lib"))) {
    const relativePath = path.relative(repoRoot, file).split(path.sep).join("/");
    const source = ts.createSourceFile(
      relativePath,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
    );
    const calls = countSandboxDeleteCalls(source);
    if (calls === 0) continue;
    seen.add(relativePath);
    const site = expected.get(relativePath);
    if (!site) {
      problems.push(
        `${relativePath}: ${String(calls)} unaccounted 'sandbox delete' call site(s). Route same-name replacement through the recreate transaction, then record the site in scripts/checks/sandbox-replacement-journal.mts.`,
      );
      continue;
    }
    if (calls !== site.expectedCalls) {
      problems.push(
        `${relativePath}: expected ${String(site.expectedCalls)} 'sandbox delete' call site(s), found ${String(calls)}.`,
      );
    }
  }

  for (const site of SANDBOX_DELETE_SITES) {
    if (!seen.has(site.relativePath)) {
      problems.push(
        `${site.relativePath}: recorded 'sandbox delete' call site is gone. Remove it from scripts/checks/sandbox-replacement-journal.mts.`,
      );
    }
  }

  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = auditSandboxDeleteSites();
  if (problems.length > 0) {
    console.error("Same-name sandbox replacement audit failed:");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log(
    `Same-name sandbox replacement audit passed (${String(SANDBOX_DELETE_SITES.length)} recorded call sites).`,
  );
}

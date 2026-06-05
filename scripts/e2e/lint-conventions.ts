#!/usr/bin/env tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E convention lint.
 *
 * Enforces conventions for `test/e2e-scenario/validation_suites/**` step scripts and
 * keeps the new typed scenario suite isolated under `test/e2e-scenario/**`.
 * Existing top-level `test/e2e/test-*.sh` entrypoints remain valid until a
 * separate migration explicitly retires them.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Rule {
  id: string;
  describe: string;
  test: (body: string) => string | null;
}

const STEP_RULES: Rule[] = [
  {
    id: "no-noninteractive-reexport",
    describe: "suite step re-exports non-interactive env vars",
    test: (body) => {
      const patterns = [
        /export\s+DEBIAN_FRONTEND\s*=\s*noninteractive/,
        /export\s+NEMOCLAW_NON_INTERACTIVE\s*=\s*1/,
      ];
      for (const p of patterns) {
        if (p.test(body))
          return `matched ${p.source}; non-interactive setup belongs to shared runtime helpers`;
      }
      return null;
    },
  },
  {
    id: "no-own-trap",
    describe: "suite step registers its own trap",
    test: (body) => {
      for (const raw of body.split("\n")) {
        const line = raw.trimStart();
        if (line.startsWith("#")) continue;
        if (/^trap\s+[^#]/.test(line))
          return "registered own trap; cleanup belongs to orchestrators/shared helpers";
      }
      return null;
    },
  },
  {
    id: "no-section-helper",
    describe: "suite step calls section helper directly",
    test: (body) =>
      /^\s*section\s+["']/m.test(body) || /^\s*section\s*\(/m.test(body)
        ? "step calls section; plan/phase output owns sections"
        : null,
  },
  {
    id: "no-tmp-log",
    describe: "suite step writes logs under /tmp",
    test: (body) =>
      /\/tmp\/[^\s'\"]+\.log/.test(body) ? "write logs under E2E_CONTEXT_DIR, not /tmp" : null,
  },
  {
    id: "no-git-rev-parse-root",
    describe: "suite step uses non-standard repo-root discovery",
    test: (body) =>
      /git\s+rev-parse\s+--show-toplevel/.test(body)
        ? "avoid git rev-parse repo-root discovery in suite steps"
        : null,
  },
];

interface LintFinding {
  file: string;
  rule: string;
  message: string;
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function lintSuiteSteps(root: string): LintFinding[] {
  const suitesDir = path.join(root, "test/e2e-scenario/validation_suites");
  const findings: LintFinding[] = [];
  for (const file of walk(suitesDir).filter((entry) => entry.endsWith(".sh"))) {
    const rel = path.relative(root, file);
    const body = fs.readFileSync(file, "utf8");
    for (const rule of STEP_RULES) {
      const message = rule.test(body);
      if (message) findings.push({ file: rel, rule: rule.id, message });
    }
  }
  return findings;
}

function lint(root: string): LintFinding[] {
  return lintSuiteSteps(root);
}

function parseArgs(argv: string[]): { root: string } {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const args = argv.slice(2);
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--root") {
      const value = args.shift();
      if (!value) throw new Error("--root requires a value");
      root = path.resolve(value);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("tsx scripts/e2e/lint-conventions.ts [--root <repo-root>]\n");
      process.exit(0);
    } else if (arg) {
      throw new Error(`unexpected arg: ${arg}`);
    }
  }
  return { root };
}

try {
  const { root } = parseArgs(process.argv);
  const findings = lint(root);
  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(`${finding.file}: ${finding.rule}: ${finding.message}\n`);
    }
    process.exit(1);
  }
  process.stdout.write("e2e convention lint passed\n");
} catch (err) {
  process.stderr.write(`lint-conventions: ${(err as Error).message}\n`);
  process.exit(2);
}

#!/usr/bin/env tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E convention lint.
 *
 * Enforces the migration-spec conventions on
 * `test/e2e/validation_suites/**` step scripts and the
 * `test/e2e/test-*.sh` legacy frontier:
 *
 *   - Suite step scripts MUST NOT re-export non-interactive env vars
 *     (use runtime/lib/env.sh::e2e_env_apply_noninteractive instead).
 *   - Suite step scripts MUST NOT register their own traps
 *     (runtime/lib/cleanup.sh owns teardown).
 *   - Suite step scripts MUST NOT call `section "..."` — filenames carry
 *     the phase label, and e2e_section is emitted by the runner.
 *   - Suite step scripts MUST NOT write to `/tmp/*.log` — use
 *     `$E2E_CONTEXT_DIR/logs/<scenario>/<suite>/<step>.log`.
 *   - Non-standard repo-root discovery (`git rev-parse --show-toplevel`)
 *     is rejected in suite step scripts; use
 *     `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"` and
 *     walk up.
 *
 * Normal PR lint intentionally excludes legacy parity bookkeeping. Generate and
 * validate legacy assertion parity from `.github/workflows/e2e-parity-compare.yaml`
 * when producing a parity report.
 *
 * Invocation:
 *   tsx scripts/e2e/lint-conventions.ts [--root <repo-root>]
 * Exits 0 on success, 1 on violations, 2 on misuse.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

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
          return `matched ${p.source}; use runtime/lib/env.sh::e2e_env_apply_noninteractive`;
      }
      return null;
    },
  },
  {
    id: "no-own-trap",
    describe: "suite step registers its own trap",
    test: (body) => {
      // Ignore commented lines and ignore `trap` inside quoted strings by
      // requiring a leading non-quote character.
      const lines = body.split("\n");
      for (const raw of lines) {
        const line = raw.replace(/^\s+/, "");
        if (line.startsWith("#")) continue;
        if (/^trap\s+[^#]/.test(line)) {
          return "registered own trap; cleanup lives in runtime/lib/cleanup.sh";
        }
      }
      return null;
    },
  },
  {
    id: "no-section-call",
    describe: "suite step calls section/e2e_section",
    test: (body) => {
      const lines = body.split("\n");
      for (const raw of lines) {
        const line = raw.replace(/^\s+/, "");
        if (line.startsWith("#")) continue;
        if (/^section\s+["']/.test(line)) {
          return "calls section; filename carries the phase label";
        }
      }
      return null;
    },
  },
  {
    id: "no-tmp-log",
    describe: "suite step writes to /tmp/*.log",
    test: (body) => {
      if (/>\s*\/tmp\/[^\s]*\.log/.test(body)) {
        return "writes to /tmp/*.log; use $E2E_CONTEXT_DIR/logs/<scenario>/<suite>/<step>.log";
      }
      return null;
    },
  },
  {
    id: "no-git-rev-parse-repo-root",
    describe: "suite step uses `git rev-parse --show-toplevel` for repo root",
    test: (body) => {
      if (/git\s+rev-parse\s+--show-toplevel/.test(body)) {
        return 'use SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" instead';
      }
      return null;
    },
  },
];

interface LintFinding {
  file: string;
  rule: string;
  message: string;
}

function walkShellScripts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith(".sh")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function parseArgs(argv: string[]): { root: string } {
  let root: string | undefined;
  const args = argv.slice(2);
  while (args.length > 0) {
    const a = args.shift()!;
    if (a === "--root") root = args.shift();
    else if (a === "-h" || a === "--help") {
      process.stdout.write("tsx scripts/e2e/lint-conventions.ts [--root <repo-root>]\n");
      process.exit(0);
    } else {
      process.stderr.write(`lint-conventions: unexpected arg: ${a}\n`);
      process.exit(2);
    }
  }
  if (!root) {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    root = path.resolve(scriptDir, "..", "..");
  }
  return { root };
}

function lintSuiteSteps(root: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const suitesRoot = path.join(root, "test/e2e/validation_suites");
  if (!fs.existsSync(suitesRoot)) return findings;
  for (const file of walkShellScripts(suitesRoot)) {
    const body = fs.readFileSync(file, "utf8");
    for (const rule of STEP_RULES) {
      const msg = rule.test(body);
      if (msg) {
        findings.push({
          file: path.relative(root, file),
          rule: rule.id,
          message: msg,
        });
      }
    }
  }
  return findings;
}

function lintRetiredLegacyWrappers(root: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const mapFile = path.join(root, "test/e2e/docs/parity-map.yaml");
  if (!fs.existsSync(mapFile)) return findings;
  const loaded = (yaml.load(fs.readFileSync(mapFile, "utf8")) ?? {}) as {
    scripts?: Record<string, { status?: unknown }>;
  };
  for (const [script, entry] of Object.entries(loaded.scripts ?? {})) {
    if (entry.status !== "retired") continue;
    const file = path.join(root, "test/e2e", script);
    if (!fs.existsSync(file) || !script.endsWith(".sh")) continue;
    const body = fs.readFileSync(file, "utf8");
    if (!/test\/e2e\/runtime\/run-scenario\.sh|runtime\/run-scenario\.sh/.test(body)) {
      findings.push({
        file: `test/e2e/${script}`,
        rule: "retired-wrapper-delegates-to-scenario-runner",
        message: "retired legacy wrapper must delegate to test/e2e/runtime/run-scenario.sh",
      });
    }
    if (
      /^\s*(pass|fail)\s*\(\)|^\s*section\s*\(\)|nemoclaw\s+onboard|bash\s+.*install\.sh/m.test(
        body,
      )
    ) {
      findings.push({
        file: `test/e2e/${script}`,
        rule: "retired-wrapper-no-monolithic-logic",
        message:
          "retired legacy wrapper must not reintroduce pass/fail helpers, install, or onboard logic",
      });
    }
  }
  return findings;
}

function main(): number {
  const { root } = parseArgs(process.argv);
  const findings = [...lintSuiteSteps(root), ...lintRetiredLegacyWrappers(root)];
  if (findings.length === 0) {
    return 0;
  }
  for (const f of findings) {
    process.stderr.write(`${f.file}: [${f.rule}] ${f.message}\n`);
  }
  process.stderr.write(`\ne2e-convention-lint: ${findings.length} violation(s)\n`);
  return 1;
}

process.exit(main());

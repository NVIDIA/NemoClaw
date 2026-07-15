// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Guard: pure unit blocks must not hide inside test/e2e/live/** files.
//
// vitest.config.ts only collects test/e2e/live/**/*.test.ts when live E2E is
// enabled (NEMOCLAW_RUN_LIVE_E2E=1). On PR CI that flag is false, so the entire
// file is uncollected — including any `describe(...)` unit block embedded in it.
// Such blocks are dead weight on PR CI: they read like coverage but never run
// where they could. This is exactly how two mockable regressions stayed
// unguarded (the skill-agent classifiers and the openclaw TUI-correlation
// logic, the latter saved only by a lucky root-level duplicate).
//
// Convention this guard enforces: inside test/e2e/live/**, the vitest unit
// primitive `it(` is banned. Live cases are declared with `test` — directly, or
// (more often) through a gate wrapper assigned from `shouldRunLiveE2E() ? test
// : test.skip` / `test.skipIf(!shouldRunLiveE2E())`, sometimes grouped under
// `describe.sequential(...)`. A live case never needs `it(`; when `it(` appears
// in a live file it is invariably a pure-unit block someone parked there (as
// happened with the skill-agent and messaging classifier blocks). Such a block
// is dead on PR CI and belongs in an importable module + a PR-collected test
// (root test/**, a co-located src/**/*.test.ts, or test/e2e/support/**).
//
// We deliberately do NOT try to flag bare `test(` unit cases: a live test that
// uses module-level helpers legitimately reads as `test("...", async () => …)`
// with no fixture, and is syntactically indistinguishable from a unit case. The
// `it(` ban is the reliable, zero-false-positive line.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_DIR = path.join(REPO_ROOT, "test", "e2e", "live");
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]s)$/;
// Match the vitest unit primitive `it(` — including `it.each(`, `it.only(`,
// `it.skip(`, etc. — as a call at a statement boundary. The leading boundary
// (line start or whitespace) prevents matching inside a custom identifier, and
// requiring a call paren after the optional member keeps non-call references
// from matching.
const IT_PRIMITIVE_PATTERN =
  /(?:^|[\s;{(])it(?:\.(?:each|only|skip|todo|fails|concurrent|sequential))?\s*\(/;

export type LiveUnitBlockViolation = {
  readonly file: string;
  readonly line: number;
  readonly text: string;
};

function toRepoPath(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

function* walkFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const absPath = path.join(dir, entry);
    const stats = statSync(absPath);
    if (stats.isDirectory()) {
      yield* walkFiles(absPath);
    } else if (stats.isFile() && TEST_FILE_PATTERN.test(entry)) {
      yield absPath;
    }
  }
}

export function findLiveUnitBlocks(source: string, file: string): LiveUnitBlockViolation[] {
  const violations: LiveUnitBlockViolation[] = [];
  const lines = source.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? "";
    const trimmed = text.trimStart();
    // Skip import lines (`import { it, test } from "vitest"`) and comments.
    if (trimmed.startsWith("import ") || trimmed.startsWith("//") || trimmed.startsWith("*")) {
      continue;
    }
    if (IT_PRIMITIVE_PATTERN.test(text)) {
      violations.push({ file, line: i + 1, text: trimmed });
    }
  }
  return violations;
}

export function collectLiveUnitBlocks(dir = LIVE_DIR): LiveUnitBlockViolation[] {
  return [...walkFiles(dir)]
    .flatMap((absPath) => findLiveUnitBlocks(readFileSync(absPath, "utf-8"), toRepoPath(absPath)))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function formatViolations(violations: readonly LiveUnitBlockViolation[]): string {
  const out = [
    "Live E2E unit-block guard failed.",
    "",
    "These test/e2e/live/** files use the vitest unit primitive it(...). That glob",
    "is only collected when NEMOCLAW_RUN_LIVE_E2E=1, so an it(...) block never runs",
    "on PR CI — it looks like coverage but guards nothing. Live cases use test(...)",
    "(directly or via a gate wrapper); it(...) in a live file is always a pure-unit",
    "block parked in the wrong place.",
    "",
    "Fix: extract the helper under test into an importable module (src/** or",
    "test/e2e/support/**) and move the it(...) block to a PR-collected project",
    "(root test/**/*.test.ts, a co-located src/**/*.test.ts, or test/e2e/support/**).",
    "Keep the live test importing the shared helper.",
    "",
  ];
  for (const v of violations) {
    out.push(`- ${v.file}:${v.line}  ${v.text}`);
  }
  return out.join("\n");
}

function main(): void {
  const violations = collectLiveUnitBlocks();
  if (violations.length > 0) {
    console.error(formatViolations(violations));
    process.exitCode = 1;
    return;
  }
  console.log("Live E2E unit-block guard passed: no it(...) blocks in test/e2e/live/**.");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main();
}

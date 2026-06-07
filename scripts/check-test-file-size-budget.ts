#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type TestFileSizeBudget = {
  readonly defaultMaxLines: number;
  readonly legacyMaxLines?: Readonly<Record<string, number>>;
};

export type TestFileSizeEntry = {
  readonly file: string;
  readonly lines: number;
};

export type TestFileSizeViolation =
  | {
      readonly kind: "oversized";
      readonly file: string;
      readonly lines: number;
      readonly maxLines: number;
      readonly budgetKind: "default" | "legacy";
    }
  | {
      readonly kind: "legacy-ratchet";
      readonly file: string;
      readonly lines: number;
      readonly maxLines: number;
    }
  | {
      readonly kind: "stale-legacy-budget";
      readonly file: string;
      readonly maxLines: number;
    };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET_PATH = path.join(REPO_ROOT, "ci", "test-file-size-budget.json");
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]s)$/;
const SCAN_ROOTS = ["test", "src", "nemoclaw/src"];
const SKIP_DIRS = new Set([
  ".git",
  ".venv",
  "coverage",
  "dist",
  "docs/_build",
  "nemoclaw/dist",
  "nemoclaw/node_modules",
  "node_modules",
]);

function toRepoPath(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

function isSkipped(absPath: string): boolean {
  const rel = toRepoPath(absPath);
  return [...SKIP_DIRS].some((skipDir) => rel === skipDir || rel.startsWith(`${skipDir}/`));
}

function* walkFiles(dir: string): Generator<string> {
  if (!existsSync(dir) || isSkipped(dir)) return;

  for (const entry of readdirSync(dir)) {
    const absPath = path.join(dir, entry);
    if (isSkipped(absPath)) continue;

    const stats = statSync(absPath);
    if (stats.isDirectory()) {
      yield* walkFiles(absPath);
    } else if (stats.isFile() && TEST_FILE_PATTERN.test(entry)) {
      yield absPath;
    }
  }
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const newlineCount = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  return newlineCount + (/(?:\r\n|\r|\n)$/.test(text) ? 0 : 1);
}

export function collectTestFileSizes(roots = SCAN_ROOTS): TestFileSizeEntry[] {
  return roots
    .flatMap((root) => [...walkFiles(path.join(REPO_ROOT, root))])
    .map((absPath) => ({
      file: toRepoPath(absPath),
      lines: countLines(readFileSync(absPath, "utf-8")),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function assertPositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

export function parseBudget(sourceText: string, filePath = BUDGET_PATH): TestFileSizeBudget {
  const parsed = JSON.parse(sourceText) as {
    readonly defaultMaxLines?: unknown;
    readonly legacyMaxLines?: unknown;
  };
  const defaultMaxLines = assertPositiveInteger(
    parsed.defaultMaxLines,
    `${filePath}: defaultMaxLines`,
  );

  if (parsed.legacyMaxLines !== undefined && !isRecord(parsed.legacyMaxLines)) {
    throw new Error(`${filePath}: legacyMaxLines must be an object when present`);
  }

  const legacyMaxLines: Record<string, number> = {};
  for (const [legacyPath, value] of Object.entries(parsed.legacyMaxLines ?? {})) {
    legacyMaxLines[legacyPath] = assertPositiveInteger(
      value,
      `${filePath}: legacyMaxLines.${legacyPath}`,
    );
  }

  return { defaultMaxLines, legacyMaxLines };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function evaluateTestFileSizeBudget(
  entries: readonly TestFileSizeEntry[],
  budget: TestFileSizeBudget,
): TestFileSizeViolation[] {
  const legacyMaxLines = budget.legacyMaxLines ?? {};
  const seenFiles = new Set(entries.map((entry) => entry.file));
  const violations: TestFileSizeViolation[] = [];

  for (const entry of entries) {
    const legacyMax = legacyMaxLines[entry.file];
    const maxLines = legacyMax ?? budget.defaultMaxLines;
    const budgetKind = legacyMax === undefined ? "default" : "legacy";

    if (entry.lines > maxLines) {
      violations.push({
        kind: "oversized",
        file: entry.file,
        lines: entry.lines,
        maxLines,
        budgetKind,
      });
    } else if (legacyMax !== undefined && entry.lines < legacyMax) {
      violations.push({
        kind: "legacy-ratchet",
        file: entry.file,
        lines: entry.lines,
        maxLines: legacyMax,
      });
    }
  }

  for (const [legacyPath, maxLines] of Object.entries(legacyMaxLines)) {
    if (!seenFiles.has(legacyPath)) {
      violations.push({ kind: "stale-legacy-budget", file: legacyPath, maxLines });
    }
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file));
}

export function formatViolations(
  violations: readonly TestFileSizeViolation[],
  budgetPath = "ci/test-file-size-budget.json",
): string {
  const lines = [
    "Test file size budget failed.",
    "",
    `Default test-file ceiling is configured in ${budgetPath}.`,
    "Split oversized tests into focused files, or ratchet the legacy budget down after shrinking them.",
    "",
  ];

  for (const violation of violations) {
    if (violation.kind === "oversized") {
      lines.push(
        `- ${violation.file}: ${violation.lines} line(s) > ${violation.maxLines} ${violation.budgetKind} budget`,
      );
    } else if (violation.kind === "legacy-ratchet") {
      lines.push(
        `- ${violation.file}: ${violation.lines} line(s) < ${violation.maxLines} legacy budget; lower the budget entry`,
      );
    } else {
      lines.push(
        `- ${violation.file}: legacy budget entry (${violation.maxLines}) has no matching test file; remove it`,
      );
    }
  }

  return lines.join("\n");
}

function main(): void {
  const budget = parseBudget(readFileSync(BUDGET_PATH, "utf-8"), BUDGET_PATH);
  const entries = collectTestFileSizes();
  const violations = evaluateTestFileSizeBudget(entries, budget);

  if (violations.length > 0) {
    console.error(formatViolations(violations));
    process.exitCode = 1;
    return;
  }

  const maxEntry = entries.reduce<TestFileSizeEntry | null>(
    (max, entry) => (max === null || entry.lines > max.lines ? entry : max),
    null,
  );
  const maxText = maxEntry ? `${maxEntry.file} (${maxEntry.lines} lines)` : "no test files";
  console.log(
    `Test file size budget passed: ${entries.length} files scanned; largest is ${maxText}.`,
  );
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main();
}

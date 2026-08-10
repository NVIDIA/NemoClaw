// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { countLines } from "../../scripts/check-test-file-size-budget.mts";
import { collectTestConditionals } from "../../scripts/find-test-conditionals.mts";

export const CODEBASE_GROWTH_BUDGET_FILE = "ci/codebase-growth-budget.json";
export const ONBOARD_ENTRYPOINT = "src/lib/onboard.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const JAVASCRIPT_FILE_RE = /\.(?:js|cjs|mjs)$/;

export type CodebaseGrowthBudget = {
  readonly onboardMaxLines: number;
  readonly javascriptFiles: readonly string[];
  readonly testIfCounts: Readonly<Record<string, number>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function sortedUniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  const entries = value as string[];
  const canonical = [...new Set(entries)].sort((left, right) => left.localeCompare(right));
  if (
    canonical.length !== entries.length ||
    canonical.some((entry, index) => entry !== entries[index])
  ) {
    throw new Error(`${label} must contain sorted unique paths`);
  }
  return entries;
}

export function parseCodebaseGrowthBudget(
  sourceText: string,
  label = CODEBASE_GROWTH_BUDGET_FILE,
): CodebaseGrowthBudget {
  const parsed = JSON.parse(sourceText) as unknown;
  if (!isRecord(parsed)) throw new Error(`${label} must contain an object`);
  const javascriptFiles = sortedUniqueStrings(parsed.javascriptFiles, `${label}.javascriptFiles`);
  if (!isRecord(parsed.testIfCounts))
    throw new Error(`${label}.testIfCounts must contain an object`);
  const entries = Object.entries(parsed.testIfCounts);
  const sorted = [...entries].sort(([left], [right]) => left.localeCompare(right));
  if (entries.some(([file], index) => file !== sorted[index]?.[0])) {
    throw new Error(`${label}.testIfCounts must use sorted paths`);
  }
  const testIfCounts = Object.fromEntries(
    entries.map(([file, count]) => [file, positiveInteger(count, `${label}.testIfCounts.${file}`)]),
  );
  return {
    onboardMaxLines: positiveInteger(parsed.onboardMaxLines, `${label}.onboardMaxLines`),
    javascriptFiles,
    testIfCounts,
  };
}

export function loadCodebaseGrowthBudget(): CodebaseGrowthBudget {
  return parseCodebaseGrowthBudget(
    readFileSync(path.join(REPO_ROOT, CODEBASE_GROWTH_BUDGET_FILE), "utf8"),
  );
}

export function collectRepositoryJavaScriptFiles(): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.js", "*.cjs", "*.mjs"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return output
    .split("\n")
    .filter((file) => JAVASCRIPT_FILE_RE.test(file) && existsSync(path.join(REPO_ROOT, file)))
    .sort((left, right) => left.localeCompare(right));
}

function compareExactPathBudgets(
  current: Readonly<Record<string, number>>,
  budget: Readonly<Record<string, number>>,
  noun: string,
): string[] {
  const violations: string[] = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = budget[file];
    if (allowed === undefined) violations.push(`${file}: ${noun} count ${count} has no budget`);
    else if (count > allowed)
      violations.push(`${file}: ${noun} count ${count} exceeds budget ${allowed}`);
    else if (count < allowed)
      violations.push(`${file}: ${noun} count ${count} is below stale budget ${allowed}`);
  }
  for (const [file, allowed] of Object.entries(budget)) {
    if (current[file] === undefined)
      violations.push(`${file}: stale ${noun} budget ${allowed} has no matching count`);
  }
  return violations;
}

export function evaluateJavaScriptFileContract(
  currentFiles: readonly string[],
  allowedFiles: readonly string[],
): string[] {
  const current = new Set(currentFiles);
  const allowed = new Set(allowedFiles);
  return [
    ...currentFiles
      .filter((file) => !allowed.has(file))
      .map((file) => `${file}: JavaScript file is not allowed`),
    ...allowedFiles
      .filter((file) => !current.has(file))
      .map((file) => `${file}: stale JavaScript allowance`),
  ];
}

export function evaluateOnboardLineContract(currentLines: number, maxLines: number): string[] {
  if (currentLines > maxLines)
    return [`${ONBOARD_ENTRYPOINT}: ${currentLines} lines exceeds budget ${maxLines}`];
  if (currentLines < maxLines)
    return [`${ONBOARD_ENTRYPOINT}: ${currentLines} lines is below stale budget ${maxLines}`];
  return [];
}

export function evaluateTestConditionalContract(
  currentCounts: Readonly<Record<string, number>>,
  budgetCounts: Readonly<Record<string, number>>,
): string[] {
  return compareExactPathBudgets(currentCounts, budgetCounts, "if statement");
}

export function evaluateCurrentJavaScriptContract(): string[] {
  const budget = loadCodebaseGrowthBudget();
  return evaluateJavaScriptFileContract(collectRepositoryJavaScriptFiles(), budget.javascriptFiles);
}

export function evaluateCurrentOnboardContract(): string[] {
  const budget = loadCodebaseGrowthBudget();
  const source = readFileSync(path.join(REPO_ROOT, ONBOARD_ENTRYPOINT), "utf8");
  return evaluateOnboardLineContract(countLines(source), budget.onboardMaxLines);
}

export function evaluateCurrentTestConditionalContract(): string[] {
  const budget = loadCodebaseGrowthBudget();
  const currentCounts = Object.fromEntries(
    collectTestConditionals().files.map((entry) => [entry.file, entry.count]),
  );
  return evaluateTestConditionalContract(currentCounts, budget.testIfCounts);
}

export function evaluateCodebaseBudgetMonotonicity(
  base: CodebaseGrowthBudget,
  head: CodebaseGrowthBudget,
  renames: ReadonlyMap<string, string>,
): string[] {
  const violations: string[] = [];
  if (head.onboardMaxLines > base.onboardMaxLines) {
    violations.push(
      `onboardMaxLines increased from ${base.onboardMaxLines} to ${head.onboardMaxLines}`,
    );
  }
  const baseJavaScript = new Set(base.javascriptFiles);
  for (const file of head.javascriptFiles) {
    const basePath = renames.get(file) ?? file;
    if (!baseJavaScript.has(basePath)) violations.push(`${file}: adds a JavaScript allowance`);
  }
  for (const [file, count] of Object.entries(head.testIfCounts)) {
    const basePath = renames.get(file) ?? file;
    const baseCount = base.testIfCounts[basePath];
    if (baseCount === undefined)
      violations.push(`${file}: adds an if-statement budget of ${count}`);
    else if (count > baseCount)
      violations.push(`${file}: if-statement budget increased from ${baseCount} to ${count}`);
  }
  return violations;
}

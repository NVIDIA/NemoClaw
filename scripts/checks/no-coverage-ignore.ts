// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Guard source files against coverage tool exclusion directives.
 *
 * Coverage reports should reflect executable code honestly. If a path is only
 * covered by subprocess integration tests, keep it visible in coverage and let
 * the ratchet baseline account for that instead of hiding it from the report.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_ROOTS = ["bin", "src", "scripts", "test", "nemoclaw/src"];
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".ts", ".tsx"]);
const SKIP_DIRS = new Set([".git", "coverage", "dist", "node_modules"]);
const FORBIDDEN_DIRECTIVE = ["v8", "ignore"].join(" ");
const FORBIDDEN_DIRECTIVE_PATTERN = new RegExp(
  String.raw`(?:\/\/|\/\*)\s*${FORBIDDEN_DIRECTIVE}\b`,
);

export interface CoverageIgnoreViolation {
  filePath: string;
  line: number;
  column: number;
  text: string;
}

export function findCoverageIgnoreDirectives(
  sourceText: string,
  filePath: string,
): CoverageIgnoreViolation[] {
  const violations: CoverageIgnoreViolation[] = [];
  for (const [index, lineText] of sourceText.split(/\r?\n/).entries()) {
    const match = FORBIDDEN_DIRECTIVE_PATTERN.exec(lineText);
    if (match) {
      violations.push({
        filePath,
        line: index + 1,
        column: match.index + 1,
        text: lineText.trim(),
      });
    }
  }
  return violations;
}

export function checkFiles(filePaths: readonly string[]): CoverageIgnoreViolation[] {
  return filePaths.flatMap((filePath) => {
    const absolutePath = path.resolve(REPO_ROOT, filePath);
    return findCoverageIgnoreDirectives(
      fs.readFileSync(absolutePath, "utf-8"),
      path.relative(REPO_ROOT, absolutePath),
    );
  });
}

export function formatViolations(violations: readonly CoverageIgnoreViolation[]): string {
  const directive = FORBIDDEN_DIRECTIVE;
  return [
    `Coverage exclusion directives are not allowed (${directive}).`,
    "Keep code visible to coverage reports and ratchet the honest baseline instead.",
    "",
    ...violations.map(
      (violation) =>
        `${violation.filePath}:${violation.line}:${violation.column} ${violation.text}`,
    ),
  ].join("\n");
}

function sourceFiles(): string[] {
  return SCAN_ROOTS.flatMap((root) => [...walkSourceFiles(path.join(REPO_ROOT, root))]).map(
    (filePath) => path.relative(REPO_ROOT, filePath),
  );
}

function* walkSourceFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkSourceFiles(fullPath);
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield fullPath;
    }
  }
}

function isScannedSourcePath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    SCAN_ROOTS.some((root) => filePath === root || filePath.startsWith(`${root}/`)) &&
    SOURCE_EXTENSIONS.has(path.extname(filePath))
  );
}

function normalizeCliPaths(args: readonly string[]): string[] {
  return args
    .filter((arg) => arg !== "--")
    .map((arg) => path.relative(REPO_ROOT, path.resolve(arg)))
    .filter(isScannedSourcePath);
}

function main(): void {
  const cliPaths = normalizeCliPaths(process.argv.slice(2));
  const filePaths = cliPaths.length > 0 ? cliPaths : sourceFiles();
  const violations = checkFiles(filePaths);
  if (violations.length > 0) {
    console.error(formatViolations(violations));
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main();
}

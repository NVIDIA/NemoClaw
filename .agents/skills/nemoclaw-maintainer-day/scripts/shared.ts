// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared utilities for NemoClaw maintainer scripts.
 *
 * Centralizes risky-area detection, test-file detection, and shell helpers
 * so that triage, check-gates, and hotspots stay in sync.
 */

import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Risky area patterns — paths that need tests before approval
// ---------------------------------------------------------------------------

export const RISKY_PATTERNS: RegExp[] = [
  /^install\.sh$/,
  /^setup\.sh$/,
  /^brev-setup\.sh$/,
  /^scripts\/.*\.sh$/,
  /^bin\/lib\/onboard\.js$/,
  /^bin\/.*\.js$/,
  /^nemoclaw\/src\/blueprint\//,
  /^nemoclaw-blueprint\//,
  /^\.github\/workflows\//,
  /\.prek\./,
  /policy/i,
  /ssrf/i,
  /credential/i,
  /inference/i,
];

export const TEST_PATTERNS: RegExp[] = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /^test\//,
];

export function isRiskyFile(path: string): boolean {
  return RISKY_PATTERNS.some((re) => re.test(path));
}

export function isTestFile(path: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(path));
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

/**
 * Run a command and return its stdout. On failure, logs the error to stderr
 * and returns an empty string so callers can handle the absence of data.
 */
export function run(
  cmd: string,
  args: string[],
  timeoutMs = 120_000,
): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[shared] ${cmd} ${args[0] ?? ""} failed: ${message}\n`);
    return "";
  }
}

/**
 * Run `gh` with the given args and parse the JSON output.
 * Returns null when the command fails or output is not valid JSON.
 */
export function ghJson(args: string[]): unknown {
  const out = run("gh", args);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    process.stderr.write(`[shared] gh JSON parse failed for: gh ${args.join(" ")}\n`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Triage scoring weights
//
// Each weight reflects relative priority in the maintainer queue.
// Documented in nemoclaw-maintainer-day/PR-REVIEW-PRIORITIES.md.
// ---------------------------------------------------------------------------

/** PR passed all checks and is already approved — only needs final gate */
export const SCORE_MERGE_NOW = 40;
/** PR has green CI, no conflicts, not draft — ready for maintainer review */
export const SCORE_REVIEW_READY = 35;
/** PR is close to ready with a clear small fix path */
export const SCORE_NEAR_MISS = 30;
/** PR touches security-sensitive code and is actionable */
export const SCORE_SECURITY_ACTIONABLE = 20;
/** PR carries the "security" GitHub label */
export const SCORE_LABEL_SECURITY = 15;
/** PR carries a "priority: high" GitHub label */
export const SCORE_LABEL_PRIORITY_HIGH = 10;
/** PR has been stale > 7 days — mild priority bump to prevent rot */
export const SCORE_STALE_AGE = 5;

/** Draft PRs or PRs with non-trivial merge conflicts are effectively blocked */
export const PENALTY_DRAFT_OR_CONFLICT = -100;
/** Unresolved major/critical CodeRabbit finding blocks approval */
export const PENALTY_CODERABBIT_MAJOR = -80;
/** Broad CI red with no obvious local fix — not worth salvaging yet */
export const PENALTY_BROAD_CI_RED = -60;
/** Blocked on external admin action (permissions, secrets, etc.) */
export const PENALTY_MERGE_BLOCKED = -20;

// ---------------------------------------------------------------------------
// CLI argument parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a string CLI flag from argv. Returns `defaultValue` when the flag is
 * absent or when the next token is missing / looks like another flag.
 */
export function parseStringArg(args: string[], flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  if (idx < 0) return defaultValue;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) {
    process.stderr.write(`[shared] ${flag} requires a value, using default: ${defaultValue}\n`);
    return defaultValue;
  }
  return value;
}

/**
 * Parse an integer CLI flag from argv. Returns `defaultValue` when the flag is
 * absent, the next token is missing, or the value is not a valid integer.
 */
export function parseIntArg(args: string[], flag: string, defaultValue: number): number {
  const idx = args.indexOf(flag);
  if (idx < 0) return defaultValue;
  const value = parseInt(args[idx + 1], 10);
  if (isNaN(value)) {
    process.stderr.write(`[shared] ${flag} requires a number, using default: ${defaultValue}\n`);
    return defaultValue;
  }
  return value;
}

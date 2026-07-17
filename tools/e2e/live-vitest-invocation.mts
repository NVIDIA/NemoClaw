// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validated construction of the common live-Vitest invocation (#6961).
 *
 * `.github/workflows/e2e.yaml` repeats the same `npx vitest run --project
 * e2e-live … --reporter=default --reporter=test/e2e/risk-signal-reporter.ts`
 * shape across many jobs. This helper owns that shape so a job supplies only a
 * validated test path and `-t` selector; the project, reporters, and silence
 * flag are fixed here.
 *
 * The inputs cross a trust boundary — a job passes matrix-derived values — so
 * they are validated before any command is built: the project must be the
 * expected live project, the test path must resolve under `test/e2e/live/`
 * without traversal, and neither the path nor the selector may contain shell
 * metacharacters. Rejection is fail-closed; nothing is quoted-away and run.
 */

import { spawnSync } from "node:child_process";
import os from "node:os";
import { pathToFileURL } from "node:url";

import { parseArgs } from "../advisors/io.mts";

export const LIVE_VITEST_PROJECT = "e2e-live";
export const LIVE_TEST_ROOT = "test/e2e/live/";
export const RISK_SIGNAL_REPORTER = "test/e2e/risk-signal-reporter.ts";

// Anything outside this set can begin a shell word-split, redirection,
// substitution, or quote breakout. The selector intentionally allows `^`, `$`,
// and `-` (anchored Vitest title patterns) but nothing that reaches the shell.
const SHELL_METACHARACTER = /[^A-Za-z0-9_./^$=:@+-]/u;
const TEST_PATH_PATTERN = /^[A-Za-z0-9_./-]+$/u;

export interface LiveVitestInvocation {
  testPath: string | undefined;
  selector: string | undefined;
  project?: string;
}

function assertNoShellMetacharacters(value: string, field: string): void {
  const match = SHELL_METACHARACTER.exec(value);
  if (match) {
    throw new Error(`${field} contains an unsupported character ${JSON.stringify(match[0])}`);
  }
}

/** Validate the `--project` value is the one live project this helper serves. */
export function validateLiveProject(project: string | undefined): string {
  const resolved = (project ?? LIVE_VITEST_PROJECT).trim();
  if (resolved !== LIVE_VITEST_PROJECT) {
    throw new Error(
      `unsupported vitest project ${JSON.stringify(resolved)}; this helper only runs ${LIVE_VITEST_PROJECT}`,
    );
  }
  return resolved;
}

/**
 * Validate a live test path: under `test/e2e/live/`, a real `.test.ts` file
 * name, no `..` traversal, no shell metacharacters, no absolute path.
 */
export function validateLiveTestPath(testPath: string | undefined): string {
  const value = (testPath ?? "").trim();
  if (!value) throw new Error("test path is required");
  if (!TEST_PATH_PATTERN.test(value)) {
    assertNoShellMetacharacters(value, "test path");
    throw new Error(`test path ${JSON.stringify(value)} has an unsupported character`);
  }
  if (value.startsWith("/")) {
    throw new Error("test path must be repository-relative, not absolute");
  }
  if (value.split("/").includes("..")) {
    throw new Error("test path must not traverse with '..'");
  }
  if (!value.startsWith(LIVE_TEST_ROOT)) {
    throw new Error(`test path must be under ${LIVE_TEST_ROOT}, got ${JSON.stringify(value)}`);
  }
  if (!value.endsWith(".test.ts")) {
    throw new Error("test path must name a .test.ts file");
  }
  return value;
}

/**
 * Validate a Vitest `-t` selector. Anchored title patterns like `^${TARGET_ID}$`
 * are expected (the shell expands `TARGET_ID` before this sees it), so the
 * expanded value must still be free of shell metacharacters.
 */
export function validateLiveSelector(selector: string | undefined): string {
  const value = (selector ?? "").trim();
  if (!value) throw new Error("selector is required");
  assertNoShellMetacharacters(value, "selector");
  return value;
}

/**
 * Build the argv for the common live-Vitest invocation from validated inputs.
 * Returned as an argv array (never a shell string) so the caller can spawn it
 * without a shell.
 */
export function buildLiveVitestArgs(invocation: LiveVitestInvocation): string[] {
  const project = validateLiveProject(invocation.project);
  const testPath = validateLiveTestPath(invocation.testPath);
  const selector = validateLiveSelector(invocation.selector);
  return [
    "vitest",
    "run",
    "--project",
    project,
    testPath,
    "-t",
    selector,
    "--silent=false",
    "--reporter=default",
    `--reporter=${RISK_SIGNAL_REPORTER}`,
  ];
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export const LIVE_VITEST_USAGE =
  "usage: live-vitest-invocation.mts run --test-path <path> --selector <selector> [--project e2e-live]";

/**
 * Translate a finished child process into this process's exit code, preserving
 * the shell's termination semantics.
 *
 * A bare `npx vitest …` under `set -euo pipefail` surfaces a signal death as
 * 128+signo, not as a generic failure. Collapsing that to 1 would make a killed
 * or OOM-reaped test run indistinguishable from an ordinary test failure.
 */
export function resolveChildExitCode(result: {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}): number {
  if (result.error) return 1;
  if (typeof result.status === "number") return result.status;
  if (result.signal) {
    const signo = os.constants.signals[result.signal];
    return typeof signo === "number" ? 128 + signo : 1;
  }
  return 1;
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(3));
  const argv = buildLiveVitestArgs({
    testPath: args.testPath,
    selector: args.selector,
    project: args.project,
  });
  // Run through the repository's pinned vitest binary, without a shell, so the
  // validated argv is passed verbatim.
  const result = spawnSync("npx", argv, { stdio: "inherit" });
  if (result.error) {
    console.error(`failed to spawn vitest: ${result.error.message}`);
  }
  process.exit(resolveChildExitCode(result));
}

function main(): void {
  const subcommand = process.argv[2];
  // Fail closed on a missing or unknown subcommand. Exiting 0 here would let a
  // typo silently skip the live E2E run while the job still reported success.
  if (subcommand !== "run") {
    console.error(
      subcommand
        ? `unsupported subcommand ${JSON.stringify(subcommand)}\n${LIVE_VITEST_USAGE}`
        : `missing subcommand\n${LIVE_VITEST_USAGE}`,
    );
    process.exit(2);
  }
  runCli();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

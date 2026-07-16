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
  process.exit(typeof result.status === "number" ? result.status : 1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv[2] === "run"
) {
  runCli();
}

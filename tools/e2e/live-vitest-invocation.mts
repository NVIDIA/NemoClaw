// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { spawnExitCode } from "../../src/lib/core/process-exit.ts";

export const LIVE_VITEST_PROJECT = "e2e-live";
export const LIVE_TEST_ROOT = "test/e2e/live/";
export const RISK_SIGNAL_REPORTER = "test/e2e/risk-signal-reporter.ts";

const SHELL_METACHARACTER = /[^A-Za-z0-9_./^$=:@+-]/u;
const TEST_PATH_PATTERN = /^[A-Za-z0-9_./-]+$/u;

export interface LiveVitestInvocation {
  testPath: string | undefined;
  selector?: string | undefined;
  project?: string | undefined;
}

export interface LiveVitestSpawnResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error | undefined;
}

export type LiveVitestSpawner = (
  command: string,
  args: string[],
  options: { stdio: "inherit" },
) => LiveVitestSpawnResult;

const LIVE_VITEST_OPTIONS = {
  "--project": "project",
  "--selector": "selector",
  "--test-path": "testPath",
} as const;

function parseLiveVitestArgs(cliArgs: string[]): LiveVitestInvocation {
  const invocation: LiveVitestInvocation = { testPath: undefined };

  for (let index = 0; index < cliArgs.length; index += 2) {
    const option = cliArgs[index];
    const key = LIVE_VITEST_OPTIONS[option as keyof typeof LIVE_VITEST_OPTIONS];
    if (!key) {
      throw new Error(`unsupported live Vitest option ${JSON.stringify(option)}`);
    }
    const value = cliArgs[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`live Vitest option ${option} requires a value`);
    }
    if (invocation[key] !== undefined) {
      throw new Error(`live Vitest option ${option} must not be repeated`);
    }
    invocation[key] = value;
  }

  return invocation;
}

function assertNoShellMetacharacters(value: string, field: string): void {
  const match = SHELL_METACHARACTER.exec(value);
  if (match) {
    throw new Error(`${field} contains an unsupported character ${JSON.stringify(match[0])}`);
  }
}

export function validateLiveProject(project: string | undefined): string {
  const resolved = (project ?? LIVE_VITEST_PROJECT).trim();
  if (resolved !== LIVE_VITEST_PROJECT) {
    throw new Error(
      `unsupported vitest project ${JSON.stringify(resolved)}; this helper only runs ${LIVE_VITEST_PROJECT}`,
    );
  }
  return resolved;
}

export function validateLiveTestPath(testPath: string | undefined): string {
  const value = (testPath ?? "").trim();
  if (!value) {
    throw new Error("test path is required");
  }
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

export function validateLiveSelector(selector: string | undefined): string | undefined {
  const value = (selector ?? "").trim();
  if (!value) {
    return undefined;
  }
  assertNoShellMetacharacters(value, "selector");
  return value;
}

export function buildLiveVitestArgs(invocation: LiveVitestInvocation): string[] {
  const project = validateLiveProject(invocation.project);
  const testPath = validateLiveTestPath(invocation.testPath);
  const selector = validateLiveSelector(invocation.selector);
  const selectorArgs = selector ? ["-t", selector] : [];
  return [
    "vitest",
    "run",
    "--project",
    project,
    testPath,
    ...selectorArgs,
    "--silent=false",
    "--reporter=default",
    `--reporter=${RISK_SIGNAL_REPORTER}`,
  ];
}

export function runLiveVitestCli(cliArgs: string[], spawn: LiveVitestSpawner = spawnSync): number {
  const argv = buildLiveVitestArgs(parseLiveVitestArgs(cliArgs));
  const result = spawn("npx", argv, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  return spawnExitCode(result);
}

export function runLiveVitestCommand(argv: string[], spawn: LiveVitestSpawner = spawnSync): number {
  const [command, ...cliArgs] = argv;
  if (command !== "run") {
    throw new Error(
      `unsupported live Vitest command ${JSON.stringify(command ?? "")}; expected "run"`,
    );
  }
  return runLiveVitestCli(cliArgs, spawn);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runLiveVitestCommand(process.argv.slice(2)));
}

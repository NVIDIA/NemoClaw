// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import * as importedProcessExit from "../../src/lib/core/process-exit.ts";

// The root TypeScript package is exposed as CJS under the exact `npx tsx`
// workflow execution mode, but as an ESM namespace under Vitest. Normalize
// both representations so the executable and tests share exit handling.
const processExit = (
  "default" in importedProcessExit && importedProcessExit.default
    ? importedProcessExit.default
    : importedProcessExit
) as typeof import("../../src/lib/core/process-exit.ts");

const { spawnExitCode } = processExit;

export const LIVE_VITEST_PROJECT = "e2e-live";
export const LIVE_TEST_ROOT = "test/e2e/live/";
export const RISK_SIGNAL_REPORTER = "test/e2e/risk-signal-reporter.ts";
// Credentialed E2E trusts the workflow from main but executes this helper from
// the reviewed PR checkout, so exact-head resource setup must live here.
export const HERMES_SECURITY_POSTURE_SWAP_BYTES = 32 * 1024 * 1024 * 1024;

const HERMES_SECURITY_POSTURE_TEST = "test/e2e/live/hermes-e2e.test.ts";
const HERMES_SECURITY_POSTURE_SWAP_FILE = "/mnt/nemoclaw-hermes-security-posture.swap";

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

function enabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export function needsHermesSecurityPostureSwap(testPath: string, env: NodeJS.ProcessEnv): boolean {
  return (
    testPath === HERMES_SECURITY_POSTURE_TEST &&
    env.GITHUB_ACTIONS === "true" &&
    env.NEMOCLAW_AGENT === "hermes" &&
    enabled(env.NEMOCLAW_E2E_SECURITY_POSTURE)
  );
}

function spawnResultExitCode(result: LiveVitestSpawnResult): number {
  if (result.error) throw result.error;
  return spawnExitCode(result);
}

export function provisionHermesSecurityPostureSwap(
  testPath: string,
  env: NodeJS.ProcessEnv,
  spawn: LiveVitestSpawner = spawnSync,
): number {
  if (!needsHermesSecurityPostureSwap(testPath, env)) return 0;

  const script = `set -euo pipefail
swap_file="$1"
swap_size_bytes="$2"
free -h
df -h / /mnt
swapon --show
swapoff "$swap_file" 2>/dev/null || true
rm -f "$swap_file"
fallocate -l "$swap_size_bytes" "$swap_file"
chmod 0600 "$swap_file"
mkswap "$swap_file"
swapon "$swap_file"
swapon --show
free -h
df -h / /mnt
docker system df`;
  return spawnResultExitCode(
    spawn(
      "sudo",
      [
        "bash",
        "-c",
        script,
        "hermes-security-posture-swap",
        HERMES_SECURITY_POSTURE_SWAP_FILE,
        String(HERMES_SECURITY_POSTURE_SWAP_BYTES),
      ],
      { stdio: "inherit" },
    ),
  );
}

export function runLiveVitestCli(
  cliArgs: string[],
  spawn: LiveVitestSpawner = spawnSync,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const invocation = parseLiveVitestArgs(cliArgs);
  const testPath = validateLiveTestPath(invocation.testPath);
  const argv = buildLiveVitestArgs({ ...invocation, testPath });
  const swapExitCode = provisionHermesSecurityPostureSwap(testPath, env, spawn);
  if (swapExitCode !== 0) return swapExitCode;
  const result = spawn("npx", argv, { stdio: "inherit" });
  return spawnResultExitCode(result);
}

export function runLiveVitestCommand(
  argv: string[],
  spawn: LiveVitestSpawner = spawnSync,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const [command, ...cliArgs] = argv;
  if (command !== "run") {
    throw new Error(
      `unsupported live Vitest command ${JSON.stringify(command ?? "")}; expected "run"`,
    );
  }
  return runLiveVitestCli(cliArgs, spawn, env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runLiveVitestCommand(process.argv.slice(2)));
}

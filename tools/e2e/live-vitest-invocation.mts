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
export const HERMES_E2E_SWAP_BYTES = 32 * 1024 * 1024 * 1024;
export const HERMES_E2E_SWAP_FILE = "/mnt/nemoclaw-hermes-e2e.swap";

const SHELL_METACHARACTER = /[^A-Za-z0-9_./^$=:@+-]/u;
const TEST_PATH_PATTERN = /^[A-Za-z0-9_./-]+$/u;
const EXACT_HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ALWAYS_HERMES_BUILD_TESTS = new Set([
  "test/e2e/live/agent-turn-latency.test.ts",
  "test/e2e/live/hermes-inference-switch.test.ts",
  "test/e2e/live/hermes-shields-config.test.ts",
]);
const HERMES_BEDROCK_BUILD_TEST = "test/e2e/live/bedrock-runtime-compatible-anthropic.test.ts";
const HERMES_SHARED_E2E_TEST = "test/e2e/live/hermes-e2e.test.ts";
const HERMES_SHARED_E2E_TARGETS = new Set(["hermes-dashboard", "hermes-e2e", "security-posture"]);
const HERMES_MCP_BUILD_TEST = "test/e2e/live/mcp-bridge.test.ts";
export const HERMES_E2E_SWAP_SCRIPT = `set -euo pipefail
swap_file="$1"
swap_size_bytes="$2"

case "$swap_size_bytes" in
  ""|*[!0-9]*)
    echo "Hermes E2E swap size must be an integer byte count" >&2
    exit 2
    ;;
esac

active_swap_bytes="$(swapon --show --bytes --noheadings --output SIZE | awk '{ total += $1 } END { printf "%.0f", total }')"
active_swap_bytes="\${active_swap_bytes:-0}"
case "$active_swap_bytes" in
  ""|*[!0-9]*)
    echo "Unable to determine active swap capacity" >&2
    exit 2
    ;;
esac

if (( active_swap_bytes >= swap_size_bytes )); then
  printf 'Hermes E2E swap is already sufficient: %s bytes active\\n' "$active_swap_bytes"
  exit 0
fi

active_swap_names="$(swapon --show --noheadings --raw --output NAME)"
fixed_swap_active=0
while IFS= read -r active_swap_name; do
  if [[ "$active_swap_name" == "$swap_file" ]]; then
    fixed_swap_active=1
    break
  fi
done <<< "$active_swap_names"
if (( fixed_swap_active == 1 )); then
  swapoff "$swap_file"
fi
rm -f -- "$swap_file"

cleanup_partial_swap() {
  status="$?"
  if (( status != 0 )); then
    if cleanup_swap_names="$(swapon --show --noheadings --raw --output NAME 2>/dev/null)"; then
      cleanup_swap_active=0
      while IFS= read -r cleanup_swap_name; do
        if [[ "$cleanup_swap_name" == "$swap_file" ]]; then
          cleanup_swap_active=1
          break
        fi
      done <<< "$cleanup_swap_names"
      if (( cleanup_swap_active == 1 )); then
        if swapoff "$swap_file" 2>/dev/null; then
          rm -f -- "$swap_file" || true
        else
          printf 'Preserving active Hermes E2E swap after setup failure: %s\\n' "$swap_file" >&2
        fi
      else
        rm -f -- "$swap_file" || true
      fi
    else
      printf 'Preserving Hermes E2E swap because active swap could not be queried: %s\\n' "$swap_file" >&2
    fi
  fi
  trap - EXIT
  exit "$status"
}
trap cleanup_partial_swap EXIT

fallocate -l "$swap_size_bytes" "$swap_file"
chmod 0600 "$swap_file"
mkswap "$swap_file"
swapon "$swap_file"

active_swap_bytes="$(swapon --show --bytes --noheadings --output SIZE | awk '{ total += $1 } END { printf "%.0f", total }')"
active_swap_bytes="\${active_swap_bytes:-0}"
case "$active_swap_bytes" in
  ""|*[!0-9]*)
    echo "Unable to verify active swap capacity" >&2
    exit 2
    ;;
esac
if (( active_swap_bytes < swap_size_bytes )); then
  printf 'Hermes E2E swap provisioning failed: %s of %s bytes active\\n' "$active_swap_bytes" "$swap_size_bytes" >&2
  exit 1
fi

trap - EXIT
printf 'Hermes E2E swap ready: %s bytes active\\n' "$active_swap_bytes"
swapon --show`;

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

export function needsHermesE2ESwap(testPath: string, env: NodeJS.ProcessEnv): boolean {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    !EXACT_HEAD_SHA_PATTERN.test(env.NEMOCLAW_E2E_EXPECTED_SHA ?? "")
  ) {
    return false;
  }
  if (ALWAYS_HERMES_BUILD_TESTS.has(testPath)) return true;
  if (testPath === HERMES_BEDROCK_BUILD_TEST) return env.NEMOCLAW_AGENT === "hermes";
  if (testPath === HERMES_SHARED_E2E_TEST) {
    return (
      env.NEMOCLAW_AGENT === "hermes" && HERMES_SHARED_E2E_TARGETS.has(env.E2E_TARGET_ID ?? "")
    );
  }
  return (
    testPath === HERMES_MCP_BUILD_TEST &&
    env.E2E_TARGET_ID === "mcp-bridge" &&
    env.NEMOCLAW_MCP_BRIDGE_AGENT === "hermes"
  );
}

function spawnResultExitCode(result: LiveVitestSpawnResult): number {
  if (result.error) throw result.error;
  return spawnExitCode(result);
}

export function provisionHermesE2ESwap(
  testPath: string,
  env: NodeJS.ProcessEnv,
  spawn: LiveVitestSpawner = spawnSync,
): number {
  if (!needsHermesE2ESwap(testPath, env)) return 0;

  return spawnResultExitCode(
    spawn(
      "/usr/bin/sudo",
      [
        "-n",
        "/usr/bin/env",
        "-i",
        "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
        "LC_ALL=C",
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        HERMES_E2E_SWAP_SCRIPT,
        "nemoclaw-hermes-e2e-swap",
        HERMES_E2E_SWAP_FILE,
        String(HERMES_E2E_SWAP_BYTES),
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
  const swapExitCode = provisionHermesE2ESwap(testPath, env, spawn);
  if (swapExitCode !== 0) return swapExitCode;
  return spawnResultExitCode(spawn("npx", argv, { stdio: "inherit" }));
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

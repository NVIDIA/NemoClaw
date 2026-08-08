// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH, writeExecutable } from "./installer-sourced-env";

/**
 * Checkout and process mechanics for installer suites. The fixture owns the
 * disposable checkout layout, the sourced-installer spawn, and the npm stub
 * shape; stub snippets, scenario environment values, and assertions stay in
 * each test. Helpers return fresh state per call and never import vitest;
 * tests register cleanup with onTestFinished(() => checkout.remove()).
 */

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");

/** A disposable installer working directory with fake bin and npm prefix. */
export interface InstallerCheckout {
  /** The mkdtemp root; also usable as HOME. */
  root: string;
  /** The created fake-bin directory for stub executables. */
  binDir: string;
  /** The created npm prefix directory (with its bin/ subdirectory). */
  prefixDir: string;
  /** Writes an executable stub into binDir and returns its path. */
  writeExecutable: (name: string, contents: string) => string;
  /** Resolves a path under the checkout root. */
  path: (...segments: string[]) => string;
  /** Removes the whole checkout. */
  remove: () => void;
}

/** Creates a fresh installer checkout with created bin and prefix/bin dirs. */
export function createInstallerCheckout(prefix: string): InstallerCheckout {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const binDir = path.join(root, "bin");
  const prefixDir = path.join(root, "prefix");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(prefixDir, "bin"), { recursive: true });
  return {
    root,
    binDir,
    prefixDir,
    writeExecutable: (name, contents) => {
      const target = path.join(binDir, name);
      writeExecutable(target, contents);
      return target;
    },
    path: (...segments) => path.join(root, ...segments),
    remove: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Spawn options for runInstallerSourcedBody. */
export interface RunInstallerSourcedOptions {
  /** The HOME to reuse; a fresh mkdtemp directory when absent. */
  home?: string;
  /** The mkdtemp prefix for a fresh HOME. */
  homePrefix?: string;
  /** Extra environment entries appended after the base entries. */
  extraEnv?: Record<string, string>;
  /** Prepend the current node executable's directory to PATH. */
  includeNodeOnPath?: boolean;
  /** Kill the child with SIGKILL after this many milliseconds. */
  timeoutMs?: number;
}

/** The decoded outcome of one sourced-installer run. */
export interface InstallerSourcedResult {
  home: string;
  result: SpawnSyncReturns<string>;
  /** stdout and stderr concatenated. */
  output: string;
  /** Removes the run's HOME directory when the helper created it; a caller-provided home stays caller-owned. */
  remove: () => void;
}

/**
 * Sources `scripts/install.sh` in a clean bash and runs body against it,
 * from the repository root, with only HOME, PATH, and INSTALLER_UNDER_TEST
 * in the environment plus the given extras.
 */
export function runInstallerSourcedBody(
  body: string,
  options?: RunInstallerSourcedOptions,
): InstallerSourcedResult {
  const createdHome = options?.home === undefined;
  const home =
    options?.home ??
    fs.mkdtempSync(path.join(os.tmpdir(), options?.homePrefix ?? "nemoclaw-installer-sourced-"));
  const basePath = options?.includeNodeOnPath
    ? `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`
    : TEST_SYSTEM_PATH;
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$INSTALLER_UNDER_TEST" >/dev/null\n${body}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: basePath,
        INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        ...options?.extraEnv,
      },
      ...(options?.timeoutMs === undefined
        ? {}
        : { timeout: options.timeoutMs, killSignal: "SIGKILL" as const }),
    },
  );
  return {
    home,
    result,
    output: `${result.stdout}${result.stderr}`,
    remove: () => {
      if (!createdHome) return;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Behavior options for writeNpmStub. */
export interface NpmStubOptions {
  /** The snippet run for install-family invocations. */
  installSnippet?: string;
  /** Also accept `npm ci` and exit 0 after the snippet runs for it. */
  handleCi?: boolean;
}

/**
 * Writes an npm stub that reports a fixed version, resolves the prefix from
 * NPM_PREFIX, runs installSnippet for install-family commands, and fails
 * loudly on anything else.
 */
export function writeNpmStub(fakeBin: string, options?: NpmStubOptions): void {
  const installSnippet = options?.installSnippet ?? "exit 0";
  const commands = options?.handleCi
    ? '[ "$1" = "ci" ] || [ "$1" = "install" ] || [ "$1" = "link" ] || [ "$1" = "uninstall" ] || [ "$1" = "pack" ] || [ "$1" = "run" ]'
    : '[ "$1" = "install" ] || [ "$1" = "link" ] || [ "$1" = "uninstall" ] || [ "$1" = "pack" ] || [ "$1" = "run" ]';
  const ciExit = options?.handleCi ? '\n  if [ "$1" = "ci" ]; then exit 0; fi' : "";
  writeExecutable(
    path.join(fakeBin, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--version" ]; then echo "10.9.2"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then echo "$NPM_PREFIX"; exit 0; fi
if ${commands}; then
  ${installSnippet}${ciExit}
fi
echo "unexpected npm invocation: $*" >&2; exit 98`,
  );
}

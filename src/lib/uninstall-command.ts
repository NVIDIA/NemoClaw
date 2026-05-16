// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";

export function buildVersionedUninstallUrl(version: string): string {
  const stableVersion = String(version || "")
    .trim()
    .replace(/^v/, "")
    .replace(/-.*/, "");
  return `https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/tags/v${stableVersion}/uninstall.sh`;
}

export function resolveUninstallScript(
  candidates: string[],
  existsSyncImpl: (path: string) => boolean = fs.existsSync,
): string | null {
  for (const candidate of candidates) {
    if (existsSyncImpl(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function exitWithSpawnResult(
  result: Pick<SpawnSyncReturns<string>, "status" | "signal">,
  exit: (code: number) => never = (code) => process.exit(code),
): never {
  if (result.status !== null) {
    return exit(result.status);
  }

  if (result.signal) {
    const signalNumber = os.constants.signals[result.signal];
    return exit(signalNumber ? 128 + signalNumber : 1);
  }

  return exit(1);
}

export interface RunUninstallCommandDeps {
  args: string[];
  rootDir: string;
  currentDir: string;
  remoteScriptUrl: string;
  env: NodeJS.ProcessEnv;
  spawnSyncImpl: (
    file: string,
    args: string[],
    options?: SpawnSyncOptions,
  ) => Pick<SpawnSyncReturns<string>, "status" | "signal">;
  existsSyncImpl?: (path: string) => boolean;
  log?: (message?: string) => void;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
}

export function runUninstallCommand(deps: RunUninstallCommandDeps): never {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const existsSyncImpl = deps.existsSyncImpl ?? fs.existsSync;

  const localScript = resolveUninstallScript(
    [path.join(deps.rootDir, "uninstall.sh"), path.join(deps.currentDir, "..", "uninstall.sh")],
    existsSyncImpl,
  );
  if (localScript) {
    log(`  Running local uninstall script: ${localScript}`);
    const result = deps.spawnSyncImpl("bash", [localScript, ...deps.args], {
      stdio: "inherit",
      cwd: deps.rootDir,
      env: deps.env,
    });
    return exitWithSpawnResult(result, exit);
  }

  error("  Local uninstall script not found.");
  error("  Remote uninstall fallback is disabled for security.");
  error(`  Download and review manually: ${deps.remoteScriptUrl}`);
  error("  Then run: bash uninstall.sh [flags]");
  return exit(1);
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";

export function buildVersionedUninstallUrl(version: string): string {
  const stableVersion = String(version || "").trim().replace(/^v/, "").replace(/-.*/, "");
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
    options?: Record<string, unknown>,
  ) => Pick<SpawnSyncReturns<string>, "status" | "signal">;
  execFileSyncImpl: (file: string, args: string[], options?: Record<string, unknown>) => void;
  existsSyncImpl?: (path: string) => boolean;
  mkdtempSyncImpl?: (prefix: string) => string;
  rmSyncImpl?: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
  tmpdirFn?: () => string;
  log?: (message?: string) => void;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
}

export function runUninstallCommand(deps: RunUninstallCommandDeps): never {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const existsSyncImpl = deps.existsSyncImpl ?? fs.existsSync;
  const mkdtempSyncImpl = deps.mkdtempSyncImpl ?? fs.mkdtempSync;
  const rmSyncImpl = deps.rmSyncImpl ?? fs.rmSync;
  const tmpdirFn = deps.tmpdirFn ?? os.tmpdir;

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

  log(`  Local uninstall script not found; falling back to ${deps.remoteScriptUrl}`);
  const uninstallDir = mkdtempSyncImpl(path.join(tmpdirFn(), "nemoclaw-uninstall-"));
  const uninstallScript = path.join(uninstallDir, "uninstall.sh");
  let result: Pick<SpawnSyncReturns<string>, "status" | "signal"> | undefined;
  let downloadFailed = false;
  try {
    try {
      deps.execFileSyncImpl("curl", ["-fsSL", deps.remoteScriptUrl, "-o", uninstallScript], {
        stdio: "inherit",
      });
    } catch {
      error(`  Failed to download uninstall script from ${deps.remoteScriptUrl}`);
      downloadFailed = true;
    }
    if (!downloadFailed) {
      result = deps.spawnSyncImpl("bash", [uninstallScript, ...deps.args], {
        stdio: "inherit",
        cwd: deps.rootDir,
        env: deps.env,
      });
    }
  } finally {
    rmSyncImpl(uninstallDir, { recursive: true, force: true });
  }
  if (downloadFailed) {
    return exit(1);
  }
  return exitWithSpawnResult(result || { status: 1, signal: null }, exit);
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";

/**
 * SHA-256 hash of the known-good uninstall.sh script.
 * Update this constant whenever uninstall.sh is modified.
 */
export const UNINSTALL_SCRIPT_SHA256 =
  "5b42651f969650a981efceca36a0e228ccd9494826ac8e9dc99d834e6b6c8d33";

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

/**
 * Compute the SHA-256 hex digest of a file.
 */
export function computeFileHash(
  filePath: string,
  readFileSyncImpl: (path: string) => Buffer = fs.readFileSync,
): string {
  const contents = readFileSyncImpl(filePath);
  return crypto.createHash("sha256").update(contents).digest("hex");
}

export interface RunUninstallCommandDeps {
  args: string[];
  rootDir: string;
  currentDir: string;
  remoteScriptUrl: string;
  expectedHash?: string;
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
  readFileSyncImpl?: (path: string) => Buffer;
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
  const readFileSyncImpl = deps.readFileSyncImpl ?? fs.readFileSync;
  const tmpdirFn = deps.tmpdirFn ?? os.tmpdir;
  const expectedHash = deps.expectedHash ?? UNINSTALL_SCRIPT_SHA256;

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
      const actualHash = computeFileHash(uninstallScript, readFileSyncImpl);
      if (actualHash !== expectedHash) {
        error(`  Integrity check failed for downloaded uninstall script.`);
        error(`    Expected SHA-256: ${expectedHash}`);
        error(`    Actual SHA-256:   ${actualHash}`);
        error(`  Refusing to execute untrusted script.`);
        rmSyncImpl(uninstallDir, { recursive: true, force: true });
        return exit(1);
      }
      log(`  SHA-256 checksum verified: ${actualHash}`);
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

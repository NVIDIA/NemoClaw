// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { openRegularFileNoFollow } from "../adapters/fs/regular-file";
import { resolveNemoclawStateDir } from "../state/paths";
import { killTimer, type KillTimerResult } from "./timer-control";

export type RemoveShieldsStateDeps = {
  rmSync?: typeof fs.rmSync;
  warn?: (message: string) => void;
};

export type CleanupShieldsDestroyArtifactsDeps = RemoveShieldsStateDeps & {
  killShieldsTimer?: (
    sandboxName: string,
  ) => Pick<KillTimerResult, "authorityRevoked" | "warnings">;
  stateDir?: string;
};

function defaultCleanupWarn(message: string): void {
  console.warn(`  ⚠ ${message}`);
}

// Match the maximum size accepted by the owning Shields policy-artifact boundary.
const MAX_SHIELDS_CLEANUP_SNAPSHOT_BYTES = 16 * 1024 * 1024;

function readShieldsCleanupSnapshot(filePath: string): Buffer | undefined {
  let artifact: ReturnType<typeof openRegularFileNoFollow> | undefined;
  try {
    artifact = openRegularFileNoFollow(filePath);
    return artifact.readBytes(MAX_SHIELDS_CLEANUP_SNAPSHOT_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read Shields cleanup artifact '${filePath}' before removal: ${message}. Shields state was preserved for retry.`,
      { cause: error },
    );
  } finally {
    artifact?.close();
  }
}

function restoreShieldsCleanupSnapshot(filePath: string, snapshot: Buffer | undefined): void {
  if (snapshot === undefined) return;
  fs.writeFileSync(filePath, snapshot, { flag: "wx", mode: 0o600 });
}

function removeShieldsRecoveryStatePair(
  recoveryArtifactPath: string,
  stateRecordPath: string,
  rmSync: typeof fs.rmSync,
): void {
  const recoverySnapshot = readShieldsCleanupSnapshot(recoveryArtifactPath);
  try {
    rmSync(recoveryArtifactPath, { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not remove external Shields policy recovery artifact '${recoveryArtifactPath}': ${message}. Shields state was preserved for retry.`,
      { cause: error },
    );
  }

  try {
    rmSync(stateRecordPath, { force: true });
  } catch (error) {
    let rollbackError: unknown;
    try {
      restoreShieldsCleanupSnapshot(recoveryArtifactPath, recoverySnapshot);
    } catch (error) {
      rollbackError = error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const rollbackStatus =
      rollbackError === undefined
        ? "Shields cleanup artifacts were restored or retained for retry."
        : `Shields cleanup rollback was incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}.`;
    throw new Error(
      `Could not remove Shields state record '${stateRecordPath}': ${message}. ${rollbackStatus}`,
      { cause: error },
    );
  }
}

/**
 * Remove host-side Shields state and recovery artifacts for a sandbox.
 *
 * Without this cleanup, stale state or an external policy handoff from a
 * previous sandbox can survive destroy → re-onboard under the same name.
 *
 * See: https://github.com/NVIDIA/NemoClaw/issues/3114
 */
export function removeShieldsState(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
  deps: RemoveShieldsStateDeps = {},
): void {
  const rmSync = deps.rmSync ?? fs.rmSync;
  const warn = deps.warn ?? defaultCleanupWarn;
  const resolvedStateDir = path.resolve(stateDir);
  const filePaths = [
    `shields-external-policy-${sandboxName}.yaml`,
    `shields-${sandboxName}.json`,
    `shields-timer-${sandboxName}.json`,
  ].map((artifactName) => path.resolve(resolvedStateDir, artifactName));
  if (filePaths.some((filePath) => !filePath.startsWith(`${resolvedStateDir}${path.sep}`))) {
    // Defense-in-depth: sandbox names are validated to [a-z0-9-] at all
    // entry points, but reject traversal attempts just in case.
    return;
  }
  const [recoveryArtifactPath, stateRecordPath, timerMarkerPath] = filePaths as [
    string,
    string,
    string,
  ];
  removeShieldsRecoveryStatePair(recoveryArtifactPath, stateRecordPath, rmSync);
  try {
    rmSync(timerMarkerPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    const message = error instanceof Error ? error.message : String(error);
    warn(`Failed to remove Shields cleanup artifact '${timerMarkerPath}': ${message}`);
  }
}

/** Revoke timer authority before retiring Shields destroy-cleanup state. */
export function cleanupShieldsDestroyArtifacts(
  sandboxName: string,
  deps: CleanupShieldsDestroyArtifactsDeps = {},
): void {
  const killShieldsTimer = deps.killShieldsTimer ?? killTimer;
  const warn = deps.warn ?? defaultCleanupWarn;

  const timerResult = killShieldsTimer(sandboxName);
  for (const warning of timerResult.warnings) {
    warn(warning);
  }
  if (!timerResult.authorityRevoked) {
    throw new Error(
      `Could not revoke Shields timer authority for sandbox '${sandboxName}'. Shields cleanup artifacts were preserved for retry.`,
    );
  }

  removeShieldsState(sandboxName, deps.stateDir ?? resolveNemoclawStateDir(), {
    rmSync: deps.rmSync ?? fs.rmSync,
    warn,
  });
}

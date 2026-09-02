// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";

import { isErrnoException } from "../../core/errno";

export interface LockFileGeneration {
  readonly dev: number;
  readonly ino: number;
  readonly reclaimable: boolean;
}

export interface ReclaimLockFileGenerationOptions<T extends LockFileGeneration> {
  readonly inspectClaimed?: (claimedPath: string) => Promise<T | null>;
  readonly assertAfterClaim?: () => void;
}

export interface ReclaimLockFileGenerationSyncOptions<T extends LockFileGeneration> {
  readonly inspectClaimed?: (claimedPath: string) => T | null;
  readonly assertAfterClaim?: () => void;
}

function lockFileGenerationFromStats(stat: fs.Stats): LockFileGeneration {
  return { dev: stat.dev, ino: stat.ino, reclaimable: stat.isFile() };
}

async function restoreClaimedLockFileGeneration(
  targetPath: string,
  quarantinePath: string,
): Promise<void> {
  try {
    await fs.promises.link(quarantinePath, targetPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
  }
  await fs.promises.rm(quarantinePath, { force: true });
}

function restoreClaimedLockFileGenerationSync(targetPath: string, quarantinePath: string): void {
  try {
    fs.linkSync(quarantinePath, targetPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
  }
  fs.rmSync(quarantinePath, { force: true });
}

function reclaimRemovalFailure(
  targetPath: string,
  quarantinePath: string,
  removalError: unknown,
  canonicalState: "replacement" | "restored",
  restorationError: unknown | null,
  quarantineRetained: boolean,
): Error {
  const restoration =
    restorationError !== null
      ? `Restoration at '${targetPath}' also failed: ${String(restorationError)}.`
      : canonicalState === "restored"
        ? `The claimed generation was restored at '${targetPath}' without overwriting any replacement.`
        : `A replacement at '${targetPath}' was preserved.`;
  const retained = quarantineRetained
    ? ` The claimed generation remains at '${quarantinePath}'; verify that it is inactive before removing only that path.`
    : "";
  return new Error(
    `Failed to remove claimed lock generation '${quarantinePath}': ${String(removalError)}. ${restoration}${retained}`,
  );
}

async function recoverClaimedLockFileAfterRemovalFailure(
  targetPath: string,
  quarantinePath: string,
  removalError: unknown,
): Promise<never> {
  let canonicalState: "replacement" | "restored" = "restored";
  let restorationError: unknown | null = null;
  try {
    await fs.promises.link(quarantinePath, targetPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") canonicalState = "replacement";
    else restorationError = error;
  }
  let quarantineRetained = false;
  try {
    await fs.promises.rm(quarantinePath, { force: true });
  } catch {
    quarantineRetained = true;
  }
  throw reclaimRemovalFailure(
    targetPath,
    quarantinePath,
    removalError,
    canonicalState,
    restorationError,
    quarantineRetained,
  );
}

function recoverClaimedLockFileAfterRemovalFailureSync(
  targetPath: string,
  quarantinePath: string,
  removalError: unknown,
): never {
  let canonicalState: "replacement" | "restored" = "restored";
  let restorationError: unknown | null = null;
  try {
    fs.linkSync(quarantinePath, targetPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") canonicalState = "replacement";
    else restorationError = error;
  }
  let quarantineRetained = false;
  try {
    fs.rmSync(quarantinePath, { force: true });
  } catch {
    quarantineRetained = true;
  }
  throw reclaimRemovalFailure(
    targetPath,
    quarantinePath,
    removalError,
    canonicalState,
    restorationError,
    quarantineRetained,
  );
}

/** Atomically remove only the exact regular-file generation observed earlier. */
export async function reclaimLockFileGeneration<T extends LockFileGeneration>(
  targetPath: string,
  expected: T,
  options: ReclaimLockFileGenerationOptions<T> = {},
): Promise<boolean> {
  if (!expected.reclaimable) return false;
  const quarantinePath = `${targetPath}.reclaim-${String(process.pid)}-${crypto.randomUUID()}`;
  try {
    await fs.promises.rename(targetPath, quarantinePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }

  let claimed: LockFileGeneration | null;
  try {
    claimed = options.inspectClaimed
      ? await options.inspectClaimed(quarantinePath)
      : lockFileGenerationFromStats(await fs.promises.lstat(quarantinePath));
  } catch (error) {
    await restoreClaimedLockFileGeneration(targetPath, quarantinePath);
    throw error;
  }
  if (claimed === null || claimed.dev !== expected.dev || claimed.ino !== expected.ino) {
    await restoreClaimedLockFileGeneration(targetPath, quarantinePath);
    return false;
  }
  try {
    options.assertAfterClaim?.();
  } catch (error) {
    await restoreClaimedLockFileGeneration(targetPath, quarantinePath);
    throw error;
  }
  try {
    await fs.promises.rm(quarantinePath, { force: true });
  } catch (error) {
    await recoverClaimedLockFileAfterRemovalFailure(targetPath, quarantinePath, error);
  }
  return true;
}

/** Synchronous counterpart used by onboarding and sync lifecycle operations. */
export function reclaimLockFileGenerationSync<T extends LockFileGeneration>(
  targetPath: string,
  expected: T,
  options: ReclaimLockFileGenerationSyncOptions<T> = {},
): boolean {
  if (!expected.reclaimable) return false;
  const quarantinePath = `${targetPath}.reclaim-${String(process.pid)}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(targetPath, quarantinePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }

  let claimed: LockFileGeneration | null;
  try {
    claimed = options.inspectClaimed
      ? options.inspectClaimed(quarantinePath)
      : lockFileGenerationFromStats(fs.lstatSync(quarantinePath));
  } catch (error) {
    restoreClaimedLockFileGenerationSync(targetPath, quarantinePath);
    throw error;
  }
  if (claimed === null || claimed.dev !== expected.dev || claimed.ino !== expected.ino) {
    restoreClaimedLockFileGenerationSync(targetPath, quarantinePath);
    return false;
  }
  try {
    options.assertAfterClaim?.();
  } catch (error) {
    restoreClaimedLockFileGenerationSync(targetPath, quarantinePath);
    throw error;
  }
  try {
    fs.rmSync(quarantinePath, { force: true });
  } catch (error) {
    recoverClaimedLockFileAfterRemovalFailureSync(targetPath, quarantinePath, error);
  }
  return true;
}

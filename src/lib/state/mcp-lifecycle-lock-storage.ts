// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isErrnoException } from "../core/errno";
import {
  isMcpLifecycleLockOwner,
  type LockObservation,
  type McpLifecycleLockOwner,
} from "./mcp-lifecycle-lock-identity";
import { resolveNemoclawStateDir } from "./paths";

export const MCP_LIFECYCLE_LOCK_DIRNAME = "mcp-lifecycle-locks";

function lockFileStem(sandboxName: string): string {
  // Hashing makes the filesystem key traversal-safe even if a caller reaches
  // the lock before the command's normal sandbox-name validation.
  return crypto.createHash("sha256").update(sandboxName).digest("hex");
}

export function getMcpLifecycleLockPath(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
): string {
  return path.join(stateDir, MCP_LIFECYCLE_LOCK_DIRNAME, `${lockFileStem(sandboxName)}.lock`);
}

function ownerFileContent(owner: McpLifecycleLockOwner): string {
  return `${JSON.stringify(owner)}\n`;
}

export async function readMcpLifecycleLockObservation(
  lockPath: string,
): Promise<LockObservation | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      lockPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    try {
      const stat = await fs.promises.lstat(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { owner: null, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
      }
    } catch (statError) {
      if (isErrnoException(statError) && statError.code === "ENOENT") return null;
      throw statError;
    }
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { owner: null, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
    }
    try {
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      return {
        owner: isMcpLifecycleLockOwner(parsed) ? parsed : null,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
      };
    } catch {
      return { owner: null, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
    }
  } finally {
    await handle.close();
  }
}

export async function mcpLifecycleLockPathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(targetPath);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function safelyReleaseMcpLifecycleLock(
  lockPath: string,
  token: string,
): Promise<void> {
  const observation = await readMcpLifecycleLockObservation(lockPath);
  if (!observation || observation.owner?.token !== token) return;
  // Claim and verify the generation before deletion. A replacement appearing
  // after the token read is restored rather than unlinked.
  await reclaimStaleMcpLifecycleLockGeneration(lockPath, observation);
}

export async function reclaimStaleMcpLifecycleLockGeneration(
  targetPath: string,
  expected: LockObservation,
): Promise<boolean> {
  const quarantinePath = `${targetPath}.reclaim-${process.pid}-${crypto.randomUUID()}`;
  try {
    // Rename is the atomic claim. Another waiter may have already removed the
    // stale generation and published a replacement after our earlier read, so
    // the moved file must be verified before it is ever deleted.
    await fs.promises.rename(targetPath, quarantinePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }

  const claimed = await readMcpLifecycleLockObservation(quarantinePath);
  const expectedToken = expected.owner?.token ?? null;
  const claimedExpectedGeneration =
    expectedToken === null
      ? claimed !== null &&
        claimed.owner === null &&
        claimed.dev === expected.dev &&
        claimed.ino === expected.ino
      : claimed?.owner?.token === expectedToken;
  if (claimedExpectedGeneration) {
    await fs.promises.rm(quarantinePath, { force: true, recursive: true });
    return true;
  }

  // We raced a replacement owner. Restore the exact moved inode with a hard
  // link (which cannot overwrite a newer generation), then drop only our
  // quarantine name. If another generation already occupies the canonical
  // path, preserve the displaced owner record for diagnosis rather than ever
  // deleting an owner we did not claim.
  try {
    await fs.promises.link(quarantinePath, targetPath);
    await fs.promises.rm(quarantinePath, { force: true });
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
  }
  return false;
}

export async function writeMcpLifecycleLockCandidateAndLink(
  lockPath: string,
  owner: McpLifecycleLockOwner,
): Promise<boolean> {
  const candidatePath = `${lockPath}.candidate-${process.pid}-${owner.token}`;
  try {
    const handle = await fs.promises.open(candidatePath, "wx", 0o600);
    try {
      await handle.writeFile(ownerFileContent(owner), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // The hard link is the atomic publication point: waiters can never see a
      // partially written owner record.
      await fs.promises.link(candidatePath, lockPath);
      return true;
    } catch (error) {
      // NFS may execute LINK but lose/replay its reply. Reconcile the result
      // from the unique candidate's link count plus our unguessable owner token
      // before treating EEXIST (or another transport error) as a failed claim.
      const candidateStat = await fs.promises.stat(candidatePath);
      const published = await readMcpLifecycleLockObservation(lockPath);
      if (candidateStat.nlink >= 2 && published?.owner?.token === owner.token) {
        return true;
      }
      if (isErrnoException(error) && error.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    try {
      await fs.promises.rm(candidatePath, { force: true });
    } catch {
      // Publication is decided only by LINK plus owner-token reconciliation.
      // A unique candidate cleanup failure must not strand a live canonical
      // self-lock before the caller enters its protected operation.
    }
  }
}

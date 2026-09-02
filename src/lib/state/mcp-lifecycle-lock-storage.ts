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

export { resolveNemoclawStateDir } from "./paths";

export const MCP_LIFECYCLE_LOCK_DIRNAME = "mcp-lifecycle-locks";
export const MAX_MCP_LIFECYCLE_LOCK_BYTES = 64 * 1024;

export class LockObservationTooLargeError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, maxBytes: number) {
    super(`Lock '${lockPath}' exceeds the ${String(maxBytes)}-byte observation limit.`);
    this.name = "LockObservationTooLargeError";
    this.lockPath = lockPath;
  }
}

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

function lifecycleLockCandidatePath(lockPath: string, pid: number, token: string): string {
  return `${lockPath}.candidate-${String(pid)}-${token}`;
}

function reportRetainedLifecycleLockCandidate(candidatePath: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  process.emitWarning(
    `Lifecycle lock candidate '${candidatePath}' could not be removed and was retained for generation-verified recovery: ${detail}`,
    { code: "NEMOCLAW_MCP_LOCK_CANDIDATE_RETAINED" },
  );
}

export async function readMcpLifecycleLockObservation(
  lockPath: string,
  maxBytes = MAX_MCP_LIFECYCLE_LOCK_BYTES,
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
        return {
          owner: null,
          mtimeMs: stat.mtimeMs,
          dev: stat.dev,
          ino: stat.ino,
          reclaimable: !stat.isDirectory(),
        };
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
      return {
        owner: null,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
        reclaimable: !stat.isDirectory(),
      };
    }
    if (stat.size > maxBytes) {
      throw new LockObservationTooLargeError(lockPath, maxBytes);
    }
    try {
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      return {
        owner: isMcpLifecycleLockOwner(parsed) ? parsed : null,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
        reclaimable: true,
      };
    } catch {
      return {
        owner: null,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
        reclaimable: true,
      };
    }
  } finally {
    await handle.close();
  }
}

export function readMcpLifecycleLockObservationSync(
  lockPath: string,
  maxBytes = MAX_MCP_LIFECYCLE_LOCK_BYTES,
): LockObservation | null {
  let fd: number;
  try {
    fd = fs.openSync(
      lockPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    try {
      const stat = fs.lstatSync(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return {
          owner: null,
          mtimeMs: stat.mtimeMs,
          dev: stat.dev,
          ino: stat.ino,
          reclaimable: !stat.isDirectory(),
        };
      }
    } catch (statError) {
      if (isErrnoException(statError) && statError.code === "ENOENT") return null;
      throw statError;
    }
    throw error;
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return {
        owner: null,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
        reclaimable: !stat.isDirectory(),
      };
    }
    if (stat.size > maxBytes) {
      throw new LockObservationTooLargeError(lockPath, maxBytes);
    }
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
      return {
        owner: isMcpLifecycleLockOwner(parsed) ? parsed : null,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
        reclaimable: true,
      };
    } catch {
      return {
        owner: null,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
        reclaimable: true,
      };
    }
  } finally {
    fs.closeSync(fd);
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

export function mcpLifecycleLockPathExistsSync(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function recoverOrphanedMcpLifecycleLockCandidate(
  lockPath: string,
  ownerPid: number,
  token: string,
): Promise<boolean> {
  const candidatePath = lifecycleLockCandidatePath(lockPath, ownerPid, token);
  const candidate = await readMcpLifecycleLockObservation(candidatePath);
  if (!candidate) return true;
  if (candidate.owner?.pid !== ownerPid || candidate.owner.token !== token) return false;
  const canonical = await readMcpLifecycleLockObservation(lockPath);
  if (canonical && canonical.dev === candidate.dev && canonical.ino === candidate.ino) return false;
  return await reclaimStaleMcpLifecycleLockGenerationInternal(
    candidatePath,
    candidate,
    undefined,
    MAX_MCP_LIFECYCLE_LOCK_BYTES,
    false,
  );
}

function recoverOrphanedMcpLifecycleLockCandidateSync(
  lockPath: string,
  ownerPid: number,
  token: string,
): boolean {
  const candidatePath = lifecycleLockCandidatePath(lockPath, ownerPid, token);
  const candidate = readMcpLifecycleLockObservationSync(candidatePath);
  if (!candidate) return true;
  if (candidate.owner?.pid !== ownerPid || candidate.owner.token !== token) return false;
  const canonical = readMcpLifecycleLockObservationSync(lockPath);
  if (canonical && canonical.dev === candidate.dev && canonical.ino === candidate.ino) return false;
  return reclaimStaleMcpLifecycleLockGenerationSyncInternal(
    candidatePath,
    candidate,
    undefined,
    MAX_MCP_LIFECYCLE_LOCK_BYTES,
    false,
  );
}

export async function safelyReleaseMcpLifecycleLock(
  lockPath: string,
  token: string,
): Promise<void> {
  const observation = await readMcpLifecycleLockObservation(lockPath);
  if (!observation || observation.owner?.token !== token) {
    await recoverOrphanedMcpLifecycleLockCandidate(lockPath, process.pid, token);
    return;
  }
  // Claim and verify the generation before deletion. A replacement appearing
  // after the token read is restored rather than unlinked.
  await reclaimStaleMcpLifecycleLockGeneration(lockPath, observation);
}

export function safelyReleaseMcpLifecycleLockSync(lockPath: string, token: string): void {
  const observation = readMcpLifecycleLockObservationSync(lockPath);
  if (!observation || observation.owner?.token !== token) {
    recoverOrphanedMcpLifecycleLockCandidateSync(lockPath, process.pid, token);
    return;
  }
  reclaimStaleMcpLifecycleLockGenerationSync(lockPath, observation);
}

async function restoreClaimedMcpLifecycleLockGeneration(
  targetPath: string,
  quarantinePath: string,
): Promise<void> {
  try {
    await fs.promises.link(quarantinePath, targetPath);
    await fs.promises.rm(quarantinePath, { force: true });
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
  }
}

function restoreClaimedMcpLifecycleLockGenerationSync(
  targetPath: string,
  quarantinePath: string,
): void {
  try {
    fs.linkSync(quarantinePath, targetPath);
    fs.rmSync(quarantinePath, { force: true });
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
  }
}

async function reclaimStaleMcpLifecycleLockGenerationInternal(
  targetPath: string,
  expected: LockObservation,
  assertAfterClaim?: () => void,
  maxObservationBytes = MAX_MCP_LIFECYCLE_LOCK_BYTES,
  recoverCandidate = true,
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

  let claimed: LockObservation | null;
  try {
    claimed = await readMcpLifecycleLockObservation(quarantinePath, maxObservationBytes);
  } catch (error) {
    await restoreClaimedMcpLifecycleLockGeneration(targetPath, quarantinePath);
    if (error instanceof LockObservationTooLargeError) {
      throw new LockObservationTooLargeError(targetPath, maxObservationBytes);
    }
    throw error;
  }
  const expectedToken = expected.owner?.token ?? null;
  const claimedExpectedGeneration =
    expectedToken === null
      ? claimed !== null &&
        claimed.owner === null &&
        claimed.dev === expected.dev &&
        claimed.ino === expected.ino
      : claimed?.owner?.token === expectedToken;
  if (claimedExpectedGeneration) {
    try {
      assertAfterClaim?.();
    } catch (error) {
      await restoreClaimedMcpLifecycleLockGeneration(targetPath, quarantinePath);
      throw error;
    }
    await fs.promises.rm(quarantinePath, { force: true, recursive: true });
    if (recoverCandidate && claimed?.owner) {
      const recovered = await recoverOrphanedMcpLifecycleLockCandidate(
        targetPath,
        claimed.owner.pid,
        claimed.owner.token,
      );
      if (!recovered) {
        reportRetainedLifecycleLockCandidate(
          lifecycleLockCandidatePath(targetPath, claimed.owner.pid, claimed.owner.token),
          new Error("the candidate is still linked to a canonical or changed generation"),
        );
      }
    }
    return true;
  }

  // We raced a replacement owner. Restore the exact moved inode with a hard
  // link (which cannot overwrite a newer generation), then drop only our
  // quarantine name. If another generation already occupies the canonical
  // path, preserve the displaced owner record for diagnosis rather than ever
  // deleting an owner we did not claim.
  await restoreClaimedMcpLifecycleLockGeneration(targetPath, quarantinePath);
  return false;
}

export async function reclaimStaleMcpLifecycleLockGeneration(
  targetPath: string,
  expected: LockObservation,
  assertAfterClaim?: () => void,
  maxObservationBytes = MAX_MCP_LIFECYCLE_LOCK_BYTES,
): Promise<boolean> {
  return await reclaimStaleMcpLifecycleLockGenerationInternal(
    targetPath,
    expected,
    assertAfterClaim,
    maxObservationBytes,
  );
}

function reclaimStaleMcpLifecycleLockGenerationSyncInternal(
  targetPath: string,
  expected: LockObservation,
  assertAfterClaim?: () => void,
  maxObservationBytes = MAX_MCP_LIFECYCLE_LOCK_BYTES,
  recoverCandidate = true,
): boolean {
  const quarantinePath = `${targetPath}.reclaim-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(targetPath, quarantinePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }

  let claimed: LockObservation | null;
  try {
    claimed = readMcpLifecycleLockObservationSync(quarantinePath, maxObservationBytes);
  } catch (error) {
    restoreClaimedMcpLifecycleLockGenerationSync(targetPath, quarantinePath);
    if (error instanceof LockObservationTooLargeError) {
      throw new LockObservationTooLargeError(targetPath, maxObservationBytes);
    }
    throw error;
  }
  const expectedToken = expected.owner?.token ?? null;
  const claimedExpectedGeneration =
    expectedToken === null
      ? claimed !== null &&
        claimed.owner === null &&
        claimed.dev === expected.dev &&
        claimed.ino === expected.ino
      : claimed?.owner?.token === expectedToken;
  if (claimedExpectedGeneration) {
    try {
      assertAfterClaim?.();
    } catch (error) {
      restoreClaimedMcpLifecycleLockGenerationSync(targetPath, quarantinePath);
      throw error;
    }
    fs.rmSync(quarantinePath, { force: true, recursive: true });
    if (recoverCandidate && claimed?.owner) {
      const recovered = recoverOrphanedMcpLifecycleLockCandidateSync(
        targetPath,
        claimed.owner.pid,
        claimed.owner.token,
      );
      if (!recovered) {
        reportRetainedLifecycleLockCandidate(
          lifecycleLockCandidatePath(targetPath, claimed.owner.pid, claimed.owner.token),
          new Error("the candidate is still linked to a canonical or changed generation"),
        );
      }
    }
    return true;
  }

  restoreClaimedMcpLifecycleLockGenerationSync(targetPath, quarantinePath);
  return false;
}

export function reclaimStaleMcpLifecycleLockGenerationSync(
  targetPath: string,
  expected: LockObservation,
  assertAfterClaim?: () => void,
  maxObservationBytes = MAX_MCP_LIFECYCLE_LOCK_BYTES,
): boolean {
  return reclaimStaleMcpLifecycleLockGenerationSyncInternal(
    targetPath,
    expected,
    assertAfterClaim,
    maxObservationBytes,
  );
}

export async function writeMcpLifecycleLockCandidateAndLink(
  lockPath: string,
  owner: McpLifecycleLockOwner,
): Promise<boolean> {
  const candidatePath = lifecycleLockCandidatePath(lockPath, process.pid, owner.token);
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
    } catch (error) {
      let cleanupError = error;
      let recovered = false;
      try {
        recovered = await recoverOrphanedMcpLifecycleLockCandidate(
          lockPath,
          process.pid,
          owner.token,
        );
      } catch (recoveryError) {
        cleanupError = recoveryError;
      }
      if (!recovered) reportRetainedLifecycleLockCandidate(candidatePath, cleanupError);
    }
  }
}

export function writeMcpLifecycleLockCandidateAndLinkSync(
  lockPath: string,
  owner: McpLifecycleLockOwner,
): boolean {
  const candidatePath = lifecycleLockCandidatePath(lockPath, process.pid, owner.token);
  try {
    const fd = fs.openSync(candidatePath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, ownerFileContent(owner), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(candidatePath, lockPath);
      return true;
    } catch (error) {
      const candidateStat = fs.statSync(candidatePath);
      const published = readMcpLifecycleLockObservationSync(lockPath);
      if (candidateStat.nlink >= 2 && published?.owner?.token === owner.token) {
        return true;
      }
      if (isErrnoException(error) && error.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    try {
      fs.rmSync(candidatePath, { force: true });
    } catch (error) {
      let cleanupError = error;
      let recovered = false;
      try {
        recovered = recoverOrphanedMcpLifecycleLockCandidateSync(
          lockPath,
          process.pid,
          owner.token,
        );
      } catch (recoveryError) {
        cleanupError = recoveryError;
      }
      if (!recovered) reportRetainedLifecycleLockCandidate(candidatePath, cleanupError);
    }
  }
}

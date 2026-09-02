// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isErrnoException } from "../../core/errno";
import {
  classifyMcpLifecycleLock,
  createMcpLifecycleLockOwner,
  type LockObservation,
} from "../mcp-lifecycle-lock-identity";
import {
  McpLifecycleLockObservationTooLargeError,
  readMcpLifecycleLockObservationSync,
  reclaimStaleMcpLifecycleLockGenerationSync,
  safelyReleaseMcpLifecycleLockSync,
  writeMcpLifecycleLockCandidateAndLinkSync,
} from "../mcp-lifecycle-lock-storage";

const ONBOARD_RECLAMATION_GUARD_OWNER = "onboard-lock-reclamation";
const CORRUPT_GUARD_GRACE_MS = 30_000;
const MAX_GUARD_ACQUIRE_ATTEMPTS = 5;
const MAX_GUARD_ARTIFACT_BYTES = 64 * 1024;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export interface OnboardLockReclamationGuardOwner {
  readonly pid: number;
  readonly processIdentity: string | null;
  readonly hostIdentity: string | null;
  readonly pidNamespaceIdentity: string | null;
  readonly acquiredAt: string;
}

export interface OnboardLockReclamationGuardContention {
  readonly guardFile: string;
  readonly owner?: OnboardLockReclamationGuardOwner;
}

export type OnboardLockReclamationGuardResult<T> =
  | { readonly status: "completed"; readonly value: T }
  | {
      readonly status: "blocked";
      readonly contention: OnboardLockReclamationGuardContention;
    };

function describeContention(
  guardFile: string,
  observation: LockObservation | null,
): OnboardLockReclamationGuardContention {
  const owner = observation?.owner;
  return {
    guardFile,
    ...(owner
      ? {
          owner: {
            pid: owner.pid,
            processIdentity: owner.processIdentity,
            hostIdentity: owner.hostIdentity ?? null,
            pidNamespaceIdentity: owner.pidNamespaceIdentity ?? null,
            acquiredAt: owner.acquiredAt,
          },
        }
      : {}),
  };
}

type GuardObservationResult =
  | { readonly status: "read"; readonly observation: LockObservation | null }
  | { readonly status: "blocked"; readonly contention: OnboardLockReclamationGuardContention };

function readGuardObservation(guardFile: string): GuardObservationResult {
  try {
    return {
      status: "read",
      observation: readMcpLifecycleLockObservationSync(guardFile, MAX_GUARD_ARTIFACT_BYTES),
    };
  } catch (error) {
    if (error instanceof McpLifecycleLockObservationTooLargeError) {
      return { status: "blocked", contention: describeContention(error.lockPath, null) };
    }
    throw error;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface GuardArtifactName {
  readonly kind: "candidate" | "reclaim";
  readonly ownerPid?: number;
  readonly ownerToken?: string;
}

function parseGuardArtifactName(guardPath: string, name: string): GuardArtifactName | null {
  const base = escapeRegExp(path.basename(guardPath));
  const candidateSegment = `\\.candidate-([1-9]\\d*)-(${UUID_PATTERN})`;
  const reclaimSegment = `\\.reclaim-[1-9]\\d*-${UUID_PATTERN}`;
  const candidate = new RegExp(`^${base}${candidateSegment}(?:${reclaimSegment})*$`, "u").exec(
    name,
  );
  if (candidate) {
    return { kind: "candidate", ownerPid: Number(candidate[1]), ownerToken: candidate[2] };
  }
  return new RegExp(`^${base}${reclaimSegment}(?:${reclaimSegment})*$`, "u").test(name)
    ? { kind: "reclaim" }
    : null;
}

function reconcileGuardArtifacts(guardPath: string): OnboardLockReclamationGuardContention | null {
  const directory = path.dirname(guardPath);
  const base = path.basename(guardPath);
  let names: string[];
  try {
    names = fs
      .readdirSync(directory)
      .filter(
        (name) => name.startsWith(`${base}.candidate-`) || name.startsWith(`${base}.reclaim-`),
      )
      .sort();
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }

  for (const name of names) {
    const artifactPath = path.join(directory, name);
    const artifactName = parseGuardArtifactName(guardPath, name);
    if (artifactName === null) return describeContention(artifactPath, null);

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(artifactPath);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_GUARD_ARTIFACT_BYTES) {
      return describeContention(artifactPath, null);
    }

    const observed = readGuardObservation(artifactPath);
    if (observed.status === "blocked") return observed.contention;
    const { observation } = observed;
    if (observation === null) continue;
    const owner = observation.owner;
    if (
      owner === null ||
      owner.sandboxName !== ONBOARD_RECLAMATION_GUARD_OWNER ||
      (artifactName.kind === "candidate" &&
        (owner.pid !== artifactName.ownerPid || owner.token !== artifactName.ownerToken))
    ) {
      return describeContention(artifactPath, observation);
    }
    const disposition = classifyMcpLifecycleLock(
      observation,
      ONBOARD_RECLAMATION_GUARD_OWNER,
      Date.now(),
      CORRUPT_GUARD_GRACE_MS,
    );
    if (disposition !== "stale") return describeContention(artifactPath, observation);
    try {
      reclaimStaleMcpLifecycleLockGenerationSync(
        artifactPath,
        observation,
        undefined,
        MAX_GUARD_ARTIFACT_BYTES,
      );
    } catch (error) {
      if (error instanceof McpLifecycleLockObservationTooLargeError) {
        return describeContention(artifactPath, null);
      }
      throw error;
    }
    const replacement = readGuardObservation(artifactPath);
    if (replacement.status === "blocked") return replacement.contention;
    if (replacement.observation !== null) {
      return describeContention(artifactPath, replacement.observation);
    }
  }
  return null;
}

/**
 * Serialize the stale-inspect, unlink, and replacement-create sequence across
 * onboarding writers. The shared lifecycle-lock storage publishes by hard
 * link and reclaims by atomic rename plus generation verification, so recovery
 * of an interrupted guard does not repeat the guarded stat-then-unlink race.
 */
export function withOnboardLockReclamationGuard<T>(
  guardPath: string,
  operation: () => T,
): OnboardLockReclamationGuardResult<T> {
  fs.mkdirSync(path.dirname(guardPath), { recursive: true, mode: 0o700 });

  const artifactContention = reconcileGuardArtifacts(guardPath);
  if (artifactContention) return { status: "blocked", contention: artifactContention };

  for (let attempt = 0; attempt < MAX_GUARD_ACQUIRE_ATTEMPTS; attempt++) {
    const token = randomUUID();
    const owner = createMcpLifecycleLockOwner(ONBOARD_RECLAMATION_GUARD_OWNER, token);
    let acquired: boolean;
    try {
      acquired = writeMcpLifecycleLockCandidateAndLinkSync(
        guardPath,
        owner,
        MAX_GUARD_ARTIFACT_BYTES,
      );
    } catch (error) {
      if (error instanceof McpLifecycleLockObservationTooLargeError) {
        return { status: "blocked", contention: describeContention(error.lockPath, null) };
      }
      throw error;
    }
    if (acquired) {
      try {
        return { status: "completed", value: operation() };
      } finally {
        safelyReleaseMcpLifecycleLockSync(guardPath, token);
      }
    }

    const observed = readGuardObservation(guardPath);
    if (observed.status === "blocked") return observed;
    const { observation } = observed;
    if (observation === null) continue;
    const disposition = classifyMcpLifecycleLock(
      observation,
      ONBOARD_RECLAMATION_GUARD_OWNER,
      Date.now(),
      CORRUPT_GUARD_GRACE_MS,
    );
    if (disposition !== "stale") {
      return {
        status: "blocked",
        contention: describeContention(guardPath, observation),
      };
    }
    try {
      reclaimStaleMcpLifecycleLockGenerationSync(
        guardPath,
        observation,
        undefined,
        MAX_GUARD_ARTIFACT_BYTES,
      );
    } catch (error) {
      if (error instanceof McpLifecycleLockObservationTooLargeError) {
        return { status: "blocked", contention: describeContention(guardPath, null) };
      }
      throw error;
    }
  }

  const observed = readGuardObservation(guardPath);
  return observed.status === "blocked"
    ? observed
    : { status: "blocked", contention: describeContention(guardPath, observed.observation) };
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  classifyMcpLifecycleLock,
  createMcpLifecycleLockOwner,
  type LockObservation,
} from "../mcp-lifecycle-lock-identity";
import {
  readMcpLifecycleLockObservationSync,
  reclaimStaleMcpLifecycleLockGenerationSync,
  safelyReleaseMcpLifecycleLockSync,
  writeMcpLifecycleLockCandidateAndLinkSync,
} from "../mcp-lifecycle-lock-storage";

const ONBOARD_RECLAMATION_GUARD_OWNER = "onboard-lock-reclamation";
const CORRUPT_GUARD_GRACE_MS = 30_000;
const MAX_GUARD_ACQUIRE_ATTEMPTS = 5;

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

  for (let attempt = 0; attempt < MAX_GUARD_ACQUIRE_ATTEMPTS; attempt++) {
    const token = randomUUID();
    const owner = createMcpLifecycleLockOwner(ONBOARD_RECLAMATION_GUARD_OWNER, token);
    if (writeMcpLifecycleLockCandidateAndLinkSync(guardPath, owner)) {
      try {
        return { status: "completed", value: operation() };
      } finally {
        safelyReleaseMcpLifecycleLockSync(guardPath, token);
      }
    }

    const observation = readMcpLifecycleLockObservationSync(guardPath);
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
    reclaimStaleMcpLifecycleLockGenerationSync(guardPath, observation);
  }

  return {
    status: "blocked",
    contention: describeContention(guardPath, readMcpLifecycleLockObservationSync(guardPath)),
  };
}

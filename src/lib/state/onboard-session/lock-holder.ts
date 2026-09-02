// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  hostProcessIdentityProbes,
  type ProcessIdentityProbes,
} from "../../adapters/process/identity";
import {
  readMcpLockHostIdentity,
  readMcpLockPidNamespaceIdentity,
} from "../mcp-lifecycle-lock-identity";

export interface OnboardLockIdentityProbes extends ProcessIdentityProbes {
  readonly localHostIdentity: string;
  readonly localPidNamespaceIdentity: string | null;
}

export interface OnboardLockHolderIdentity {
  readonly pid: number;
  readonly processStartIdentity: string | null;
  readonly hostIdentity: string | null;
  readonly pidNamespaceIdentity: string | null;
}

export interface OnboardLockRecord extends OnboardLockHolderIdentity {
  readonly startedAt: string | null;
  readonly command: string | null;
}

export type OnboardLockDisposition =
  | {
      readonly state: "held";
      readonly record: OnboardLockRecord;
      readonly identityVerified: boolean;
      readonly provenance: "foreign" | "local" | "unknown";
    }
  | { readonly state: "settling" }
  | { readonly state: "stale" };

export const ONBOARD_LOCK_SETTLING_MS = 30_000;
export const MAX_ONBOARD_LOCK_BYTES = 64 * 1024;

const hostOnboardLockIdentityProbes: OnboardLockIdentityProbes = {
  ...hostProcessIdentityProbes,
  localHostIdentity: readMcpLockHostIdentity(),
  localPidNamespaceIdentity: readMcpLockPidNamespaceIdentity(),
};

function onboardLockHolderProvenance(
  lock: OnboardLockHolderIdentity,
  probes: OnboardLockIdentityProbes,
): "foreign" | "local" | "unknown" {
  if (lock.hostIdentity === null) return "unknown";
  if (lock.hostIdentity !== probes.localHostIdentity) return "foreign";
  if (probes.localPidNamespaceIdentity !== null) {
    if (lock.pidNamespaceIdentity === null) return "unknown";
    return lock.pidNamespaceIdentity === probes.localPidNamespaceIdentity ? "local" : "foreign";
  }
  return lock.pidNamespaceIdentity === null ? "local" : "unknown";
}

/**
 * Confirm that a live PID still names the process that wrote an onboarding
 * lock. Process-start metadata distinguishes a reused PID; unavailable
 * metadata stays fail-closed and continues to treat it as held.
 */
function onboardLockHolderIdentity(
  lock: OnboardLockHolderIdentity,
  probes: OnboardLockIdentityProbes,
): "departed" | "verified" | "unavailable" {
  if (!probes.isAlive(lock.pid)) return "departed";
  if (lock.processStartIdentity === null) return "unavailable";
  const currentIdentity = probes.readStrongIdentity(lock.pid);
  if (currentIdentity === null) return "unavailable";
  return currentIdentity === lock.processStartIdentity ? "verified" : "departed";
}

function parseOnboardLockRecord(value: unknown): OnboardLockRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { pid, startedAt, command, processStartIdentity, hostIdentity, pidNamespaceIdentity } =
    value as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    processStartIdentity:
      typeof processStartIdentity === "string" && processStartIdentity.length > 0
        ? processStartIdentity
        : null,
    hostIdentity: typeof hostIdentity === "string" && hostIdentity.length > 0 ? hostIdentity : null,
    pidNamespaceIdentity:
      typeof pidNamespaceIdentity === "string" && pidNamespaceIdentity.length > 0
        ? pidNamespaceIdentity
        : null,
    startedAt: typeof startedAt === "string" ? startedAt : null,
    command: typeof command === "string" ? command : null,
  };
}

/** Build the persisted owner record with process-start identity evidence when available. */
export function createOnboardLockRecord(
  command: string | null,
  startedAt: string,
  probes: OnboardLockIdentityProbes = hostOnboardLockIdentityProbes,
): OnboardLockRecord {
  return {
    pid: probes.currentPid,
    processStartIdentity: probes.readStrongIdentity(probes.currentPid),
    hostIdentity: probes.localHostIdentity,
    pidNamespaceIdentity: probes.localPidNamespaceIdentity,
    startedAt,
    command,
  };
}

/**
 * Classify a stable snapshot of an onboarding lock. Filesystem readers own
 * their race protections, while this function is the single policy owner for
 * the persisted record, malformed-write grace period, and holder identity.
 */
export function classifyOnboardLockContents(
  contents: string,
  modifiedAtMs: number,
  nowMs = Date.now(),
  probes: OnboardLockIdentityProbes = hostOnboardLockIdentityProbes,
): OnboardLockDisposition {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    value = null;
  }

  const record = parseOnboardLockRecord(value);
  if (record === null) {
    return nowMs - modifiedAtMs > ONBOARD_LOCK_SETTLING_MS
      ? { state: "stale" }
      : { state: "settling" };
  }
  const provenance = onboardLockHolderProvenance(record, probes);
  if (provenance !== "local") {
    return { state: "held", record, identityVerified: false, provenance };
  }
  const holderIdentity = onboardLockHolderIdentity(record, probes);
  return holderIdentity === "departed"
    ? { state: "stale" }
    : {
        state: "held",
        record,
        identityVerified: holderIdentity === "verified",
        provenance,
      };
}

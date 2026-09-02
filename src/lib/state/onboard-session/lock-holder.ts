// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  hostProcessIdentityProbes,
  readHostIdentity,
  readPidNamespaceIdentity,
  type ProcessIdentityProbes,
} from "../../adapters/process/identity";

export interface OnboardLockIdentityProbes extends ProcessIdentityProbes {
  readonly localHostIdentity: string | null;
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

interface ParsedOnboardLockRecord {
  readonly record: OnboardLockRecord;
  readonly format: "current" | "legacy";
}

const hostOnboardLockIdentityProbes: OnboardLockIdentityProbes = {
  ...hostProcessIdentityProbes,
  localHostIdentity: readHostIdentity(),
  localPidNamespaceIdentity: readPidNamespaceIdentity(),
};

function onboardLockHolderProvenance(
  lock: OnboardLockHolderIdentity,
  probes: OnboardLockIdentityProbes,
): "foreign" | "local" | "unknown" {
  if (lock.hostIdentity === null || probes.localHostIdentity === null) return "unknown";
  if (lock.hostIdentity !== probes.localHostIdentity) return "foreign";
  if (probes.localPidNamespaceIdentity !== null) {
    if (lock.pidNamespaceIdentity === null) return "unknown";
    return lock.pidNamespaceIdentity === probes.localPidNamespaceIdentity ? "local" : "foreign";
  }
  return process.platform !== "linux" && lock.pidNamespaceIdentity === null ? "local" : "unknown";
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

function parseOnboardLockRecord(value: unknown): ParsedOnboardLockRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { pid, startedAt, command, processStartIdentity, hostIdentity, pidNamespaceIdentity } =
    value as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  const fields = value as Record<string, unknown>;
  const format = ["processStartIdentity", "hostIdentity", "pidNamespaceIdentity"].some((field) =>
    Object.hasOwn(fields, field),
  )
    ? "current"
    : "legacy";
  return {
    format,
    record: {
      pid,
      processStartIdentity:
        typeof processStartIdentity === "string" && processStartIdentity.length > 0
          ? processStartIdentity
          : null,
      hostIdentity:
        typeof hostIdentity === "string" && hostIdentity.length > 0 ? hostIdentity : null,
      pidNamespaceIdentity:
        typeof pidNamespaceIdentity === "string" && pidNamespaceIdentity.length > 0
          ? pidNamespaceIdentity
          : null,
      startedAt: typeof startedAt === "string" ? startedAt : null,
      command: typeof command === "string" ? command : null,
    },
  };
}

function canProbeLegacyOwner(probes: OnboardLockIdentityProbes): boolean {
  return (
    probes.localHostIdentity !== null &&
    (process.platform !== "linux" || probes.localPidNamespaceIdentity !== null)
  );
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

  const parsed = parseOnboardLockRecord(value);
  if (parsed === null) {
    return nowMs - modifiedAtMs > ONBOARD_LOCK_SETTLING_MS
      ? { state: "stale" }
      : { state: "settling" };
  }
  const { record } = parsed;
  const provenance = onboardLockHolderProvenance(record, probes);
  if (provenance !== "local") {
    // Pre-provenance NemoClaw versions emitted only pid, startedAt, and
    // command from the host CLI. Preserve that exact compatibility format:
    // when this environment has stable local identity and the recorded PID
    // is demonstrably absent, the interrupted legacy run is stale. Records
    // with any current identity field remain fail-closed when provenance is
    // incomplete, and explicitly foreign records never reach a local probe.
    // Retirement: https://github.com/NVIDIA/NemoClaw/issues/10890. Remove this
    // branch once the minimum supported direct-upgrade source release includes
    // #10845, so every supported writer publishes provenance fields.
    if (
      provenance === "unknown" &&
      parsed.format === "legacy" &&
      canProbeLegacyOwner(probes) &&
      !probes.isAlive(record.pid)
    ) {
      return { state: "stale" };
    }
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

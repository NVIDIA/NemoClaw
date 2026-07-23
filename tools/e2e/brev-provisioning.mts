// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface BrevProvisioningInstance {
  name: string;
  status?: string;
}

export type BrevProvisioningDecision =
  | { kind: "continue"; consecutiveMissing: number }
  | { kind: "terminal"; consecutiveMissing: number; reason: string };

export interface BrevProvisioningSnapshot {
  instances: readonly BrevProvisioningInstance[];
  authoritative: boolean;
}

interface ObserveBrevProvisioningProgressOptions {
  attempt: number;
  instanceName: string;
  consecutiveMissing: number;
  lastSshError: string;
  cause: unknown;
  inspect: () => BrevProvisioningSnapshot;
}

const TERMINAL_STATUSES = new Set([
  "DELETED",
  "DELETING",
  "ERROR",
  "FAILED",
  "OFF",
  "STOPPED",
  "STOPPING",
  "TERMINATED",
]);

function normalizeBrevProvisioningInstance(raw: unknown): BrevProvisioningInstance | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = record.name ?? record.workspaceName ?? record.instanceName ?? record.Name;
  if (typeof name !== "string" || !name.trim()) return null;
  const status = record.status ?? record.state ?? record.lifecycleStatus ?? record.Status;
  return {
    name: name.trim(),
    status: typeof status === "string" ? status.trim().toUpperCase() : undefined,
  };
}

/** Parse only documented Brev JSON inventory shapes, rejecting ambiguous objects. */
export function parseBrevJsonInventory(raw: unknown): BrevProvisioningInstance[] {
  let rawInstances: unknown[];
  if (Array.isArray(raw)) {
    rawInstances = raw;
  } else if (
    raw !== null &&
    typeof raw === "object" &&
    Array.isArray((raw as Record<string, unknown>).workspaces)
  ) {
    rawInstances = (raw as Record<string, unknown>).workspaces as unknown[];
  } else {
    throw new Error("Brev JSON inventory has an unrecognized shape");
  }
  return rawInstances.map((instance, index) => {
    const normalized = normalizeBrevProvisioningInstance(instance);
    if (!normalized) {
      throw new Error(`Brev JSON inventory entry ${index} is malformed`);
    }
    return normalized;
  });
}

/**
 * Parse human-readable `brev ls` output for best-effort cleanup only.
 *
 * Unlike `brev ls --json`, the text form has no machine-readable contract that
 * distinguishes an empty inventory from diagnostic or format-drifted output.
 * It must therefore never be used as authoritative evidence of absence.
 */
export function parseBrevTextInventory(output: string): BrevProvisioningSnapshot {
  const instances: BrevProvisioningInstance[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(/\s+/);
    const [name] = fields;
    if (!name || /^(NAME|TYPE|Usage:|Error:|no)$/i.test(name)) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue;
    const status = fields.find((field) =>
      /^(CREATING|DELETING|FAILED|OFF|ON|READY|RUNNING|STARTING|STOPPED|STOPPING)$/i.test(field),
    );
    instances.push({
      name,
      status: status?.toUpperCase(),
    });
  }
  return { authoritative: false, instances };
}

/** Resolve a bounded retry count from BREV_PROVISION_ATTEMPTS. */
export function parseBrevProvisioningAttempts(raw: string | undefined, fallback = 2): number {
  const parsed = Number(raw ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function evaluateBrevProvisioningState(
  instances: readonly BrevProvisioningInstance[],
  instanceName: string,
  consecutiveMissing: number,
  authoritative: boolean,
  missingThreshold = 3,
): BrevProvisioningDecision {
  if (!authoritative) return { kind: "continue", consecutiveMissing };

  const instance = instances.find((candidate) => candidate.name === instanceName);
  if (!instance) {
    const nextMissing = consecutiveMissing + 1;
    return nextMissing >= missingThreshold
      ? {
          kind: "terminal",
          consecutiveMissing: nextMissing,
          reason: `Brev no longer reports instance "${instanceName}" after ${nextMissing} successful list queries`,
        }
      : { kind: "continue", consecutiveMissing: nextMissing };
  }

  const status = instance.status?.trim().toUpperCase();
  if (status && TERMINAL_STATUSES.has(status)) {
    return {
      kind: "terminal",
      consecutiveMissing: 0,
      reason: `Brev reports terminal status ${status} for instance "${instanceName}"`,
    };
  }

  return { kind: "continue", consecutiveMissing: 0 };
}

export function observeBrevProvisioningProgress({
  attempt,
  instanceName,
  consecutiveMissing,
  lastSshError,
  cause,
  inspect,
}: ObserveBrevProvisioningProgressOptions): number {
  if (attempt !== 1 && attempt % 3 !== 0) return consecutiveMissing;

  const snapshot = inspect();
  const decision = evaluateBrevProvisioningState(
    snapshot.instances,
    instanceName,
    consecutiveMissing,
    snapshot.authoritative,
  );
  if (decision.kind === "terminal") {
    throw new Error(`${decision.reason}. Last SSH error: ${lastSshError}`, { cause });
  }
  return decision.consecutiveMissing;
}

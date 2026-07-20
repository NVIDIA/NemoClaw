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

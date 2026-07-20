// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface BrevProvisioningInstance {
  name: string;
  status?: string;
}

export type BrevProvisioningDecision =
  | { kind: "continue"; consecutiveMissing: number }
  | { kind: "terminal"; consecutiveMissing: number; reason: string };

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

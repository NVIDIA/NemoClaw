// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ReadinessCapability, SystemReadinessReport } from "./types.js";

export const STORAGE_COMPATIBLE_CAPABILITY = "host.docker.storage_compatible";
const STORAGE_REMEDIATION_CAPABILITY = "host.docker.storage_remediation_available";
const STORAGE_INCOMPATIBLE_FINDING = "host.docker.storage_incompatible";

function capabilityState(
  report: SystemReadinessReport,
  id: string,
): ReadinessCapability["state"] | undefined {
  const matches = report.capabilities.filter((capability) => capability.id === id);
  return matches.length === 1 ? matches[0]!.state : undefined;
}

export function hasRemediableStorageConflict(report: SystemReadinessReport): boolean {
  const blocking = report.findings.filter(
    ({ severity }) => severity === "fatal" || severity === "blocking",
  );
  return (
    report.status === "incompatible" &&
    report.exitCode === 2 &&
    blocking.length === 1 &&
    blocking[0]!.id === STORAGE_INCOMPATIBLE_FINDING &&
    blocking[0]!.severity === "blocking" &&
    blocking[0]!.capabilityIds?.length === 1 &&
    blocking[0]!.capabilityIds[0] === STORAGE_COMPATIBLE_CAPABILITY &&
    capabilityState(report, STORAGE_COMPATIBLE_CAPABILITY) === "absent" &&
    capabilityState(report, STORAGE_REMEDIATION_CAPABILITY) === "present"
  );
}

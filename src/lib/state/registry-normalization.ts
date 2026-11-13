// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isObjectRecord } from "../core/json-types";
import type { SandboxEntry, SandboxExternalComponentSelection } from "./registry/types";
import { normalizePendingSandboxCreateIdentity } from "./registry/pending-create-identity";

export { normalizePendingSandboxCreateIdentity };

const POLICY_SHADOW_FIELDS = [
  "baselineExclusions",
  "baselineExclusionTransition",
  "customPolicies",
  "policies",
  "policyAuthority",
  "policyCreationReceipt",
  "pendingPolicyVerification",
  "policyHash",
  "policyPresetsFinalized",
  "policyTier",
  "policyVersion",
  "observedPolicyAuthority",
] as const;

/** Remove legacy policy shadow state without interpreting or replaying it. */
export function normalizeSandboxPolicyAttribution(entry: SandboxEntry): SandboxEntry {
  const result = { ...entry } as SandboxEntry & Record<string, unknown>;
  for (const field of POLICY_SHADOW_FIELDS) delete result[field];
  if (result.pendingCreateIdentity !== undefined) {
    result.pendingCreateIdentity = normalizePendingSandboxCreateIdentity(
      result.pendingCreateIdentity,
    );
  }
  return result;
}

export function parseSandboxRegistryEntries(value: unknown): Array<[string, SandboxEntry]> {
  const sandboxes = isObjectRecord(value) ? value : {};
  return Object.entries(sandboxes).filter((entry): entry is [string, SandboxEntry] =>
    isSandboxEntryLike(entry[0], entry[1]),
  );
}

function isSandboxEntryLike(name: string, entry: unknown): entry is SandboxEntry {
  return (
    isObjectRecord(entry) &&
    typeof entry.name === "string" &&
    entry.name === name &&
    entry.name.trim().length > 0
  );
}

export function retainedDefaultSandbox(
  defaultSandbox: string | null,
  sandboxes: Record<string, SandboxEntry>,
): string | null {
  if (defaultSandbox === null) return null;
  if (!Object.prototype.hasOwnProperty.call(sandboxes, defaultSandbox)) return null;
  const entry = sandboxes[defaultSandbox];
  if (!entry || entry.pendingRouteReservation === true) return null;
  return defaultSandbox;
}

const COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;

export function parseSandboxExternalComponentSelection(
  value: unknown,
): SandboxExternalComponentSelection | null {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (
    !record ||
    Object.keys(record).length !== 5 ||
    record.schemaVersion !== 1 ||
    typeof record.componentId !== "string" ||
    !COMPONENT_ID.test(record.componentId) ||
    typeof record.gatewayName !== "string" ||
    !record.gatewayName ||
    typeof record.lifecycleGeneration !== "string" ||
    !record.lifecycleGeneration ||
    typeof record.sandboxIdentityFingerprint !== "string" ||
    !FINGERPRINT.test(record.sandboxIdentityFingerprint)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    componentId: record.componentId,
    gatewayName: record.gatewayName,
    lifecycleGeneration: record.lifecycleGeneration,
    sandboxIdentityFingerprint: record.sandboxIdentityFingerprint,
  };
}

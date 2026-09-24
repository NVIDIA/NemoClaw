// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isObjectRecord } from "../core/json-types";
import type { SandboxEntry } from "./registry/types";
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

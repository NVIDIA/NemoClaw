// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxPolicyAuthority } from "../adapters/openshell/policy-authority";
import { isObjectRecord } from "../core/json-types";
import { normalizeTrustedPrivatePolicyPinReceipt } from "../policy/trusted-private-endpoints";
import type {
  BaselineExclusionEntry,
  BaselineExclusionTransition,
  CustomPolicyEntry,
  SandboxEntry,
} from "./registry/types";

const BASELINE_TRANSITION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASELINE_TRANSITION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/** Keep legacy absence unknown and reject every unrecognized authority value. */
export function normalizeSandboxPolicyAuthority(
  value: unknown,
): SandboxPolicyAuthority | undefined {
  if (value === undefined) return undefined;
  if (value === "nemoclaw-managed" || value === "externally-managed") return value;
  throw new Error(
    "Sandbox registry contains an invalid policy authority; repair the registry before continuing",
  );
}

/** Remove policy attribution that an external authority owns and normalize managed state. */
export function normalizeSandboxPolicyAttribution(entry: SandboxEntry): SandboxEntry {
  const policyAuthority = normalizeSandboxPolicyAuthority(entry.policyAuthority);
  const {
    policies: _policies,
    customPolicies: _customPolicies,
    baselineExclusions: _baselineExclusions,
    baselineExclusionTransition: _baselineExclusionTransition,
    policyPresetsFinalized: _policyPresetsFinalized,
    policyTier: _policyTier,
    policyAuthority: _policyAuthority,
    ...rest
  } = entry;
  if (policyAuthority === "externally-managed") {
    return { ...rest, policies: [], policyAuthority };
  }

  const baselineExclusions = normalizeBaselineExclusions(entry.baselineExclusions);
  const baselineExclusionTransition = normalizeBaselineExclusionTransition(
    entry.baselineExclusionTransition,
  );
  const customPolicies = normalizeCustomPolicyEntries(entry.customPolicies);
  return {
    ...rest,
    ...(entry.policies !== undefined ? { policies: entry.policies } : {}),
    ...(customPolicies ? { customPolicies } : {}),
    ...(baselineExclusions ? { baselineExclusions } : {}),
    ...(baselineExclusionTransition ? { baselineExclusionTransition } : {}),
    ...(entry.policyPresetsFinalized !== undefined
      ? { policyPresetsFinalized: entry.policyPresetsFinalized }
      : {}),
    ...(entry.policyTier !== undefined ? { policyTier: entry.policyTier } : {}),
    ...(policyAuthority !== undefined ? { policyAuthority } : {}),
  };
}

/** Normalize persisted custom policy content and its generated-pin authority. */
export function normalizeCustomPolicyEntries(value: unknown): CustomPolicyEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      "Sandbox registry customPolicies must be an array; repair the registry before rebuilding",
    );
  }
  const entries: CustomPolicyEntry[] = [];
  for (const item of value) {
    if (
      !isObjectRecord(item) ||
      typeof item.name !== "string" ||
      item.name.trim().length === 0 ||
      typeof item.content !== "string" ||
      (item.pendingContent !== undefined && typeof item.pendingContent !== "string") ||
      (item.sourcePath !== undefined && typeof item.sourcePath !== "string") ||
      (item.appliedAt !== undefined && typeof item.appliedAt !== "string")
    ) {
      throw new Error(
        "Sandbox registry contains a malformed custom policy; repair the registry before rebuilding",
      );
    }
    let trustedPrivatePins;
    try {
      trustedPrivatePins = normalizeTrustedPrivatePolicyPinReceipt(
        item.content,
        item.trustedPrivatePins,
      );
    } catch {
      throw new Error(
        `Sandbox registry custom policy '${item.name}' has invalid trusted-private pin authority; repair the registry before rebuilding`,
      );
    }
    entries.push({
      name: item.name,
      content: item.content,
      ...(item.pendingContent !== undefined ? { pendingContent: item.pendingContent } : {}),
      ...(item.sourcePath !== undefined ? { sourcePath: item.sourcePath } : {}),
      ...(item.appliedAt !== undefined ? { appliedAt: item.appliedAt } : {}),
      ...(trustedPrivatePins ? { trustedPrivatePins } : {}),
    });
  }
  return entries.length > 0 ? entries : undefined;
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function normalizeBaselineExclusionEntry(item: unknown): BaselineExclusionEntry {
  if (!isObjectRecord(item)) {
    throw new Error(
      "Sandbox registry contains a malformed baseline exclusion; repair the registry before rebuilding",
    );
  }
  const version = item.version;
  const agent = typeof item.agent === "string" ? item.agent.trim() : "";
  const key = typeof item.key === "string" ? item.key.trim() : "";
  const digest = typeof item.digest === "string" ? item.digest.trim() : "";
  const acknowledgedAt =
    typeof item.acknowledgedAt === "string" ? item.acknowledgedAt.trim() : item.acknowledgedAt;
  if (
    version !== 1 ||
    !BASELINE_TRANSITION_KEY_PATTERN.test(agent) ||
    !BASELINE_TRANSITION_KEY_PATTERN.test(key) ||
    !SHA256_DIGEST_PATTERN.test(digest) ||
    (acknowledgedAt !== undefined &&
      (typeof acknowledgedAt !== "string" || !isCanonicalIsoTimestamp(acknowledgedAt)))
  ) {
    throw new Error(
      "Sandbox registry contains an invalid versioned baseline exclusion; repair the registry before rebuilding",
    );
  }
  const entry: BaselineExclusionEntry = { version, agent, key, digest };
  if (typeof acknowledgedAt === "string") entry.acknowledgedAt = acknowledgedAt;
  if (item.appliedAgentVersion === null) {
    entry.appliedAgentVersion = null;
  } else if (typeof item.appliedAgentVersion === "string") {
    entry.appliedAgentVersion = item.appliedAgentVersion;
  } else if (item.appliedAgentVersion !== undefined) {
    throw new Error(
      `Sandbox registry baseline exclusion '${key}' has an invalid agent version; repair the registry before rebuilding`,
    );
  }
  return entry;
}

/**
 * Coerce a persisted `baselineExclusions` value into well-formed entries.
 * A legacy registry without the field yields `undefined`, while malformed
 * exclusion state fails closed so rebuild cannot silently restore egress that
 * the operator intended to remove.
 */
export function normalizeBaselineExclusions(value: unknown): BaselineExclusionEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      "Sandbox registry baselineExclusions must be an array; repair the registry before rebuilding",
    );
  }
  const byKey = new Map<string, BaselineExclusionEntry>();
  for (const item of value) {
    const entry = normalizeBaselineExclusionEntry(item);
    const { key } = entry;
    byKey.set(key, entry);
  }
  return byKey.size > 0 ? [...byKey.values()] : undefined;
}

/** Normalize the crash-recovery journal, rejecting partial or forged states. */
export function normalizeBaselineExclusionTransition(
  value: unknown,
): BaselineExclusionTransition | undefined {
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) {
    throw new Error(
      "Sandbox registry contains a malformed baseline exclusion transition; repair the registry before rebuilding",
    );
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const operation = value.operation;
  const startedAt = typeof value.startedAt === "string" ? value.startedAt.trim() : "";
  if (
    !BASELINE_TRANSITION_ID_PATTERN.test(id) ||
    (operation !== "exclude" && operation !== "restore") ||
    !isCanonicalIsoTimestamp(startedAt)
  ) {
    throw new Error(
      "Sandbox registry contains an incomplete baseline exclusion transition; repair the registry before rebuilding",
    );
  }
  const exclusion = normalizeBaselineExclusionEntry(value.exclusion);
  if (
    !BASELINE_TRANSITION_KEY_PATTERN.test(exclusion.key) ||
    !SHA256_DIGEST_PATTERN.test(exclusion.digest) ||
    (exclusion.acknowledgedAt !== undefined && !isCanonicalIsoTimestamp(exclusion.acknowledgedAt))
  ) {
    throw new Error(
      "Sandbox registry contains an invalid baseline exclusion transition source; repair the registry before rebuilding",
    );
  }
  const targetLiveDigest =
    value.targetLiveDigest === null
      ? null
      : typeof value.targetLiveDigest === "string"
        ? value.targetLiveDigest.trim()
        : "";
  if (
    (operation === "exclude" && targetLiveDigest !== null) ||
    (operation === "restore" &&
      (targetLiveDigest === null || !SHA256_DIGEST_PATTERN.test(targetLiveDigest)))
  ) {
    throw new Error(
      `Sandbox registry baseline exclusion transition '${exclusion.key}' has an invalid live target; repair the registry before rebuilding`,
    );
  }
  return { id, operation, exclusion, targetLiveDigest, startedAt };
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

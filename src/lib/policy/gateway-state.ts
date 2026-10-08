// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import {
  getTelemetryTarget,
  isTelemetryOperationActive,
  recordTelemetryTarget,
} from "../actions/telemetry/operation";
import type {
  TelemetryOutcome,
  TelemetryState,
  ValueStatus,
  TelemetryMetadataError,
} from "../domain/telemetry/event";
import {
  readAppliedPolicySelection,
  type AppliedPolicySelection,
} from "../domain/telemetry/provenance";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding/identity";
import type { SandboxEntry } from "../state/registry/types";
import {
  readSandboxTelemetryEntry,
  updateSandboxTelemetrySelections,
} from "../state/registry/telemetry-selections";

export type PresetContentSource = { name: string; content: string | null };
export type PresetContentGatewayState = "match" | "absent" | "drift" | null;

type GatewayInspectionOptions = {
  readPolicy: () => string;
  parseCurrentPolicy: (raw: string | null | undefined) => string;
  extractPresetEntries: (content: string | null | undefined) => string | null;
};

function readParsedPolicy(options: GatewayInspectionOptions): Record<string, unknown> | null {
  let rawPolicy: string;
  try {
    rawPolicy = options.readPolicy();
  } catch {
    return null;
  }
  const currentPolicy = options.parseCurrentPolicy(rawPolicy);
  if (!currentPolicy) return null;
  try {
    const parsed = YAML.parse(currentPolicy);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function presetPolicyKeys(
  content: string | null,
  extractPresetEntries: GatewayInspectionOptions["extractPresetEntries"],
): string[] | null {
  const entries = extractPresetEntries(content);
  if (!entries) return null;
  try {
    const policies = YAML.parse(`network_policies:\n${entries}`)?.network_policies;
    if (!policies || typeof policies !== "object" || Array.isArray(policies)) return null;
    const keys = Object.keys(policies);
    return keys.length > 0 ? keys : null;
  } catch {
    return null;
  }
}

export function inspectGatewayPresetNames(
  options: GatewayInspectionOptions & { sources: () => readonly PresetContentSource[] },
): string[] | null {
  const parsed = readParsedPolicy(options);
  if (!parsed) return null;
  const policies = parsed.network_policies;
  if (!policies || typeof policies !== "object" || Array.isArray(policies)) return [];
  const gatewayKeys = new Set(Object.keys(policies));
  return options.sources().flatMap((source) => {
    const keys = presetPolicyKeys(source.content, options.extractPresetEntries);
    return keys?.every((key) => gatewayKeys.has(key)) ? [source.name] : [];
  });
}

export function inspectPresetContentGatewayState(
  options: GatewayInspectionOptions & { presetContent: string; policyKey?: string },
): PresetContentGatewayState {
  const parsed = readParsedPolicy(options);
  if (!parsed) return null;
  const current = parsed.network_policies;
  const entries = options.extractPresetEntries(options.presetContent);
  if (!entries) return "drift";
  try {
    const expected = YAML.parse(`network_policies:\n${entries}`)?.network_policies;
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !expected ||
      typeof expected !== "object" ||
      Array.isArray(expected)
    ) {
      return "drift";
    }
    const currentPolicies = current as Record<string, unknown>;
    const expectedPolicies = expected as Record<string, unknown>;
    const expectedKeys =
      options.policyKey === undefined ? Object.keys(expectedPolicies) : [options.policyKey];
    if (expectedKeys.length === 0) return "drift";
    if (options.policyKey !== undefined && !Object.hasOwn(expectedPolicies, options.policyKey)) {
      return "drift";
    }
    const presentKeys = expectedKeys.filter((key) => Object.hasOwn(currentPolicies, key));
    if (presentKeys.length === 0) return "absent";
    if (presentKeys.length !== expectedKeys.length) return "drift";
    return expectedKeys.every((key) =>
      isDeepStrictEqual(currentPolicies[key], expectedPolicies[key]),
    )
      ? "match"
      : "drift";
  } catch {
    return "drift";
  }
}

export function recordPolicyResult(
  sandboxName: string,
  outcome: TelemetryOutcome,
  state: TelemetryState,
  verificationStatus?: ValueStatus,
  metadataErrors?: TelemetryMetadataError[],
): void {
  if (!isTelemetryOperationActive()) return;
  let gatewayName = "";
  try {
    const entry = readSandboxTelemetryEntry(sandboxName);
    if (entry) gatewayName = resolveSandboxGatewayName(entry);
  } catch {
    /* Missing owner evidence must not change the product action. */
  }
  const previous = getTelemetryTarget(sandboxName, gatewayName);
  if (outcome === "no_change" && previous?.outcome === "completed") return;
  recordTelemetryTarget({
    scope: "configuration",
    sandboxName,
    gatewayName,
    outcome,
    state,
    ...(verificationStatus ? { verificationStatus } : {}),
    ...(metadataErrors ? { metadataErrors } : {}),
  });
}

/** Store only the verified tier receipt without delaying or changing product success. */
export function persistAppliedPolicySelection(
  sandboxName: string,
  receipt: AppliedPolicySelection,
): boolean {
  try {
    const entry = readSandboxTelemetryEntry(sandboxName);
    if (entry && updateSandboxTelemetrySelections(entry, { appliedPolicySelection: receipt }))
      return true;
  } catch {
    /* The policy is applied; only its selection receipt could not be stored. */
  }
  recordPolicyResult(sandboxName, "completed", "applied", "collection_error", [
    { category: "policy_tier" },
  ]);
  return false;
}

/** Retain selection origin only after the captured live policy's rebuild was accepted. */
export function restoreAppliedPolicySelection(
  sandboxName: string,
  previous?: SandboxEntry,
): boolean {
  try {
    const entry = readSandboxTelemetryEntry(sandboxName);
    if (!entry || entry.name !== sandboxName) return false;
    const gatewayName = resolveSandboxGatewayName(entry);
    // A newer verified selection owns the replacement; never replace it with history.
    if (entry.appliedPolicySelection !== undefined)
      return readAppliedPolicySelection(entry.appliedPolicySelection) !== null;
    if (previous?.appliedPolicySelection === undefined) return true;
    if (
      previous.pendingCreateIdentity !== undefined ||
      previous.pendingRouteReservation !== undefined ||
      previous.name !== entry.name ||
      (previous.agent ?? "openclaw") !== (entry.agent ?? "openclaw") ||
      resolveSandboxGatewayName(previous) !== gatewayName
    )
      return false;
    const receipt = readAppliedPolicySelection(previous.appliedPolicySelection);
    return (
      receipt !== null &&
      updateSandboxTelemetrySelections(entry, { appliedPolicySelection: receipt })
    );
  } catch {
    // Policy application remains successful when optional metadata cannot be saved.
    return false;
  }
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import {
  assertExternalPolicyRequirements,
  assertRecordedPolicyAuthority,
  inspectGlobalPolicyAuthority,
  inspectSandboxPolicyAuthority,
  type SandboxPolicyAuthority,
  type SandboxPolicyAuthorityInspection,
} from "../../../adapters/openshell/policy-authority";
import * as policies from "../../../policy";
import * as registry from "../../../policy/policy-registry";
import type { SandboxEntry } from "../../../policy/policy-registry";
import { MCP_BRIDGE_POLICY_SOURCE } from "../mcp-bridge-policy";
import { resolveManagedMcpPolicyRequirementContents } from "./mcp-requirements";

export { resolveManagedMcpPolicyRequirementContents };

type RequiredPolicy = Record<string, unknown>;

interface SnapshotPolicyAuthorityDeps {
  readonly inspectGlobalPolicyAuthority?: typeof inspectGlobalPolicyAuthority;
  readonly inspectSandboxPolicyAuthority?: typeof inspectSandboxPolicyAuthority;
}

export interface SnapshotPolicyAuthorityReceipt {
  readonly authority: SandboxPolicyAuthority;
  readonly gatewayName: string;
  readonly inspectLiveSource: boolean;
  readonly managedMcpPolicies: readonly RequiredPolicy[];
  readonly operation: string;
  readonly requiredPolicies: readonly RequiredPolicy[];
  readonly sourceSandboxName: string;
  readonly verifyGlobalCreatePolicy: boolean;
}

export interface SnapshotPolicyAuthorityRemovalReceipt {
  readonly entry: SandboxEntry;
}

function parseRequiredPolicy(content: string, operation: string): RequiredPolicy {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch {
    throw new Error(`Refusing to ${operation}: a required network policy document is invalid.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Refusing to ${operation}: a required network policy document is invalid.`);
  }
  const networkPolicies = (parsed as RequiredPolicy).network_policies;
  if (
    networkPolicies !== undefined &&
    (typeof networkPolicies !== "object" ||
      networkPolicies === null ||
      Array.isArray(networkPolicies))
  ) {
    throw new Error(`Refusing to ${operation}: a required network policy document is invalid.`);
  }
  return parsed as RequiredPolicy;
}

/** Resolve every network-policy document that snapshot restore may replay. */
export function resolveSnapshotPolicyRequirements(input: {
  readonly basePolicyContent?: string;
  readonly builtinPresetNames: readonly string[];
  readonly customPolicies: readonly {
    readonly content: string;
    readonly name: string;
    readonly sourcePath?: string;
  }[];
  readonly managedMcpPolicyContents?: readonly string[];
  readonly operation: string;
  readonly sandboxName: string;
}): RequiredPolicy[] {
  const required: RequiredPolicy[] = [];
  if (input.basePolicyContent !== undefined) {
    if (input.basePolicyContent.length === 0) {
      throw new Error(`Refusing to ${input.operation}: the required create policy is empty.`);
    }
    required.push(parseRequiredPolicy(input.basePolicyContent, input.operation));
  }

  const customNames = new Set<string>();
  for (const custom of input.customPolicies) {
    if (custom.sourcePath === MCP_BRIDGE_POLICY_SOURCE) continue;
    const name = custom.name.trim();
    if (!name || typeof custom.content !== "string" || custom.content.length === 0) {
      throw new Error(
        `Refusing to ${input.operation}: required custom policy metadata is invalid.`,
      );
    }
    customNames.add(name.toLowerCase());
    required.push(parseRequiredPolicy(custom.content, input.operation));
  }
  for (const content of input.managedMcpPolicyContents ?? []) {
    required.push(parseRequiredPolicy(content, input.operation));
  }
  for (const rawName of input.builtinPresetNames) {
    const name = rawName.trim();
    if (!name) {
      throw new Error(`Refusing to ${input.operation}: a required policy preset name is invalid.`);
    }
    if (customNames.has(name.toLowerCase())) continue;
    const content = policies.loadPresetForSandbox(input.sandboxName, name);
    if (!content) {
      throw new Error(
        `Refusing to ${input.operation}: required policy preset '${name}' is unavailable.`,
      );
    }
    required.push(parseRequiredPolicy(content, input.operation));
  }
  return required;
}

function verifyRequirements(
  inspection: SandboxPolicyAuthorityInspection,
  receipt: Pick<
    SnapshotPolicyAuthorityReceipt,
    "operation" | "requiredPolicies" | "sourceSandboxName"
  >,
): void {
  for (const requiredPolicy of receipt.requiredPolicies) {
    assertExternalPolicyRequirements({
      inspection,
      requiredPolicy,
      operation: receipt.operation,
      sandboxName: receipt.sourceSandboxName,
    });
  }
}

function inspectSnapshotAuthorities(
  receipt: Omit<SnapshotPolicyAuthorityReceipt, "authority">,
  recordedAuthority: unknown,
  deps: SnapshotPolicyAuthorityDeps,
): {
  authority: SandboxPolicyAuthority;
  globalInspection: SandboxPolicyAuthorityInspection | null;
  liveInspection: SandboxPolicyAuthorityInspection | null;
} {
  const liveInspection = receipt.inspectLiveSource
    ? (deps.inspectSandboxPolicyAuthority ?? inspectSandboxPolicyAuthority)({
        sandboxName: receipt.sourceSandboxName,
        gatewayName: receipt.gatewayName,
      })
    : null;
  if (liveInspection && recordedAuthority !== undefined) {
    assertRecordedPolicyAuthority(recordedAuthority, liveInspection.authority, receipt.operation);
  }
  const globalInspection = receipt.verifyGlobalCreatePolicy
    ? (deps.inspectGlobalPolicyAuthority ?? inspectGlobalPolicyAuthority)({
        gatewayName: receipt.gatewayName,
      })
    : null;
  if (liveInspection && globalInspection) {
    assertRecordedPolicyAuthority(
      liveInspection.authority,
      globalInspection.authority,
      receipt.operation,
    );
    return { authority: liveInspection.authority, globalInspection, liveInspection };
  }
  if (liveInspection) {
    return { authority: liveInspection.authority, globalInspection, liveInspection };
  }
  if (globalInspection) {
    if (recordedAuthority === undefined) {
      throw new Error(
        `Refusing to ${receipt.operation}: legacy policy authority requires a live source inspection.`,
      );
    }
    assertRecordedPolicyAuthority(recordedAuthority, globalInspection.authority, receipt.operation);
    return { authority: globalInspection.authority, globalInspection, liveInspection };
  }
  throw new Error(`Refusing to ${receipt.operation}: policy authority could not be inspected.`);
}

/** Qualify snapshot restore or clone policy authority before destination effects. */
export function qualifySnapshotPolicyAuthority(
  input: {
    readonly gatewayName: string;
    readonly operation: string;
    readonly managedMcpPolicies: readonly RequiredPolicy[];
    readonly requiredPolicies: readonly RequiredPolicy[];
    readonly sourceEntry: SandboxEntry;
    readonly sourceLive: boolean;
    readonly verifyGlobalCreatePolicy: boolean;
  },
  deps: SnapshotPolicyAuthorityDeps = {},
): SnapshotPolicyAuthorityReceipt {
  if (!input.sourceLive && input.sourceEntry.policyAuthority === undefined) {
    throw new Error(
      `Refusing to ${input.operation}: legacy policy authority requires a live source inspection.`,
    );
  }
  const receiptWithoutAuthority = {
    gatewayName: input.gatewayName,
    inspectLiveSource: input.sourceLive,
    managedMcpPolicies: input.managedMcpPolicies,
    operation: input.operation,
    requiredPolicies: input.requiredPolicies,
    sourceSandboxName: input.sourceEntry.name,
    verifyGlobalCreatePolicy: input.verifyGlobalCreatePolicy,
  };
  const inspection = inspectSnapshotAuthorities(
    receiptWithoutAuthority,
    input.sourceEntry.policyAuthority,
    deps,
  );
  const { authority } = inspection;
  if (input.sourceEntry.policyAuthority === undefined) {
    if (!registry.updateSandbox(input.sourceEntry.name, { policyAuthority: authority })) {
      throw new Error(
        `Refusing to ${input.operation}: the observed policy authority could not be recorded.`,
      );
    }
  }
  input.sourceEntry.policyAuthority = authority;
  if (inspection.liveInspection)
    verifyRequirements(inspection.liveInspection, receiptWithoutAuthority);
  if (inspection.globalInspection) {
    verifyRequirements(inspection.globalInspection, receiptWithoutAuthority);
  }
  return { ...receiptWithoutAuthority, authority };
}

/** Inspect an unregistered Ready clone against its qualified source receipt. */
export function inspectSnapshotCloneTargetPolicyAuthority(
  sourceReceipt: SnapshotPolicyAuthorityReceipt,
  targetSandboxName: string,
  deps: SnapshotPolicyAuthorityDeps = {},
): SnapshotPolicyAuthorityReceipt {
  const targetReceiptWithoutAuthority = {
    gatewayName: sourceReceipt.gatewayName,
    inspectLiveSource: true,
    managedMcpPolicies: sourceReceipt.managedMcpPolicies,
    operation: sourceReceipt.operation,
    requiredPolicies: sourceReceipt.requiredPolicies,
    sourceSandboxName: targetSandboxName,
    verifyGlobalCreatePolicy: false,
  };
  const inspection = inspectSnapshotAuthorities(
    targetReceiptWithoutAuthority,
    sourceReceipt.authority,
    deps,
  );
  assertRecordedPolicyAuthority(
    sourceReceipt.authority,
    inspection.authority,
    sourceReceipt.operation,
  );
  if (!inspection.liveInspection) {
    throw new Error(
      `Refusing to ${sourceReceipt.operation}: the Ready clone policy could not be inspected.`,
    );
  }
  verifyRequirements(inspection.liveInspection, targetReceiptWithoutAuthority);
  return { ...targetReceiptWithoutAuthority, authority: inspection.authority };
}

async function revalidateRecordedSnapshotPolicyAuthority(
  receipt: SnapshotPolicyAuthorityReceipt,
): Promise<SandboxEntry> {
  const current = registry.getSandbox(receipt.sourceSandboxName);
  if (!current) {
    throw new Error(
      `Refusing to ${receipt.operation}: the snapshot source is no longer registered.`,
    );
  }
  if (current.policyAuthority === undefined) {
    throw new Error(`Refusing to ${receipt.operation}: the recorded policy authority is missing.`);
  }
  assertRecordedPolicyAuthority(current.policyAuthority, receipt.authority, receipt.operation);
  const currentManagedMcpPolicies = (
    await resolveManagedMcpPolicyRequirementContents(current, receipt.operation)
  ).map((content) => parseRequiredPolicy(content, receipt.operation));
  if (!isDeepStrictEqual(currentManagedMcpPolicies, receipt.managedMcpPolicies)) {
    throw new Error(
      `Refusing to ${receipt.operation}: managed MCP policy requirements changed after qualification.`,
    );
  }
  return current;
}

/** Recheck the durable portion of a receipt after its live sandbox was deleted. */
export async function revalidateDeletedSnapshotPolicyAuthority(
  receipt: SnapshotPolicyAuthorityReceipt,
): Promise<void> {
  await revalidateRecordedSnapshotPolicyAuthority(receipt);
}

/** Check the exact registry row captured by the terminal destination removal. */
export async function revalidateRemovedSnapshotPolicyAuthority(
  receipt: SnapshotPolicyAuthorityReceipt,
  removalReceipt: SnapshotPolicyAuthorityRemovalReceipt,
): Promise<void> {
  const removed = removalReceipt.entry;
  if (removed.name !== receipt.sourceSandboxName || removed.policyAuthority === undefined) {
    throw new Error(
      `Refusing to ${receipt.operation}: the removed destination authority receipt is invalid.`,
    );
  }
  assertRecordedPolicyAuthority(removed.policyAuthority, receipt.authority, receipt.operation);
  const removedManagedMcpPolicies = (
    await resolveManagedMcpPolicyRequirementContents(removed, receipt.operation)
  ).map((content) => parseRequiredPolicy(content, receipt.operation));
  if (!isDeepStrictEqual(removedManagedMcpPolicies, receipt.managedMcpPolicies)) {
    throw new Error(
      `Refusing to ${receipt.operation}: managed MCP policy requirements changed before destination removal.`,
    );
  }
}

/** Recheck a snapshot authority receipt at the destination mutation edge. */
export async function revalidateSnapshotPolicyAuthority(
  receipt: SnapshotPolicyAuthorityReceipt,
  deps: SnapshotPolicyAuthorityDeps = {},
): Promise<void> {
  const current = await revalidateRecordedSnapshotPolicyAuthority(receipt);
  const inspection = inspectSnapshotAuthorities(receipt, current.policyAuthority, deps);
  assertRecordedPolicyAuthority(receipt.authority, inspection.authority, receipt.operation);
  if (inspection.liveInspection) verifyRequirements(inspection.liveInspection, receipt);
  if (inspection.globalInspection) verifyRequirements(inspection.globalInspection, receipt);
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertRecordedPolicyAuthority } from "../../../adapters/openshell/policy-authority";
import {
  isDcodeAgent,
  OBSERVABILITY_POLICY_BINDING,
} from "../../../onboard/observability-policy-presets";
import { normalizePolicyTierName } from "../../../onboard/policy-tier-suppression";
import { HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL } from "../../../onboard/runtime-provider/host-local-inference-routing";
import * as policies from "../../../policy";
import * as registry from "../../../policy/policy-registry";
import type { SandboxEntry } from "../../../policy/policy-registry";
import { getMessagingPlanFromEntry } from "../../../state/registry-messaging";
import { MCP_BRIDGE_POLICY_SOURCE } from "../mcp-bridge-policy";
import { resolveManagedMcpPolicyRequirementContents } from "./mcp-requirements";
import {
  assertManagedMcpPolicyRequirementsUnchanged,
  inspectPolicyAuthorityRequirements,
  parseRequiredPolicyDocument,
  type PolicyAuthorityInspectionDeps,
  type RequiredPolicy,
} from "./preflight";

export { resolveManagedMcpPolicyRequirementContents };

export interface SnapshotPolicyAuthorityReceipt {
  readonly authority: "nemoclaw-managed" | "externally-managed";
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

const LOCAL_INFERENCE_POLICY_PROVIDERS = new Set(["llama-cpp-local", "ollama-local", "vllm-local"]);

/** Derive requirements from durable features even when external authority clears preset attribution. */
export function resolveSnapshotBuiltinPolicyRequirements(input: {
  readonly customPolicies: readonly { readonly content: string }[];
  readonly snapshotPolicyPresets: readonly string[];
  readonly sourceEntry: SandboxEntry;
}): string[] {
  const { sourceEntry } = input;
  const required = new Set(input.snapshotPolicyPresets);
  const messagingPlan = getMessagingPlanFromEntry(sourceEntry);
  const disabledChannels = new Set(messagingPlan?.disabledChannels ?? []);
  for (const entry of messagingPlan?.networkPolicy.entries ?? []) {
    if (!disabledChannels.has(entry.channelId)) required.add(entry.presetName);
  }

  if (
    sourceEntry.webSearchEnabled === true &&
    (sourceEntry.webSearchProvider === "brave" || sourceEntry.webSearchProvider === "tavily")
  ) {
    required.add(sourceEntry.webSearchProvider);
  }
  const usesCanonicalInjectedHostRoute =
    sourceEntry.endpointUrl === HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL &&
    sourceEntry.endpointSource === "inference-set" &&
    typeof sourceEntry.hostLocalInferenceReceipt === "string" &&
    sourceEntry.hostLocalInferenceProvenance !== undefined;
  if (
    typeof sourceEntry.provider === "string" &&
    LOCAL_INFERENCE_POLICY_PROVIDERS.has(sourceEntry.provider) &&
    !usesCanonicalInjectedHostRoute
  ) {
    required.add("local-inference");
  }

  const customOwnsObservability = input.customPolicies.some((entry) =>
    OBSERVABILITY_POLICY_BINDING.ownsContent(entry.content),
  );
  const includeManagedObservability =
    !customOwnsObservability &&
    isDcodeAgent(sourceEntry.agent) &&
    sourceEntry.observabilityEnabled === true &&
    normalizePolicyTierName(sourceEntry.policyTier) !== "restricted";
  return OBSERVABILITY_POLICY_BINDING.setAttribution([...required], includeManagedObservability);
}

function parseRequiredPolicy(content: string, operation: string): RequiredPolicy {
  const parsed = parseRequiredPolicyDocument(content, operation);
  const networkPolicies = parsed.network_policies;
  if (
    typeof networkPolicies !== "object" ||
    networkPolicies === null ||
    Array.isArray(networkPolicies) ||
    Object.keys(networkPolicies).length === 0
  ) {
    throw new Error(`Refusing to ${operation}: a required network policy document is invalid.`);
  }
  return parsed;
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
  deps: PolicyAuthorityInspectionDeps = {},
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
  const inspection = inspectPolicyAuthorityRequirements(
    {
      ...receiptWithoutAuthority,
      recordedAuthority: input.sourceEntry.policyAuthority,
      sandboxName: receiptWithoutAuthority.sourceSandboxName,
    },
    deps,
  );
  const { authority } = inspection;
  if (
    input.sourceEntry.policyAuthority === undefined &&
    !registry.updateSandbox(input.sourceEntry.name, { policyAuthority: authority })
  ) {
    throw new Error(
      `Refusing to ${input.operation}: the observed policy authority could not be recorded.`,
    );
  }
  input.sourceEntry.policyAuthority = authority;
  inspection.verifyRequirements();
  return { ...receiptWithoutAuthority, authority };
}

/** Inspect an unregistered Ready clone against its qualified source receipt. */
export function inspectSnapshotCloneTargetPolicyAuthority(
  sourceReceipt: SnapshotPolicyAuthorityReceipt,
  targetSandboxName: string,
  deps: PolicyAuthorityInspectionDeps = {},
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
  const inspection = inspectPolicyAuthorityRequirements(
    {
      ...targetReceiptWithoutAuthority,
      recordedAuthority: sourceReceipt.authority,
      sandboxName: targetReceiptWithoutAuthority.sourceSandboxName,
    },
    deps,
  );
  if (!inspection.liveInspection) {
    throw new Error(
      `Refusing to ${sourceReceipt.operation}: the Ready clone policy could not be inspected.`,
    );
  }
  inspection.verifyRequirements();
  return { ...targetReceiptWithoutAuthority, authority: inspection.authority };
}

function requireRecordedSnapshotPolicyAuthority(
  receipt: SnapshotPolicyAuthorityReceipt,
): SandboxEntry {
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
  return current;
}

async function revalidateRecordedSnapshotPolicyAuthority(
  receipt: SnapshotPolicyAuthorityReceipt,
): Promise<SandboxEntry> {
  const current = requireRecordedSnapshotPolicyAuthority(receipt);
  const currentManagedMcpPolicies = (
    await resolveManagedMcpPolicyRequirementContents(current, receipt.operation)
  ).map((content) => parseRequiredPolicy(content, receipt.operation));
  assertManagedMcpPolicyRequirementsUnchanged(
    currentManagedMcpPolicies,
    receipt.managedMcpPolicies,
    receipt.operation,
    "after qualification",
  );
  return current;
}

/** Recheck live policy synchronously inside a blocking filesystem operation. */
export function revalidateSnapshotPolicyAuthorityAtMutationBoundary(
  receipt: SnapshotPolicyAuthorityReceipt,
  deps: PolicyAuthorityInspectionDeps = {},
): void {
  const current = requireRecordedSnapshotPolicyAuthority(receipt);
  inspectPolicyAuthorityRequirements(
    {
      ...receipt,
      recordedAuthority: current.policyAuthority,
      sandboxName: receipt.sourceSandboxName,
    },
    deps,
  ).verifyRequirements();
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
  assertManagedMcpPolicyRequirementsUnchanged(
    removedManagedMcpPolicies,
    receipt.managedMcpPolicies,
    receipt.operation,
    "before destination removal",
  );
}

/** Recheck a snapshot authority receipt at the destination mutation edge. */
export async function revalidateSnapshotPolicyAuthority(
  receipt: SnapshotPolicyAuthorityReceipt,
  deps: PolicyAuthorityInspectionDeps = {},
): Promise<void> {
  const current = await revalidateRecordedSnapshotPolicyAuthority(receipt);
  inspectPolicyAuthorityRequirements(
    {
      ...receipt,
      recordedAuthority: current.policyAuthority,
      sandboxName: receipt.sourceSandboxName,
    },
    deps,
  ).verifyRequirements();
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { assertRecordedPolicyAuthority } from "../../../adapters/openshell/policy-authority";

export { isPolicyAuthorityRefusalError } from "../../../adapters/openshell/policy-authority";
import { prepareInitialSandboxCreatePolicy } from "../../../onboard/initial-policy";
import { mergeRebuildMessagingPolicyPresets } from "../../../onboard/messaging-policy-presets";
import { normalizePolicyTierName } from "../../../onboard/policy-tier-suppression";
import {
  observeSandboxPresenceOnGateway,
  type SandboxGatewayPresence,
} from "../../../onboard/sandbox-recreate-probe";
import * as policies from "../../../policy";
import * as registry from "../../../state/registry";
import type { RebuildManifest } from "../../../state/sandbox";
import { getPersistedSandboxTargetGatewayName } from "../gateway-target";
import { MCP_BRIDGE_POLICY_SOURCE } from "../mcp-bridge-policy";
import { normalizeRebuildTargetPolicyPresets } from "../rebuild-backup-phase";
import { resolveRebuildDurableConfig } from "../rebuild-durable-config";
import type { RebuildSandboxEntry } from "../rebuild-flow-helpers";
import { resolveManagedMcpPolicyRequirementContents } from "./mcp-requirements";
import {
  assertManagedMcpPolicyRequirementsUnchanged,
  inspectPolicyAuthorityRequirements,
  parseRequiredPolicyDocument,
  type PolicyAuthorityInspectionDeps,
  type RecordedPolicyAuthority,
  type RequiredPolicy,
} from "./preflight";

export interface RebuildPolicyAuthorityReceipt {
  readonly authority: RecordedPolicyAuthority;
  readonly gatewayName: string;
  readonly managedMcpPolicies: readonly RequiredPolicy[];
  readonly operation: string;
  readonly requiredPolicies: readonly RequiredPolicy[];
  readonly sandboxName: string;
}

interface RebuildPolicyAuthorityDeps extends PolicyAuthorityInspectionDeps {
  readonly observeSandboxPresence?: (target: {
    readonly gatewayName: string;
    readonly sandboxName: string;
  }) => SandboxGatewayPresence;
}

function parseRequiredPolicy(content: string, operation: string): RequiredPolicy {
  const parsed = parseRequiredPolicyDocument(content, operation);
  const networkPolicies = parsed.network_policies;
  if (
    networkPolicies !== undefined &&
    (typeof networkPolicies !== "object" ||
      networkPolicies === null ||
      Array.isArray(networkPolicies))
  ) {
    throw new Error(`Refusing to ${operation}: a required network policy document is invalid.`);
  }
  return parsed;
}

function readPreparedPolicy(
  policy: ReturnType<typeof prepareInitialSandboxCreatePolicy>,
  operation: string,
): string {
  let content: string;
  let cleanupFailed = false;
  try {
    content = fs.readFileSync(policy.policyPath, "utf8");
  } catch {
    throw new Error(`Refusing to ${operation}: the required rebuild policy is unreadable.`);
  } finally {
    if (policy.cleanup && policy.cleanup() !== true) cleanupFailed = true;
  }
  if (cleanupFailed) {
    throw new Error(`Refusing to ${operation}: the temporary rebuild policy could not be removed.`);
  }
  return content;
}

async function resolveRequiredPolicies(input: {
  readonly manifest: RebuildManifest | null;
  readonly operation: string;
  readonly requestedObservabilityEnabled?: boolean;
  readonly sandboxEntry: RebuildSandboxEntry;
  readonly sandboxName: string;
}): Promise<{ managedMcpPolicies: RequiredPolicy[]; requiredPolicies: RequiredPolicy[] }> {
  const { manifest, operation, requestedObservabilityEnabled, sandboxEntry, sandboxName } = input;
  const agentName = sandboxEntry.agent || "openclaw";
  const baseline = policies.resolveAgentBaselinePolicy(agentName);
  if (!baseline) {
    throw new Error(
      `Refusing to ${operation}: the '${agentName}' baseline network policy is unavailable.`,
    );
  }

  const durableConfig = resolveRebuildDurableConfig(sandboxName, sandboxEntry);
  if (durableConfig.webSearchError) {
    throw new Error(`Refusing to ${operation}: ${durableConfig.webSearchError}.`);
  }
  const managedMcpPolicies = (
    await resolveManagedMcpPolicyRequirementContents(sandboxEntry, operation)
  ).map((content) => parseRequiredPolicy(content, operation));
  const validatedMcpPresetNames = new Set(
    Object.values(sandboxEntry.mcp?.bridges ?? {}).map((bridge) => bridge.policyName),
  );
  const disabledChannels = registry.getDisabledMessagingChannelsFromEntry(sandboxEntry);
  const activeChannels = registry
    .getConfiguredMessagingChannelsFromEntry(sandboxEntry)
    .filter((channel) => !disabledChannels.includes(channel));
  const builtinPresetNames = new Set(
    policies.listPresets({ agent: agentName }).map((preset) => preset.name),
  );
  const authoritativePresets = manifest?.policyPresets ?? sandboxEntry.policies ?? [];
  const recordedPresets: string[] = [];
  for (const preset of authoritativePresets) {
    if (typeof preset !== "string" || preset.length === 0) {
      throw new Error(`Refusing to ${operation}: recorded policy preset metadata is invalid.`);
    }
    if (builtinPresetNames.has(preset)) {
      recordedPresets.push(preset);
      continue;
    }
    if (validatedMcpPresetNames.has(preset)) continue;
    throw new Error(
      `Refusing to ${operation}: recorded policy preset ${JSON.stringify(preset)} is neither a current built-in policy preset for '${agentName}' nor a validated managed MCP policy.`,
    );
  }
  const manifestPresets = manifest?.policyPresets === undefined ? undefined : recordedPresets;
  const mergedPresets = mergeRebuildMessagingPolicyPresets(
    manifestPresets,
    recordedPresets,
    activeChannels,
    disabledChannels,
  );
  const targetEntry = {
    ...sandboxEntry,
    observabilityEnabled: requestedObservabilityEnabled ?? sandboxEntry.observabilityEnabled,
  };
  const targetPresets = normalizeRebuildTargetPolicyPresets(
    mergedPresets,
    targetEntry,
    durableConfig.webSearchConfig,
  );
  const prepared = prepareInitialSandboxCreatePolicy(baseline.policyPath, activeChannels, {
    additionalPresets: targetPresets,
    agentName,
    baselineExclusions: sandboxEntry.baselineExclusions ?? [],
    policyTier: normalizePolicyTierName(sandboxEntry.policyTier),
  });
  const required = [parseRequiredPolicy(readPreparedPolicy(prepared, operation), operation)];
  const customPolicies = manifest?.customPolicies ?? sandboxEntry.customPolicies ?? [];
  for (const custom of customPolicies) {
    if (
      !custom ||
      typeof custom.name !== "string" ||
      custom.name.length === 0 ||
      typeof custom.content !== "string" ||
      custom.content.length === 0
    ) {
      throw new Error(`Refusing to ${operation}: required custom policy metadata is invalid.`);
    }
    if (custom.sourcePath === MCP_BRIDGE_POLICY_SOURCE) continue;
    required.push(parseRequiredPolicy(custom.content, operation));
  }
  required.push(...managedMcpPolicies);
  return { managedMcpPolicies, requiredPolicies: required };
}

function inspectRebuildPolicyAuthority(
  receipt: Omit<RebuildPolicyAuthorityReceipt, "authority">,
  recordedAuthority: RebuildSandboxEntry["policyAuthority"],
  deps: RebuildPolicyAuthorityDeps,
): ReturnType<typeof inspectPolicyAuthorityRequirements> {
  const inspectLiveSource =
    (deps.observeSandboxPresence ?? observeSandboxPresenceOnGateway)({
      sandboxName: receipt.sandboxName,
      gatewayName: receipt.gatewayName,
    }) !== "missing";
  if (!inspectLiveSource && recordedAuthority === undefined) {
    throw new Error(
      `Refusing to ${receipt.operation}: the sandbox is absent and its recorded policy authority is missing.`,
    );
  }
  return inspectPolicyAuthorityRequirements(
    {
      ...receipt,
      inspectLiveSource,
      recordedAuthority,
      verifyGlobalCreatePolicy: true,
    },
    deps,
  );
}

/** Qualify both the live source and its recreate policy before rebuild effects. */
export async function qualifyRebuildPolicyAuthority(
  input: {
    readonly manifest: RebuildManifest | null;
    readonly requestedObservabilityEnabled?: boolean;
    readonly sandboxEntry: RebuildSandboxEntry;
    readonly sandboxName: string;
  },
  deps: RebuildPolicyAuthorityDeps = {},
): Promise<RebuildPolicyAuthorityReceipt> {
  const operation = `rebuild sandbox '${input.sandboxName}'`;
  const requirementEntry = { ...input.sandboxEntry };
  const authorityReceipt = {
    gatewayName: getPersistedSandboxTargetGatewayName(input.sandboxEntry),
    managedMcpPolicies: [],
    operation,
    requiredPolicies: [],
    sandboxName: input.sandboxName,
  };
  const authorityInspection = inspectRebuildPolicyAuthority(
    authorityReceipt,
    input.sandboxEntry.policyAuthority,
    deps,
  );
  const { authority } = authorityInspection;
  if (
    input.sandboxEntry.policyAuthority === undefined &&
    !registry.updateSandbox(input.sandboxName, { policyAuthority: authority })
  ) {
    throw new Error(
      `Refusing to ${operation}: the observed policy authority could not be recorded.`,
    );
  }
  const normalizedEntry = registry.normalizeSandboxPolicyAttribution({
    ...input.sandboxEntry,
    policyAuthority: authority,
  });
  delete input.sandboxEntry.policies;
  delete input.sandboxEntry.customPolicies;
  delete input.sandboxEntry.baselineExclusions;
  delete input.sandboxEntry.baselineExclusionTransition;
  delete input.sandboxEntry.policyPresetsFinalized;
  delete input.sandboxEntry.policyTier;
  delete input.sandboxEntry.policyAuthority;
  Object.assign(input.sandboxEntry, normalizedEntry);
  authorityInspection.verifyRequirements();

  if (authority === "nemoclaw-managed") {
    return { ...authorityReceipt, authority };
  }

  const { managedMcpPolicies, requiredPolicies } = await resolveRequiredPolicies({
    ...input,
    sandboxEntry: requirementEntry,
    operation,
  });
  const receipt = { ...authorityReceipt, managedMcpPolicies, requiredPolicies };
  const requirementInspection = inspectRebuildPolicyAuthority(receipt, authority, deps);
  requirementInspection.verifyRequirements();
  return { ...receipt, authority };
}

/** Recheck the exact rebuild policy authority immediately before lifecycle effects. */
export async function revalidateRebuildPolicyAuthority(
  receipt: RebuildPolicyAuthorityReceipt,
  deps: RebuildPolicyAuthorityDeps = {},
): Promise<void> {
  const current = registry.getSandbox(receipt.sandboxName);
  if (!current) {
    throw new Error(`Refusing to ${receipt.operation}: the sandbox is no longer registered.`);
  }
  if (current.policyAuthority === undefined) {
    throw new Error(`Refusing to ${receipt.operation}: the recorded policy authority is missing.`);
  }
  assertRecordedPolicyAuthority(current.policyAuthority, receipt.authority, receipt.operation);
  if (receipt.authority === "externally-managed") {
    const currentManagedMcpPolicies = (
      await resolveManagedMcpPolicyRequirementContents(current, receipt.operation)
    ).map((content) => parseRequiredPolicy(content, receipt.operation));
    assertManagedMcpPolicyRequirementsUnchanged(
      currentManagedMcpPolicies,
      receipt.managedMcpPolicies,
      receipt.operation,
      "after qualification",
    );
  }
  const authorityCheck = inspectRebuildPolicyAuthority(receipt, current.policyAuthority, deps);
  authorityCheck.verifyRequirements();
}

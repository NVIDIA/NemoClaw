// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
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
import { prepareInitialSandboxCreatePolicy } from "../../../onboard/initial-policy";
import { mergeRebuildMessagingPolicyPresets } from "../../../onboard/messaging-policy-presets";
import { normalizePolicyTierName } from "../../../onboard/policy-tier-suppression";
import * as policies from "../../../policy";
import * as registry from "../../../policy/policy-registry";
import type { RebuildManifest } from "../../../state/sandbox";
import { getPersistedSandboxTargetGatewayName } from "../gateway-target";
import { MCP_BRIDGE_POLICY_SOURCE } from "../mcp-bridge-policy";
import { normalizeRebuildTargetPolicyPresets } from "../rebuild-backup-phase";
import { resolveRebuildDurableConfig } from "../rebuild-durable-config";
import type { RebuildSandboxEntry } from "../rebuild-flow-helpers";
import { resolveManagedMcpPolicyRequirementContents } from "./mcp-requirements";

type RequiredPolicy = Record<string, unknown>;

export interface RebuildPolicyAuthorityReceipt {
  readonly authority: SandboxPolicyAuthority;
  readonly gatewayName: string;
  readonly managedMcpPolicies: readonly RequiredPolicy[];
  readonly operation: string;
  readonly requiredPolicies: readonly RequiredPolicy[];
  readonly sandboxName: string;
}

interface RebuildPolicyAuthorityDeps {
  readonly inspectGlobalPolicyAuthority?: typeof inspectGlobalPolicyAuthority;
  readonly inspectSandboxPolicyAuthority?: typeof inspectSandboxPolicyAuthority;
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
  const disabledChannels = registry.getDisabledMessagingChannelsFromEntry(sandboxEntry);
  const activeChannels = registry
    .getConfiguredMessagingChannelsFromEntry(sandboxEntry)
    .filter((channel) => !disabledChannels.includes(channel));
  const recordedPresets = (manifest?.policyPresets ?? sandboxEntry.policies ?? []).filter(
    (preset): preset is string => typeof preset === "string" && preset.length > 0,
  );
  const mergedPresets = mergeRebuildMessagingPolicyPresets(
    manifest?.policyPresets,
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
    if (custom.sourcePath === MCP_BRIDGE_POLICY_SOURCE) continue;
    if (
      !custom ||
      typeof custom.name !== "string" ||
      custom.name.length === 0 ||
      typeof custom.content !== "string" ||
      custom.content.length === 0
    ) {
      throw new Error(`Refusing to ${operation}: required custom policy metadata is invalid.`);
    }
    required.push(parseRequiredPolicy(custom.content, operation));
  }
  const managedMcpPolicies = (
    await resolveManagedMcpPolicyRequirementContents(sandboxEntry, operation)
  ).map((content) => parseRequiredPolicy(content, operation));
  required.push(...managedMcpPolicies);
  return { managedMcpPolicies, requiredPolicies: required };
}

function verifyRequiredPolicies(
  inspection: SandboxPolicyAuthorityInspection,
  receipt: Pick<RebuildPolicyAuthorityReceipt, "operation" | "requiredPolicies" | "sandboxName">,
): void {
  for (const requiredPolicy of receipt.requiredPolicies) {
    assertExternalPolicyRequirements({
      inspection,
      requiredPolicy,
      operation: receipt.operation,
      sandboxName: receipt.sandboxName,
    });
  }
}

function inspectRebuildAuthorities(
  receipt: Pick<
    RebuildPolicyAuthorityReceipt,
    "gatewayName" | "operation" | "requiredPolicies" | "sandboxName"
  >,
  deps: RebuildPolicyAuthorityDeps,
): {
  authority: SandboxPolicyAuthority;
  globalInspection: SandboxPolicyAuthorityInspection;
  sandboxInspection: SandboxPolicyAuthorityInspection;
} {
  const sandboxInspection = (deps.inspectSandboxPolicyAuthority ?? inspectSandboxPolicyAuthority)({
    sandboxName: receipt.sandboxName,
    gatewayName: receipt.gatewayName,
  });
  const globalInspection = (deps.inspectGlobalPolicyAuthority ?? inspectGlobalPolicyAuthority)({
    gatewayName: receipt.gatewayName,
  });
  assertRecordedPolicyAuthority(
    sandboxInspection.authority,
    globalInspection.authority,
    receipt.operation,
  );
  return { authority: sandboxInspection.authority, globalInspection, sandboxInspection };
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
  const { managedMcpPolicies, requiredPolicies } = await resolveRequiredPolicies({
    ...input,
    operation,
  });
  const receipt = {
    gatewayName: getPersistedSandboxTargetGatewayName(input.sandboxEntry),
    managedMcpPolicies,
    operation,
    requiredPolicies,
    sandboxName: input.sandboxName,
  };
  const inspection = inspectRebuildAuthorities(receipt, deps);
  const { authority } = inspection;
  if (input.sandboxEntry.policyAuthority !== undefined) {
    assertRecordedPolicyAuthority(input.sandboxEntry.policyAuthority, authority, operation);
  } else if (!registry.updateSandbox(input.sandboxName, { policyAuthority: authority })) {
    throw new Error(
      `Refusing to ${operation}: the observed policy authority could not be recorded.`,
    );
  }
  input.sandboxEntry.policyAuthority = authority;
  verifyRequiredPolicies(inspection.sandboxInspection, receipt);
  verifyRequiredPolicies(inspection.globalInspection, receipt);
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
  const currentManagedMcpPolicies = (
    await resolveManagedMcpPolicyRequirementContents(current, receipt.operation)
  ).map((content) => parseRequiredPolicy(content, receipt.operation));
  if (!isDeepStrictEqual(currentManagedMcpPolicies, receipt.managedMcpPolicies)) {
    throw new Error(
      `Refusing to ${receipt.operation}: managed MCP policy requirements changed after qualification.`,
    );
  }
  const inspection = inspectRebuildAuthorities(receipt, deps);
  assertRecordedPolicyAuthority(receipt.authority, inspection.authority, receipt.operation);
  verifyRequiredPolicies(inspection.sandboxInspection, receipt);
  verifyRequiredPolicies(inspection.globalInspection, receipt);
}

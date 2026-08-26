// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { isValidName } from "../../sandbox-name-contract";
import { ROOT } from "../../state/paths";
import type { MessagingAgentId } from "../manifest";
import { listMessagingPolicyPresetMetadata } from "./metadata";
import {
  enabledPlanChannelIds,
  type EnabledPlanSelection,
  normalizeMessagingChannelId,
} from "../post-agent-install-selection";

type PolicyPresetLocator = {
  readonly channelId: string;
  readonly presetName: string;
};

type PolicyPresetMetadataReader = (options: {
  readonly agent?: MessagingAgentId;
}) => readonly PolicyPresetLocator[];

export type MessagingChannelPolicyLoadOptions = {
  readonly agent?: MessagingAgentId | string | null;
  readonly sandboxName?: string;
};

const CHANNELS_ROOT = path.join(ROOT, "src", "lib", "messaging", "channels");
const POLICY_FILE_BY_AGENT: Readonly<Record<MessagingAgentId, string>> = {
  openclaw: "openclaw.yaml",
  hermes: "hermes.yaml",
};

export interface MessagingChannelPolicyPresetInfo {
  readonly file: string;
  readonly name: string;
  readonly description: string;
  readonly channelId: string;
  readonly agent: MessagingAgentId;
}

export interface MessagingChannelPolicyResolver {
  readonly resolveMessagingChannelPolicyPresetPath: (
    presetName: string,
    agent?: MessagingAgentId | string | null | undefined,
  ) => string | null;
  readonly loadMessagingChannelPolicyPreset: (
    presetName: string,
    options?: MessagingChannelPolicyLoadOptions,
  ) => string | null;
  readonly listMessagingChannelPolicyPresets: (options?: {
    readonly agent?: MessagingAgentId | string | null;
  }) => MessagingChannelPolicyPresetInfo[];
}

export interface MessagingChannelPolicyResolverDeps {
  readonly existsSync: (file: string) => boolean;
  readonly readFileSync: (file: string, encoding: BufferEncoding) => string;
  readonly listPresetMetadata: PolicyPresetMetadataReader;
}

export interface CredentialBoundMessagingPolicyOmission {
  readonly channelId: string;
  readonly reason: string;
  readonly recoveryAction: string;
}

export type CredentialBoundMessagingPolicyOmissionReporter = (
  omission: CredentialBoundMessagingPolicyOmission,
) => void;

export function materializeMessagingPolicySandboxName(
  content: string,
  sandboxName: string | null | undefined,
): string | null {
  if (!content.includes("{sandboxName}")) return content;
  if (sandboxName === undefined || sandboxName === null || !isValidName(sandboxName)) return null;
  return content.replaceAll("{sandboxName}", sandboxName);
}

interface MessagingPolicy {
  readonly channelId: string;
  readonly policyKeys: readonly string[];
  readonly presetName: string;
}

interface MaterializedMessagingPolicy {
  readonly credentialProviders: ReadonlySet<string>;
  readonly networkPolicies: Record<string, unknown>;
}

function parsePolicyMapping(content: string): Record<string, unknown> | null {
  try {
    const parsed = YAML.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function listMessagingPolicies(agent: MessagingAgentId): MessagingPolicy[] {
  return listMessagingPolicyPresetMetadata({ agent }).map((policy) => ({
    channelId: policy.channelId,
    policyKeys: policy.agentPolicyKeys[agent] ?? policy.policyKeys,
    presetName: policy.presetName,
  }));
}

function listNetworkPolicyCredentialProviders(
  policy: Record<string, unknown> | null,
  policyNames: readonly string[],
): Set<string> {
  const networkPolicies = policy?.network_policies;
  if (!networkPolicies || typeof networkPolicies !== "object" || Array.isArray(networkPolicies)) {
    return new Set();
  }
  const liveProviders = new Set<string>();
  for (const policyName of policyNames) {
    const networkPolicy = (networkPolicies as Record<string, unknown>)[policyName];
    if (!networkPolicy || typeof networkPolicy !== "object" || Array.isArray(networkPolicy)) {
      continue;
    }
    const endpoints = (networkPolicy as Record<string, unknown>).endpoints;
    if (!Array.isArray(endpoints)) continue;
    for (const endpoint of endpoints) {
      if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) continue;
      const binding = (endpoint as Record<string, unknown>).credential_binding;
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) continue;
      const provider = (binding as Record<string, unknown>).provider;
      if (typeof provider === "string") liveProviders.add(provider);
    }
  }
  return liveProviders;
}

function credentialProviderOmissionReason(
  livePolicy: Record<string, unknown> | null,
  policy: MessagingPolicy,
  expectedProviders: ReadonlySet<string>,
): string | null {
  const liveProviders = listNetworkPolicyCredentialProviders(livePolicy, policy.policyKeys);
  if (
    liveProviders.size === expectedProviders.size &&
    [...expectedProviders].every((providerName) => liveProviders.has(providerName))
  ) {
    return null;
  }
  if (liveProviders.size === 0) {
    return `the live policy has no credential providers; expected ${expectedProviders.size}`;
  }
  return (
    `the live policy credential-provider set is partial or mismatched; ` +
    `expected ${expectedProviders.size}, found ${liveProviders.size}`
  );
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function loadMaterializedMessagingPolicy(
  policy: MessagingPolicy,
  sandboxName: string,
  agent: MessagingAgentId,
): MaterializedMessagingPolicy | null {
  const content = loadMessagingChannelPolicyPreset(policy.presetName, {
    agent,
    sandboxName,
  });
  const boundPolicy = content ? parsePolicyMapping(content) : null;
  const networkPolicies = boundPolicy?.network_policies;
  if (!networkPolicies || typeof networkPolicies !== "object" || Array.isArray(networkPolicies)) {
    return null;
  }
  const entries = policy.policyKeys.flatMap((policyName) => {
    const networkPolicy = objectRecord((networkPolicies as Record<string, unknown>)[policyName]);
    return networkPolicy ? [[policyName, networkPolicy] as const] : [];
  });
  if (entries.length !== policy.policyKeys.length) return null;
  return {
    credentialProviders: listNetworkPolicyCredentialProviders(boundPolicy, policy.policyKeys),
    networkPolicies: Object.fromEntries(entries),
  };
}

function removeMessagingPolicy(
  networkPolicies: Record<string, unknown>,
  policy: MessagingPolicy,
): void {
  for (const policyName of new Set([policy.presetName, ...policy.policyKeys])) {
    delete networkPolicies[policyName];
  }
}

function messagingRouteRecoveryAction(sandboxName: string, channelId: string): string {
  return (
    `run \`nemoclaw ${sandboxName} channels add ${channelId}\`; approve the rebuild prompt ` +
    `in an interactive terminal, or run \`nemoclaw ${sandboxName} rebuild\` afterward in ` +
    "non-interactive mode"
  );
}

function livePolicyContainsMessagingRoute(
  networkPolicies: Record<string, unknown>,
  policy: MessagingPolicy,
): boolean {
  return [...new Set([policy.presetName, ...policy.policyKeys])].some((policyName) =>
    Object.hasOwn(networkPolicies, policyName),
  );
}

/**
 * Compose every enabled messaging route from its channel-owned policy. Routes
 * with credential bindings require the exact provider set in the live policy;
 * routes without bindings do not. A missing plan rejects the transition when
 * the live policy is unreadable or carries any messaging route. Disabled
 * channels and missing, partial, or mismatched provider state omit the route
 * instead of submitting unresolved bindings.
 */
export function composeCredentialBoundMessagingPolicies(
  targetPolicyYaml: string,
  livePolicyYaml: string,
  sandboxName: string,
  agent: MessagingAgentId,
  messagingPlan: EnabledPlanSelection | null,
  reportOmission?: CredentialBoundMessagingPolicyOmissionReporter,
): string {
  if (!isValidName(sandboxName)) {
    throw new Error("Cannot materialize the Shields-down credential provider binding");
  }
  const materializedTarget = materializeMessagingPolicySandboxName(targetPolicyYaml, sandboxName);
  const target = materializedTarget ? parsePolicyMapping(materializedTarget) : null;
  if (!target) throw new Error("Credential-bound messaging target policy must be a YAML mapping");
  const live = parsePolicyMapping(livePolicyYaml);
  const enabledChannels = messagingPlan ? enabledPlanChannelIds(messagingPlan) : null;
  const messagingPolicies = listMessagingPolicies(agent);
  const targetPolicies = target.network_policies;
  if (!targetPolicies || typeof targetPolicies !== "object" || Array.isArray(targetPolicies)) {
    throw new Error("Credential-bound messaging target policy must contain network_policies");
  }
  const networkPolicies = targetPolicies as Record<string, unknown>;
  if (enabledChannels === null) {
    const liveNetworkPolicies = objectRecord(live?.network_policies);
    if (!liveNetworkPolicies) {
      throw new Error(
        `Cannot compose messaging routes for sandbox '${sandboxName}' because the channel plan ` +
          `is unavailable and the live policy could not be read. Recovery: ` +
          `${messagingRouteRecoveryAction(sandboxName, "<channel>")}.`,
      );
    }
    const liveMessagingPolicy = messagingPolicies.find((policy) =>
      livePolicyContainsMessagingRoute(liveNetworkPolicies, policy),
    );
    if (liveMessagingPolicy) {
      const channelId = normalizeMessagingChannelId(liveMessagingPolicy.channelId);
      throw new Error(
        `Cannot compose the messaging route for sandbox '${sandboxName}', channel ` +
          `'${channelId}' because the channel plan is unavailable. Recovery: ` +
          `${messagingRouteRecoveryAction(sandboxName, channelId)}.`,
      );
    }
    for (const policy of messagingPolicies) removeMessagingPolicy(networkPolicies, policy);
    return YAML.stringify(target);
  }
  for (const policy of messagingPolicies) {
    const channelId = normalizeMessagingChannelId(policy.channelId);
    const materializedPolicy = loadMaterializedMessagingPolicy(policy, sandboxName, agent);
    const channelEnabled = enabledChannels.has(channelId);
    if (!channelEnabled) {
      removeMessagingPolicy(networkPolicies, policy);
      continue;
    }

    const providerReason =
      materializedPolicy && materializedPolicy.credentialProviders.size > 0
        ? credentialProviderOmissionReason(live, policy, materializedPolicy.credentialProviders)
        : null;
    removeMessagingPolicy(networkPolicies, policy);
    if (!materializedPolicy || providerReason !== null) {
      reportOmission?.({
        channelId,
        reason: providerReason ?? "the channel policy could not be materialized",
        recoveryAction: messagingRouteRecoveryAction(sandboxName, channelId),
      });
    } else {
      Object.assign(networkPolicies, materializedPolicy.networkPolicies);
    }
  }
  return YAML.stringify(target);
}

function normalizeAgent(
  agent: MessagingAgentId | string | null | undefined,
): MessagingAgentId | null {
  if (agent == null) return "openclaw";
  if (agent === "openclaw" || agent === "hermes") return agent;
  return null;
}

function isSafeId(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value);
}

function channelPolicyPath(channelId: string, agent: MessagingAgentId): string | null {
  if (!isSafeId(channelId)) return null;
  return path.join(CHANNELS_ROOT, channelId, "policy", POLICY_FILE_BY_AGENT[agent]);
}

function readPresetHeader(content: string): { name: string; description: string } | null {
  let parsed: { preset?: unknown } | null;
  try {
    parsed = YAML.parse(content);
  } catch {
    return null;
  }
  const preset = parsed?.preset;
  if (!preset || typeof preset !== "object" || Array.isArray(preset)) return null;
  const fields = preset as Record<string, unknown>;
  const name = fields.name;
  if (typeof name !== "string" || name.trim().length === 0) return null;
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  return { name: name.trim(), description };
}

function readChannelPolicyInfo(
  channelId: string,
  expectedPresetName: string,
  agent: MessagingAgentId,
  deps: MessagingChannelPolicyResolverDeps,
): MessagingChannelPolicyPresetInfo | null {
  const file = channelPolicyPath(channelId, agent);
  if (!file || !deps.existsSync(file)) return null;
  const content = deps.readFileSync(file, "utf-8");
  const header = readPresetHeader(content);
  if (!header || header.name !== expectedPresetName) return null;
  return {
    file: path.relative(ROOT, file).replaceAll(path.sep, "/"),
    name: header.name,
    description: header.description,
    channelId,
    agent,
  };
}

export function createMessagingChannelPolicyResolver(
  deps: MessagingChannelPolicyResolverDeps,
): MessagingChannelPolicyResolver {
  function resolveMessagingChannelPolicyPresetPath(
    presetName: string,
    agent: MessagingAgentId | string | null | undefined = "openclaw",
  ): string | null {
    const normalizedAgent = normalizeAgent(agent);
    if (!normalizedAgent) return null;
    for (const preset of deps.listPresetMetadata({ agent: normalizedAgent })) {
      if (preset.presetName !== presetName) continue;
      const file = channelPolicyPath(preset.channelId, normalizedAgent);
      if (file && deps.existsSync(file)) return file;
    }
    return null;
  }

  function loadMessagingChannelPolicyPreset(
    presetName: string,
    options: MessagingChannelPolicyLoadOptions = {},
  ): string | null {
    const file = resolveMessagingChannelPolicyPresetPath(presetName, options.agent);
    if (!file) return null;
    const content = deps.readFileSync(file, "utf-8");
    const header = readPresetHeader(content);
    if (header?.name !== presetName) return null;
    return materializeMessagingPolicySandboxName(content, options.sandboxName);
  }

  function listMessagingChannelPolicyPresets(
    options: { readonly agent?: MessagingAgentId | string | null } = {},
  ): MessagingChannelPolicyPresetInfo[] {
    const agent = normalizeAgent(options.agent);
    if (!agent) return [];
    const result: MessagingChannelPolicyPresetInfo[] = [];
    const seen = new Set<string>();
    for (const preset of deps.listPresetMetadata({ agent })) {
      if (seen.has(preset.presetName)) continue;
      const info = readChannelPolicyInfo(preset.channelId, preset.presetName, agent, deps);
      if (!info) continue;
      result.push(info);
      seen.add(preset.presetName);
    }
    return result;
  }

  return {
    listMessagingChannelPolicyPresets,
    loadMessagingChannelPolicyPreset,
    resolveMessagingChannelPolicyPresetPath,
  };
}

const defaultPolicyResolver = createMessagingChannelPolicyResolver({
  existsSync: (file) => fs.existsSync(file),
  readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
  listPresetMetadata: listMessagingPolicyPresetMetadata,
});

export function resolveMessagingChannelPolicyPresetPath(
  presetName: string,
  agent: MessagingAgentId | string | null | undefined = "openclaw",
): string | null {
  return defaultPolicyResolver.resolveMessagingChannelPolicyPresetPath(presetName, agent);
}

export function loadMessagingChannelPolicyPreset(
  presetName: string,
  options: MessagingChannelPolicyLoadOptions = {},
): string | null {
  return defaultPolicyResolver.loadMessagingChannelPolicyPreset(presetName, options);
}

export function listMessagingChannelPolicyPresets(
  options: { readonly agent?: MessagingAgentId | string | null } = {},
): MessagingChannelPolicyPresetInfo[] {
  return defaultPolicyResolver.listMessagingChannelPolicyPresets(options);
}

export function isMessagingChannelPolicyPreset(presetName: string): boolean {
  return listMessagingPolicyPresetMetadata().some((preset) => preset.presetName === presetName);
}

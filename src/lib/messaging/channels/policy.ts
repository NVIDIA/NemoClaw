// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { isValidName } from "../../sandbox-name-contract";
import { ROOT } from "../../state/paths";
import type { MessagingAgentId } from "../manifest";
import {
  listMessagingPolicyPresetMetadata,
  listMessagingProviderNamesForChannel,
} from "./metadata";
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

export function materializeMessagingPolicySandboxName(
  content: string,
  sandboxName: string | null | undefined,
): string | null {
  if (!content.includes("{sandboxName}")) return content;
  if (sandboxName === undefined || sandboxName === null || !isValidName(sandboxName)) return null;
  return content.replaceAll("{sandboxName}", sandboxName);
}

interface CredentialBoundMessagingPolicy {
  readonly channelId: string;
  readonly livePolicyKeys: readonly string[];
  readonly permissivePolicyKey: string;
  readonly providerNames: readonly string[];
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

function listCredentialBoundMessagingPolicies(
  sandboxName: string,
  agent: MessagingAgentId,
): CredentialBoundMessagingPolicy[] {
  return listMessagingPolicyPresetMetadata({ agent }).flatMap((policy) => {
    const providerNames = listMessagingProviderNamesForChannel(sandboxName, policy.channelId, {
      agent,
    });
    if (providerNames.length === 0) return [];
    return [
      {
        channelId: policy.channelId,
        livePolicyKeys: policy.agentPolicyKeys[agent] ?? policy.policyKeys,
        permissivePolicyKey: policy.presetName,
        providerNames,
      },
    ];
  });
}

function networkPoliciesUseExactCredentialProviders(
  policy: Record<string, unknown> | null,
  policyNames: readonly string[],
  providerNames: readonly string[],
): boolean {
  const networkPolicies = policy?.network_policies;
  if (!networkPolicies || typeof networkPolicies !== "object" || Array.isArray(networkPolicies)) {
    return false;
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
  return (
    liveProviders.size === providerNames.length &&
    providerNames.every((providerName) => liveProviders.has(providerName))
  );
}

function endpointRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function endpointProvider(endpoint: Record<string, unknown>): string | null {
  const binding = endpointRecord(endpoint.credential_binding);
  return typeof binding?.provider === "string" ? binding.provider : null;
}

function sameEndpointIdentity(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): boolean {
  if (
    target.host !== source.host ||
    target.port !== source.port ||
    (target.protocol !== undefined &&
      source.protocol !== undefined &&
      target.protocol !== source.protocol)
  ) {
    return false;
  }
  const targetProvider = endpointProvider(target);
  const sourceProvider = endpointProvider(source);
  if (targetProvider && sourceProvider) return targetProvider === sourceProvider;
  return target.path === source.path;
}

function loadCredentialBoundPermissiveEndpoints(
  policy: CredentialBoundMessagingPolicy,
  sandboxName: string,
  agent: MessagingAgentId,
  targetEndpoints: readonly unknown[],
): unknown[] | null {
  const content = loadMessagingChannelPolicyPreset(policy.permissivePolicyKey, {
    agent,
    sandboxName,
  });
  const boundPolicy = content ? parsePolicyMapping(content) : null;
  if (
    !networkPoliciesUseExactCredentialProviders(
      boundPolicy,
      policy.livePolicyKeys,
      policy.providerNames,
    )
  ) {
    return null;
  }
  const networkPolicies = boundPolicy?.network_policies;
  if (!networkPolicies || typeof networkPolicies !== "object" || Array.isArray(networkPolicies)) {
    return null;
  }
  const sourceEndpoints = policy.livePolicyKeys.flatMap((policyName) => {
    const networkPolicy = (networkPolicies as Record<string, unknown>)[policyName];
    if (!networkPolicy || typeof networkPolicy !== "object" || Array.isArray(networkPolicy)) {
      return [];
    }
    const value = (networkPolicy as Record<string, unknown>).endpoints;
    return Array.isArray(value) ? value : [];
  });
  if (sourceEndpoints.length === 0) return null;

  const unmatchedTargets = [...targetEndpoints];
  const merged = sourceEndpoints.map((sourceValue) => {
    const source = endpointRecord(sourceValue);
    if (!source) return sourceValue;
    const targetIndex = unmatchedTargets.findIndex((targetValue) => {
      const target = endpointRecord(targetValue);
      return target ? sameEndpointIdentity(target, source) : false;
    });
    if (targetIndex < 0) return source;
    const target = endpointRecord(unmatchedTargets.splice(targetIndex, 1)[0]);
    if (!target) return source;
    const result: Record<string, unknown> = { ...target };
    const binding = endpointRecord(source.credential_binding);
    if (binding) result.credential_binding = binding;
    else delete result.credential_binding;
    if (typeof source.path === "string") result.path = source.path;
    return result;
  });
  return [...merged, ...unmatchedTargets];
}

/**
 * Keep credential-bound messaging routes only when the live policy proves the
 * complete provider set for an enabled channel. Disabled channels and missing,
 * partial, or mismatched provider state omit the route instead of submitting
 * unresolved bindings.
 */
export function composeCredentialBoundMessagingPolicies(
  targetPolicyYaml: string,
  livePolicyYaml: string,
  sandboxName: string,
  agent: MessagingAgentId,
  messagingPlan: EnabledPlanSelection | null,
): string {
  if (!isValidName(sandboxName)) {
    throw new Error("Cannot materialize the Shields-down credential provider binding");
  }
  const materializedTarget = materializeMessagingPolicySandboxName(targetPolicyYaml, sandboxName);
  const target = materializedTarget ? parsePolicyMapping(materializedTarget) : null;
  if (!target) throw new Error("Credential-bound messaging target policy must be a YAML mapping");
  const live = parsePolicyMapping(livePolicyYaml);
  const enabledChannels = enabledPlanChannelIds(messagingPlan ?? { channels: [] });
  const messagingPolicies = listCredentialBoundMessagingPolicies(sandboxName, agent);
  const targetPolicies = target.network_policies;
  if (targetPolicies && typeof targetPolicies === "object" && !Array.isArray(targetPolicies)) {
    const networkPolicies = targetPolicies as Record<string, unknown>;
    for (const policy of messagingPolicies) {
      const targetPolicy = networkPolicies[policy.permissivePolicyKey];
      const targetPolicyRecord = endpointRecord(targetPolicy);
      const targetEndpoints = targetPolicyRecord?.endpoints;
      const providersMatch =
        enabledChannels.has(normalizeMessagingChannelId(policy.channelId)) &&
        networkPoliciesUseExactCredentialProviders(
          live,
          policy.livePolicyKeys,
          policy.providerNames,
        );
      const boundEndpoints =
        providersMatch && Array.isArray(targetEndpoints)
          ? loadCredentialBoundPermissiveEndpoints(policy, sandboxName, agent, targetEndpoints)
          : null;
      if (!boundEndpoints || !targetPolicyRecord) {
        delete networkPolicies[policy.permissivePolicyKey];
      } else {
        networkPolicies[policy.permissivePolicyKey] = {
          ...targetPolicyRecord,
          endpoints: boundEndpoints,
        };
      }
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

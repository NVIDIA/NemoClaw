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
  type MessagingPolicyConfiguredEndpointMetadata,
} from "./metadata";

type PolicyPresetLocator = {
  readonly channelId: string;
  readonly presetName: string;
  readonly configuredEndpoints?: readonly MessagingPolicyConfiguredEndpointMetadata[];
};

type PolicyPresetMetadataReader = (options: {
  readonly agent?: MessagingAgentId;
}) => readonly PolicyPresetLocator[];

export type MessagingChannelPolicyLoadOptions = {
  readonly agent?: MessagingAgentId | string | null;
  readonly sandboxName?: string;
  readonly messagingConfig?: Readonly<Record<string, string | undefined>> | null;
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

function parseConfiguredHttpsOrigin(rawValue: string): URL {
  if (/[\r\n]/u.test(rawValue)) {
    throw new Error("Configured messaging policy origins must not contain line breaks.");
  }
  const text = rawValue.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Configured messaging policy origin must be a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Configured messaging policy origin must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Configured messaging policy origin must not include credentials.");
  }
  const authority = text.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu)?.[1] ?? "";
  if (authority.includes(":")) {
    throw new Error("Configured messaging policy origin must not include an explicit port.");
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("Configured messaging policy value must be an HTTPS origin.");
  }
  return url;
}

function configuredHostnameIsAllowed(hostname: string, allowedHostPattern: string): boolean {
  if (!allowedHostPattern.startsWith("^") || !allowedHostPattern.endsWith("$")) {
    throw new Error("Configured messaging policy hostname pattern must be anchored.");
  }
  try {
    return new RegExp(allowedHostPattern).test(hostname);
  } catch {
    throw new Error("Configured messaging policy hostname pattern is invalid.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function materializeConfiguredEndpoints(
  content: string,
  endpoints: readonly MessagingPolicyConfiguredEndpointMetadata[],
  messagingConfig: Readonly<Record<string, string | undefined>> | null | undefined,
): string {
  if (endpoints.length === 0 || !messagingConfig) return content;
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch {
    throw new Error("Cannot materialize configured messaging endpoint from invalid policy YAML.");
  }
  if (!isRecord(parsed) || !isRecord(parsed.network_policies)) {
    throw new Error("Cannot materialize configured messaging endpoint without network policies.");
  }

  let changed = false;
  for (const endpoint of endpoints) {
    const rawValue = messagingConfig[endpoint.envKey];
    if (!rawValue?.trim()) continue;
    const url = parseConfiguredHttpsOrigin(rawValue);
    const hostname = url.hostname.toLowerCase();
    const policy = parsed.network_policies[endpoint.policyKey];
    if (!isRecord(policy) || !Array.isArray(policy.endpoints)) {
      throw new Error(
        `Cannot materialize configured messaging endpoint; policy '${endpoint.policyKey}' has no endpoint list.`,
      );
    }
    if (
      policy.endpoints.some(
        (candidate) => isRecord(candidate) && candidate.host === hostname,
      )
    ) {
      continue;
    }
    if (!configuredHostnameIsAllowed(hostname, endpoint.allowedHostPattern)) {
      throw new Error("Configured messaging policy origin uses an unexpected host.");
    }
    const template = policy.endpoints.find(
      (candidate) => isRecord(candidate) && candidate.host === endpoint.templateHost,
    );
    if (!isRecord(template)) {
      throw new Error(
        `Cannot materialize configured messaging endpoint; reviewed template '${endpoint.templateHost}' is missing.`,
      );
    }
    policy.endpoints.push({ ...template, host: hostname });
    changed = true;
  }
  return changed ? YAML.stringify(parsed) : content;
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
    const normalizedAgent = normalizeAgent(options.agent);
    if (!normalizedAgent) return null;
    const metadata = deps
      .listPresetMetadata({ agent: normalizedAgent })
      .find((preset) => preset.presetName === presetName);
    const file = resolveMessagingChannelPolicyPresetPath(presetName, normalizedAgent);
    if (!file) return null;
    const content = deps.readFileSync(file, "utf-8");
    const header = readPresetHeader(content);
    if (header?.name !== presetName) return null;
    const materialized = materializeMessagingPolicySandboxName(content, options.sandboxName);
    return materialized === null
      ? null
      : materializeConfiguredEndpoints(
          materialized,
          metadata?.configuredEndpoints ?? [],
          options.messagingConfig,
        );
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

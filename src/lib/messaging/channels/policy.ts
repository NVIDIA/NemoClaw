// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import { isValidName } from "../../sandbox-name-contract";
import { ROOT } from "../../state/paths";
import type { MessagingAgentId } from "../manifest";
import { listMessagingPolicyPresetMetadata } from "./metadata";
import { isWechatIlinkIdcHost, normalizeWechatIlinkBaseUrl } from "./wechat/ilink-base-url";

type PolicyPresetLocator = {
  readonly channelId: string;
  readonly presetName: string;
};

type PolicyMapping = Record<string, unknown>;

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
const WECHAT_BASE_URL_ENV_KEY = "WECHAT_BASE_URL";
const WECHAT_POLICY_KEY = "wechat_bridge";
const WECHAT_TEMPLATE_HOST = "ilinkai.wechat.com";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Approve only channel-owned, structurally identical policy endpoint migrations. */
export function isReviewedMessagingChannelPolicyUpgrade(
  key: string,
  liveValue: unknown,
  replacementValue: unknown,
): boolean {
  if (key !== WECHAT_POLICY_KEY) return false;
  if (!isRecord(liveValue) || !isRecord(replacementValue)) return false;
  if (!Array.isArray(liveValue.endpoints) || !Array.isArray(replacementValue.endpoints)) {
    return false;
  }

  const idcEndpoints = (endpoints: unknown[]): PolicyMapping[] =>
    endpoints.filter(
      (endpoint): endpoint is PolicyMapping =>
        isRecord(endpoint) &&
        typeof endpoint.host === "string" &&
        isWechatIlinkIdcHost(endpoint.host),
    );
  const liveIdcEndpoints = idcEndpoints(liveValue.endpoints);
  const replacementIdcEndpoints = idcEndpoints(replacementValue.endpoints);
  if (liveIdcEndpoints.length > 1 || replacementIdcEndpoints.length !== 1) return false;
  if (
    [...liveValue.endpoints, ...replacementValue.endpoints].some(
      (endpoint) =>
        isRecord(endpoint) && typeof endpoint.host === "string" && endpoint.host.includes("*"),
    )
  ) {
    return false;
  }

  const liveTemplate = liveValue.endpoints.find(
    (endpoint) => isRecord(endpoint) && endpoint.host === WECHAT_TEMPLATE_HOST,
  );
  const replacementTemplate = replacementValue.endpoints.find(
    (endpoint) => isRecord(endpoint) && endpoint.host === WECHAT_TEMPLATE_HOST,
  );
  if (!isRecord(liveTemplate) || !isRecord(replacementTemplate)) return false;
  const matchesTemplate = (endpoint: Record<string, unknown>, template: PolicyMapping) =>
    isDeepStrictEqual(endpoint, { ...template, host: endpoint.host });
  if (liveIdcEndpoints.some((endpoint) => !matchesTemplate(endpoint, liveTemplate))) return false;
  if (replacementIdcEndpoints.some((endpoint) => !matchesTemplate(endpoint, replacementTemplate))) {
    return false;
  }

  const withoutIdcEndpoints = (policy: PolicyMapping, endpoints: unknown[]): PolicyMapping => ({
    ...policy,
    endpoints: endpoints.filter(
      (endpoint) =>
        !isRecord(endpoint) ||
        typeof endpoint.host !== "string" ||
        !isWechatIlinkIdcHost(endpoint.host),
    ),
  });
  return isDeepStrictEqual(
    withoutIdcEndpoints(liveValue, liveValue.endpoints),
    withoutIdcEndpoints(replacementValue, replacementValue.endpoints),
  );
}

function materializeWechatIlinkEndpoint(
  content: string,
  messagingConfig: Readonly<Record<string, string | undefined>> | null | undefined,
): string {
  const baseUrl = normalizeWechatIlinkBaseUrl(messagingConfig?.[WECHAT_BASE_URL_ENV_KEY]);
  if (!baseUrl) return content;
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  if (!isWechatIlinkIdcHost(hostname)) return content;

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch {
    throw new Error("Cannot materialize the WeChat IDC endpoint from invalid policy YAML.");
  }
  if (!isRecord(parsed) || !isRecord(parsed.network_policies)) {
    throw new Error("Cannot materialize the WeChat IDC endpoint without network policies.");
  }

  const policy = parsed.network_policies[WECHAT_POLICY_KEY];
  if (!isRecord(policy) || !Array.isArray(policy.endpoints)) {
    throw new Error(
      `Cannot materialize the WeChat IDC endpoint; policy '${WECHAT_POLICY_KEY}' has no endpoint list.`,
    );
  }
  if (policy.endpoints.some((candidate) => isRecord(candidate) && candidate.host === hostname)) {
    return content;
  }
  const template = policy.endpoints.find(
    (candidate) => isRecord(candidate) && candidate.host === WECHAT_TEMPLATE_HOST,
  );
  if (!isRecord(template)) {
    throw new Error(
      `Cannot materialize the WeChat IDC endpoint; reviewed template '${WECHAT_TEMPLATE_HOST}' is missing.`,
    );
  }
  policy.endpoints.push({ ...template, host: hostname });
  return YAML.stringify(parsed);
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
    if (materialized === null) return null;
    return metadata?.channelId === "wechat"
      ? materializeWechatIlinkEndpoint(materialized, options.messagingConfig)
      : materialized;
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

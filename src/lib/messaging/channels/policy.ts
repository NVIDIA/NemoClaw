// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { ROOT } from "../../state/paths";
import type { MessagingAgentId } from "../manifest";
import { listMessagingPolicyPresetMetadata } from "./metadata";

type PolicyPresetLocator = {
  readonly channelId: string;
  readonly presetName: string;
};

type PolicyPresetMetadataReader = (options: {
  readonly agent?: MessagingAgentId;
}) => readonly PolicyPresetLocator[];

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
    options?: { readonly agent?: MessagingAgentId | string | null },
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
    options: { readonly agent?: MessagingAgentId | string | null } = {},
  ): string | null {
    const file = resolveMessagingChannelPolicyPresetPath(presetName, options.agent);
    if (!file) return null;
    const content = deps.readFileSync(file, "utf-8");
    const header = readPresetHeader(content);
    return header?.name === presetName ? content : null;
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
  options: { readonly agent?: MessagingAgentId | string | null } = {},
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

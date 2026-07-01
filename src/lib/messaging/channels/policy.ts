// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { ROOT } from "../../state/paths";
import type { MessagingAgentId } from "../manifest";
import { listMessagingPolicyPresetMetadata } from "./metadata";

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
): MessagingChannelPolicyPresetInfo | null {
  const file = channelPolicyPath(channelId, agent);
  if (!file || !fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, "utf-8");
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

export function resolveMessagingChannelPolicyPresetPath(
  presetName: string,
  agent: MessagingAgentId | string | null | undefined = "openclaw",
): string | null {
  const normalizedAgent = normalizeAgent(agent);
  if (!normalizedAgent) return null;
  for (const preset of listMessagingPolicyPresetMetadata({ agent: normalizedAgent })) {
    if (preset.presetName !== presetName) continue;
    const file = channelPolicyPath(preset.channelId, normalizedAgent);
    if (file && fs.existsSync(file)) return file;
  }
  return null;
}

export function loadMessagingChannelPolicyPreset(
  presetName: string,
  options: { readonly agent?: MessagingAgentId | string | null } = {},
): string | null {
  const file = resolveMessagingChannelPolicyPresetPath(presetName, options.agent);
  if (!file) return null;
  const content = fs.readFileSync(file, "utf-8");
  const header = readPresetHeader(content);
  return header?.name === presetName ? content : null;
}

export function listMessagingChannelPolicyPresets(
  options: { readonly agent?: MessagingAgentId | string | null } = {},
): MessagingChannelPolicyPresetInfo[] {
  const agent = normalizeAgent(options.agent);
  if (!agent) return [];
  const result: MessagingChannelPolicyPresetInfo[] = [];
  const seen = new Set<string>();
  for (const preset of listMessagingPolicyPresetMetadata({ agent })) {
    if (seen.has(preset.presetName)) continue;
    const info = readChannelPolicyInfo(preset.channelId, preset.presetName, agent);
    if (!info) continue;
    result.push(info);
    seen.add(preset.presetName);
  }
  return result;
}

export function isMessagingChannelPolicyPreset(presetName: string): boolean {
  return listMessagingPolicyPresetMetadata().some((preset) => preset.presetName === presetName);
}

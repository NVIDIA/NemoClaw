// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

export type PresetContentSource = { name: string; content: string | null };
export type PresetContentGatewayState = "match" | "absent" | "drift" | null;

type GatewayInspectionOptions = {
  readPolicy: () => string;
  parseCurrentPolicy: (raw: string | null | undefined) => string;
  extractPresetEntries: (content: string | null | undefined) => string | null;
};

function readParsedPolicy(options: GatewayInspectionOptions): Record<string, unknown> | null {
  let rawPolicy: string;
  try {
    rawPolicy = options.readPolicy();
  } catch {
    return null;
  }
  const currentPolicy = options.parseCurrentPolicy(rawPolicy);
  if (!currentPolicy) return null;
  try {
    const parsed = YAML.parse(currentPolicy);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function presetPolicyKeys(
  content: string | null,
  extractPresetEntries: GatewayInspectionOptions["extractPresetEntries"],
): string[] | null {
  const entries = extractPresetEntries(content);
  if (!entries) return null;
  try {
    const policies = YAML.parse(`network_policies:\n${entries}`)?.network_policies;
    if (!policies || typeof policies !== "object" || Array.isArray(policies)) return null;
    const keys = Object.keys(policies);
    return keys.length > 0 ? keys : null;
  } catch {
    return null;
  }
}

export function inspectGatewayPresetNames(
  options: GatewayInspectionOptions & { sources: () => readonly PresetContentSource[] },
): string[] | null {
  const parsed = readParsedPolicy(options);
  if (!parsed) return null;
  const policies = parsed.network_policies;
  if (!policies || typeof policies !== "object" || Array.isArray(policies)) return [];
  const gatewayKeys = new Set(Object.keys(policies));
  return options.sources().flatMap((source) => {
    const keys = presetPolicyKeys(source.content, options.extractPresetEntries);
    return keys?.every((key) => gatewayKeys.has(key)) ? [source.name] : [];
  });
}

export function inspectPresetContentGatewayState(
  options: GatewayInspectionOptions & { presetContent: string; policyKey?: string },
): PresetContentGatewayState {
  const parsed = readParsedPolicy(options);
  if (!parsed) return null;
  const current = parsed.network_policies;
  const entries = options.extractPresetEntries(options.presetContent);
  if (!entries) return "drift";
  try {
    const expected = YAML.parse(`network_policies:\n${entries}`)?.network_policies;
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !expected ||
      typeof expected !== "object" ||
      Array.isArray(expected)
    ) {
      return "drift";
    }
    const currentPolicies = current as Record<string, unknown>;
    const expectedPolicies = expected as Record<string, unknown>;
    const expectedKeys =
      options.policyKey === undefined ? Object.keys(expectedPolicies) : [options.policyKey];
    if (expectedKeys.length === 0) return "drift";
    if (options.policyKey !== undefined && !Object.hasOwn(expectedPolicies, options.policyKey)) {
      return "drift";
    }
    const presentKeys = expectedKeys.filter((key) => Object.hasOwn(currentPolicies, key));
    if (presentKeys.length === 0) return "absent";
    if (presentKeys.length !== expectedKeys.length) return "drift";
    return expectedKeys.every((key) =>
      isDeepStrictEqual(currentPolicies[key], expectedPolicies[key]),
    )
      ? "match"
      : "drift";
  } catch {
    return "drift";
  }
}

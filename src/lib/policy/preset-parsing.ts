// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

import type { JsonObject, JsonValue } from "../core/json-types";

export type PolicyValue = JsonValue;
export type PolicyObject = JsonObject;
export type PolicyDocument = PolicyObject & {
  version?: number;
  network_policies?: PolicyObject;
};

export function isPolicyDocument(value: PolicyValue): value is PolicyDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPolicyObject(value: PolicyValue): value is PolicyObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPresetPolicyMap(value: PolicyValue): value is PolicyObject {
  return (
    isPolicyObject(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every(isPolicyObject)
  );
}

export function parseNetworkPolicies(content: string | null | undefined): PolicyObject | null {
  if (!content) return null;
  try {
    const parsed = YAML.parse(content);
    const networkPolicies = isPolicyDocument(parsed) ? parsed.network_policies : null;
    return isPolicyObject(networkPolicies) ? networkPolicies : null;
  } catch {
    return null;
  }
}

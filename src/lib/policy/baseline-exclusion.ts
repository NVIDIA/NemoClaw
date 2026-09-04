// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import YAML from "yaml";

import { type JsonValue } from "../core/json-types";
import {
  isPolicyDocument,
  isPolicyObject,
  type PolicyObject,
  type PolicyValue,
  parseNetworkPolicies,
} from "./preset-parsing";

const PROTECTED_BASELINE_EXCLUSION_KEYS = new Set(["managed_inference"]);

const BASELINE_EXCLUSION_FEATURE_IMPACTS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  openclaw: {
    nvidia: "Direct NVIDIA API inference may stop working.",
    openclaw_gateway_dialback:
      "OpenClaw sessions_spawn and multi-agent delegation may stop working.",
    clawhub: "ClawHub authentication and skill or plugin discovery may stop working.",
    openclaw_api: "OpenClaw authentication and plugin discovery may stop working.",
    openclaw_docs: "In-sandbox access to OpenClaw documentation may stop working.",
    npm_registry: "OpenClaw plugin installation from npm may stop working.",
  },
  hermes: {
    nvidia: "Direct NVIDIA API inference may stop working.",
    nous_research: "Hermes public metadata lookup and agent updates may stop working.",
    pypi: "Hermes skill or plugin dependency installation through pip may stop working.",
  },
  "langchain-deepagents-code": {
    github: "Git operations and GitHub API or source access may stop working.",
    pypi: "Python package installation through pip may stop working.",
  },
};

/** Baseline entries that remain mandatory for the managed sandbox contract. */
export function isProtectedBaselineExclusionKey(key: string): boolean {
  return PROTECTED_BASELINE_EXCLUSION_KEYS.has(key);
}

/**
 * Entry-specific supported features that an exclusion can disable. Missing
 * metadata must block exclusion so a newly added baseline entry cannot bypass
 * the operator disclosure requirement.
 */
export function getBaselineExclusionFeatureImpact(agent: string, key: string): string | null {
  return BASELINE_EXCLUSION_FEATURE_IMPACTS[agent]?.[key] ?? null;
}

function canonicalize(value: PolicyValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPolicyObject(value)) {
    const sorted: PolicyObject = {};
    for (const key of Object.keys(value).sort()) {
      const canonical = canonicalize(value[key]);
      if (canonical !== undefined) sorted[key] = canonical;
    }
    return sorted;
  }
  return value;
}

/**
 * Content digest over a single baseline network policy entry, stable across
 * YAML key ordering and whitespace. Binds an operator's exclusion approval to
 * the exact reviewed egress so a later release that redefines the entry
 * invalidates the approval instead of silently replaying it.
 */
export function digestBaselineEntry(entry: PolicyValue): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(entry)))
    .digest("hex");
}

/** Exact baseline entry for a key, or null when the base policy omits it. */
export function getBaselineEntry(basePolicyContent: string, key: string): PolicyObject | null {
  const networkPolicies = parseNetworkPolicies(basePolicyContent);
  if (!networkPolicies) return null;
  if (!Object.prototype.hasOwnProperty.call(networkPolicies, key)) return null;
  const entry = networkPolicies[key];
  return isPolicyObject(entry) ? entry : null;
}

/** Keys of every baseline network policy entry, in declaration order. */
export function listBaselineEntryKeys(basePolicyContent: string): string[] {
  const networkPolicies = parseNetworkPolicies(basePolicyContent);
  return networkPolicies ? Object.keys(networkPolicies) : [];
}

function scalarText(value: PolicyValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  return String(value);
}

/**
 * Human-readable preview of every endpoint, method/path rule, and binary an
 * exclusion removes, so the operator reviews the exact scope before approving.
 */
export function renderBaselineEntryScope(key: string, entry: PolicyObject): string[] {
  const lines: string[] = [`  ${key}:`];
  const endpoints = entry.endpoints;
  if (Array.isArray(endpoints)) {
    for (const endpoint of endpoints) {
      if (!isPolicyObject(endpoint)) continue;
      const host = scalarText(endpoint.host);
      const port = scalarText(endpoint.port);
      const protocol = scalarText(endpoint.protocol);
      const location = [host, port ? `:${port}` : "", protocol ? ` (${protocol})` : ""].join("");
      lines.push(`    endpoint: ${location || "(unspecified)"}`);
      const rules = endpoint.rules;
      if (Array.isArray(rules)) {
        for (const rule of rules) {
          if (!isPolicyObject(rule)) continue;
          const allow = isPolicyObject(rule.allow) ? rule.allow : null;
          const deny = isPolicyObject(rule.deny) ? rule.deny : null;
          const verb = allow ? "allow" : deny ? "deny" : "rule";
          const spec = allow ?? deny;
          const method = spec ? scalarText(spec.method) : "";
          const routePath = spec ? scalarText(spec.path) : "";
          lines.push(`      ${verb}: ${[method, routePath].filter(Boolean).join(" ") || "(any)"}`);
        }
      }
    }
  }
  const binaries = entry.binaries;
  if (Array.isArray(binaries)) {
    for (const binary of binaries) {
      const binaryPath = isPolicyObject(binary) ? scalarText(binary.path) : scalarText(binary);
      if (binaryPath) lines.push(`    binary: ${binaryPath}`);
    }
  }
  return lines;
}

function parsePolicyDocumentOrNull(policyContent: string): PolicyObject | null {
  try {
    const parsed = YAML.parse(policyContent);
    return isPolicyDocument(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Remove a single baseline entry from a policy document by exact key. Returns
 * the unchanged policy and `removed: false` when the key is absent or the
 * document has no object-shaped `network_policies`.
 */
export function removeBaselineEntryFromPolicy(
  currentPolicy: string,
  key: string,
): { policy: string; removed: boolean } {
  const document = parsePolicyDocumentOrNull(currentPolicy);
  const networkPolicies = document?.network_policies;
  if (
    !document ||
    !networkPolicies ||
    typeof networkPolicies !== "object" ||
    Array.isArray(networkPolicies) ||
    !Object.prototype.hasOwnProperty.call(networkPolicies, key)
  ) {
    return { policy: currentPolicy, removed: false };
  }
  delete networkPolicies[key];
  document.network_policies = networkPolicies;
  return { policy: YAML.stringify(document), removed: true };
}

/**
 * Merge a baseline entry back into a policy document under its key, restoring a
 * previously excluded entry against the current release baseline.
 */
export function mergeBaselineEntryIntoPolicy(
  currentPolicy: string,
  key: string,
  entry: PolicyObject,
): string {
  const document = parsePolicyDocumentOrNull(currentPolicy) ?? { version: 1 };
  const existing = document.network_policies;
  const networkPolicies =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  networkPolicies[key] = entry;
  document.version = Number(document.version) || 1;
  document.network_policies = networkPolicies;
  return YAML.stringify(document);
}

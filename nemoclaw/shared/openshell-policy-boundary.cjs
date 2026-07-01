// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const YAML = require("yaml");

const MISSING_POLICY_DOCUMENT =
  "Current policy from openshell policy get --base does not contain a policy YAML document";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} source
 * @param {string} invalidMessage
 * @returns {unknown}
 */
function parseYaml(source, invalidMessage) {
  try {
    return YAML.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${invalidMessage}: ${detail}`);
  }
}

// sourceOfTruth: This is the only implementation of the OpenShell
// metadata/YAML parse boundary and provider-composed policy filter.
// consumers: The root CommonJS CLI and ESM plugin runner both load this exact
// package-root CommonJS module in source tests and published runtimes.
// invalidState: `policy get --base` can return metadata-only, diagnostic, or
// malformed YAML output that must never be mistaken for an empty policy.
// sourceBoundary: OpenShell owns command output; this parser owns the trusted
// YAML mapping admitted to every NemoClaw policy mutation.
// whyNotSourceFix: NemoClaw must remain safe with the supported OpenShell CLI
// even when a gateway or older command path returns degraded output.
// regressionTest: package-contract parser parity plus root and plugin policy
// tests cover the fail-soft and strict consumers.
// removalCondition: remove only when no NemoClaw consumer parses OpenShell
// policy command output or OpenShell provides an equivalent typed API.
/**
 * @param {string} raw
 * @param {{ allowUnmarkedPolicyBody?: boolean }} [options]
 * @returns {{ yamlBody: string, policy: Record<string, unknown> }}
 */
function parseOpenShellPolicy(raw, options = {}) {
  const separatorIndex = raw.indexOf("---");
  const yamlBody = (separatorIndex >= 0 ? raw.slice(separatorIndex + 3) : raw).trim();
  if (!yamlBody || /^(error|failed|invalid|warning|status)\b/i.test(yamlBody)) {
    throw new Error(MISSING_POLICY_DOCUMENT);
  }

  const parsed = parseYaml(
    yamlBody,
    "Current policy from openshell policy get --base is not valid YAML",
  );
  if (!isMapping(parsed)) {
    throw new Error("Current policy from openshell policy get --base must be a YAML mapping");
  }

  if (options.allowUnmarkedPolicyBody) {
    if (!/^[a-z_][a-z0-9_]*\s*:/m.test(yamlBody)) {
      throw new Error(MISSING_POLICY_DOCUMENT);
    }
  } else if (
    separatorIndex < 0 &&
    !("version" in parsed) &&
    !("network_policies" in parsed)
  ) {
    throw new Error(MISSING_POLICY_DOCUMENT);
  }

  return { yamlBody, policy: parsed };
}

// invalidState: OpenShell `policy get --base` unexpectedly includes a
// provider-composed `_provider_*` entry that `policy set` must never receive.
// sourceBoundary: OpenShell owns base-policy composition; NemoClaw owns every
// read-modify-write payload it submits.
// whyNotSourceFix: the upstream formatter cannot be fixed from this repository,
// so filter defensively until the supported contract guarantees their absence.
// regressionTest: the root policy round-trip and plugin runner policy tests.
// removalCondition: OpenShell's supported base-policy contract guarantees that
// provider-composed entries are absent from every mutation read.
// tracking: revalidate this guard at every stable OpenShell pin after 0.0.72.
/**
 * @template T
 * @param {Record<string, T>} policies
 * @returns {Record<string, T>}
 */
function withoutProviderComposedPolicies(policies) {
  return Object.fromEntries(
    Object.entries(policies).filter(([name]) => !name.startsWith("_provider_")),
  );
}

/**
 * @param {string} policy
 * @returns {string}
 */
function stripProviderComposedPolicies(policy) {
  const parsed = parseYaml(
    policy,
    "Cannot filter provider-composed policy entries from invalid YAML",
  );
  if (!isMapping(parsed) || !isMapping(parsed.network_policies)) return policy;

  const filtered = withoutProviderComposedPolicies(parsed.network_policies);
  if (Object.keys(filtered).length === Object.keys(parsed.network_policies).length) return policy;
  return YAML.stringify({ ...parsed, network_policies: filtered });
}

exports.parseOpenShellPolicy = parseOpenShellPolicy;
exports.stripProviderComposedPolicies = stripProviderComposedPolicies;
exports.withoutProviderComposedPolicies = withoutProviderComposedPolicies;

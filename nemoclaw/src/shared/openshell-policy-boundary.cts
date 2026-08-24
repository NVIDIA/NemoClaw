// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

export type OpenShellPolicyMapping = Record<string, unknown>;

export type ValidatedOpenShellPolicyMapping = OpenShellPolicyMapping & {
  readonly version?: number;
  readonly network_policies?: OpenShellPolicyMapping;
};

export interface ParsedOpenShellPolicy {
  readonly yamlBody: string;
  readonly policy: ValidatedOpenShellPolicyMapping;
}

export type OpenShellPolicyAuthority = "nemoclaw-managed" | "externally-managed";

export interface SandboxPolicyAuthorityInspection {
  readonly authority: OpenShellPolicyAuthority;
  readonly effectivePolicy: OpenShellPolicyMapping;
}

const MISSING_POLICY_DOCUMENT =
  "Current policy from openshell policy get --base does not contain a policy YAML document";

function isMapping(value: unknown): value is OpenShellPolicyMapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPolicyAuthority(value: unknown): value is OpenShellPolicyAuthority {
  return value === "nemoclaw-managed" || value === "externally-managed";
}

function parseJsonMapping(source: string, invalidMessage: string): OpenShellPolicyMapping {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(invalidMessage);
  }
  if (!isMapping(parsed)) {
    throw new Error(invalidMessage);
  }
  return parsed;
}

/** Parse machine-readable effective policy metadata for one sandbox. */
export function parseSandboxPolicyAuthorityMetadata(
  raw: string,
  sandboxName: string,
): SandboxPolicyAuthorityInspection {
  if (raw.trim().length === 0) {
    throw new Error("OpenShell returned empty sandbox policy authority metadata");
  }
  const metadata = parseJsonMapping(
    raw,
    "OpenShell returned malformed sandbox policy authority metadata",
  );
  if (
    metadata.scope !== "sandbox" ||
    metadata.sandbox !== sandboxName ||
    metadata.status !== "effective" ||
    (metadata.policy_source !== "sandbox" && metadata.policy_source !== "global") ||
    !isMapping(metadata.policy)
  ) {
    throw new Error("OpenShell returned invalid sandbox policy authority metadata");
  }
  return {
    authority: metadata.policy_source === "sandbox" ? "nemoclaw-managed" : "externally-managed",
    effectivePolicy: metadata.policy,
  };
}

/** Parse machine-readable global policy metadata after history proves a revision exists. */
export function parseGlobalPolicyAuthorityMetadata(
  raw: string,
): SandboxPolicyAuthorityInspection {
  if (raw.trim().length === 0) {
    throw new Error("OpenShell returned empty global policy authority metadata");
  }
  const metadata = parseJsonMapping(
    raw,
    "OpenShell returned malformed global policy authority metadata",
  );
  if (
    metadata.scope !== "global" ||
    Object.hasOwn(metadata, "sandbox") ||
    metadata.policy_source !== "global"
  ) {
    throw new Error("OpenShell returned invalid global policy authority metadata");
  }
  if (metadata.status === "superseded") {
    return { authority: "nemoclaw-managed", effectivePolicy: {} };
  }
  if (metadata.status !== "loaded" || !isMapping(metadata.policy)) {
    throw new Error("OpenShell returned invalid global policy authority metadata");
  }
  return { authority: "externally-managed", effectivePolicy: metadata.policy };
}

/** Require durable and observed policy authority to describe the same owner. */
export function assertMatchingPolicyAuthority(recorded: unknown, observed: unknown): void {
  if (!isPolicyAuthority(recorded)) {
    throw new Error("the recorded policy authority is unavailable or invalid");
  }
  if (!isPolicyAuthority(observed)) {
    throw new Error("the observed OpenShell policy authority is unavailable or invalid");
  }
  if (recorded !== observed) {
    throw new Error(`OpenShell policy authority changed from ${recorded} to ${observed}`);
  }
}

function policyMapping(value: unknown, invalidMessage: string): OpenShellPolicyMapping {
  if (!isMapping(value)) throw new Error(invalidMessage);
  return value;
}

function policyValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => policyValuesEqual(value, right[index]))
    );
  }
  if (!isMapping(left) || !isMapping(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        Object.hasOwn(right, key) &&
        policyValuesEqual(left[key], right[key]),
    )
  );
}

function formatPolicyKeys(keys: readonly string[]): string {
  return keys.map((key) => JSON.stringify(key)).join(", ");
}

function assertPolicyRequirementContainmentForOwner(
  inspection: SandboxPolicyAuthorityInspection,
  requiredPolicy: OpenShellPolicyMapping,
  owner: string,
): void {
  if (!isPolicyAuthority(inspection.authority)) {
    throw new Error("the observed OpenShell policy authority is invalid");
  }
  const effectivePolicy = policyMapping(
    inspection.effectivePolicy,
    "the observed effective policy is invalid",
  );
  const required = policyMapping(requiredPolicy, "the required policy input is invalid");
  const requiredNetwork =
    required.network_policies === undefined
      ? {}
      : policyMapping(required.network_policies, "the required network policy input is invalid");
  const observedNetwork = isMapping(effectivePolicy.network_policies)
    ? effectivePolicy.network_policies
    : null;
  const missing: string[] = [];
  const drifted: string[] = [];
  for (const key of Object.keys(requiredNetwork).sort()) {
    if (!observedNetwork || !Object.hasOwn(observedNetwork, key)) {
      missing.push(key);
    } else if (!policyValuesEqual(observedNetwork[key], requiredNetwork[key])) {
      drifted.push(key);
    }
  }
  const requiredSections = Object.keys(required)
    .filter((key) => key !== "network_policies" && key !== "version")
    .sort();
  const missingSections: string[] = [];
  const driftedSections: string[] = [];
  for (const key of requiredSections) {
    if (!Object.hasOwn(effectivePolicy, key)) {
      missingSections.push(key);
    } else if (!policyValuesEqual(effectivePolicy[key], required[key])) {
      driftedSections.push(key);
    }
  }
  if (
    missing.length === 0 &&
    drifted.length === 0 &&
    missingSections.length === 0 &&
    driftedSections.length === 0
  ) {
    return;
  }
  const differences = [
    ...(missing.length > 0 ? [`missing entries ${formatPolicyKeys(missing)}`] : []),
    ...(drifted.length > 0 ? [`drifted entries ${formatPolicyKeys(drifted)}`] : []),
    ...(missingSections.length > 0
      ? [`missing sections ${formatPolicyKeys(missingSections)}`]
      : []),
    ...(driftedSections.length > 0
      ? [`drifted sections ${formatPolicyKeys(driftedSections)}`]
      : []),
  ].join("; ");
  throw new Error(`the ${owner} has ${differences}`);
}

/** Require a policy to contain the requested entries and sections. */
export function assertPolicyRequirementContainment(
  inspection: SandboxPolicyAuthorityInspection,
  requiredPolicy: OpenShellPolicyMapping,
): void {
  assertPolicyRequirementContainmentForOwner(inspection, requiredPolicy, "observed policy");
}

/**
 * Require an external policy to contain the requested entries and sections.
 * Additional externally managed content is allowed.
 */
export function assertExternalPolicyRequirementContainment(
  inspection: SandboxPolicyAuthorityInspection,
  requiredPolicy: OpenShellPolicyMapping,
): void {
  if (!isPolicyAuthority(inspection.authority)) {
    throw new Error("the observed OpenShell policy authority is invalid");
  }
  if (inspection.authority === "nemoclaw-managed") return;
  assertPolicyRequirementContainmentForOwner(
    inspection,
    requiredPolicy,
    "externally managed policy",
  );
}

function assertValidatedPolicyFields(
  policy: OpenShellPolicyMapping,
): asserts policy is ValidatedOpenShellPolicyMapping {
  if (
    policy.version !== undefined &&
    (typeof policy.version !== "number" || !Number.isInteger(policy.version) || policy.version < 1)
  ) {
    throw new Error(
      "Current policy from openshell policy get --base version must be a positive integer",
    );
  }
  if (policy.network_policies !== undefined && !isMapping(policy.network_policies)) {
    throw new Error("Current policy network_policies must be a YAML mapping");
  }
}

function parseYaml(source: string, invalidMessage: string): unknown {
  try {
    return YAML.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${invalidMessage}: ${detail}`);
  }
}

// sourceOfTruth: This is the only implementation of the OpenShell
// metadata/YAML parse boundary and provider-composed policy filter.
// consumers: The root CommonJS CLI consumes the generated .cjs through its
// typed wrapper; the ESM plugin runner imports that same generated .cjs.
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
export function parseOpenShellPolicy(raw: string): ParsedOpenShellPolicy {
  const separator = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/.exec(raw);
  const yamlBody = (separator ? raw.slice(separator.index + separator[0].length) : raw).trim();
  if (!yamlBody) {
    throw new Error(MISSING_POLICY_DOCUMENT);
  }

  const parsed = parseYaml(
    yamlBody,
    "Current policy from openshell policy get --base is not valid YAML",
  );
  if (!isMapping(parsed)) {
    throw new Error("Current policy from openshell policy get --base must be a YAML mapping");
  }
  assertValidatedPolicyFields(parsed);

  // Unmarked output is accepted only when it has a positive policy-root
  // identity. OpenShell diagnostic mappings are otherwise indistinguishable
  // from policy YAML and must never reach a read-modify-write caller. A marked
  // document may contain only future top-level fields because the marker is the
  // policy identity; versionless network_policies remains compatible.
  if (!separator && !("version" in parsed) && !("network_policies" in parsed)) {
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
// tracking: revalidated for stable OpenShell 0.0.106; revalidate after 0.0.106.
export function withoutProviderComposedPolicies<T>(policies: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(policies).filter(([name]) => !name.startsWith("_provider_")),
  );
}

export function stripProviderComposedPolicies(policy: string): string {
  const parsed = parseYaml(
    policy,
    "Cannot filter provider-composed policy entries from invalid YAML",
  );
  if (!isMapping(parsed) || !isMapping(parsed.network_policies)) return policy;

  const filtered = withoutProviderComposedPolicies(parsed.network_policies);
  if (Object.keys(filtered).length === Object.keys(parsed.network_policies).length) return policy;
  return YAML.stringify({ ...parsed, network_policies: filtered });
}

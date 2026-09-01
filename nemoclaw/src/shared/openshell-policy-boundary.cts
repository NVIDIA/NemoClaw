// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

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

export interface OpenShellPolicyIdentity {
  readonly hash: string;
  readonly activeVersion: number;
}

export interface OpenShellPolicyInspection {
  readonly policySource: "sandbox" | "global";
  readonly effectivePolicy: OpenShellPolicyMapping;
  readonly policyIdentity: OpenShellPolicyIdentity;
}

/** Result of checking whether a verified active global policy exists. */
export type ActiveGlobalPolicyInspection =
  | { readonly state: "absent" }
  | {
      readonly state: "active";
      readonly inspection: OpenShellPolicyInspection & { readonly policySource: "global" };
    };

export type OpenShellGlobalPolicyHistoryState = "absent" | "present" | "invalid";

const OPENSHELL_GLOBAL_POLICY_HISTORY_ABSENT = "No global policy history found";

/** Classify the exact OpenShell 0.0.106 global-policy history output contract. */
export function classifyOpenShellGlobalPolicyHistory(
  stdout: string,
  stderr: string,
): OpenShellGlobalPolicyHistoryState {
  if (stdout.trim().length > 0) return "present";
  return stderr.trim() === OPENSHELL_GLOBAL_POLICY_HISTORY_ABSENT ? "absent" : "invalid";
}

const MISSING_POLICY_DOCUMENT =
  "Current policy from openshell policy get --base does not contain a policy YAML document";

function isMapping(value: unknown): value is OpenShellPolicyMapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const POLICY_HASH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parsePolicyIdentity(
  metadata: OpenShellPolicyMapping,
  invalidMessage: string,
): OpenShellPolicyIdentity {
  if (
    typeof metadata.hash !== "string" ||
    !POLICY_HASH_PATTERN.test(metadata.hash) ||
    !positiveInteger(metadata.active_version)
  ) {
    throw new Error(invalidMessage);
  }
  return { hash: metadata.hash, activeVersion: metadata.active_version };
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
export function parseSandboxPolicyMetadata(
  raw: string,
  sandboxName: string,
): OpenShellPolicyInspection {
  if (raw.trim().length === 0) {
    throw new Error("OpenShell returned empty sandbox policy metadata");
  }
  const metadata = parseJsonMapping(raw, "OpenShell returned malformed sandbox policy metadata");
  if (
    metadata.scope !== "sandbox" ||
    metadata.sandbox !== sandboxName ||
    metadata.status !== "effective" ||
    (metadata.policy_source !== "sandbox" && metadata.policy_source !== "global") ||
    !isMapping(metadata.policy)
  ) {
    throw new Error("OpenShell returned invalid sandbox policy metadata");
  }
  return {
    policySource: metadata.policy_source,
    effectivePolicy: metadata.policy,
    policyIdentity: parsePolicyIdentity(
      metadata,
      "OpenShell returned invalid sandbox policy identity metadata",
    ),
  };
}

/** Parse one global policy revision without treating absence as NemoClaw ownership. */
export function parseActiveGlobalPolicyMetadata(raw: string): ActiveGlobalPolicyInspection {
  if (raw.trim().length === 0) {
    throw new Error("OpenShell returned empty global policy metadata");
  }
  const metadata = parseJsonMapping(raw, "OpenShell returned malformed global policy metadata");
  if (
    metadata.scope !== "global" ||
    (metadata.status !== "loaded" && metadata.status !== "superseded") ||
    metadata.policy_source !== "global" ||
    Object.hasOwn(metadata, "sandbox")
  ) {
    throw new Error("OpenShell returned invalid global policy metadata");
  }
  if (metadata.status === "superseded") return { state: "absent" };
  if (!isMapping(metadata.policy)) {
    throw new Error("OpenShell returned invalid global policy metadata");
  }
  return {
    state: "active",
    inspection: {
      policySource: "global",
      effectivePolicy: metadata.policy,
      policyIdentity: parsePolicyIdentity(
        metadata,
        "OpenShell returned invalid global policy metadata",
      ),
    },
  };
}

function policyMapping(value: unknown, invalidMessage: string): OpenShellPolicyMapping {
  if (!isMapping(value)) throw new Error(invalidMessage);
  return value;
}

function formatPolicyKeys(keys: readonly string[]): string {
  return keys.map((key) => JSON.stringify(key)).join(", ");
}

function policyValueContains(observed: unknown, required: unknown): boolean {
  if (isMapping(required)) {
    return (
      isMapping(observed) &&
      Object.entries(required).every(
        ([key, value]) =>
          Object.hasOwn(observed, key) && policyValueContains(observed[key], value),
      )
    );
  }
  if (Array.isArray(required)) {
    return (
      Array.isArray(observed) &&
      required.every((requiredValue) =>
        observed.some((observedValue) => policyValueContains(observedValue, requiredValue)),
      )
    );
  }
  return isDeepStrictEqual(observed, required);
}

function assertPolicyRequirementContainmentForOwner(
  inspection: OpenShellPolicyInspection,
  requiredPolicy: OpenShellPolicyMapping,
  owner: string,
): void {
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
    } else if (!policyValueContains(observedNetwork[key], requiredNetwork[key])) {
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
    } else if (!policyValueContains(effectivePolicy[key], required[key])) {
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
  inspection: OpenShellPolicyInspection,
  requiredPolicy: OpenShellPolicyMapping,
): void {
  assertPolicyRequirementContainmentForOwner(inspection, requiredPolicy, "observed policy");
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
// sourceBoundary: OpenShell owns base-policy composition; NemoClaw is responsible
// only for the exact read-modify-write payload of the current command.
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

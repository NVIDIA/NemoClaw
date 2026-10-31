// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isTavilyProviderProfileId } from "../inference/web-search/provider-profile";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import {
  getTelemetryTarget,
  isTelemetryOperationActive,
  recordTelemetryTarget,
} from "../actions/telemetry/operation";
import type {
  TelemetryOutcome,
  TelemetryState,
  ValueStatus,
  TelemetryMetadataError,
} from "../domain/telemetry/event";
import {
  readAppliedPolicySelection,
  type AppliedPolicySelection,
} from "../domain/telemetry/provenance";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding/identity";
import type { SandboxEntry } from "../state/registry/types";
import {
  readSandboxTelemetryEntry,
  updateSandboxTelemetrySelections,
} from "../state/registry/telemetry-selections";

import { createManagedProviderAdapter } from "../adapters/openshell/managed-provider-adapter";
import { runOpenshellProviderCommand } from "../adapters/openshell/provider-command";
import { inspectOpenShellSandboxIdentityFingerprint } from "../adapters/openshell/sandbox-identity-cli";
import type { OpenShellRuntimeSelection } from "../adapters/openshell/runtime-selection";

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

export function recordPolicyResult(
  sandboxName: string,
  outcome: TelemetryOutcome,
  state: TelemetryState,
  verificationStatus?: ValueStatus,
  metadataErrors?: TelemetryMetadataError[],
): void {
  if (!isTelemetryOperationActive()) return;
  let gatewayName = "";
  try {
    const entry = readSandboxTelemetryEntry(sandboxName);
    if (entry) gatewayName = resolveSandboxGatewayName(entry);
  } catch {
    /* Missing owner evidence must not change the product action. */
  }
  const previous = getTelemetryTarget(sandboxName, gatewayName);
  if (outcome === "no_change" && previous?.outcome === "completed") return;
  recordTelemetryTarget({
    scope: "configuration",
    sandboxName,
    gatewayName,
    outcome,
    state,
    ...(verificationStatus ? { verificationStatus } : {}),
    ...(metadataErrors ? { metadataErrors } : {}),
  });
}

/** Store only the verified tier receipt without delaying or changing product success. */
export function persistAppliedPolicySelection(
  sandboxName: string,
  receipt: AppliedPolicySelection,
): boolean {
  try {
    const entry = readSandboxTelemetryEntry(sandboxName);
    if (entry && updateSandboxTelemetrySelections(entry, { appliedPolicySelection: receipt }))
      return true;
  } catch {
    /* The policy is applied; only its selection receipt could not be stored. */
  }
  recordPolicyResult(sandboxName, "completed", "applied", "collection_error", [
    { category: "policy_tier" },
  ]);
  return false;
}

/** Retain selection origin only after the captured live policy's rebuild was accepted. */
export function restoreAppliedPolicySelection(
  sandboxName: string,
  previous?: SandboxEntry,
): boolean {
  try {
    const entry = readSandboxTelemetryEntry(sandboxName);
    if (!entry || entry.name !== sandboxName) return false;
    const gatewayName = resolveSandboxGatewayName(entry);
    // A newer verified selection owns the replacement; never replace it with history.
    if (entry.appliedPolicySelection !== undefined)
      return readAppliedPolicySelection(entry.appliedPolicySelection) !== null;
    if (previous?.appliedPolicySelection === undefined) return true;
    if (
      previous.pendingCreateIdentity !== undefined ||
      previous.pendingRouteReservation !== undefined ||
      previous.name !== entry.name ||
      (previous.agent ?? "openclaw") !== (entry.agent ?? "openclaw") ||
      resolveSandboxGatewayName(previous) !== gatewayName
    )
      return false;
    const receipt = readAppliedPolicySelection(previous.appliedPolicySelection);
    return (
      receipt !== null &&
      updateSandboxTelemetrySelections(entry, { appliedPolicySelection: receipt })
    );
  } catch {
    // Policy application remains successful when optional metadata cannot be saved.
    return false;
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Detach sandbox grants; gateway credentials remain available to other sandboxes. */
export async function revokeTavilyProviders(
  sandboxName: string,
  gatewayName: string,
  registry: {
    getSandbox(name: string): SandboxEntry | null;
    updateSandbox(name: string, updates: Partial<SandboxEntry>): boolean;
  },
  runtimeSelection?: OpenShellRuntimeSelection,
): Promise<() => void> {
  const adapter = createManagedProviderAdapter((args, options) =>
    runOpenshellProviderCommand(args, { ...options, runtimeSelection }),
  );
  const request = { target: { kind: "named" as const, gatewayName }, sandboxName };
  let entry = registry.getSandbox(sandboxName);
  if (!entry) throw new Error("Sandbox registry state is unavailable.");
  const identityRequest = { sandboxName, gatewayName, runtimeSelection };
  const identity = inspectOpenShellSandboxIdentityFingerprint(identityRequest);
  const revalidate = () => {
    if (
      !isDeepStrictEqual(registry.getSandbox(sandboxName), entry) ||
      inspectOpenShellSandboxIdentityFingerprint(identityRequest) !== identity ||
      (entry?.lifecycleLiveIdentityFingerprint &&
        entry.lifecycleLiveIdentityFingerprint !== identity)
    )
      throw new Error("Sandbox identity changed during Tavily removal.");
  };
  revalidate();
  const inventory = await adapter.listProviderAttachments(request);
  if (!inventory.ok) throw new Error("Cannot read sandbox provider attachments.");
  const tavily: string[] = [];
  for (const providerName of inventory.value.names) {
    const provider = await adapter.getProvider({ target: request.target, providerName });
    if (!provider.ok) throw new Error("Cannot inspect an attached provider.");
    if (isTavilyProviderProfileId(provider.value.type)) tavily.push(providerName);
  }
  revalidate();
  // Persist explicit disabled intent before a partial detach can interrupt removal.
  // Rebuild must not recover an old enabled selection from the onboarding session.
  if (
    entry.webSearchProvider === "tavily" ||
    (entry.webSearchProvider == null && tavily.length > 0)
  ) {
    if (
      !registry.updateSandbox(sandboxName, { webSearchEnabled: false, webSearchProvider: null })
    ) {
      throw new Error("Cannot save disabled Tavily search selection.");
    }
    entry = registry.getSandbox(sandboxName);
    if (!entry || entry.webSearchEnabled !== false || entry.webSearchProvider != null) {
      throw new Error("Cannot verify disabled Tavily search selection.");
    }
  }
  for (const providerName of tavily) {
    revalidate();
    const result = await adapter.detachProvider({ ...request, providerName });
    // Always read back a possibly applied write. Never retry an ambiguous detach.
    const observed = await adapter.listProviderAttachments(request);
    revalidate();
    if (!result.ok || !observed.ok || observed.value.names.includes(providerName)) {
      throw new Error(
        "Tavily provider detachment is incomplete; inspect sandbox attachments before retrying.",
      );
    }
  }
  return revalidate;
}

/** Match the simple host/path globs used by OpenShell; unknown syntax is inconclusive. */
function policyGlobMatches(pattern: unknown, value: string, separator: string): boolean {
  if (typeof pattern !== "string" || /[[\]{}\\]/u.test(pattern)) {
    throw new Error("Cannot verify effective policy glob.");
  }
  const expression = pattern
    .split(/(\*\*|\*|\?)/u)
    .map((part) => {
      if (part === "**") return ".*";
      if (part === "*") return `[^${separator}]*`;
      if (part === "?") return `[^${separator}]`;
      return part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
    })
    .join("");
  return new RegExp(`^${expression}$`, "u").test(value);
}

function endpointMayAllowTavily(endpoint: Record<string, unknown>): boolean {
  const ports = endpoint.ports ?? [];
  if (
    !Array.isArray(ports) ||
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    throw new Error("Cannot verify effective endpoint ports.");
  }
  const port = endpoint.port;
  if (
    port !== undefined &&
    (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
  ) {
    throw new Error("Cannot verify effective endpoint port.");
  }
  if (
    port !== 443 &&
    !ports.includes(443) &&
    ((typeof port === "number" && port > 0) || ports.length > 0)
  )
    return false;
  if (typeof endpoint.host !== "string") throw new Error("Cannot verify effective endpoint host.");
  const host = endpoint.host.toLowerCase().replace(/\.$/u, "");
  if (host !== "*" && !policyGlobMatches(host, "api.tavily.com", ".")) return false;
  // Only enforced REST rules prove a route disjoint. Audit and passthrough
  // modes, other protocols, and missing constraints cannot establish denial.
  if (
    endpoint.protocol !== "rest" ||
    endpoint.enforcement === "audit" ||
    endpoint.tls === "passthrough"
  )
    return true;
  const rules = endpoint.rules;
  if (rules === undefined) return true;
  if (!Array.isArray(rules)) throw new Error("Cannot verify effective REST rules.");
  return ["/search", "/extract"].some((path) => {
    if (endpoint.path !== undefined && !policyGlobMatches(endpoint.path, path, "/")) return false;
    return rules.some((rule: unknown) => {
      if (!isMapping(rule) || !isMapping(rule.allow) || typeof rule.allow.method !== "string") {
        throw new Error("Cannot verify effective REST matcher.");
      }
      const method = rule.allow.method.toUpperCase();
      return (method === "POST" || method === "*") && policyGlobMatches(rule.allow.path, path, "/");
    });
  });
}

/** Prove disjoint port/REST scopes without assuming the requesting process identity. */
export function hasTavilyEgress(policy: unknown): boolean {
  if (!isMapping(policy) || !isMapping(policy.network_policies)) {
    throw new Error("Cannot verify effective network policy.");
  }
  return Object.values(policy.network_policies).some((rule) => {
    if (!isMapping(rule) || !Array.isArray(rule.endpoints)) {
      throw new Error("Cannot verify an effective network rule.");
    }
    // OpenShell also matches ancestors and can relax binary identity at runtime.
    // A different binary path in this document is not proof of Tavily denial.
    return rule.endpoints.some((endpoint) => {
      if (!isMapping(endpoint)) throw new Error("Cannot verify an effective network endpoint.");
      return endpointMayAllowTavily(endpoint);
    });
  });
}

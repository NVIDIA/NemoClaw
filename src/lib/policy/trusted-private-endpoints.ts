// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isIP } from "node:net";

import YAML from "yaml";

import { isPrivateHostname, OPENSHELL_SANDBOX_HOST_BRIDGE } from "../private-networks";
import {
  assertTrustedPrivateEndpointCapability,
  assertEndpointResolvesPublic,
  canonicalizeTrustedPrivateEndpointPins,
  type EndpointDnsLookupFn,
  normalizeTrustedPrivateHost,
} from "../security/trusted-private-endpoint";

export interface ExternalPolicyPreset {
  filePath: string;
  presetName: string;
  content: string;
  trustedPrivatePinCapability?: TrustedPrivatePolicyPinCapability;
}

declare const trustedPrivatePolicyPinCapabilityBrand: unique symbol;

export interface TrustedPrivatePolicyPinCapability {
  readonly [trustedPrivatePolicyPinCapabilityBrand]: true;
}

const TRUSTED_PRIVATE_POLICY_PIN_CAPABILITIES = new WeakMap<object, string>();

export interface TrustedPrivatePolicyPreparationDependencies {
  lookup?: EndpointDnsLookupFn;
  /** Command-scoped declarations that must match this exact input batch. */
  requiredDeclarations?: readonly string[];
}

type EndpointReference = {
  endpoint: Record<string, unknown>;
  host: string;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function policyContentDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isHostGatewayBridge(host: string): boolean {
  return host === OPENSHELL_SANDBOX_HOST_BRIDGE;
}

/**
 * Validate command-generated pinned content before granting a process-local
 * capability. No receipt or policy copy is persisted outside OpenShell.
 */
function validateTrustedPrivatePinnedContent(content: string): void {
  let document: unknown;
  try {
    document = YAML.parse(content) as unknown;
  } catch {
    throw new Error("trusted private pinned policy content is not valid YAML");
  }
  if (!isObjectRecord(document) || !isObjectRecord(document.network_policies)) {
    throw new Error("trusted private pinned policy content has no network policies");
  }

  let validatedPinnedEndpoint = false;
  for (const policy of Object.values(document.network_policies)) {
    if (!isObjectRecord(policy)) continue;
    if (Object.prototype.hasOwnProperty.call(policy, "allowed_ips")) {
      throw new Error("trusted private policy pins must be attached to exact endpoints");
    }
    if (!Array.isArray(policy.endpoints)) continue;
    for (const endpoint of policy.endpoints) {
      if (
        !isObjectRecord(endpoint) ||
        !Object.prototype.hasOwnProperty.call(endpoint, "allowed_ips")
      ) {
        continue;
      }
      if (typeof endpoint.host !== "string") {
        throw new Error("trusted private policy pin endpoint has no exact host");
      }
      const host = normalizeTrustedPrivateHost(endpoint.host);
      if (isHostGatewayBridge(host)) continue;
      if (!Array.isArray(endpoint.allowed_ips) || endpoint.allowed_ips.length === 0) {
        throw new Error(`trusted private policy endpoint '${host}' has no exact address pins`);
      }
      const addresses = endpoint.allowed_ips;
      let canonical: readonly string[];
      try {
        canonical = canonicalizeTrustedPrivateEndpointPins(
          host,
          addresses as readonly string[],
        ).addresses;
      } catch {
        throw new Error(`trusted private policy endpoint '${host}' has a disallowed address pin`);
      }
      if (
        canonical.length !== addresses.length ||
        canonical.some((address, index) => address !== addresses[index])
      ) {
        throw new Error(`trusted private policy endpoint '${host}' has non-canonical private pins`);
      }
      validatedPinnedEndpoint = true;
    }
  }
  if (!validatedPinnedEndpoint) {
    throw new Error("trusted private pinned policy content has no generated private pins");
  }
}

function issueTrustedPrivatePolicyPinCapability(
  content: string,
): TrustedPrivatePolicyPinCapability {
  validateTrustedPrivatePinnedContent(content);
  const capability = Object.freeze({}) as TrustedPrivatePolicyPinCapability;
  TRUSTED_PRIVATE_POLICY_PIN_CAPABILITIES.set(capability, policyContentDigest(content));
  return capability;
}

/** True only for process-local authority issued for this exact policy content. */
export function isTrustedPrivatePolicyPinCapability(
  content: string,
  value: unknown,
): value is TrustedPrivatePolicyPinCapability {
  return (
    typeof value === "object" &&
    value !== null &&
    TRUSTED_PRIVATE_POLICY_PIN_CAPABILITIES.get(value) === policyContentDigest(content)
  );
}

function endpointUrl(host: string): string {
  return `https://${isIP(host) === 6 ? `[${host}]` : host}/`;
}

function collectEndpointReferences(document: unknown): EndpointReference[] {
  if (!isObjectRecord(document) || !isObjectRecord(document.network_policies)) return [];
  const references: EndpointReference[] = [];
  for (const policy of Object.values(document.network_policies)) {
    if (!isObjectRecord(policy) || !Array.isArray(policy.endpoints)) continue;
    for (const endpoint of policy.endpoints) {
      if (!isObjectRecord(endpoint) || typeof endpoint.host !== "string") continue;
      let host: string;
      try {
        host = normalizeTrustedPrivateHost(endpoint.host);
      } catch {
        continue;
      }
      references.push({ endpoint, host });
    }
  }
  return references;
}

export function findUntrustedPrivatePolicyEndpointHost(
  document: unknown,
  trustedHosts?: ReadonlySet<string>,
): string | null {
  for (const { host } of collectEndpointReferences(document)) {
    if (
      !isHostGatewayBridge(host) &&
      isPrivateHostname(host) &&
      trustedHosts?.has(host) !== true
    ) {
      return host;
    }
  }
  return null;
}

function normalizeDeclarations(values: readonly string[], rejectDuplicates: boolean): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const host = normalizeTrustedPrivateHost(value);
    if (seen.has(host) && rejectDuplicates) {
      throw new Error(
        `Trusted private host '${host}' was declared more than once after normalization.`,
      );
    }
    if (!seen.has(host)) {
      seen.add(host);
      normalized.push(host);
    }
  }
  return normalized;
}

/**
 * Inject exact, validated private-address pins into already-validated custom
 * policy presets. User-authored content remains untrusted: only a
 * provenance-checked capability issued by the shared preflight can produce
 * `allowed_ips` entries.
 */
export async function prepareTrustedPrivatePolicyPresets(
  presets: readonly ExternalPolicyPreset[],
  declarations: readonly string[],
  dependencies: TrustedPrivatePolicyPreparationDependencies = {},
): Promise<ExternalPolicyPreset[]> {
  const trustedHosts = normalizeDeclarations(declarations, false);
  const trustedHostSet = new Set(trustedHosts);
  const parsedPresets = presets.map((preset) => {
    const document = YAML.parse(preset.content) as unknown;
    if (!isObjectRecord(document)) {
      throw new Error(`Preset '${preset.presetName}' is not a YAML mapping.`);
    }
    const references = collectEndpointReferences(document);
    for (const { endpoint, host } of references) {
      if (
        Object.prototype.hasOwnProperty.call(endpoint, "allowed_ips") &&
        !isHostGatewayBridge(host)
      ) {
        throw new Error(
          `Preset '${preset.presetName}' contains user-authored allowed_ips, which is not permitted.`,
        );
      }
    }
    const untrustedPrivateHost = findUntrustedPrivatePolicyEndpointHost(
      document,
      trustedHostSet,
    );
    if (untrustedPrivateHost) {
      throw new Error(
        `Preset '${preset.presetName}' endpoint host '${untrustedPrivateHost}' is rejected. Add explicit trust only for RFC1918, CGNAT, or IPv6 unique local destinations.`,
      );
    }
    return { preset, document, references, injectedEndpoints: new Set<Record<string, unknown>>() };
  });

  if (declarations.length === 0) return presets.map((preset) => ({ ...preset }));

  const requiredHosts = normalizeDeclarations(
    dependencies.requiredDeclarations ?? declarations,
    true,
  );
  const requiredHostSet = new Set(requiredHosts);

  const referencesByHost = new Map<string, EndpointReference[]>();
  for (const host of trustedHosts) referencesByHost.set(host, []);
  for (const { references } of parsedPresets) {
    for (const reference of references) {
      referencesByHost.get(reference.host)?.push(reference);
    }
  }

  for (const host of requiredHosts) {
    if ((referencesByHost.get(host)?.length ?? 0) === 0) {
      throw new Error(
        `Trusted private host '${host}' does not match an endpoint in the custom preset input.`,
      );
    }
  }
  for (const [host, references] of referencesByHost) {
    if (references.length === 0) continue;
    const result = await assertEndpointResolvesPublic(endpointUrl(host), dependencies.lookup, {
      trustedPrivateHosts: [host],
    });
    if (!result.ok) {
      throw new Error(
        `Trusted private host '${host}' failed destination preflight: ${result.reason ?? "validation failed"}.`,
      );
    }
    if (!result.trustedPrivateCapability) {
      if (requiredHostSet.has(host)) {
        throw new Error(
          `Trusted private host '${host}' did not resolve to an operator-trustable private address.`,
        );
      }
      continue;
    }
    const resolvedPins = result.addresses?.length
      ? result.addresses
      : result.trustedPrivateCapability.addresses;
    let pins: readonly string[];
    try {
      pins = assertTrustedPrivateEndpointCapability(
        host,
        resolvedPins,
        result.trustedPrivateCapability,
      ).addresses;
    } catch {
      throw new Error(
        `Trusted private host '${host}' returned address pins that do not match its capability.`,
      );
    }
    for (const { endpoint } of references) {
      endpoint.allowed_ips = [...pins];
      for (const parsedPreset of parsedPresets) {
        if (parsedPreset.references.some((reference) => reference.endpoint === endpoint)) {
          parsedPreset.injectedEndpoints.add(endpoint);
          break;
        }
      }
    }
  }

  return parsedPresets.map(({ preset, document, injectedEndpoints }) => {
    const content = YAML.stringify(document);
    const injectedPins = injectedEndpoints.size > 0;
    if (!injectedPins) return { ...preset, content };
    return {
      ...preset,
      content,
      trustedPrivatePinCapability: issueTrustedPrivatePolicyPinCapability(content),
    };
  });
}

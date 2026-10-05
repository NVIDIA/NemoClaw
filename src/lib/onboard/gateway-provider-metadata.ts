// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../adapters/openshell/provider-adapter";
import { parseCliOpenShellProviderMetadata } from "../adapters/openshell/provider-metadata-cli";

const PROVIDER_PROBE_TIMEOUT_MS = 5_000;

export type GatewayProviderMetadata = Omit<OpenShellProviderMetadata, "revision">;

// #9813 owns the remaining raw CLI consumers of these compatibility exports.
// New consumers must use OpenShellProviderAdapter typed results.
export function parseGatewayProviderMetadata(output: string): GatewayProviderMetadata | null {
  const metadata = parseCliOpenShellProviderMetadata(output);
  if (!metadata) return null;
  const { revision: _revision, ...legacyMetadata } = metadata;
  return legacyMetadata;
}

export type GatewayProviderBinding = {
  name: string;
  type: string;
  credentialKey: string;
  configKey: string;
};

export type GatewayCredentialOnlyProviderBinding = {
  name: string;
  type: string;
  credentialKey: string;
};

export type GatewayCredentialFamilyProviderBinding = GatewayCredentialOnlyProviderBinding;

/** Match the complete non-secret provider identity used for route decisions. */
export function matchesGatewayProviderBinding(
  metadata: GatewayProviderMetadata | null,
  expected: GatewayProviderBinding,
): boolean {
  return Boolean(
    metadata &&
    metadata.name === expected.name &&
    metadata.type === expected.type &&
    metadata.credentialKeys.length === 1 &&
    metadata.credentialKeys[0] === expected.credentialKey &&
    metadata.configKeys.length === 1 &&
    metadata.configKeys[0] === expected.configKey,
  );
}

/** Match a provider that exposes exactly one credential and no configuration. */
export function matchesGatewayCredentialOnlyProviderBinding(
  metadata: GatewayProviderMetadata | null,
  expected: GatewayCredentialOnlyProviderBinding,
): boolean {
  return Boolean(
    metadata &&
    metadata.name === expected.name &&
    metadata.type === expected.type &&
    metadata.credentialKeys.length === 1 &&
    metadata.credentialKeys[0] === expected.credentialKey &&
    metadata.configKeys.length === 0,
  );
}

/** Match a canonical credential plus credentials in its namespaced family. */
export function matchesGatewayCredentialFamilyProviderBinding(
  metadata: GatewayProviderMetadata | null,
  expected: GatewayCredentialFamilyProviderBinding,
): boolean {
  return Boolean(
    metadata &&
    metadata.name === expected.name &&
    metadata.type === expected.type &&
    metadata.configKeys.length === 0 &&
    metadata.credentialKeys.includes(expected.credentialKey) &&
    metadata.credentialKeys.every(
      (key) => key === expected.credentialKey || key.startsWith(`${expected.credentialKey}_`),
    ),
  );
}

export type GatewayCredentialOnlyProviderInspection =
  | { readonly kind: "collision" }
  | { readonly kind: "exact" }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "missing" };

async function inspectGatewayCredentialBinding(
  expected: GatewayCredentialOnlyProviderBinding,
  providerAdapter: Pick<OpenShellProviderAdapter, "getProvider">,
  matches: (
    metadata: GatewayProviderMetadata | null,
    expected: GatewayCredentialOnlyProviderBinding,
  ) => boolean,
  gatewayName?: string | null,
): Promise<GatewayCredentialOnlyProviderInspection> {
  try {
    const result = await providerAdapter.getProvider({
      providerName: expected.name,
      target: gatewayName ? { kind: "named", gatewayName } : { kind: "selected" },
      timeoutMs: PROVIDER_PROBE_TIMEOUT_MS,
    });
    if (!result.ok) {
      return result.error.kind === "command" && result.error.reason === "not_found"
        ? { kind: "missing" }
        : { kind: "indeterminate" };
    }
    const { revision: _revision, ...metadata } = result.value;
    return matches(metadata, expected) ? { kind: "exact" } : { kind: "collision" };
  } catch {
    return { kind: "indeterminate" };
  }
}

/** Distinguish a credential family from absence and lookup failure. */
export function inspectGatewayCredentialFamilyProviderBinding(
  expected: GatewayCredentialFamilyProviderBinding,
  providerAdapter: Pick<OpenShellProviderAdapter, "getProvider">,
  gatewayName?: string | null,
): Promise<GatewayCredentialOnlyProviderInspection> {
  return inspectGatewayCredentialBinding(
    expected,
    providerAdapter,
    matchesGatewayCredentialFamilyProviderBinding,
    gatewayName,
  );
}

/** Read one exact provider identity without reading or exporting credential values. */
export async function readGatewayProviderMetadata(
  name: string,
  providerAdapter: Pick<OpenShellProviderAdapter, "getProvider">,
  gatewayName?: string | null,
): Promise<GatewayProviderMetadata | null> {
  try {
    const result = await providerAdapter.getProvider({
      providerName: name,
      target: gatewayName ? { kind: "named", gatewayName } : { kind: "selected" },
    });
    if (!result.ok) return null;
    const { revision: _revision, ...metadata } = result.value;
    return metadata.name === name ? metadata : null;
  } catch {
    return null;
  }
}

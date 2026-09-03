// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { reportsExactProviderNotFound } from "../adapters/openshell/provider-diagnostic-cli";
import type { OpenShellProviderMetadata } from "../adapters/openshell/provider-adapter";
import {
  isValidCliOpenShellProviderIdentifier,
  parseCliOpenShellProviderMetadata,
} from "../adapters/openshell/provider-metadata-cli";

const PROVIDER_PROBE_DIAGNOSTIC_LIMIT = 64 * 1024;
const PROVIDER_PROBE_TIMEOUT_MS = 5_000;

export type GatewayProviderMetadata = OpenShellProviderMetadata;

// #9813 owns the remaining raw CLI consumers of these compatibility exports.
// New consumers must use OpenShellProviderAdapter typed results.
export const parseGatewayProviderMetadata = parseCliOpenShellProviderMetadata;

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

type GatewayProviderCommandResult = {
  status?: number | null;
  stdout?: unknown;
  stderr?: unknown;
  output?: unknown;
  error?: unknown;
  signal?: unknown;
};

type GatewayProviderRunner = (
  args: string[],
  options: {
    ignoreError: true;
    maxBuffer?: number;
    suppressOutput: true;
    stdio: ["ignore", "pipe", "pipe"];
    timeout?: number;
  },
) => GatewayProviderCommandResult;

export type GatewayCredentialOnlyProviderInspection =
  | { readonly kind: "collision" }
  | { readonly kind: "exact" }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "missing" };

function commandStreamText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (Array.isArray(value)) return value.map(commandStreamText).filter(Boolean).join("\n");
  return "";
}

function providerCommandOutput(result: GatewayProviderCommandResult): string {
  const streams = [result.stderr, result.stdout]
    .map(commandStreamText)
    .filter((value) => value.length > 0);
  return streams.length > 0 ? streams.join("\n") : commandStreamText(result.output);
}

function inspectGatewayCredentialBinding(
  expected: GatewayCredentialOnlyProviderBinding,
  runOpenshell: GatewayProviderRunner,
  matches: (
    metadata: GatewayProviderMetadata | null,
    expected: GatewayCredentialOnlyProviderBinding,
  ) => boolean,
): GatewayCredentialOnlyProviderInspection {
  let result: GatewayProviderCommandResult;
  try {
    result = runOpenshell(["provider", "get", expected.name], {
      ignoreError: true,
      maxBuffer: PROVIDER_PROBE_DIAGNOSTIC_LIMIT,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PROVIDER_PROBE_TIMEOUT_MS,
    });
  } catch {
    return { kind: "indeterminate" };
  }

  const output = providerCommandOutput(result);
  if (result.error || result.signal || result.status !== 0) {
    return !result.error &&
      !result.signal &&
      result.status === 1 &&
      reportsExactProviderNotFound(output, expected.name, PROVIDER_PROBE_DIAGNOSTIC_LIMIT)
      ? { kind: "missing" }
      : { kind: "indeterminate" };
  }

  const metadata = parseGatewayProviderMetadata(output);
  return matches(metadata, expected) ? { kind: "exact" } : { kind: "collision" };
}

/** Distinguish a credential family from absence and lookup failure. */
export function inspectGatewayCredentialFamilyProviderBinding(
  expected: GatewayCredentialFamilyProviderBinding,
  runOpenshell: GatewayProviderRunner,
): GatewayCredentialOnlyProviderInspection {
  return inspectGatewayCredentialBinding(
    expected,
    runOpenshell,
    matchesGatewayCredentialFamilyProviderBinding,
  );
}

/** Read one exact provider identity without reading or exporting credential values. */
export function readGatewayProviderMetadata(
  name: string,
  runOpenshell: GatewayProviderRunner,
  gatewayName?: string | null,
): GatewayProviderMetadata | null {
  if (!isValidCliOpenShellProviderIdentifier(name)) return null;

  const args = ["provider", "get"];
  if (gatewayName) args.push("-g", gatewayName);
  args.push(name);
  const result = runOpenshell(args, {
    ignoreError: true,
    suppressOutput: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;

  const output = `${commandStreamText(result.stdout)}\n${commandStreamText(result.stderr)}`;
  const metadata = parseGatewayProviderMetadata(output);
  return metadata?.name === name ? metadata : null;
}

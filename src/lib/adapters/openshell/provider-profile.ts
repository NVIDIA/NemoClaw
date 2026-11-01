// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

type ProviderProfileBoundary = Readonly<{
  id: string;
  credentials: readonly Readonly<Record<string, unknown>>[];
  endpoints: readonly unknown[];
  binaries: readonly string[];
  inference_capable: boolean;
}>;

export type CheckedInProviderProfileContract = Readonly<{
  profileId: string;
  boundary: ProviderProfileBoundary;
}>;

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const CREDENTIAL_KEYS = new Set([
  "auth_style",
  "description",
  "env_vars",
  "header_name",
  "name",
  "query_param",
  "refresh",
  "required",
]);

function providerProfileBoundary(value: unknown): ProviderProfileBoundary | null {
  const profile = recordValue(value);
  if (
    !profile ||
    typeof profile.id !== "string" ||
    !Array.isArray(profile.credentials) ||
    !Array.isArray(profile.endpoints) ||
    !Array.isArray(profile.binaries) ||
    profile.binaries.some((binary) => typeof binary !== "string") ||
    typeof profile.inference_capable !== "boolean"
  ) {
    return null;
  }
  const credentials = profile.credentials.map((value) => {
    const credential = recordValue(value);
    if (
      !credential ||
      Object.keys(credential).some((key) => !CREDENTIAL_KEYS.has(key)) ||
      typeof credential.name !== "string" ||
      !Array.isArray(credential.env_vars) ||
      credential.env_vars.some((envVar) => typeof envVar !== "string") ||
      typeof credential.required !== "boolean" ||
      typeof credential.auth_style !== "string" ||
      typeof credential.header_name !== "string" ||
      (credential.query_param !== undefined && typeof credential.query_param !== "string") ||
      (credential.refresh !== undefined && recordValue(credential.refresh) === null)
    ) {
      return null;
    }
    return {
      name: credential.name,
      env_vars: credential.env_vars,
      required: credential.required,
      auth_style: credential.auth_style,
      header_name: credential.header_name,
      query_param: credential.query_param,
      refresh: credential.refresh ?? null,
    };
  });
  if (credentials.some((credential) => credential === null)) return null;
  if (profile.endpoints.some((endpoint) => recordValue(endpoint) === null)) return null;
  return {
    id: profile.id,
    credentials: credentials as readonly Readonly<Record<string, unknown>>[],
    endpoints: profile.endpoints,
    binaries: profile.binaries as string[],
    inference_capable: profile.inference_capable,
  };
}

/** Parse the credential boundary owned by one checked-in provider profile. */
export function parseCheckedInProviderProfileContract(
  source: string,
): CheckedInProviderProfileContract | null {
  try {
    const boundary = providerProfileBoundary(YAML.parse(source) as unknown);
    return boundary ? { profileId: boundary.id, boundary } : null;
  } catch {
    return null;
  }
}

/** Compare an exported gateway profile with its checked-in credential boundary. */
export function exportedProviderProfileMatchesContract(
  exported: string,
  expected: CheckedInProviderProfileContract,
): boolean {
  try {
    const actual = providerProfileBoundary(JSON.parse(exported) as unknown);
    return actual !== null && isDeepStrictEqual(actual, expected.boundary);
  } catch {
    return false;
  }
}

/**
 * True when the applied gateway profile is an outdated (lagging) version of the
 * checked-in boundary: every credential, endpoint and capability matches, but
 * the applied binaries allowlist is a strict subset of the checked-in one.
 *
 * This is the profile "lag" surface behind #13657: NemoClaw updated the
 * checked-in egress allowlist (e.g. added `/usr/bin/curl`) but an earlier
 * import on the gateway still carries the narrower list, so the sandbox policy
 * it derives from is missing the path the in-sandbox probe actually runs.
 * Such a profile is NemoClaw-owned content that merely fell behind; it is
 * refreshed rather than failing the closed boundary. A widened or
 * contradictory profile remains rejected (see #9806).
 */
export function appliedProviderProfileLaggingContract(
  exported: string,
  expected: CheckedInProviderProfileContract,
): boolean {
  let actual: ProviderProfileBoundary | null = null;
  try {
    actual = providerProfileBoundary(JSON.parse(exported) as unknown);
  } catch {
    return false;
  }
  if (!actual) return false;
  const boundary = expected.boundary;
  return (
    actual.id === boundary.id &&
    actual.inference_capable === boundary.inference_capable &&
    isDeepStrictEqual(actual.credentials, boundary.credentials) &&
    isDeepStrictEqual(actual.endpoints, boundary.endpoints) &&
    actual.binaries.length < boundary.binaries.length &&
    actual.binaries.every((binary) => boundary.binaries.includes(binary))
  );
}

export function isMissingProviderProfile(output: string, profileId: string): boolean {
  const normalized = output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/gu, "")
    .replace(/\n\s*│\s*/gu, " ")
    .trim();
  const escapedProfileId = profileId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const missingMessage = new RegExp(
    `^(?:(?:custom )?provider )?profile(?: ['"]${escapedProfileId}['"])? not found[.!]?$`,
    "iu",
  );
  if (missingMessage.test(normalized)) return true;

  const structuredStatus =
    /(?:status:\s*['"]?NotFound['"]?|code:\s*['"]Some requested entity was not found['"])/iu;
  const message = normalized.match(/message:\s*['"]([^'"\r\n]+)['"]/iu)?.[1]?.trim() ?? "";
  return structuredStatus.test(normalized) && missingMessage.test(message);
}

export function endpointlessProviderProfilePath(root: string, profileId: string): string {
  return path.join(root, "nemoclaw-blueprint", "provider-profiles", `${profileId}.yaml`);
}

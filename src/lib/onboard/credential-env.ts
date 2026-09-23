// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  KNOWN_CREDENTIAL_ENV_KEYS,
  loadCredentials,
  resolveProviderCredential,
} from "../credentials/store";

/** Snapshot only NemoClaw's allowlisted credentials for a trusted child process. */
export function snapshotKnownCredentialEnv(): Record<string, string> {
  return loadCredentials();
}

/** Snapshot only the named known credentials for a scoped child process. */
export function snapshotCredentialEnv(envNames: readonly string[]): Record<string, string> {
  const knownNames = new Set(KNOWN_CREDENTIAL_ENV_KEYS);
  const snapshot: Record<string, string> = {};
  for (const envName of new Set(envNames)) {
    if (!knownNames.has(envName)) continue;
    const value = resolveProviderCredential(envName);
    if (value) snapshot[envName] = value;
  }
  return snapshot;
}

/**
 * Resolve and return a credential for host-side callers. Scoped overrides are
 * returned without exporting them to `process.env`.
 */
export function hydrateCredentialEnv(
  envName: string | null | undefined,
  resolveCredential: (envName: string) => string | null = resolveProviderCredential,
): string | null {
  if (!envName) return null;
  return resolveCredential(envName);
}

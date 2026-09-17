// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadCredentials, resolveProviderCredential } from "../credentials/store";

/** Snapshot only NemoClaw's allowlisted credentials for a trusted child process. */
export function snapshotKnownCredentialEnv(): Record<string, string> {
  return loadCredentials();
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

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveProviderCredential } from "../credentials/store";

/**
 * Resolve a credential into process.env[envName] so subsequent gateway upserts
 * can read it via `--credential <ENV>`.
 */
export function hydrateCredentialEnv(
  envName: string | null | undefined,
  resolveCredential: (envName: string) => string | null = resolveProviderCredential,
): string | null {
  if (!envName) return null;
  return resolveCredential(envName);
}

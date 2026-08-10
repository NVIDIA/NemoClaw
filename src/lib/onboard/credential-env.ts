// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveProviderCredential } from "../credentials/store";
import { shouldStripCredentialEnv } from "../security/credential-env";

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

/**
 * Return only credential values that must be treated as opaque redaction
 * canaries. Names are discarded so callers cannot accidentally serialize the
 * host environment while preparing failure diagnostics.
 */
export function collectCredentialEnvSensitiveValues(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  additionalValues: Iterable<string | null | undefined> = [],
): string[] {
  return [
    ...new Set([
      ...Object.entries(env)
        .filter(([name, value]) => Boolean(value) && shouldStripCredentialEnv(name))
        .map(([, value]) => value as string),
      ...[...additionalValues].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    ]),
  ];
}

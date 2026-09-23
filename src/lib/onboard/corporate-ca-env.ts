// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CORPORATE_CA_EXPLICIT_ENV,
  CORPORATE_CA_FALLBACK_ENV_VARS,
  isCorporateCaImportDisabled,
  isKnownMergedTrustStorePath,
  warnCorporateCa,
} from "./corporate-ca-policy";
import type { ResolvedCorporateCa } from "./corporate-ca-types";
import { CorporateCaValidationError } from "./corporate-ca-types";
import { validateCorporateCaFile } from "./corporate-ca-validation";

/**
 * Resolve a corporate CA bundle from the host environment.
 *
 * Throws only for an invalid explicit source. Conventional CA env vars are
 * skipped with warnings so a default host env does not break unrelated onboards.
 */
export function resolveCorporateCaFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCorporateCa | null {
  if (isCorporateCaImportDisabled(env)) return null;

  const explicit = env[CORPORATE_CA_EXPLICIT_ENV];
  if (explicit && explicit.trim()) {
    const sourcePath = explicit.trim();
    if (isKnownMergedTrustStorePath(sourcePath)) {
      throw new CorporateCaValidationError(
        `${CORPORATE_CA_EXPLICIT_ENV} points at a merged OS trust store (${sourcePath}); export only your corporate root (and intermediates) to a small PEM file instead`,
      );
    }
    const pem = validateCorporateCaFile(sourcePath);
    return { pem, sourcePath, sourceEnv: CORPORATE_CA_EXPLICIT_ENV };
  }

  for (const name of CORPORATE_CA_FALLBACK_ENV_VARS) {
    const value = env[name];
    if (!value || !value.trim()) continue;
    const sourcePath = value.trim();
    if (isKnownMergedTrustStorePath(sourcePath)) {
      warnCorporateCa(
        `${name} points at a merged OS trust store (${sourcePath}); skipped to avoid a broad trust import - set ${CORPORATE_CA_EXPLICIT_ENV} to a small corporate-root PEM to import explicitly`,
      );
      continue;
    }
    try {
      const pem = validateCorporateCaFile(sourcePath);
      return { pem, sourcePath, sourceEnv: name };
    } catch (err) {
      warnCorporateCa(
        `${name} is set (${sourcePath}) but was skipped for corporate CA import: ${
          (err as Error).message
        }; set ${CORPORATE_CA_EXPLICIT_ENV} for fail-loud behavior`,
      );
    }
  }
  return null;
}

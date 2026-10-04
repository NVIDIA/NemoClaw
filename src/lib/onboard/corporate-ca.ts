// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host corporate-proxy CA import (#6210).
 *
 * OpenShell injects its own L7-proxy CA into the sandbox at runtime
 * (`SSL_CERT_FILE` / `/etc/openshell-tls/ca-bundle.pem`). When a separate
 * corporate MITM proxy sits in front of the host and re-signs external TLS with
 * a different root, that corporate root is absent from the sandbox trust path.
 *
 * This public module composes the focused corporate-CA source modules and keeps
 * the onboard call sites stable.
 */

import { resolveCorporateCaFromEnv } from "./corporate-ca-env";
import {
  CORPORATE_CA_HOST_ANCHOR_DIRS,
  hostAnchorDirsFromEnv,
  resolveCorporateCaFromLiteralSslCerts,
  resolveCorporateCaFromHostAnchors,
} from "./corporate-ca-host-anchors";
import {
  CORPORATE_CA_ANCHOR_DIRS_ENV,
  CORPORATE_CA_LITERAL_SSL_CERTS_DIR,
  isCorporateCaImportDisabled,
} from "./corporate-ca-policy";
import type { ResolvedCorporateCa } from "./corporate-ca-types";

export { resolveCorporateCaFromEnv } from "./corporate-ca-env";
export {
  CORPORATE_CA_HOST_ANCHOR_DIRS,
  resolveCorporateCaFromLiteralSslCerts,
  resolveCorporateCaFromHostAnchors,
} from "./corporate-ca-host-anchors";
export {
  CORPORATE_CA_ANCHOR_DIRS_ENV,
  CORPORATE_CA_DISABLE_ENV,
  CORPORATE_CA_EXPLICIT_ENV,
  CORPORATE_CA_FALLBACK_ENV_VARS,
  CORPORATE_CA_HOST_ANCHOR_SOURCE,
  CORPORATE_CA_LITERAL_SSL_CERTS_SOURCE,
  CORPORATE_CA_LITERAL_SSL_CERTS_DIR,
  isKnownMergedTrustStorePath,
  KNOWN_MERGED_TRUST_STORE_PATHS,
  MAX_CORPORATE_CA_BYTES,
  MAX_CORPORATE_CA_CERTS,
} from "./corporate-ca-policy";
export { CorporateCaValidationError } from "./corporate-ca-types";
export type { ResolvedCorporateCa } from "./corporate-ca-types";
export { validateCorporateCaFile } from "./corporate-ca-validation";

export interface ResolveCorporateCaOptions {
  /** Override the host anchor directories scanned (testing seam). */
  hostAnchorDirs?: readonly string[];
  /** Override the literal `/etc/ssl/certs` warning probe path (testing seam). */
  literalSslCertsDir?: string | null;
}

/**
 * Resolve a corporate CA bundle for the sandbox image (#6210).
 *
 * Resolution order:
 *   1. Explicit `NEMOCLAW_CORPORATE_CA_BUNDLE` (fail-loud when invalid).
 *   2. Conventional CA env vars (`REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
 *      `SSL_CERT_FILE`), skipped with a warning when invalid.
 *   3. Host administrator-managed anchor directories, overridable via
 *      `NEMOCLAW_CORPORATE_CA_ANCHOR_DIRS`.
 *
 * If automatic anchor sources miss but direct regular CA files exist in the
 * literal `/etc/ssl/certs` output directory, import only those validated
 * standalone CA files while still excluding the merged OS trust bundle.
 */
export function resolveCorporateCa(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveCorporateCaOptions = {},
): ResolvedCorporateCa | null {
  if (isCorporateCaImportDisabled(env)) return null;
  const fromEnv = resolveCorporateCaFromEnv(env);
  if (fromEnv) return fromEnv;

  const envAnchorDirs = hostAnchorDirsFromEnv(env);
  const anchorDirs = options.hostAnchorDirs ?? envAnchorDirs ?? CORPORATE_CA_HOST_ANCHOR_DIRS;
  const fromHostAnchors = resolveCorporateCaFromHostAnchors(anchorDirs);
  if (fromHostAnchors) return fromHostAnchors;

  const hostScanningDisabledByEnv =
    envAnchorDirs !== null && (env[CORPORATE_CA_ANCHOR_DIRS_ENV] ?? "").trim().length === 0;
  const literalSslCertsDir =
    options.literalSslCertsDir === undefined
      ? CORPORATE_CA_LITERAL_SSL_CERTS_DIR
      : options.literalSslCertsDir;
  if (!hostScanningDisabledByEnv && literalSslCertsDir !== null) {
    return resolveCorporateCaFromLiteralSslCerts(literalSslCertsDir);
  }
  return null;
}

/** Base64-encode PEM text for a single-line Dockerfile ARG value. */
export function encodeCorporateCaArg(pem: string): string {
  return Buffer.from(pem, "utf8")
    .toString("base64")
    .replace(/[\r\n]/g, "");
}

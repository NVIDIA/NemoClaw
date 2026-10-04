// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

/**
 * Env vars inspected for a corporate CA bundle, in priority order.
 *
 * `NEMOCLAW_CORPORATE_CA_BUNDLE` is the explicit opt-in: when it is set but
 * invalid we fail the build loudly. The remaining three are conventional CA
 * env vars the reporter already exports for their corporate proxy; when one of
 * those points at a missing/invalid file we skip it silently rather than break
 * an onboard that never asked for a corporate CA.
 */
export const CORPORATE_CA_EXPLICIT_ENV = "NEMOCLAW_CORPORATE_CA_BUNDLE";
export const CORPORATE_CA_FALLBACK_ENV_VARS = [
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "SSL_CERT_FILE",
] as const;

/**
 * Well-known merged OS trust-store files. These interleave the distro's public
 * roots with any locally-added corporate root, so importing one wholesale would
 * widen sandbox trust far beyond the single corporate proxy CA #6210 is about.
 */
export const KNOWN_MERGED_TRUST_STORE_PATHS: readonly string[] = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/ssl/cert.pem",
  "/etc/ssl/ca-bundle.pem",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/pki/tls/certs/ca-bundle.trust.crt",
  "/etc/pki/tls/cert.pem",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
];

/**
 * True when `candidate` resolves to a well-known merged OS trust store (see
 * {@link KNOWN_MERGED_TRUST_STORE_PATHS}). Matches both the normalized path and,
 * where resolvable, its symlink target.
 */
export function isKnownMergedTrustStorePath(candidate: string): boolean {
  const normalized = path.resolve(candidate);
  if (KNOWN_MERGED_TRUST_STORE_PATHS.includes(normalized)) return true;
  try {
    return KNOWN_MERGED_TRUST_STORE_PATHS.includes(fs.realpathSync(candidate));
  } catch {
    return false;
  }
}

/** Literal Debian/Ubuntu merged trust-store output directory from #6210. */
export const CORPORATE_CA_LITERAL_SSL_CERTS_DIR = "/etc/ssl/certs";

/**
 * Override the host anchor directories scanned. A path-list (`path.delimiter`
 * separated). Set to an empty value to disable host-store scanning entirely.
 */
export const CORPORATE_CA_ANCHOR_DIRS_ENV = "NEMOCLAW_CORPORATE_CA_ANCHOR_DIRS";

/** Reported `sourceEnv` when a CA is discovered from host anchor source dirs. */
export const CORPORATE_CA_HOST_ANCHOR_SOURCE = "host trust-store anchor source";

/** Reported `sourceEnv` for direct standalone CA files under `/etc/ssl/certs`. */
export const CORPORATE_CA_LITERAL_SSL_CERTS_SOURCE = "host /etc/ssl/certs standalone CA";

/** Opt-out: set to a falsey token to disable corporate CA import entirely. */
export const CORPORATE_CA_DISABLE_ENV = "NEMOCLAW_CORPORATE_CA_IMPORT";

/**
 * Upper bound on an accepted CA bundle. A corporate CA chain is a handful of
 * certificates; this rejects an accidental full host trust-store dump.
 */
export const MAX_CORPORATE_CA_BYTES = 128 * 1024;

/**
 * Upper bound on certificates in an accepted bundle. Keeps the imported trust
 * anchors scoped to a corporate CA chain rather than an entire OS trust store.
 */
export const MAX_CORPORATE_CA_CERTS = 24;

export const PEM_CERTIFICATE_RE_GLOBAL =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Emit an operator-facing warning about a skipped corporate-CA import source.
 * Messages carry only public paths, never certificate bytes.
 */
export function warnCorporateCa(message: string): void {
  console.error(`[nemoclaw] WARNING: ${message} (#6210)`);
}

export function isCorporateCaImportDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env[CORPORATE_CA_DISABLE_ENV];
  if (raw === undefined) return false;
  switch (raw.trim().toLowerCase()) {
    case "0":
    case "false":
    case "no":
    case "off":
      return true;
    default:
      return false;
  }
}

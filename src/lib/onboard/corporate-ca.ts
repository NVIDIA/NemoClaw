// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { X509Certificate } from "node:crypto";
import fs from "node:fs";

/**
 * Host corporate-proxy CA import (#6210).
 *
 * OpenShell injects its own L7-proxy CA into the sandbox at runtime
 * (`SSL_CERT_FILE` / `/etc/openshell-tls/ca-bundle.pem`). When a *separate*
 * corporate MITM proxy sits in front of the host and re-signs external TLS with
 * a different root, that corporate root is absent from the sandbox trust path,
 * so external endpoints (e.g. `api.telegram.org`) fail verification even though
 * the network policy allows the connection.
 *
 * This module validates an operator-supplied corporate CA bundle on the host
 * and encodes it so onboard can bake it into the sandbox image. The entrypoint
 * then *appends* it to the OpenShell trust bundle at runtime — never replacing
 * the OpenShell CA (preserving the #1828 behavior).
 */

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

/** Opt-out: set to a falsey token to disable corporate CA import entirely. */
export const CORPORATE_CA_DISABLE_ENV = "NEMOCLAW_CORPORATE_CA_IMPORT";

/**
 * Upper bound on an accepted CA bundle. A corporate CA chain is a handful of
 * certificates (a few KiB); this bound rejects an accidental full host
 * trust-store dump (which would bake broad, unrelated trust into the image).
 */
export const MAX_CORPORATE_CA_BYTES = 128 * 1024;

/**
 * Upper bound on certificates in an accepted bundle. Keeps the imported trust
 * anchors scoped to a corporate CA chain rather than an entire OS trust store.
 */
export const MAX_CORPORATE_CA_CERTS = 24;

const PEM_CERTIFICATE_RE_GLOBAL = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export interface ResolvedCorporateCa {
  /** Validated PEM text of the corporate CA bundle. */
  pem: string;
  /** Absolute-or-relative path the CA was read from. */
  sourcePath: string;
  /** Env var the path came from. */
  sourceEnv: string;
}

export class CorporateCaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorporateCaValidationError";
  }
}

/**
 * Validate a candidate corporate CA bundle file and return its PEM text.
 *
 * Opens the file once with `O_NOFOLLOW` and validates the *opened* descriptor
 * (via `fstat`, then reads from the same fd) so a symlink/file swap between
 * check and use cannot slip a different file past validation. Rejects
 * symlinks, non-regular files, empty/oversized files, world-writable sources,
 * bundles with no or too many PEM CERTIFICATE blocks, and a leading block that
 * is not a parseable X.509 certificate.
 */
export function validateCorporateCaFile(filePath: string): string {
  let fd: number;
  try {
    // O_NOFOLLOW refuses to open through a final-component symlink atomically.
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new CorporateCaValidationError(
        `corporate CA bundle must not be a symlink: ${filePath}`,
      );
    }
    throw new CorporateCaValidationError(
      `corporate CA bundle not found or unreadable: ${filePath}`,
    );
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new CorporateCaValidationError(
        `corporate CA bundle is not a regular file: ${filePath}`,
      );
    }
    if (stat.size === 0) {
      throw new CorporateCaValidationError(`corporate CA bundle is empty: ${filePath}`);
    }
    if (stat.size > MAX_CORPORATE_CA_BYTES) {
      throw new CorporateCaValidationError(
        `corporate CA bundle exceeds ${MAX_CORPORATE_CA_BYTES} bytes: ${filePath}`,
      );
    }
    // Refuse a source any other local user could tamper with before the build.
    if ((stat.mode & 0o002) !== 0) {
      throw new CorporateCaValidationError(
        `corporate CA bundle must not be world-writable: ${filePath}`,
      );
    }
    const content = fs.readFileSync(fd, "utf8");
    const blocks = content.match(PEM_CERTIFICATE_RE_GLOBAL);
    if (!blocks || blocks.length === 0) {
      throw new CorporateCaValidationError(
        `corporate CA bundle contains no PEM CERTIFICATE block: ${filePath}`,
      );
    }
    if (blocks.length > MAX_CORPORATE_CA_CERTS) {
      throw new CorporateCaValidationError(
        `corporate CA bundle has ${blocks.length} certificates (max ${MAX_CORPORATE_CA_CERTS}): ${filePath}`,
      );
    }
    // Structural check: the first block must parse as a real X.509 certificate,
    // catching truncated/corrupt PEM at build time rather than at TLS handshake.
    try {
      new X509Certificate(blocks[0]);
    } catch {
      throw new CorporateCaValidationError(
        `corporate CA bundle leading block is not a valid X.509 certificate: ${filePath}`,
      );
    }
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

function isDisabled(env: NodeJS.ProcessEnv): boolean {
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

/**
 * Resolve a corporate CA bundle from the host environment.
 *
 * Returns `null` when no corporate CA is configured (or import is disabled).
 * Throws {@link CorporateCaValidationError} only when the *explicit*
 * `NEMOCLAW_CORPORATE_CA_BUNDLE` is set to an invalid path; invalid fallback
 * env vars are skipped silently.
 */
export function resolveCorporateCaFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCorporateCa | null {
  if (isDisabled(env)) return null;

  const explicit = env[CORPORATE_CA_EXPLICIT_ENV];
  if (explicit && explicit.trim()) {
    const sourcePath = explicit.trim();
    // Explicit request: surface validation failures instead of silently
    // building an image that cannot verify external TLS.
    const pem = validateCorporateCaFile(sourcePath);
    return { pem, sourcePath, sourceEnv: CORPORATE_CA_EXPLICIT_ENV };
  }

  for (const name of CORPORATE_CA_FALLBACK_ENV_VARS) {
    const value = env[name];
    if (!value || !value.trim()) continue;
    const sourcePath = value.trim();
    try {
      const pem = validateCorporateCaFile(sourcePath);
      return { pem, sourcePath, sourceEnv: name };
    } catch {
      // A conventional CA env var pointing at a missing/invalid file must not
      // break onboard for users who never asked for a corporate CA import.
    }
  }
  return null;
}

/** Base64-encode PEM text for a single-line Dockerfile ARG value. */
export function encodeCorporateCaArg(pem: string): string {
  return Buffer.from(pem, "utf8")
    .toString("base64")
    .replace(/[\r\n]/g, "");
}

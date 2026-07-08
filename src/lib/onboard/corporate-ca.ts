// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

/**
 * Anchor-file extensions each host trust tool actually installs. Debian/Ubuntu
 * `update-ca-certificates` installs only `*.crt` from its anchor dir; RHEL/Fedora
 * `update-ca-trust` accepts `*.pem`/`*.crt`/`*.cer`. Matching per-directory keeps
 * us from importing a staged/backup PEM that is not actually in the host store.
 */
const DEBIAN_ANCHOR_EXT_RE = /\.crt$/i;
const RHEL_ANCHOR_EXT_RE = /\.(?:pem|crt|cer)$/i;

/**
 * Default host trust-store anchor directories and the extensions each installs.
 * These are the *administrator-managed anchor source* dirs — not the merged
 * `/etc/ssl/certs/` output (see {@link CORPORATE_CA_HOST_ANCHOR_DIRS}).
 */
const DEFAULT_HOST_ANCHOR_SPECS = [
  { dir: "/usr/local/share/ca-certificates", extensions: DEBIAN_ANCHOR_EXT_RE },
  { dir: "/etc/pki/ca-trust/source/anchors", extensions: RHEL_ANCHOR_EXT_RE },
] as const;

/**
 * Host trust-store anchor directories scanned as a last resort (#6210
 * acceptance path). These hold ONLY locally-added anchors: the distro's ~140
 * public roots live elsewhere and are compiled into the merged
 * `/etc/ssl/certs/ca-certificates.crt` output — which we deliberately do NOT
 * scan. Reading the anchor sources lets us import exactly the corporate root the
 * reporter installed on the DGX Station host without baking broad, unrelated OS
 * trust into the image. Discovery is bounded by {@link MAX_CORPORATE_CA_CERTS} /
 * {@link MAX_CORPORATE_CA_BYTES}; a directory that would exceed those caps is
 * skipped rather than truncated.
 */
export const CORPORATE_CA_HOST_ANCHOR_DIRS = DEFAULT_HOST_ANCHOR_SPECS.map(
  (spec) => spec.dir,
) as readonly string[];

/**
 * Override the host anchor directories scanned. A path-list (`path.delimiter`
 * separated). Set to an empty value to disable host-store scanning entirely.
 * Lets operators on non-standard distros point at their anchor location, and
 * keeps host-store discovery deterministic under test.
 */
export const CORPORATE_CA_ANCHOR_DIRS_ENV = "NEMOCLAW_CORPORATE_CA_ANCHOR_DIRS";

/** Reported `sourceEnv` when a CA is discovered from the host anchor dirs. */
export const CORPORATE_CA_HOST_ANCHOR_SOURCE = "host trust store";

/**
 * Recognized extensions for a directory not in {@link DEFAULT_HOST_ANCHOR_SPECS}
 * (an operator-supplied override): accept the broader RHEL-style set since the
 * operator pointed at it explicitly.
 */
function anchorExtensionsFor(dir: string): RegExp {
  return (
    DEFAULT_HOST_ANCHOR_SPECS.find((spec) => spec.dir === dir)?.extensions ?? RHEL_ANCHOR_EXT_RE
  );
}

/**
 * Bounds on the recursive anchor-directory walk. `update-ca-certificates`
 * trusts `.crt` files *recursively* under the anchor dir, so discovery must
 * descend subdirectories; these caps keep a pathological tree from turning
 * discovery into an unbounded scan.
 */
const HOST_ANCHOR_MAX_DEPTH = 8;
const HOST_ANCHOR_MAX_FILES = 256;
/**
 * Cap on directories visited during the walk. Bounds the scan even when an
 * override points at a broad tree (e.g. `/` or `$HOME`) with few matching
 * certificate files, so `HOST_ANCHOR_MAX_FILES` alone cannot stop it.
 */
const HOST_ANCHOR_MAX_DIRS = 1024;

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
 * Join validated PEM CERTIFICATE blocks into a normalized bundle.
 *
 * Returns *only* the certificate blocks — each trimmed of surrounding
 * whitespace and separated by a single newline, with a trailing newline. Any
 * bytes outside the CERTIFICATE blocks in the source file (an adjacent private
 * key, comments, arbitrary text) are dropped, so nothing but the validated
 * public certificates is ever baked into the image build context.
 */
function normalizeCertificateBlocks(blocks: readonly string[]): string {
  return `${blocks.map((block) => block.trim()).join("\n")}\n`;
}

/**
 * Validate a candidate corporate CA bundle file and return normalized PEM text.
 *
 * Opens the file once with `O_NOFOLLOW` and validates the *opened* descriptor
 * (via `fstat`, then reads from the same fd) so a symlink/file swap between
 * check and use cannot slip a different file past validation. Rejects
 * symlinks, non-regular files, empty/oversized files, world-writable sources,
 * bundles with no or too many PEM CERTIFICATE blocks, and any block that is not
 * a parseable X.509 certificate.
 *
 * Returns a bundle containing only the validated CERTIFICATE blocks (via
 * {@link normalizeCertificateBlocks}); adjacent private keys or arbitrary
 * payload in the source file are never returned or baked into the image.
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
    // Structural check: every block must parse as a real X.509 certificate,
    // catching truncated/corrupt PEM at build time rather than at TLS handshake.
    for (const block of blocks) {
      try {
        new X509Certificate(block);
      } catch {
        throw new CorporateCaValidationError(
          `corporate CA bundle contains a block that is not a valid X.509 certificate: ${filePath}`,
        );
      }
    }
    // Return only the validated certificate blocks. Anything else in the file
    // (an adjacent private key, comments, arbitrary payload) is intentionally
    // dropped so it can never be copied into the build context / image layers.
    return normalizeCertificateBlocks(blocks);
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
 * Returns `null` when no corporate CA env var is configured (or import is
 * disabled). Throws {@link CorporateCaValidationError} only when the *explicit*
 * `NEMOCLAW_CORPORATE_CA_BUNDLE` is set to an invalid path; invalid fallback
 * env vars are skipped silently. Does not touch the host trust store — see
 * {@link resolveCorporateCaFromHostAnchors} and {@link resolveCorporateCa}.
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

/**
 * Recursively collect anchor certificate files under a directory, bounded by
 * {@link HOST_ANCHOR_MAX_DEPTH} / {@link HOST_ANCHOR_MAX_FILES}. Symlinked files
 * and directories are skipped (a symlink `Dirent` is neither `isFile()` nor
 * `isDirectory()`), so the walk cannot follow a link out of the anchor tree or
 * loop. Returns paths in deterministic sorted order.
 */
function collectAnchorFiles(root: string, extensions: RegExp): string[] {
  const out: string[] = [];
  let dirsVisited = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (
    stack.length > 0 &&
    out.length < HOST_ANCHOR_MAX_FILES &&
    dirsVisited < HOST_ANCHOR_MAX_DIRS
  ) {
    const current = stack.pop();
    if (current === undefined) break;
    dirsVisited += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue; // Absent/unreadable directory — skip it.
    }
    for (const entry of entries) {
      if (out.length >= HOST_ANCHOR_MAX_FILES) break; // Enforce the cap mid-directory.
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < HOST_ANCHOR_MAX_DEPTH) {
        stack.push({ dir: full, depth: current.depth + 1 });
      } else if (entry.isFile() && extensions.test(entry.name)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/**
 * Resolve a corporate CA from the host administrator-managed anchor directories
 * (#6210 acceptance path). See {@link CORPORATE_CA_HOST_ANCHOR_DIRS} for why
 * these bounded source dirs — not the merged `/etc/ssl/certs/` output — are the
 * safe place to detect an installed corporate root. Each directory is scanned
 * recursively (matching `update-ca-certificates`), bounded by the depth/file
 * caps above.
 *
 * Returns `null` when no anchor directory yields a usable, bounded bundle.
 * Never throws: an unreadable/invalid/oversized anchor set is skipped silently
 * (this is an implicit fallback, like the conventional CA env vars).
 */
export function resolveCorporateCaFromHostAnchors(
  dirs: readonly string[] = CORPORATE_CA_HOST_ANCHOR_DIRS,
): ResolvedCorporateCa | null {
  for (const dir of dirs) {
    const files = collectAnchorFiles(dir, anchorExtensionsFor(dir));
    const blocks: string[] = [];
    for (const file of files) {
      try {
        // validateCorporateCaFile enforces per-file symlink/size/mode/cert
        // checks and returns normalized certificate blocks only.
        blocks.push(validateCorporateCaFile(file).trim());
      } catch {
        // Skip an unreadable/invalid anchor file rather than fail discovery.
      }
    }
    if (blocks.length === 0) continue;
    const pem = normalizeCertificateBlocks(blocks);
    // Aggregate caps: keep the imported trust scoped to a corporate chain. A
    // directory that would exceed the caps is skipped, never truncated.
    const certCount = pem.match(PEM_CERTIFICATE_RE_GLOBAL)?.length ?? 0;
    if (certCount === 0 || certCount > MAX_CORPORATE_CA_CERTS) continue;
    if (Buffer.byteLength(pem, "utf8") > MAX_CORPORATE_CA_BYTES) continue;
    return { pem, sourcePath: dir, sourceEnv: CORPORATE_CA_HOST_ANCHOR_SOURCE };
  }
  return null;
}

/**
 * Resolve the host anchor directories to scan: the {@link
 * CORPORATE_CA_ANCHOR_DIRS_ENV} override when set (empty value → no scan), else
 * the built-in {@link CORPORATE_CA_HOST_ANCHOR_DIRS}. Returns `null` when the
 * override is unset so the caller can fall back to the defaults.
 */
function hostAnchorDirsFromEnv(env: NodeJS.ProcessEnv): readonly string[] | null {
  const raw = env[CORPORATE_CA_ANCHOR_DIRS_ENV];
  if (raw === undefined) return null;
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export interface ResolveCorporateCaOptions {
  /** Override the host anchor directories scanned (testing seam). */
  hostAnchorDirs?: readonly string[];
}

/**
 * Resolve a corporate CA bundle for the sandbox image (#6210).
 *
 * Resolution order:
 *   1. Explicit `NEMOCLAW_CORPORATE_CA_BUNDLE` (fail-loud when invalid).
 *   2. Conventional CA env vars (`REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
 *      `SSL_CERT_FILE`), skipped silently when invalid.
 *   3. Host administrator-managed anchor directories (overridable/disablable
 *      via {@link CORPORATE_CA_ANCHOR_DIRS_ENV}), skipped silently.
 *
 * Returns `null` when nothing is configured or import is disabled via
 * `NEMOCLAW_CORPORATE_CA_IMPORT`.
 */
export function resolveCorporateCa(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveCorporateCaOptions = {},
): ResolvedCorporateCa | null {
  if (isDisabled(env)) return null;
  const fromEnv = resolveCorporateCaFromEnv(env);
  if (fromEnv) return fromEnv;
  const anchorDirs =
    options.hostAnchorDirs ?? hostAnchorDirsFromEnv(env) ?? CORPORATE_CA_HOST_ANCHOR_DIRS;
  return resolveCorporateCaFromHostAnchors(anchorDirs);
}

/** Base64-encode PEM text for a single-line Dockerfile ARG value. */
export function encodeCorporateCaArg(pem: string): string {
  return Buffer.from(pem, "utf8")
    .toString("base64")
    .replace(/[\r\n]/g, "");
}

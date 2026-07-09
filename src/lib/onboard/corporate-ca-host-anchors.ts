// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  CORPORATE_CA_ANCHOR_DIRS_ENV,
  CORPORATE_CA_EXPLICIT_ENV,
  CORPORATE_CA_HOST_ANCHOR_SOURCE,
  isKnownMergedTrustStorePath,
  MAX_CORPORATE_CA_BYTES,
  MAX_CORPORATE_CA_CERTS,
  PEM_CERTIFICATE_RE_GLOBAL,
  warnCorporateCa,
} from "./corporate-ca-policy";
import type { ResolvedCorporateCa } from "./corporate-ca-types";
import { normalizeCertificateBlocks, validateCorporateCaFile } from "./corporate-ca-validation";

/**
 * Anchor-file extensions each host trust tool actually installs. Debian/Ubuntu
 * `update-ca-certificates` installs only `*.crt` from its anchor dir; RHEL/Fedora
 * `update-ca-trust` accepts `*.pem`/`*.crt`/`*.cer`.
 */
const DEBIAN_ANCHOR_EXT_RE = /\.crt$/i;
const RHEL_ANCHOR_EXT_RE = /\.(?:pem|crt|cer)$/i;

const DEFAULT_HOST_ANCHOR_SPECS = [
  { dir: "/usr/local/share/ca-certificates", extensions: DEBIAN_ANCHOR_EXT_RE },
  { dir: "/etc/pki/ca-trust/source/anchors", extensions: RHEL_ANCHOR_EXT_RE },
] as const;

/**
 * Host trust-store anchor directories scanned as a last resort (#6210
 * acceptance path). Automatic import reads administrator-managed anchor source
 * directories only, not the merged `/etc/ssl/certs/ca-certificates.crt` output.
 */
export const CORPORATE_CA_HOST_ANCHOR_DIRS = DEFAULT_HOST_ANCHOR_SPECS.map(
  (spec) => spec.dir,
) as readonly string[];

function anchorExtensionsFor(dir: string): RegExp {
  return (
    DEFAULT_HOST_ANCHOR_SPECS.find((spec) => spec.dir === dir)?.extensions ?? RHEL_ANCHOR_EXT_RE
  );
}

const HOST_ANCHOR_MAX_DEPTH = 8;
const HOST_ANCHOR_MAX_FILES = 256;
const HOST_ANCHOR_MAX_DIRS = 1024;

const LITERAL_SSL_CERTS_EXT_RE = /\.(?:pem|crt|cer)$/i;
const LITERAL_SSL_CERTS_MERGED_BASENAMES = new Set(["ca-certificates.crt"]);

/**
 * Recursively collect anchor certificate files under a directory. Symlinked
 * files and directories are skipped because their Dirent is neither a regular
 * file nor directory, so the walk cannot follow a link out of the anchor tree.
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
      continue;
    }
    for (const entry of entries) {
      if (out.length >= HOST_ANCHOR_MAX_FILES) break;
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

function collectLiteralSslCertFiles(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        LITERAL_SSL_CERTS_EXT_RE.test(entry.name) &&
        !LITERAL_SSL_CERTS_MERGED_BASENAMES.has(entry.name),
    )
    .map((entry) => path.join(root, entry.name))
    .filter((file) => !isKnownMergedTrustStorePath(file))
    .sort()
    .slice(0, HOST_ANCHOR_MAX_FILES);
}

export function warnIfLiteralSslCertsOnlySource(root: string): void {
  const candidates = collectLiteralSslCertFiles(root);
  if (candidates.length === 0) return;

  const validCandidates: string[] = [];
  for (const candidate of candidates) {
    try {
      validateCorporateCaFile(candidate);
      validCandidates.push(candidate);
    } catch {
      // Invalid standalone files, including normal leaf certs such as
      // ssl-cert-snakeoil.pem, are not actionable for the #6210 warning.
    }
  }
  if (validCandidates.length === 0) return;

  const example = validCandidates[0];
  warnCorporateCa(
    `host ${root} contains standalone CA certificate file(s) such as ${example}, but NemoClaw does not import the merged/output trust directory automatically; set ${CORPORATE_CA_EXPLICIT_ENV} to the corporate root PEM, or set ${CORPORATE_CA_ANCHOR_DIRS_ENV} to the administrator anchor source directory`,
  );
}

/**
 * Resolve a corporate CA from host administrator-managed anchor directories.
 * Returns null when no anchor directory yields a usable, bounded CA bundle.
 */
export function resolveCorporateCaFromHostAnchors(
  dirs: readonly string[] = CORPORATE_CA_HOST_ANCHOR_DIRS,
): ResolvedCorporateCa | null {
  for (const dir of dirs) {
    const files = collectAnchorFiles(dir, anchorExtensionsFor(dir));
    const blocks: string[] = [];
    for (const file of files) {
      try {
        blocks.push(validateCorporateCaFile(file).trim());
      } catch {
        // Skip an unreadable/invalid anchor file rather than fail discovery.
      }
    }
    if (blocks.length === 0) {
      if (files.length > 0) {
        warnCorporateCa(
          `host trust-store anchor directory ${dir} has ${files.length} candidate file(s) but none were valid corporate CA certificates; skipping`,
        );
      }
      continue;
    }
    const pem = normalizeCertificateBlocks(blocks);
    const certCount = pem.match(PEM_CERTIFICATE_RE_GLOBAL)?.length ?? 0;
    if (certCount === 0 || certCount > MAX_CORPORATE_CA_CERTS) {
      warnCorporateCa(
        `host trust-store anchor directory ${dir} yields ${certCount} certificate(s) (max ${MAX_CORPORATE_CA_CERTS}); skipping to avoid a broad trust import`,
      );
      continue;
    }
    if (Buffer.byteLength(pem, "utf8") > MAX_CORPORATE_CA_BYTES) {
      warnCorporateCa(
        `host trust-store anchor directory ${dir} exceeds ${MAX_CORPORATE_CA_BYTES} bytes; skipping`,
      );
      continue;
    }
    return { pem, sourcePath: dir, sourceEnv: CORPORATE_CA_HOST_ANCHOR_SOURCE };
  }
  return null;
}

/**
 * Resolve the host anchor directories to scan: the override when set (empty
 * value means no scan), else null so the caller can use built-in defaults.
 */
export function hostAnchorDirsFromEnv(env: NodeJS.ProcessEnv): readonly string[] | null {
  const raw = env[CORPORATE_CA_ANCHOR_DIRS_ENV];
  if (raw === undefined) return null;
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

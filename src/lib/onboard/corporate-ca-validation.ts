// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { X509Certificate } from "node:crypto";
import fs from "node:fs";

import {
  MAX_CORPORATE_CA_BYTES,
  MAX_CORPORATE_CA_CERTS,
  PEM_CERTIFICATE_RE_GLOBAL,
} from "./corporate-ca-policy";
import { CorporateCaValidationError } from "./corporate-ca-types";

/**
 * Join validated PEM CERTIFICATE blocks into a normalized bundle.
 *
 * Returns only certificate blocks, each trimmed and separated by a single
 * newline, with a trailing newline. Any bytes outside the CERTIFICATE blocks in
 * the source file are dropped.
 */
export function normalizeCertificateBlocks(blocks: readonly string[]): string {
  return `${blocks.map((block) => block.trim()).join("\n")}\n`;
}

/**
 * Validate a candidate corporate CA bundle file and return normalized PEM text.
 *
 * Opens the file once with `O_NOFOLLOW` and validates the opened descriptor so a
 * symlink/file swap between check and use cannot slip a different file past
 * validation. Rejects symlinks, non-regular files, empty/oversized files,
 * group/world-writable sources, bundles with no or too many PEM CERTIFICATE
 * blocks, any block that is not parseable X.509, and any certificate whose
 * Basic Constraints do not mark it as a CA.
 */
export function validateCorporateCaFile(filePath: string): string {
  let fd: number;
  try {
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
    // Refuse a source another local user could tamper with before the build.
    if ((stat.mode & 0o022) !== 0) {
      throw new CorporateCaValidationError(
        `corporate CA bundle must not be group- or world-writable: ${filePath}`,
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

    for (const block of blocks) {
      let cert: X509Certificate;
      try {
        cert = new X509Certificate(block);
      } catch {
        throw new CorporateCaValidationError(
          `corporate CA bundle contains a block that is not a valid X.509 certificate: ${filePath}`,
        );
      }
      if (!cert.ca) {
        throw new CorporateCaValidationError(
          `corporate CA bundle contains a certificate that is not a CA (basicConstraints CA:TRUE required): ${filePath}`,
        );
      }
    }

    return normalizeCertificateBlocks(blocks);
  } finally {
    fs.closeSync(fd);
  }
}

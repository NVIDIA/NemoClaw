// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { basename } from "node:path";

import {
  SECRET_BLOCK_PATTERNS,
  STRUCTURED_TOKEN_PATTERNS,
  TOKEN_PREFIX_PATTERNS,
  isCredentialField,
  isSafeCredentialPlaceholder,
} from "../../../nemoclaw/dist/shared/credential-filter-boundary.cjs";

// Public jwt.io documentation vector, also shipped in Zod's parser tests.
// Keep the segments separate so repository secret scanners do not mistake the
// reviewed fixture itself for a credential.
const PUBLIC_JWT_DOCUMENTATION_VECTOR = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ",
  "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
].join(".");

export {
  CREDENTIAL_PLACEHOLDER,
  CREDENTIAL_SENSITIVE_BASENAMES,
  isConfigObject,
  isConfigValue,
  isCredentialField,
  isSafeCredentialPlaceholder,
  isSensitiveFile,
  redactCredentialText,
  sanitizeEnvFileContent,
  stripCredentials,
  valueLooksLikeSecret,
} from "../../../nemoclaw/dist/shared/credential-filter-boundary.cjs";
export type {
  ConfigObject,
  ConfigValue,
} from "../../../nemoclaw/dist/shared/credential-filter-boundary.cjs";

/** Detect standalone credential fingerprints without interpreting surrounding file structure. */
export function textContainsHighConfidenceCredential(
  value: string,
  options: { privateKeyHeader?: boolean } = {},
): boolean {
  const withoutPlaceholders = textWithoutSafeCredentialFixtures(value);
  for (const pattern of [
    ...TOKEN_PREFIX_PATTERNS,
    ...STRUCTURED_TOKEN_PATTERNS,
    ...SECRET_BLOCK_PATTERNS,
  ]) {
    pattern.lastIndex = 0;
    if (pattern.test(withoutPlaceholders)) return true;
  }
  return (
    options.privateKeyHeader !== false &&
    /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/u.test(withoutPlaceholders)
  );
}

function textWithoutSafeCredentialFixtures(value: string): string {
  return (
    value
      .replace(/(?:Bearer\s+)?openshell:resolve:env:[A-Za-z0-9_]+/giu, "unused")
      .replace(/(?:xox[bx]|xapp)-OPENSHELL-RESOLVE-ENV-[A-Za-z0-9_-]+/gu, (candidate) =>
        isSafeCredentialPlaceholder(candidate) ? "unused" : candidate,
      )
      // Generated bundles contain the accepted-placeholder matcher itself.
      // Normalize that exact source fragment without stripping the reserved
      // prefix from malformed placeholder-shaped credential values.
      .replace(/(?:xox[bx]|xapp)-OPENSHELL-RESOLVE-ENV-\[A-Za-z0-9_\]\+/gu, "unused")
      .replace(/(?<![A-Za-z0-9_-])sk-OPENSHELL-PROXY-REWRITE(?![A-Za-z0-9_-])/gu, "unused")
      .replaceAll(PUBLIC_JWT_DOCUMENTATION_VECTOR, "unused")
      .replaceAll("[STRIPPED_BY_MIGRATION]", "unused")
  );
}

/** Detect standalone and context-anchored credentials in opaque file content. */
export function textContainsCredential(
  value: string,
  options: { opaqueAssignments?: boolean; privateKeyHeader?: boolean } = {},
): boolean {
  const withoutPlaceholders = textWithoutSafeCredentialFixtures(value);
  if (textContainsHighConfidenceCredential(withoutPlaceholders, options)) return true;
  const authorization =
    /\b(?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*["']?Bearer[ \t]+([A-Za-z0-9_.+/=-]{10,})/gimu;
  if (authorization.test(withoutPlaceholders)) return true;
  if (options.opaqueAssignments === false) return false;
  const assignment =
    /(?<![A-Za-z0-9_.-])["']?([_A-Za-z][_A-Za-z0-9.-]{0,127})["']?[ \t]*[:=][ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;{}]+))/gu;
  for (;;) {
    const match = assignment.exec(withoutPlaceholders);
    if (!match) break;
    const field = match[1]!.replace(/^_+/u, "");
    const candidate = match[2] ?? match[3] ?? match[4] ?? "";
    if (
      !/^(?:module\.)?exports\./u.test(field) &&
      isCredentialField(field) &&
      !isSafeCredentialPlaceholder(candidate)
    ) {
      return true;
    }
    // A non-credential outer JSON key can contain a nested credential key.
    // Advance one character so the bounded scan considers that inner object.
    assignment.lastIndex = match.index + 1;
  }
  return false;
}

/** Detect npm registry credential directives even when their values are opaque. */
export function npmConfigContainsCredentialDirective(value: string): boolean {
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const directive = key.slice(key.lastIndexOf(":") + 1);
    if (/^_?(?:auth(?:token)?|password|username)$/iu.test(directive)) return true;
  }
  return false;
}

/** Dependency lockfiles do not store NemoClaw runtime credentials. */
const SNAPSHOT_CREDENTIAL_SCAN_EXCLUDED_BASENAMES = new Set([
  ".package-lock.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-lock.yml",
]);

/** Whether a filename is a dependency lockfile. */
export function isDependencyLockfile(filename: string): boolean {
  return SNAPSHOT_CREDENTIAL_SCAN_EXCLUDED_BASENAMES.has(basename(filename).toLowerCase());
}

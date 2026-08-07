// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Credential stripping for host→sandbox migration snapshots.
// Kept in parity with src/lib/security/credential-filter.ts so migration
// cannot leave channel tokens, env secrets, or auth headers in the sandbox.

import { isObjectRecord, type UnknownRecord } from "../shared/object-record.js";

export const CREDENTIAL_PLACEHOLDER = "[STRIPPED_BY_MIGRATION]";

/**
 * Basenames that MUST NOT be copied into snapshot bundles.
 */
export const CREDENTIAL_SENSITIVE_BASENAMES = new Set([
  "auth-profiles.json",
  "auth.json",
  "chatgpt-auth.json",
]);

const CREDENTIAL_FIELDS = new Set([
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "pass",
  "passwd",
  "resolvedkey",
]);

const CREDENTIAL_FIELD_PATTERN =
  /^(?:(?:personal[._-]?)?access|refresh|client|bearer|oauth|auth|api|private|public|signing|session|bot|app|resolved)[._-]?(?:tokens?|keys?|secrets?|passwords?|passphrases?|credentials?)$/i;

const ENV_SECRET_FIELD_PATTERN =
  /^(?:[A-Z0-9]+_)*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|PASSPHRASE|CREDENTIAL)S?$/;

const CREDENTIAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

const HEADER_CREDENTIAL_PATTERN = /-(?:key|token|secret|password|passphrase|credential|auth)s?$/i;

const PUBLIC_KEY_FIELD_PATTERN = /(?:^|[._-])public[._-]?keys?$/i;

const SAFE_CREDENTIAL_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^openshell:resolve:env:[A-Za-z0-9_]+$/,
  /^Bearer\s+openshell:resolve:env:[A-Za-z0-9_]+$/i,
  /^xoxb-OPENSHELL-RESOLVE-ENV-[A-Za-z0-9_]+$/,
  /^xapp-OPENSHELL-RESOLVE-ENV-[A-Za-z0-9_]+$/,
];

const SAFE_CREDENTIAL_PLACEHOLDER_LITERALS: ReadonlySet<string> = new Set([
  "unused",
  CREDENTIAL_PLACEHOLDER,
]);

/**
 * Context-anchored secret shapes mirrored from
 * src/lib/security/secret-patterns.ts. The plugin package cannot import
 * src/lib at runtime, so a repository-level parity test pins this copy.
 */
export const CONTEXT_SECRET_PATTERNS: readonly RegExp[] = [
  /(?<=Bearer\s+)[A-Za-z0-9_.+/=-]{10,}/gi,
  /(?<=(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)|(?:X[-_])?API[-_]KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]{10,}/gi,
  /(?<=(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}(?:Token|Secret|Credential)|[A-Za-z0-9]{0,128}(?:[Aa]ccess|[Rr]efresh|[Cc]lient|[Bb]earer|[Aa]uth|[Aa][Pp][Ii]|[Pp]rivate|[Ss]igning|[Ss]ession|[Bb]ot|[Aa]pp|[Rr]esolved)Key|[A-Za-z0-9]{1,128}(?:Password|Passwd|Pass))["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]{10,}/g,
  /(?<=(?:^|[^A-Za-z0-9])KEY["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]{10,}/g,
];

/**
 * High-confidence raw secret shapes used as a value-level backstop.
 * Kept aligned with TOKEN_PREFIX / STRUCTURED / SECRET_BLOCK patterns from
 * src/lib/security/secret-patterns.ts (plugin package cannot import src/lib).
 */
const VALUE_SECRET_PATTERNS: readonly RegExp[] = [
  /nvapi-[A-Za-z0-9_-]{10,}/,
  /nvcf-[A-Za-z0-9_-]{10,}/,
  /ghp_[A-Za-z0-9_-]{10,}/,
  /(?:github_pat_)[A-Za-z0-9_]{30,}/,
  /sk-proj-[A-Za-z0-9_-]{10,}/,
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}/,
  /A(?:K|S)IA[A-Z0-9]{16}/,
  /hf_[A-Za-z0-9]{10,}/,
  /glpat-[A-Za-z0-9_-]{10,}/,
  /gsk_[A-Za-z0-9]{10,}/,
  /pypi-[A-Za-z0-9_-]{10,}/,
  /\bbot\d{8,10}:[A-Za-z0-9_-]{35}\b/,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
  /\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/,
  /tvly-[A-Za-z0-9_-]{10,}/,
  /lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*/,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/,
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
  ...CONTEXT_SECRET_PATTERNS,
];

function hasPassCredentialSegment(key: string): boolean {
  const normalized = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return (
    normalized === "pass" ||
    normalized === "passwd" ||
    normalized.endsWith("_pass") ||
    normalized.endsWith("_passwd")
  );
}

export function isCredentialField(key: string): boolean {
  if (PUBLIC_KEY_FIELD_PATTERN.test(key)) return false;
  return (
    CREDENTIAL_FIELDS.has(key.toLowerCase()) ||
    CREDENTIAL_FIELD_PATTERN.test(key) ||
    hasPassCredentialSegment(key) ||
    ENV_SECRET_FIELD_PATTERN.test(key) ||
    HEADER_CREDENTIAL_PATTERN.test(key) ||
    CREDENTIAL_HEADER_NAMES.has(key.toLowerCase())
  );
}

export function valueLooksLikeSecret(value: string): boolean {
  return VALUE_SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    const matched = pattern.test(value);
    pattern.lastIndex = 0;
    return matched;
  });
}

export function isSafeCredentialPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const withoutScheme = value.replace(/^Bearer\s+/i, "");
  if (
    SAFE_CREDENTIAL_PLACEHOLDER_LITERALS.has(value) ||
    SAFE_CREDENTIAL_PLACEHOLDER_LITERALS.has(withoutScheme)
  ) {
    return true;
  }
  return SAFE_CREDENTIAL_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

function scrubConfigValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (isSafeCredentialPlaceholder(value)) return value;
    return valueLooksLikeSecret(value) ? CREDENTIAL_PLACEHOLDER : value;
  }
  return stripCredentials(value);
}

function cliFlagName(token: string): string | null {
  const match = /^--?([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(token);
  return match ? match[1] : null;
}

function scrubArrayElement(value: unknown, previous: unknown): unknown {
  if (typeof value !== "string") return stripCredentials(value);
  if (isSafeCredentialPlaceholder(value)) return value;

  const eq = value.indexOf("=");
  if (eq > 0 && value.startsWith("-")) {
    const flagName = cliFlagName(value.slice(0, eq));
    if (flagName && isCredentialField(flagName)) {
      const inlineValue = value.slice(eq + 1);
      return isSafeCredentialPlaceholder(inlineValue)
        ? value
        : `${value.slice(0, eq)}=${CREDENTIAL_PLACEHOLDER}`;
    }
  }

  if (!value.startsWith("-") && typeof previous === "string") {
    const prevFlag = cliFlagName(previous);
    if (prevFlag && isCredentialField(prevFlag)) return CREDENTIAL_PLACEHOLDER;
  }

  return valueLooksLikeSecret(value) ? CREDENTIAL_PLACEHOLDER : value;
}

/**
 * Recursively strip credential fields from a JSON-like object.
 */
export function stripCredentials(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((value, index) => scrubArrayElement(value, obj[index - 1]));
  }
  if (!isObjectRecord(obj)) return obj;

  const result: UnknownRecord = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isCredentialField(key)) {
      result[key] =
        value === null || value === undefined || isSafeCredentialPlaceholder(value)
          ? value
          : CREDENTIAL_PLACEHOLDER;
    } else {
      result[key] = scrubConfigValue(value);
    }
  }
  return result;
}

/**
 * Strip credentials from a shell-style environment file body.
 *
 * Field-name matching handles ordinary secret variables while the value-shape
 * backstop catches provider tokens stored under an otherwise benign key.
 */
export function sanitizeEnvFileContent(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) return line;
      const eq = line.indexOf("=");
      if (eq <= 0) return line;
      const rawKey = line.slice(0, eq).trim();
      const key = rawKey.replace(/^export\s+/i, "").trim();
      const value = line.slice(eq + 1);
      if (isSafeCredentialPlaceholder(value)) return line;
      if (!key) return line;
      if (!isCredentialField(key) && !valueLooksLikeSecret(value)) return line;
      return `${line.slice(0, eq)}=${CREDENTIAL_PLACEHOLDER}`;
    })
    .join("\n");
}

export function isSensitiveFile(filename: string): boolean {
  return CREDENTIAL_SENSITIVE_BASENAMES.has(filename.toLowerCase());
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function frozenPatterns(patterns: RegExp[]): readonly RegExp[] {
  return Object.freeze(patterns);
}

/** Token-prefix patterns that match standalone secrets. */
export const TOKEN_PREFIX_PATTERNS: readonly RegExp[] = frozenPatterns([
  /nvapi-[A-Za-z0-9_-]{10,}/g,
  /nvcf-[A-Za-z0-9_-]{10,}/g,
  /ghp_[A-Za-z0-9_-]{10,}/g,
  /(?:github_pat_)[A-Za-z0-9_]{30,}/g,
  /sk-proj-[A-Za-z0-9_-]{10,}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}/g,
  /A(?:K|S)IA[A-Z0-9]{16}/g,
  /hf_[A-Za-z0-9]{10,}/g,
  /glpat-[A-Za-z0-9_-]{10,}/g,
  /gsk_[A-Za-z0-9]{10,}/g,
  /pypi-[A-Za-z0-9_-]{10,}/g,
  /\bbot\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  /\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g,
  /tvly-[A-Za-z0-9_-]{10,}/g,
  /lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*/g,
]);

/** Structured standalone tokens without a provider-specific prefix. */
export const STRUCTURED_TOKEN_PATTERNS: readonly RegExp[] = frozenPatterns([
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/g,
]);

/** Context-anchored patterns that require a credential label or auth scheme. */
export const CONTEXT_PATTERNS: readonly RegExp[] = frozenPatterns([
  /(?<=Bearer\s+)[A-Za-z0-9_.+/=-]{10,}/gi,
  /(?<=(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)|(?:X[-_])?API[-_]KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]{10,}/gi,
  /(?<=(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}(?:Token|Secret|Credential)|[A-Za-z0-9]{0,128}(?:[Aa]ccess|[Rr]efresh|[Cc]lient|[Bb]earer|[Aa]uth|[Aa][Pp][Ii]|[Pp]rivate|[Ss]igning|[Ss]ession|[Bb]ot|[Aa]pp|[Rr]esolved)Key|[A-Za-z0-9]{1,128}(?:Password|Passwd|Pass))["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]{10,}/g,
  /(?<=(?:^|[^A-Za-z0-9])KEY["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]{10,}/g,
]);

/** Multi-line secret blocks without a token prefix. */
export const SECRET_BLOCK_PATTERNS: readonly RegExp[] = frozenPatterns([
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
]);

/** All supported secret patterns. */
export const SECRET_PATTERNS: readonly RegExp[] = frozenPatterns([
  ...TOKEN_PREFIX_PATTERNS,
  ...STRUCTURED_TOKEN_PATTERNS,
  ...SECRET_BLOCK_PATTERNS,
  ...CONTEXT_PATTERNS,
]);

/** Token prefixes covered by the debug.sh fallback when Node is unavailable. */
export const EXPECTED_SHELL_PREFIXES = ["nvapi-", "nvcf-", "ghp_", "sk-", "tvly-"];

/** Match pass/passwd only as a complete or terminal credential-name segment. */
export function hasPassCredentialSegment(key: string): boolean {
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

export type ConfigValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | ConfigValue[]
  | ConfigObject;

export type ConfigObject = { [key: string]: ConfigValue };

export const CREDENTIAL_PLACEHOLDER = "[STRIPPED_BY_MIGRATION]";

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
// Public keys are verification material. Exempt publicKey, PUBLIC_KEY,
// public-key, and prefixed forms before applying credential-name patterns.
const PUBLIC_KEY_FIELD_PATTERN = /(?:^|[._-])public[._-]?keys?$/i;
// OpenShell resolves these references at launch. Replacing a reference with a
// stripped marker would produce a credential-free but unusable restored config.
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  return false;
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

export function isConfigObject(value: unknown): value is ConfigObject {
  return isObjectRecord(value);
}

export function isConfigValue(value: unknown): value is ConfigValue {
  if (value === null || value === undefined) return true;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return true;
  }
  if (Array.isArray(value)) return value.every((entry) => isConfigValue(entry));
  if (!isConfigObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((entry) => isConfigValue(entry));
}

function scrubConfigValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (isSafeCredentialPlaceholder(value)) return value;
    let hasUrlCredentials = false;
    try {
      const url = new URL(value);
      hasUrlCredentials = url.username !== "" || url.password !== "";
    } catch {
      // Non-URL configuration strings continue through the normal secret patterns.
    }
    return hasUrlCredentials || valueLooksLikeSecret(value) ? CREDENTIAL_PLACEHOLDER : value;
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

  if (typeof previous === "string") {
    const previousFlag = cliFlagName(previous);
    if (previousFlag && isCredentialField(previousFlag)) return CREDENTIAL_PLACEHOLDER;
  }

  return valueLooksLikeSecret(value) ? CREDENTIAL_PLACEHOLDER : value;
}

export function stripCredentials(obj: null): null;
export function stripCredentials(obj: undefined): undefined;
export function stripCredentials(obj: boolean): boolean;
export function stripCredentials(obj: number): number;
export function stripCredentials(obj: string): string;
export function stripCredentials<T extends ConfigValue[]>(obj: T): T;
export function stripCredentials<T extends ConfigObject>(obj: T): T;
export function stripCredentials(obj: ConfigValue): ConfigValue;
export function stripCredentials(obj: unknown): unknown;
export function stripCredentials(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((value, index) => scrubArrayElement(value, obj[index - 1]));
  }
  if (!isObjectRecord(obj)) return obj;

  const result: Record<string, unknown> = {};
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

export const URL_TOKEN_PATTERN_SOURCE = String.raw`[a-z][a-z0-9+.-]*:\/\/(?:[^/?#\s'"]+['"][^/?#@\s]*@)?[^\s'"]+`;
const DIAGNOSTIC_URL_PATTERN = new RegExp(URL_TOKEN_PATTERN_SOURCE, "giu");
const DIAGNOSTIC_ASSIGNMENT_PATTERN =
  /\b([A-Za-z][A-Za-z0-9._-]{0,127})([ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+)/gu;

function redactDiagnosticAssignments(value: string): string {
  return value.replace(DIAGNOSTIC_ASSIGNMENT_PATTERN, (match, key: string, separator: string) =>
    isCredentialField(key) ? `${key}${separator}<REDACTED>` : match,
  );
}

function redactDiagnosticUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // A malformed URL-like token is untrusted diagnostic data. Replacing the
    // complete token fails closed when its authority or query cannot be parsed.
    return "<REDACTED>";
  }
  url.username = "";
  url.password = "";
  for (const [key, queryValue] of url.searchParams) {
    if (isCredentialField(key) || valueLooksLikeSecret(queryValue)) {
      url.searchParams.set(key, "<REDACTED>");
    }
  }
  const redactedHash = redactDiagnosticAssignments(url.hash);
  if (redactedHash !== url.hash || valueLooksLikeSecret(url.hash)) url.hash = "";
  return url.toString();
}

/** Fully redact credential-shaped assignments, bearer values, and URL credentials. */
export function redactCredentialText(value: string): string {
  let result = value.replace(DIAGNOSTIC_URL_PATTERN, redactDiagnosticUrl);
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "<REDACTED>");
  }
  return redactDiagnosticAssignments(result).replace(/\b(Bearer)\s+\S+/giu, "$1 <REDACTED>");
}

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
      if (isSafeCredentialPlaceholder(value) || !key) return line;
      if (!isCredentialField(key) && !valueLooksLikeSecret(value)) return line;
      return `${line.slice(0, eq)}=${CREDENTIAL_PLACEHOLDER}`;
    })
    .join("\n");
}

export function isSensitiveFile(filename: string): boolean {
  return CREDENTIAL_SENSITIVE_BASENAMES.has(filename.toLowerCase());
}

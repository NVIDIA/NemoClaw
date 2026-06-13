// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared credential-stripping logic for config files.
//
// Used by:
//   - sandbox-state.ts (rebuild backup/restore)
//   - migration-state.ts (host→sandbox onboarding migration)
//
// Credentials must never be baked into sandbox filesystems or local backups.
// They are injected at runtime via OpenShell's provider credential mechanism.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { SECRET_PATTERNS } from "./secret-patterns";

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

function readRegularFileNoFollow(filePath: string): string | null {
  let fd: number;
  try {
    if (typeof constants.O_NOFOLLOW !== "number") {
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
    }
    const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    fd = openSync(filePath, constants.O_RDONLY | noFollowFlag);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    return String(readFileSync(fd, "utf-8"));
  } finally {
    closeSync(fd);
  }
}

function writeFileAtomically(filePath: string, contents: string): void {
  const tmpPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  writeFileSync(tmpPath, contents, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

/**
 * JSON-like configuration value supported by credential stripping.
 */
export type ConfigValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | ConfigValue[]
  | ConfigObject;

/**
 * JSON-like configuration object supported by credential stripping.
 */
export type ConfigObject = { [key: string]: ConfigValue };

const CREDENTIAL_PLACEHOLDER = "[STRIPPED_BY_MIGRATION]";

/**
 * File basenames that contain sensitive auth material and should be
 * excluded from backups entirely.
 */
export const CREDENTIAL_SENSITIVE_BASENAMES = new Set(["auth-profiles.json", "auth.json"]);

/**
 * Dependency lockfiles may contain package metadata that resembles credentials
 * (for example package names or tarball URLs with `sk-` substrings). They do
 * not store NemoClaw runtime credentials and should not fail snapshot leak
 * checks.
 */
const SNAPSHOT_CREDENTIAL_SCAN_EXCLUDED_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-lock.yml",
]);

/**
 * Credential field names that MUST be stripped from config files.
 */
const CREDENTIAL_FIELDS = new Set([
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
  "resolvedKey",
]);

/**
 * Pattern-based detection for credential field names not covered by the
 * explicit set above. Matches common suffixes like accessToken, privateKey,
 * clientSecret, etc. `bot`/`app` cover the OpenClaw channel token fields
 * (`botToken`, `appToken`) used by Slack/Telegram accounts.
 */
const CREDENTIAL_FIELD_PATTERN =
  /(?:access|refresh|client|bearer|auth|api|private|public|signing|session|bot|app)(?:Token|Key|Secret|Password)$/;

/**
 * Environment-variable-style secret names (SCREAMING_SNAKE_CASE) such as an MCP
 * server's `env: { GITHUB_TOKEN, BRAVE_API_KEY, TOKEN }` block. These are not
 * camelCase, so the suffix pattern above misses them. Matches an all-uppercase
 * name that is, or ends in, a secret word (`TOKEN`, `KEY`, `SECRET`,
 * `PASSWORD`, `PASSPHRASE`, `CREDENTIAL`, optionally pluralized) — covering both
 * the prefixed (`GITHUB_TOKEN`) and bare (`TOKEN`) forms — while leaving benign
 * env vars like `NODE_ENV`, `LOG_LEVEL`, or `PATH` untouched.
 */
const ENV_SECRET_FIELD_PATTERN =
  /^(?:[A-Z0-9]+_)*(?:TOKEN|KEY|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL)S?$/;

/**
 * Well-known HTTP auth header names (matched case-insensitively) whose entire
 * value is a credential but that do not end in a secret word. Remote MCP
 * servers in openclaw.json may carry these (issue #5027).
 */
const CREDENTIAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

/**
 * Hyphen-delimited header-style names ending in a secret word, e.g.
 * `X-API-Key`, `X-API-Token`, `X-Auth-Token`, `Private-Token`. The required
 * hyphen before the secret word keeps camelCase settings such as `maxTokens`
 * (no hyphen) from matching, so only header-shaped names are scrubbed.
 */
const HEADER_CREDENTIAL_PATTERN = /-(?:key|token|secret|password|passphrase|credential|auth)s?$/i;

/**
 * Public keys are verification material, not secrets, so they must never be
 * scrubbed even though they end in `Key`/`KEY`. Covers `publicKey`,
 * `PUBLIC_KEY`, `public-key`, and prefixed forms like `X-Public-Key` /
 * `GITHUB_PUBLIC_KEY`. Checked before the secret patterns below.
 */
const PUBLIC_KEY_FIELD_PATTERN = /(?:^|[-_])public[-_]?keys?$/i;

/**
 * Check whether a field name should be treated as credential-bearing.
 */
export function isCredentialField(key: string): boolean {
  if (PUBLIC_KEY_FIELD_PATTERN.test(key)) return false;
  return (
    CREDENTIAL_FIELDS.has(key) ||
    CREDENTIAL_FIELD_PATTERN.test(key) ||
    ENV_SECRET_FIELD_PATTERN.test(key) ||
    HEADER_CREDENTIAL_PATTERN.test(key) ||
    CREDENTIAL_HEADER_NAMES.has(key.toLowerCase())
  );
}

/**
 * Value-level backstop: whether a string value matches a known secret format
 * (provider key prefixes like `sk-`/`ghp_`/`xoxb-`, `Bearer <token>`, etc.).
 * This scrubs raw secrets that sit under an unrecognized key name — e.g. a
 * custom MCP auth header — without over-stripping benign settings, since these
 * patterns only match credential-shaped values. Resolve placeholders are
 * checked by the caller and never reach here.
 */
export function valueLooksLikeSecret(value: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    // SECRET_PATTERNS carry the global flag, so reset before each stateful test.
    pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  return false;
}

/**
 * Value patterns that are references to a credential, not the credential
 * itself. NemoClaw never stores raw secrets in agent config files; provider
 * keys and channel tokens are written as OpenShell `resolve:env:<NAME>`
 * placeholders (the `<NAME>` is an environment variable name, not secret
 * material) and resolved at gateway launch from OpenShell provider storage.
 * Slack's Bolt SDK rejects a bare placeholder, so its tokens use the
 * `xoxb`/`xapp` prefixed variants. `unused` is the sentinel OpenClaw writes for
 * a provider whose auth is proxy-injected. Preserving these lets a sanitized
 * backup restore into a working config (issue #5027) instead of replacing the
 * reference with a dead `[STRIPPED_BY_MIGRATION]` marker.
 */
const SAFE_CREDENTIAL_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^openshell:resolve:env:[A-Za-z0-9_]+$/,
  // Auth headers carry the resolve reference after a `Bearer ` scheme prefix.
  /^Bearer\s+openshell:resolve:env:[A-Za-z0-9_]+$/i,
  /^xoxb-OPENSHELL-RESOLVE-ENV-[A-Za-z0-9_]+$/,
  /^xapp-OPENSHELL-RESOLVE-ENV-[A-Za-z0-9_]+$/,
];

const SAFE_CREDENTIAL_PLACEHOLDER_LITERALS: ReadonlySet<string> = new Set([
  "unused",
  CREDENTIAL_PLACEHOLDER,
]);

/**
 * Whether a value under a credential-named field is a non-secret reference
 * that must be preserved rather than scrubbed.
 */
export function isSafeCredentialPlaceholder(value: ConfigValue): boolean {
  if (typeof value !== "string") return false;
  // Accept an optional `Bearer ` auth scheme in front of a safe literal, e.g.
  // `Authorization: "Bearer unused"` for proxy-injected credentials.
  const withoutScheme = value.replace(/^Bearer\s+/i, "");
  if (
    SAFE_CREDENTIAL_PLACEHOLDER_LITERALS.has(value) ||
    SAFE_CREDENTIAL_PLACEHOLDER_LITERALS.has(withoutScheme)
  ) {
    return true;
  }
  return SAFE_CREDENTIAL_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Narrow an unknown value to a JSON-like configuration object.
 */
export function isConfigObject(value: ConfigValue | object): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrow an unknown value to a JSON-like configuration value.
 */
export function isConfigValue(value: ConfigValue | object): value is ConfigValue {
  if (value === null || value === undefined) return true;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isConfigValue(entry));
  }
  if (!isConfigObject(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  return Object.values(value).every((entry) => isConfigValue(entry));
}

/**
 * Recursively strip credential fields from a JSON-like object.
 * Returns a new object with sensitive values replaced by a placeholder.
 */
export function stripCredentials(obj: null): null;
export function stripCredentials(obj: undefined): undefined;
export function stripCredentials(obj: boolean): boolean;
export function stripCredentials(obj: number): number;
export function stripCredentials(obj: string): string;
export function stripCredentials<T extends ConfigValue[]>(obj: T): T;
export function stripCredentials<T extends ConfigObject>(obj: T): T;
export function stripCredentials(obj: ConfigValue): ConfigValue;
export function stripCredentials(obj: ConfigValue): ConfigValue {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    // Arrays (e.g. an MCP server's `args`) can carry secrets both by shape and
    // by CLI-flag context: `["--api-key", "<opaque>"]` or `"--api-key=<opaque>"`.
    return obj.map((value, index) => scrubArrayElement(value, obj[index - 1]));
  }
  if (!isConfigObject(obj)) return obj;

  const result: ConfigObject = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isCredentialField(key)) {
      // Preserve non-secret references (OpenShell resolve placeholders, the
      // `unused` sentinel); scrub anything else that looks like a raw secret.
      result[key] = isSafeCredentialPlaceholder(value) ? value : CREDENTIAL_PLACEHOLDER;
    } else {
      result[key] = scrubConfigValue(value);
    }
  }
  return result;
}

/**
 * Scrub a value found under a non-credential key (or in an array): a raw secret
 * detected by shape is replaced with the placeholder; resolve references are
 * preserved; everything else recurses through stripCredentials.
 */
function scrubConfigValue(value: ConfigValue): ConfigValue {
  if (typeof value === "string") {
    if (isSafeCredentialPlaceholder(value)) return value;
    return valueLooksLikeSecret(value) ? CREDENTIAL_PLACEHOLDER : value;
  }
  return stripCredentials(value);
}

/** Bare flag name from a CLI token: `--api-key` → `api-key`, else null. */
function cliFlagName(token: string): string | null {
  const match = /^--?([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(token);
  return match ? match[1] : null;
}

/**
 * Scrub one array element, adding CLI-flag context to the shape backstop: a
 * value passed inline as `--api-key=<secret>` or positionally right after a
 * credential flag (`["--api-key", "<secret>"]`) is scrubbed even when the
 * secret itself is opaque (no recognizable prefix). MCP servers commonly pass
 * credentials this way.
 */
function scrubArrayElement(value: ConfigValue, previous: ConfigValue): ConfigValue {
  if (typeof value !== "string") return stripCredentials(value);
  if (isSafeCredentialPlaceholder(value)) return value;

  // Inline `--flag=value` form.
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

  // Positional value immediately after a credential flag. Skip when this token
  // is itself a flag (starts with `-`) so a value-less flag does not swallow
  // the next flag.
  if (!value.startsWith("-") && typeof previous === "string") {
    const prevFlag = cliFlagName(previous);
    if (prevFlag && isCredentialField(prevFlag)) return CREDENTIAL_PLACEHOLDER;
  }

  return valueLooksLikeSecret(value) ? CREDENTIAL_PLACEHOLDER : value;
}

/**
 * Strip credential fields from a JSON config file in-place.
 * Removes the "gateway" section (contains auth tokens — regenerated at startup).
 */
export function sanitizeConfigFile(configPath: string): void {
  const rawConfig = readRegularFileNoFollow(configPath);
  if (rawConfig === null) return;
  let parsed: ConfigValue;
  try {
    parsed = parseJson<ConfigValue>(rawConfig);
  } catch {
    return; // Not valid JSON — skip (may be YAML for Hermes)
  }
  if (!isConfigObject(parsed)) return;

  const { gateway: _gateway, ...config } = parsed;
  const sanitized = stripCredentials(config);
  writeFileAtomically(configPath, JSON.stringify(sanitized, null, 2));
}

/**
 * Check if a filename should be excluded from backups entirely.
 */
export function isSensitiveFile(filename: string): boolean {
  return CREDENTIAL_SENSITIVE_BASENAMES.has(filename.toLowerCase());
}

/**
 * Return whether a snapshot file should be scanned for credential-looking
 * payloads by coarse-grained E2E leak checks.
 */
export function shouldScanSnapshotFileForCredentials(filename: string): boolean {
  const normalizedBasename = basename(filename).toLowerCase();
  if (SNAPSHOT_CREDENTIAL_SCAN_EXCLUDED_BASENAMES.has(normalizedBasename)) return false;
  return (
    normalizedBasename === ".env" ||
    normalizedBasename.endsWith(".env") ||
    normalizedBasename.endsWith(".json")
  );
}

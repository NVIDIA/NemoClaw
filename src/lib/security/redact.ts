// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StdioOptions } from "node:child_process";

/**
 * Unified secret redaction — single module for all consumers.
 *
 * Consolidates the redaction logic previously duplicated across runner.ts,
 * debug.ts, and onboard-session.ts into one place. Adding a new token
 * pattern means updating secret-patterns.ts only.
 *
 * Two modes:
 * - `redact()` — partial (keep first 4 chars). Used by runner.ts for CLI output.
 * - `redactFull()` — full replacement. Used by debug.ts for diagnostic dumps.
 * - `redactSensitiveText()` — full replacement + truncation. Used by onboard-session.ts.
 *
 * Ref: https://github.com/NVIDIA/NemoClaw/issues/2381
 */

import { listMessagingCredentialMetadata } from "../messaging/channels";
import { isCredentialField } from "./credential-filter";
import { redactUrlTokenFull, redactUrlTokenPartial, URL_TOKEN_PATTERN } from "./redact-url";
import {
  CONTEXT_PATTERNS,
  SECRET_BLOCK_PATTERNS,
  SECRET_PATTERNS,
  STRUCTURED_TOKEN_PATTERNS,
  TOKEN_PREFIX_PATTERNS,
} from "./secret-patterns";

const SENSITIVE_ENV_ASSIGNMENT_KEYS = [
  "NVIDIA_INFERENCE_API_KEY",
  "NVIDIA_API_KEY",
  "NEMOCLAW_PROVIDER_KEY",
  "NOUS_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "COMPATIBLE_API_KEY",
  "COMPATIBLE_ANTHROPIC_API_KEY",
  "BRAVE_API_KEY",
  "TAVILY_API_KEY",
  ...listMessagingCredentialMetadata().map((credential) => credential.providerEnvKey),
];

const SENSITIVE_ENV_ASSIGNMENT_PATTERN = new RegExp(
  `(${SENSITIVE_ENV_ASSIGNMENT_KEYS.map(escapeRegExp).join("|")})=\\S+`,
  "gi",
);

// ── Partial redaction (runner.ts style) ─────────────────────────

function redactMatch(match: string): string {
  return match.slice(0, 4) + "*".repeat(Math.min(match.length - 4, 20));
}

export function redact(str: string): string {
  if (typeof str !== "string") return str;
  let out = str.replace(URL_TOKEN_PATTERN, (value) =>
    redactUrlTokenPartial(value, isSensitiveKey, redactStandaloneSecrets),
  );
  for (const pat of SECRET_PATTERNS) {
    pat.lastIndex = 0;
    out = out.replace(pat, redactMatch);
  }
  return out;
}

export function redactError(err: unknown): unknown {
  if (!err || typeof err !== "object") return err;
  const e = err as Record<string, unknown>;
  const originalMessage = typeof e.message === "string" ? e.message : null;
  if (typeof e.message === "string") e.message = redact(e.message);
  if (typeof e.cmd === "string") e.cmd = redact(e.cmd);
  if (typeof e.stdout === "string") e.stdout = redact(e.stdout);
  if (typeof e.stderr === "string") e.stderr = redact(e.stderr);
  if (Array.isArray(e.output)) {
    e.output = e.output.map((v: unknown) => (typeof v === "string" ? redact(v) : v));
  }
  if (originalMessage && typeof e.stack === "string") {
    e.stack = e.stack.replaceAll(originalMessage, e.message as string);
  }
  return err;
}

export function writeRedactedResult(
  result: { stdout?: Buffer | string | null; stderr?: Buffer | string | null } | null,
  stdio: StdioOptions | undefined,
): void {
  if (!result || stdio === "inherit" || !Array.isArray(stdio)) return;
  if (stdio[1] === "pipe" && result.stdout) {
    process.stdout.write(redact(result.stdout.toString()));
  }
  if (stdio[2] === "pipe" && result.stderr) {
    process.stderr.write(redact(result.stderr.toString()));
  }
}

// ── Full redaction (debug.ts style) ─────────────────────────────

const FULL_REDACT_PATTERNS: [RegExp, string][] = [
  ...SECRET_BLOCK_PATTERNS.map((p): [RegExp, string] => [
    new RegExp(p.source, p.flags),
    "<REDACTED>",
  ]),
  [
    /("(?:authorization|proxy-authorization|cookie|set-cookie)"\s*:\s*")((?:(?:basic|bearer|digest)\s+)?)(?:\\.|[^"\\])*"/gi,
    '$1$2<REDACTED>"',
  ],
  [
    /('(?:authorization|proxy-authorization|cookie|set-cookie)'\s*:\s*')((?:(?:basic|bearer|digest)\s+)?)(?:\\.|[^'\\])*'/gi,
    "$1$2<REDACTED>'",
  ],
  [
    /("(?:authorization|proxy-authorization|cookie|set-cookie)"[ \t]*[:=])(?![ \t]*"(?:\\.|[^"\\])*")[^\r\n]*/gi,
    "$1 <REDACTED>",
  ],
  [
    /('(?:authorization|proxy-authorization|cookie|set-cookie)'[ \t]*[:=])(?![ \t]*'(?:\\.|[^'\\])*')[^\r\n]*/gi,
    "$1 <REDACTED>",
  ],
  [
    /(\b(?:authorization|proxy-authorization|cookie|set-cookie)[ \t]*[:=])[^\r\n]*\r(?!\n)[^\r\n]*/gi,
    "$1 <REDACTED>",
  ],
  [
    /(\b(?:authorization|proxy-authorization|cookie|set-cookie)[ \t]*[:=])[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)+/gi,
    "$1 <REDACTED>",
  ],
  [
    /(\b(?:authorization|proxy-authorization)[ \t]*[:=][ \t]*(?:basic|bearer)[ \t]+)\S+/gi,
    "$1<REDACTED>",
  ],
  [
    /(\b(?:authorization|proxy-authorization)[ \t]*[:=][ \t]*digest[ \t]+)[^\r\n]*/gi,
    "$1<REDACTED>",
  ],
  [
    /(\b(?:authorization|proxy-authorization)[ \t]*[:=])(?![ \t]*(?:basic|bearer|digest)(?:[ \t]|$))[ \t]*[^\r\n]*/gi,
    "$1 <REDACTED>",
  ],
  [/(\b(?:cookie|set-cookie)[ \t]*[:=][ \t]*)[^\r\n]*/gi, "$1<REDACTED>"],
  [
    /((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_(?:key|token|secret|credential|password|passwd|pass)|(?:x[-_])?api[-_]key|token|secret|credential|password|passwd|pass)["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]+((?:"|')?)/gi,
    "$1<REDACTED>$2",
  ],
  [
    /((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}(?:Token|Secret|Credential)|[A-Za-z0-9]{0,128}(?:[Aa]ccess|[Rr]efresh|[Cc]lient|[Bb]earer|[Aa]uth|[Aa][Pp][Ii]|[Pp]rivate|[Ss]igning|[Ss]ession|[Bb]ot|[Aa]pp|[Rr]esolved)Key|[A-Za-z0-9]{1,128}(?:Password|Passwd|Pass))["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]+((?:"|')?)/g,
    "$1<REDACTED>$2",
  ],
  [
    /((?:^|[^A-Za-z0-9])KEY["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]+((?:"|')?)/g,
    "$1<REDACTED>$2",
  ],
  ...TOKEN_PREFIX_PATTERNS.map((p): [RegExp, string] => [
    new RegExp(p.source, p.flags),
    "<REDACTED>",
  ]),
  ...STRUCTURED_TOKEN_PATTERNS.map((p): [RegExp, string] => [
    new RegExp(p.source, p.flags),
    "<REDACTED>",
  ]),
  [/(Bearer )\S+/gi, "$1<REDACTED>"],
  [/\/bot[^/\s]+\//g, "/bot<REDACTED>/"],
];

export function redactFull(text: string): string {
  let result = text;
  for (const [pattern, replacement] of FULL_REDACT_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

function redactStandaloneSecrets(text: string, replacement: string): string {
  let result = text;
  for (const pattern of [
    ...TOKEN_PREFIX_PATTERNS,
    ...STRUCTURED_TOKEN_PATTERNS,
    ...SECRET_BLOCK_PATTERNS,
  ]) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result.replace(/\/bot[^/\s]+\//g, `/bot${replacement}/`);
}

/** Redact self-identifying tokens and secret blocks without rewriting surrounding structure. */
export function redactStandaloneSecretsFull(text: string): string {
  return redactStandaloneSecrets(text, "<REDACTED>");
}

// ── Sensitive text redaction (onboard-session.ts style) ─────────

export function redactSensitiveText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let result = value
    .replace(SENSITIVE_ENV_ASSIGNMENT_PATTERN, "$1=<REDACTED>")
    .replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>");
  for (const pattern of [
    ...SECRET_BLOCK_PATTERNS,
    ...CONTEXT_PATTERNS,
    ...TOKEN_PREFIX_PATTERNS,
    ...STRUCTURED_TOKEN_PATTERNS,
  ]) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "<REDACTED>");
  }
  return result.slice(0, 240);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return redactUrlTokenFull(value, isSensitiveKey, redactStandaloneSecrets, redactSensitiveText);
}

const SENSITIVE_KEY_WORDS: ReadonlySet<string> = new Set([
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "password",
  "secret",
  "token",
]);

function isSensitiveKey(key: string): boolean {
  if (isCredentialField(key)) return true;
  const words = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return (
    words.some((word) => SENSITIVE_KEY_WORDS.has(word)) ||
    (words.includes("api") && words.includes("key"))
  );
}

function credentialFlagKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const flag = /^--?([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(value.trim());
  return flag && isSensitiveKey(flag[1]) ? flag[1] : null;
}

const CREDENTIAL_CONTEXT_LABEL_PATTERN =
  /^(?:tokens?|secrets?|passwords?|passphrases?|credentials?|auth|authorization|bearer|cookies?|set[ _-]*cookie|proxy[ _-]*(?:auth|authorization)|(?:api|access|refresh|client|bearer|auth|private|signing|session|bot|app|resolved)[ _-]*(?:tokens?|keys?|secrets?|passwords?))$/i;

function credentialContextKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const flag = credentialFlagKey(value);
  if (flag) return flag;
  const candidate = value.trim().replace(/[:=]$/, "").trim();
  return candidate &&
    (isCredentialField(candidate) || CREDENTIAL_CONTEXT_LABEL_PATTERN.test(candidate))
    ? candidate
    : null;
}

/** Redact opaque values whose credential context is carried by the previous argument. */
export function redactLogSequence(values: readonly unknown[]): unknown[] {
  return values.map((value, index) =>
    index > 0 && credentialContextKey(values[index - 1]) !== null ? "<REDACTED>" : value,
  );
}

function redactInlineCredentialFlag(value: string): string {
  const match = /^(--?)([A-Za-z0-9][A-Za-z0-9._-]*)=(.*)$/s.exec(value);
  if (!match || !isSensitiveKey(match[2])) return redactFull(value);
  return `${match[1]}${match[2]}=<REDACTED>`;
}

export function redactForLog(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactInlineCredentialFlag(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      index > 0 && credentialFlagKey(value[index - 1]) !== null
        ? "<REDACTED>"
        : redactForLog(entry, seen),
    );
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = isSensitiveKey(key) ? "<REDACTED>" : redactForLog(entry, seen);
  }
  return redacted;
}

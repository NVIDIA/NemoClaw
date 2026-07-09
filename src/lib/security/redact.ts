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
import {
  CONTEXT_PATTERNS,
  SECRET_BLOCK_PATTERNS,
  SECRET_PATTERNS,
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

// Proxy variables and diagnostics are not limited to lowercase HTTP(S) URLs.
// Match any RFC-style URI scheme so credentials in uppercase or SOCKS proxy
// URLs receive the same URL-parser-backed redaction.
const URL_TOKEN_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi;
const URL_TRAILING_DELIMITERS = ")]}>.,;:!?";
const MAX_URL_PARSE_ATTEMPTS = 9;

// ── Partial redaction (runner.ts style) ─────────────────────────

function redactMatch(match: string): string {
  return match.slice(0, 4) + "*".repeat(Math.min(match.length - 4, 20));
}

function isUnmatchedClosingDelimiter(value: string, closing: string): boolean {
  const openingByClosing: Record<string, string> = {
    ")": "(",
    "]": "[",
    "}": "{",
    ">": "<",
  };
  const opening = openingByClosing[closing];
  if (!opening) return false;
  let balance = 0;
  for (const character of value) {
    if (character === opening) balance += 1;
    else if (character === closing) balance -= 1;
  }
  return balance < 0;
}

function isProseUrlSuffix(value: string, trailing: string): boolean {
  return ".,;".includes(trailing) || isUnmatchedClosingDelimiter(value, trailing);
}

function parseUrlToken(value: string): { url: URL; suffix: string } | null {
  let candidate = value;
  let suffix = "";
  for (let attempt = 0; candidate && attempt < MAX_URL_PARSE_ATTEMPTS; attempt += 1) {
    const trailing = candidate.at(-1);
    // Capture the complete token first so punctuation that is valid in
    // userinfo cannot terminate redaction. Only then peel terminal prose
    // punctuation and unmatched wrapper closers before URL parsing.
    if (trailing && isProseUrlSuffix(candidate, trailing)) {
      candidate = candidate.slice(0, -1);
      suffix = `${trailing}${suffix}`;
      continue;
    }
    try {
      return { url: new URL(candidate), suffix };
    } catch {
      if (!trailing || !URL_TRAILING_DELIMITERS.includes(trailing)) return null;
      candidate = candidate.slice(0, -1);
      suffix = `${trailing}${suffix}`;
    }
  }
  return null;
}

function redactMalformedUrlUserinfo(value: string, replacement: string | null): string {
  const schemeEnd = value.indexOf("://") + 3;
  if (schemeEnd < 3) return value;
  const relativeAuthorityEnd = value.slice(schemeEnd).search(/[/?#]/);
  const authorityEnd = relativeAuthorityEnd < 0 ? value.length : schemeEnd + relativeAuthorityEnd;
  const authority = value.slice(schemeEnd, authorityEnd);
  const userinfoEnd = authority.lastIndexOf("@");
  if (userinfoEnd < 1) return value;
  const userinfo = authority.slice(0, userinfoEnd);
  const redactedUserinfo =
    replacement === null ? "" : `${userinfo.includes(":") ? `${replacement}:` : ""}${replacement}@`;
  return `${value.slice(0, schemeEnd)}${redactedUserinfo}${authority.slice(userinfoEnd + 1)}${value.slice(authorityEnd)}`;
}

function redactUrlPartial(value: string): string {
  if (typeof value !== "string" || value.length === 0) return value;
  const parsed = parseUrlToken(value);
  if (!parsed) return redactMalformedUrlUserinfo(value, "****");
  if (parsed.url.username) parsed.url.username = "****";
  if (parsed.url.password) parsed.url.password = "****";
  for (const key of [...parsed.url.searchParams.keys()]) {
    if (/(^|[-_])(?:signature|sig|token|auth|access_token)$/i.test(key)) {
      parsed.url.searchParams.set(key, "****");
    }
  }
  return `${parsed.url.toString()}${parsed.suffix}`;
}

export function redact(str: string): string {
  if (typeof str !== "string") return str;
  let out = str.replace(URL_TOKEN_PATTERN, redactUrlPartial);
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

/** Redact self-identifying tokens and secret blocks without rewriting surrounding structure. */
export function redactStandaloneSecretsFull(text: string): string {
  let result = text;
  for (const pattern of [...TOKEN_PREFIX_PATTERNS, ...SECRET_BLOCK_PATTERNS]) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "<REDACTED>");
  }
  return result.replace(/\/bot[^/\s]+\//g, "/bot<REDACTED>/");
}

// ── Sensitive text redaction (onboard-session.ts style) ─────────

export function redactSensitiveText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let result = value
    .replace(SENSITIVE_ENV_ASSIGNMENT_PATTERN, "$1=<REDACTED>")
    .replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>");
  for (const pattern of [...SECRET_BLOCK_PATTERNS, ...CONTEXT_PATTERNS, ...TOKEN_PREFIX_PATTERNS]) {
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
  const parsed = parseUrlToken(value);
  if (!parsed) return redactSensitiveText(redactMalformedUrlUserinfo(value, null));
  if (parsed.url.username || parsed.url.password) {
    parsed.url.username = "";
    parsed.url.password = "";
  }
  for (const key of [...parsed.url.searchParams.keys()]) {
    if (/(^|[-_])(?:signature|sig|token|auth|access_token)$/i.test(key)) {
      parsed.url.searchParams.set(key, "<REDACTED>");
    }
  }
  parsed.url.hash = "";
  return `${parsed.url.toString()}${parsed.suffix}`;
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

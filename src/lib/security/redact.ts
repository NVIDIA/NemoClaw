// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
import { SECRET_PATTERNS, TOKEN_PREFIX_PATTERNS } from "./secret-patterns";

const SENSITIVE_ENV_ASSIGNMENT_KEYS = [
  "NVIDIA_INFERENCE_API_KEY",
  "NVIDIA_API_KEY",
  "NOUS_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "COMPATIBLE_API_KEY",
  "COMPATIBLE_ANTHROPIC_API_KEY",
  "BRAVE_API_KEY",
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

function redactUrlPartial(value: string): string {
  if (typeof value !== "string" || value.length === 0) return value;
  try {
    const url = new URL(value);
    if (url.username) url.username = "****";
    if (url.password) url.password = "****";
    for (const key of [...url.searchParams.keys()]) {
      if (/(^|[-_])(?:signature|sig|token|auth|access_token)$/i.test(key)) {
        url.searchParams.set(key, "****");
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function redact(str: string): string {
  if (typeof str !== "string") return str;
  let out = str.replace(/https?:\/\/[^\s'"]+/g, redactUrlPartial);
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
  stdio: string | string[],
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
  [
    /(NVIDIA_INFERENCE_API_KEY|NVIDIA_API_KEY|API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|_KEY)=\S+/gi,
    "$1=<REDACTED>",
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

// ── Sensitive text redaction (onboard-session.ts style) ─────────

export function redactSensitiveText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let result = value
    .replace(SENSITIVE_ENV_ASSIGNMENT_PATTERN, "$1=<REDACTED>")
    .replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>");
  for (const pattern of TOKEN_PREFIX_PATTERNS) {
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
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/(^|[-_])(?:signature|sig|token|auth|access_token)$/i.test(key)) {
        url.searchParams.set(key, "<REDACTED>");
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return redactSensitiveText(value);
  }
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[_-]?key|token|secret|password|credential|authorization|bearer)/i.test(key);
}

export function redactForLog(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactFull(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((entry) => redactForLog(entry, seen));

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = isSensitiveKey(key) ? "<REDACTED>" : redactForLog(entry, seen);
  }
  return redacted;
}

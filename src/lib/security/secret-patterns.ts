// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical secret redaction patterns — single source of truth.
 *
 * All TypeScript consumers import through src/lib/security/redact.ts (#2381).
 * debug.sh delegates to the compiled redact module when node is available;
 * its sed fallback only covers the prefixes in EXPECTED_SHELL_PREFIXES.
 *
 * Ref: https://github.com/NVIDIA/NemoClaw/issues/2381
 * Ref: https://github.com/NVIDIA/NemoClaw/issues/1736
 */

/** Token-prefix patterns that match standalone (no context needed). */
export const TOKEN_PREFIX_PATTERNS: RegExp[] = [
  // NVIDIA
  /nvapi-[A-Za-z0-9_-]{10,}/g,
  /nvcf-[A-Za-z0-9_-]{10,}/g,
  // GitHub
  /ghp_[A-Za-z0-9_-]{10,}/g,
  /(?:github_pat_)[A-Za-z0-9_]{30,}/g,
  // OpenAI (sk-proj- before sk- so the more specific prefix matches first)
  /sk-proj-[A-Za-z0-9_-]{10,}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  // Slack (consolidated class covers xoxb-, xoxp-, xoxa-, xoxs-, xapp-)
  /(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}/g,
  // AWS access key IDs (AKIA = long-term, ASIA = temporary/session)
  /A(?:K|S)IA[A-Z0-9]{16}/g,
  // HuggingFace
  /hf_[A-Za-z0-9]{10,}/g,
  // GitLab
  /glpat-[A-Za-z0-9_-]{10,}/g,
  // Groq
  /gsk_[A-Za-z0-9]{10,}/g,
  // PyPI
  /pypi-[A-Za-z0-9_-]{10,}/g,
  // Telegram bot tokens (8-10 digit bot ID + 35-char secret)
  /\bbot\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  // Discord bot tokens (base64 user ID . timestamp . HMAC)
  /\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g,
  // Tavily
  /tvly-[A-Za-z0-9_-]{10,}/g,
  // LangSmith (personal access tokens: lsv2_pt_<hash>; service keys: lsv2_sk_<hash>)
  // Match every underscore-delimited segment so redaction cannot expose a key tail.
  /lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*/g,
];

/** Context-anchored patterns (require a prefix like KEY=, Bearer, etc.). */
export const CONTEXT_PATTERNS: RegExp[] = [
  /(?<=Bearer\s+)[A-Za-z0-9_.+/=-]{10,}/gi,
  /(?<=(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)|(?:X[-_])?API[-_]KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]{10,}/gi,
  /(?<=(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}(?:Token|Secret|Credential)|[A-Za-z0-9]{0,128}(?:[Aa]ccess|[Rr]efresh|[Cc]lient|[Bb]earer|[Aa]uth|[Aa][Pp][Ii]|[Pp]rivate|[Ss]igning|[Ss]ession|[Bb]ot|[Aa]pp|[Rr]esolved)Key|[A-Za-z0-9]{1,128}(?:Password|Passwd|Pass))["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]{10,}/g,
  /(?<=(?:^|[^A-Za-z0-9])KEY["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]{10,}/g,
];

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

/** Multi-line or JSON-escaped secret blocks that do not have a token prefix. */
export const SECRET_BLOCK_PATTERNS: RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
];

/** All secret patterns combined. */
export const SECRET_PATTERNS: RegExp[] = [
  ...TOKEN_PREFIX_PATTERNS,
  ...SECRET_BLOCK_PATTERNS,
  ...CONTEXT_PATTERNS,
];

/**
 * Token prefixes covered by the debug.sh sed fallback.
 * The primary path delegates to node; this fallback only runs when
 * node or dist/ is unavailable. Consistency test verifies these appear.
 */
export const EXPECTED_SHELL_PREFIXES = ["nvapi-", "nvcf-", "ghp_", "sk-", "tvly-"];

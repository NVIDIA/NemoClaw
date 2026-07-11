// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CONTEXT_PATTERNS } from "./secret-patterns";

type SensitiveKeyDetector = (key: string) => boolean;
type StandaloneSecretRedactor = (text: string, replacement: string) => string;
type MalformedUrlRedactor = (text: string) => string | null;

// Proxy variables and diagnostics are not limited to lowercase HTTP(S) URLs.
// Match any RFC-style URI scheme so credentials in uppercase or SOCKS proxy
// URLs receive the same URL-parser-backed redaction.
export const URL_TOKEN_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi;

const URL_TRAILING_DELIMITERS = ")]}>.,;:!?";
const MAX_URL_PARSE_ATTEMPTS = 9;

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

function parseUrlTokenForRedaction(value: string): { url: URL; suffix: string } | null {
  const parsed = parseUrlToken(value);
  if (parsed) return parsed;

  // Avoid repeating URL construction for arbitrarily long malformed wrapper
  // suffixes. Strip the remaining delimiter run in one linear pass, then make
  // one final parse attempt so encoded query secrets still reach redaction.
  let suffixStart = value.length;
  while (suffixStart > 0 && URL_TRAILING_DELIMITERS.includes(value.charAt(suffixStart - 1))) {
    suffixStart -= 1;
  }
  if (suffixStart === value.length) return null;
  try {
    return { url: new URL(value.slice(0, suffixStart)), suffix: value.slice(suffixStart) };
  } catch {
    return null;
  }
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

function isSensitiveUrlQueryKey(key: string, isSensitiveKey: SensitiveKeyDetector): boolean {
  return isSensitiveKey(key) || /(^|[-_])(?:signature|sig|token|auth|access_token)$/i.test(key);
}

function redactUrlQueryValue(
  text: string,
  replacement: string,
  redactStandaloneSecrets: StandaloneSecretRedactor,
): string {
  let result = redactStandaloneSecrets(text, replacement);
  for (const pattern of CONTEXT_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

function redactUrlSearchParams(
  url: URL,
  replacement: string,
  isSensitiveKey: SensitiveKeyDetector,
  redactStandaloneSecrets: StandaloneSecretRedactor,
): void {
  const redactedSearchParams = new URLSearchParams();
  for (const [key, queryValue] of url.searchParams) {
    // Query names are not a security boundary. Preserve benign values, but
    // redact any decoded value that carries a recognizable secret shape.
    redactedSearchParams.append(
      key,
      isSensitiveUrlQueryKey(key, isSensitiveKey)
        ? replacement
        : redactUrlQueryValue(queryValue, replacement, redactStandaloneSecrets),
    );
  }
  url.search = redactedSearchParams.toString();
}

export function redactUrlTokenPartial(
  value: string,
  isSensitiveKey: SensitiveKeyDetector,
  redactStandaloneSecrets: StandaloneSecretRedactor,
): string {
  if (value.length === 0) return value;
  const parsed = parseUrlTokenForRedaction(value);
  if (!parsed) return redactMalformedUrlUserinfo(value, "****");
  if (parsed.url.username) parsed.url.username = "****";
  if (parsed.url.password) parsed.url.password = "****";
  redactUrlSearchParams(parsed.url, "****", isSensitiveKey, redactStandaloneSecrets);
  return `${parsed.url.toString()}${parsed.suffix}`;
}

export function redactUrlTokenFull(
  value: string,
  isSensitiveKey: SensitiveKeyDetector,
  redactStandaloneSecrets: StandaloneSecretRedactor,
  redactMalformedUrl: MalformedUrlRedactor,
): string | null {
  const parsed = parseUrlTokenForRedaction(value);
  if (!parsed) return redactMalformedUrl(redactMalformedUrlUserinfo(value, null));
  if (parsed.url.username || parsed.url.password) {
    parsed.url.username = "";
    parsed.url.password = "";
  }
  redactUrlSearchParams(parsed.url, "<REDACTED>", isSensitiveKey, redactStandaloneSecrets);
  parsed.url.hash = "";
  return `${parsed.url.toString()}${parsed.suffix}`;
}

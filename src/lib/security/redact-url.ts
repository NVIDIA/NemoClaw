// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CONTEXT_PATTERNS } from "./secret-patterns";

type SensitiveKeyDetector = (key: string) => boolean;
type StandaloneSecretRedactor = (text: string, replacement: string) => string;
type MalformedUrlRedactor = (text: string) => string | null;

// Redaction intentionally accepts every RFC-style URI scheme. Proxy and
// custom-scheme URLs can carry credentials too; an allowlist here would create
// a bypass rather than enforce a network boundary.
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

  // After the bounded detailed parse, strip an arbitrarily long delimiter run
  // in one linear pass and make one final parse attempt. This path stays
  // deliberately silent: logging malformed input from a redactor could leak
  // the very credential it is trying to contain.
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

function redactSearchParams(
  searchParams: URLSearchParams,
  replacement: string,
  isSensitiveKey: SensitiveKeyDetector,
  redactStandaloneSecrets: StandaloneSecretRedactor,
): string {
  const redactedSearchParams = new URLSearchParams();
  for (const [key, queryValue] of searchParams) {
    // Query names are not a security boundary. Redact token-shaped names and
    // values after URLSearchParams has decoded their percent escapes.
    redactedSearchParams.append(
      redactUrlQueryValue(key, replacement, redactStandaloneSecrets),
      isSensitiveUrlQueryKey(key, isSensitiveKey)
        ? replacement
        : redactUrlQueryValue(queryValue, replacement, redactStandaloneSecrets),
    );
  }
  return redactedSearchParams.toString();
}

function redactUrlSearchParams(
  url: URL,
  replacement: string,
  isSensitiveKey: SensitiveKeyDetector,
  redactStandaloneSecrets: StandaloneSecretRedactor,
): void {
  url.search = redactSearchParams(
    url.searchParams,
    replacement,
    isSensitiveKey,
    redactStandaloneSecrets,
  );
}

function redactUrlFragment(
  fragment: string,
  replacement: string,
  isSensitiveKey: SensitiveKeyDetector,
  redactStandaloneSecrets: StandaloneSecretRedactor,
): string {
  const prefix = fragment.startsWith("#") ? "#" : "";
  const value = prefix ? fragment.slice(1) : fragment;
  if (!value) return fragment;
  if (value.includes("=")) {
    return `${prefix}${redactSearchParams(
      new URLSearchParams(value),
      replacement,
      isSensitiveKey,
      redactStandaloneSecrets,
    )}`;
  }
  // A synthetic form value decodes valid percent triplets while preserving
  // malformed escapes, so one bad escape cannot hide an encoded token.
  const decodedValue = new URLSearchParams(`value=${value}`).get("value") ?? value;
  if (decodedValue.includes("=")) {
    return `${prefix}${redactSearchParams(
      new URLSearchParams(decodedValue),
      replacement,
      isSensitiveKey,
      redactStandaloneSecrets,
    )}`;
  }
  const redactedValue = redactUrlQueryValue(decodedValue, replacement, redactStandaloneSecrets);
  return redactedValue === decodedValue ? fragment : `${prefix}${redactedValue}`;
}

function redactMalformedUrlQuery(
  value: string,
  replacement: string,
  stripFragment: boolean,
  isSensitiveKey: SensitiveKeyDetector,
  redactStandaloneSecrets: StandaloneSecretRedactor,
): string {
  const fragmentStart = value.indexOf("#");
  const bodyEnd = fragmentStart < 0 ? value.length : fragmentStart;
  const body = value.slice(0, bodyEnd);
  const suffix =
    stripFragment || fragmentStart < 0
      ? ""
      : redactUrlFragment(
          value.slice(fragmentStart),
          replacement,
          isSensitiveKey,
          redactStandaloneSecrets,
        );
  const queryStart = body.indexOf("?");
  if (queryStart < 0) return `${body}${suffix}`;
  const redactedQuery = redactSearchParams(
    new URLSearchParams(body.slice(queryStart + 1)),
    replacement,
    isSensitiveKey,
    redactStandaloneSecrets,
  );
  return `${body.slice(0, queryStart + 1)}${redactedQuery}${suffix}`;
}

export function redactUrlTokenPartial(
  value: string,
  isSensitiveKey: SensitiveKeyDetector,
  redactStandaloneSecrets: StandaloneSecretRedactor,
): string {
  if (value.length === 0) return value;
  const parsed = parseUrlTokenForRedaction(value);
  if (!parsed) {
    return redactMalformedUrlQuery(
      redactMalformedUrlUserinfo(value, "****"),
      "****",
      false,
      isSensitiveKey,
      redactStandaloneSecrets,
    );
  }
  if (parsed.url.username) parsed.url.username = "****";
  if (parsed.url.password) parsed.url.password = "****";
  redactUrlSearchParams(parsed.url, "****", isSensitiveKey, redactStandaloneSecrets);
  parsed.url.hash = redactUrlFragment(
    parsed.url.hash,
    "****",
    isSensitiveKey,
    redactStandaloneSecrets,
  );
  return `${parsed.url.toString()}${parsed.suffix}`;
}

export function redactUrlTokenFull(
  value: string,
  isSensitiveKey: SensitiveKeyDetector,
  redactStandaloneSecrets: StandaloneSecretRedactor,
  redactMalformedUrl: MalformedUrlRedactor,
): string | null {
  const parsed = parseUrlTokenForRedaction(value);
  if (!parsed) {
    const redactedValue = redactMalformedUrlQuery(
      redactMalformedUrlUserinfo(value, null),
      "<REDACTED>",
      true,
      isSensitiveKey,
      redactStandaloneSecrets,
    );
    const queryStart = redactedValue.indexOf("?");
    if (queryStart < 0) return redactMalformedUrl(redactedValue);
    const redactedPrefix = redactMalformedUrl(redactedValue.slice(0, queryStart));
    return redactedPrefix === null ? null : `${redactedPrefix}${redactedValue.slice(queryStart)}`;
  }
  if (parsed.url.username || parsed.url.password) {
    parsed.url.username = "";
    parsed.url.password = "";
  }
  redactUrlSearchParams(parsed.url, "<REDACTED>", isSensitiveKey, redactStandaloneSecrets);
  // Endpoint fragments are never sent to the server and can contain OAuth
  // credentials, so persistence intentionally drops them instead of logging.
  parsed.url.hash = "";
  return `${parsed.url.toString()}${parsed.suffix}`;
}

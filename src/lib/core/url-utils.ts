// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure string utilities for URL normalization, text compaction, and
 * formatting helpers used across the CLI.
 */

export function compactText(value = ""): string {
  return String(value).replace(/\s+/g, " ").trim();
}

export function stripEndpointSuffix(pathname = "", suffixes: string[] = []): string {
  for (const suffix of suffixes) {
    if (pathname === suffix) return "";
    if (pathname.endsWith(suffix)) {
      return pathname.slice(0, -suffix.length);
    }
  }
  return pathname;
}

export type EndpointFlavor = "anthropic" | "openai";

const MAX_CANONICAL_ENDPOINT_LENGTH = 2048;

export function normalizeProviderBaseUrl(
  value: string | URL | null | undefined,
  flavor: EndpointFlavor,
): string {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    const suffixes =
      flavor === "anthropic"
        ? ["/v1/messages", "/v1/models", "/v1", "/messages", "/models"]
        : ["/responses", "/chat/completions", "/completions", "/models"];
    let pathname = stripEndpointSuffix(url.pathname.replace(/\/+$/, ""), suffixes);
    pathname = pathname.replace(/\/+$/, "");
    url.pathname = pathname || "/";
    return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

/** True when an endpoint input carries userinfo, query, or fragment components. */
export function endpointUrlHasUserinfoQueryOrFragment(value: string | null | undefined): boolean {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    // A scheme-less input such as user:pass@host/v1 parses with scheme
    // "user:" and empty userinfo; classify it from the raw string instead.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return /[?#@]/.test(raw);
    }
    // Parsed fields catch every userinfo form the WHATWG parser accepts,
    // including special-scheme URLs without canonical `//`. Test the raw
    // authority as well so an empty userinfo delimiter (empty url.username)
    // remains visible before parsing normalizes it away.
    return (
      Boolean(url.username || url.password) ||
      /^https?:[\\/]*[^/?#\\]*@/i.test(raw) ||
      /[?#]/.test(raw)
    );
  } catch {
    return /[?#@]/.test(raw);
  }
}

// Endpoint URL inputs feed provider registration, registry writes, Dockerfile
// ARGs, and container startup commands, so intake accepts only characters that
// stay inert across every downstream consumer. The set matches the
// startup-command token allowlist in onboard/docker-startup-command-env.ts
// plus "~"; the two sets stay separate because command tokens and endpoint
// URLs are distinct contracts.
const ENDPOINT_URL_ALLOWED_CHARACTERS = /^[A-Za-z0-9_./:=,@%+\-[\]~]+$/u;
const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\p{Cf}]/u;

function trimEndpointUrlAsciiSpaces(value: string): string {
  return value.replace(/^ +/u, "").replace(/ +$/u, "");
}

export type EndpointUrlViolation = {
  kind:
    | "userinfo-query-fragment"
    | "control-characters"
    | "encoded-control-characters"
    | "unsupported-characters"
    | "invalid-url"
    | "unsupported-protocol";
  reason: string;
};

/**
 * Classify an endpoint URL input that onboarding must reject before any
 * network request, provider registration, registry write, or sandbox and
 * image mutation (#9301). Returns null for an empty input (emptiness is a
 * separate required-input error) and for a safe absolute HTTP(S) URL. The
 * reason completes the sentence "Endpoint URL ..." and never echoes the
 * input value.
 */
export function unsafeEndpointUrlViolation(
  value: string | null | undefined,
): EndpointUrlViolation | null {
  const input = String(value || "");
  const raw = trimEndpointUrlAsciiSpaces(input);
  if (!raw) return null;
  // Inspect the original input before surrounding ASCII spaces are
  // normalized. The WHATWG parser and downstream consumers can discard
  // boundary controls, but intake promises to reject them before mutation.
  if (CONTROL_OR_FORMAT_CHARACTER.test(input)) {
    return { kind: "control-characters", reason: "must not contain control characters." };
  }
  if (endpointUrlHasUserinfoQueryOrFragment(raw)) {
    return {
      kind: "userinfo-query-fragment",
      reason: "must not contain userinfo, query, or fragment components.",
    };
  }
  // Decode once and reclassify so a percent-encoded control or format
  // character (ASCII %0A as well as UTF-8 forms such as %C2%80 and %E2%80%8B)
  // cannot pass while its literal form is rejected. Downstream consumers
  // decode at most once, so a double-encoded sequence stays inert text.
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding carries no decoded controls; the remaining
    // checks classify the raw input.
  }
  if (CONTROL_OR_FORMAT_CHARACTER.test(decoded)) {
    return {
      kind: "encoded-control-characters",
      reason: "must not contain percent-encoded control characters.",
    };
  }
  if (!ENDPOINT_URL_ALLOWED_CHARACTERS.test(raw)) {
    return {
      kind: "unsupported-characters",
      reason: "must contain only URL-safe ASCII characters.",
    };
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { kind: "unsupported-protocol", reason: "must use HTTP or HTTPS." };
    }
  } catch {
    return { kind: "invalid-url", reason: "must be a valid HTTP or HTTPS URL." };
  }
  return null;
}

/** Return the bounded canonical form of a credential-free HTTP(S) provider endpoint. */
export function canonicalEndpoint(
  value: string | null | undefined,
  flavor: EndpointFlavor,
): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > MAX_CANONICAL_ENDPOINT_LENGTH) return null;
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return normalizeProviderBaseUrl(parsed, flavor);
  } catch {
    return null;
  }
}

export function isLoopbackHostname(hostname = ""): boolean {
  const normalized = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function formatEnvAssignment(name: string, value: string): string {
  return `${name}=${value}`;
}

export function parsePolicyPresetEnv(value: string): string[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

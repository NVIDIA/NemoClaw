// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure string utilities for URL normalization, text compaction, and
 * formatting helpers used across the CLI.
 */

import { MAX_CANONICAL_ENDPOINT_LENGTH } from "./endpoint-contract.ts";
export {
  endpointUrlHasUserinfoQueryOrFragment,
  MAX_CANONICAL_ENDPOINT_LENGTH,
  unsafeEndpointUrlViolation,
} from "./endpoint-contract.ts";
export type { EndpointUrlViolation } from "./endpoint-contract.ts";

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

/**
 * Classify a socket peer address as loopback. Dual-stack listeners report IPv4
 * peers as IPv4-mapped IPv6 (`::ffff:127.0.0.1`), so strip that prefix first.
 */
export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
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

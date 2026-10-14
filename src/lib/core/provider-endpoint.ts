// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MAX_CANONICAL_ENDPOINT_LENGTH } from "./endpoint-url-safety.ts";

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

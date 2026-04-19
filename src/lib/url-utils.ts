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

export function normalizeProviderBaseUrl(value: unknown, flavor: EndpointFlavor): string {
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

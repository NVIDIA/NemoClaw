// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure string utilities for URL normalization, text compaction, and
 * formatting helpers used across the CLI.
 */

export function compactText(value = ""): string {
  return String(value).replace(/\s+/g, " ").trim();
}

export {
  isLoopbackHostname,
  stripEndpointSuffix,
  normalizeProviderBaseUrl,
  canonicalEndpoint,
  type EndpointFlavor,
} from "./endpoint-url-safety.ts";

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

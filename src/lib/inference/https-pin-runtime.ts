// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTPS DNS-pinning runtime adapter: classification and hidden adapter
 * constants for arbitrary DNS-backed HTTPS custom inference endpoints
 * (`compatible-endpoint` / `compatible-anthropic-endpoint`).
 *
 * A DNS-backed HTTPS custom endpoint cannot be registered with OpenShell
 * directly: OpenShell's gateway re-resolves the hostname when it makes its
 * own outbound connection, which can race the SSRF preflight's resolution
 * (TOCTOU/DNS rebinding) and exposes the real hostname to that runtime
 * boundary. This module classifies which endpoints need the adapter; the
 * adapter itself (`https-pin-runtime-adapter.ts`) terminates the pinned
 * outbound HTTPS connection on the host, immediately after the addresses it
 * connects to were validated, and registers only its own loopback-adjacent
 * `host.openshell.internal` route with OpenShell.
 */

import crypto from "node:crypto";
import { isIP } from "node:net";

import { HTTPS_PIN_RUNTIME_ADAPTER_PORT } from "../core/ports";
import { isOpenShellManagedHost } from "./endpoint-ssrf-preflight";

/** Route-scoped bearer token OpenShell uses to reach this adapter. Never the real upstream credential. */
export const HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV =
  "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_TOKEN";
/** Host-only control-plane secret used to manage the shared adapter process. Never registered with OpenShell. */
export const HTTPS_PIN_RUNTIME_ADAPTER_CONTROL_TOKEN_ENV =
  "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_CONTROL_TOKEN";
export const HTTPS_PIN_RUNTIME_ADAPTER_BIND_HOST = "0.0.0.0";
export const HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_HOST = "127.0.0.1";
export const HTTPS_PIN_RUNTIME_ADAPTER_SANDBOX_HOST = "host.openshell.internal";
export const HTTPS_PIN_RUNTIME_ADAPTER_BASE_ORIGIN = `http://${HTTPS_PIN_RUNTIME_ADAPTER_SANDBOX_HOST}:${HTTPS_PIN_RUNTIME_ADAPTER_PORT}`;
export const HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_ORIGIN = `http://${HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_HOST}:${HTTPS_PIN_RUNTIME_ADAPTER_PORT}`;

export type HttpsPinCredentialProviderType = "openai" | "anthropic";

export interface HttpsPinCredentialHeader {
  name: string;
  value: string;
}

/** Upstream credential header for the real endpoint, matching each provider type's existing convention. */
export function resolveHttpsPinCredentialHeader(
  providerType: HttpsPinCredentialProviderType,
  credentialValue: string,
): HttpsPinCredentialHeader {
  if (providerType === "anthropic") {
    return { name: "x-api-key", value: credentialValue };
  }
  return { name: "authorization", value: `Bearer ${credentialValue}` };
}

function parseUrl(value: string | URL | null | undefined): URL | null {
  const raw = value instanceof URL ? value.href : String(value || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * True when `endpointUrl` is exactly the shape that the DNS-pinning adapter
 * exists for: HTTPS, a DNS-backed hostname (not an IP literal), and not one
 * of NemoClaw's own trusted OpenShell-managed aliases. HTTP endpoints are
 * already handled by direct IP substitution; HTTPS IP-literal endpoints
 * already connect to an address the caller can see up front; OpenShell
 * aliases are already exempt loopback-equivalent routes.
 */
export function isHttpsPinRuntimeEligible(endpointUrl: string | URL | null | undefined): boolean {
  const url = parseUrl(endpointUrl);
  if (!url || url.protocol !== "https:") return false;
  const hostname = url.hostname;
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare)) return false;
  if (isOpenShellManagedHost(hostname)) return false;
  return true;
}

/** Deterministic, stable identifier for one (gateway, provider, endpoint) route. Safe to persist and log. */
export function computeHttpsPinRouteId(
  gatewayName: string,
  provider: string,
  endpointUrl: string,
): string {
  return crypto
    .createHash("sha256")
    .update(`nemoclaw:https-pin-route-id:v1\0${gatewayName}\0${provider}\0${endpointUrl}`)
    .digest("hex");
}

/** Opaque sandbox-facing base URL for one route; never includes source URL material. */
export function buildHttpsPinRouteBaseUrl(routeId: string): string {
  return `${HTTPS_PIN_RUNTIME_ADAPTER_BASE_ORIGIN}/route/${routeId}`;
}

/** Host-side (loopback) equivalent of {@link buildHttpsPinRouteBaseUrl}, for health checks and the control plane. */
export function buildHttpsPinRouteLoopbackBaseUrl(routeId: string): string {
  return `${HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_ORIGIN}/route/${routeId}`;
}

/**
 * Parse only the opaque adapter route shape persisted by NemoClaw.
 *
 * The port is intentionally not compared with the current process setting:
 * cleanup must still recognize routes persisted before an explicit adapter
 * port change.
 */
export function parseHttpsPinRouteId(baseUrl: string | null | undefined): string | null {
  const url = parseUrl(baseUrl);
  if (
    !url ||
    url.protocol !== "http:" ||
    url.hostname !== HTTPS_PIN_RUNTIME_ADAPTER_SANDBOX_HOST ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    return null;
  }
  return url.pathname.match(/^\/route\/([0-9a-f]{64})$/u)?.[1] ?? null;
}

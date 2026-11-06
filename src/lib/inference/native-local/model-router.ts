// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadBlueprintProfile, type BlueprintInferenceProfile } from "../../core/model-router-port";
import {
  nativeLocalCredentialReference as agentCredentialReference,
  qualifiedNativeLocalEndpointUrl,
  NATIVE_LOCAL_CREDENTIAL_ENV,
} from "./agent-config";
import { unsafeEndpointUrlViolation } from "../../core/endpoint-url-safety";

/** Recognize the existing provider even when its endpoint needs repair. */
export function isModelRouterProvider(provider: string | null | undefined): boolean {
  return (
    provider === "nvidia-router" ||
    Boolean(provider && provider === loadBlueprintProfile("routed")?.provider_name)
  );
}

/** The existing routed blueprint owns the provider name, host port, and API path. */
export function nativeModelRouterEndpoint(
  provider: string | null | undefined,
  endpointUrl?: string | null,
  profile: BlueprintInferenceProfile | null = loadBlueprintProfile("routed"),
): string | null {
  if (
    !profile ||
    profile.router?.enabled !== true ||
    (provider !== "nvidia-router" && provider !== profile.provider_name) ||
    typeof provider !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(provider)
  )
    return null;
  const port = profile.router.port || 4000;
  const selected = endpointUrl ?? profile.endpoint;
  if (
    typeof selected !== "string" ||
    !selected ||
    typeof profile.endpoint !== "string" ||
    !profile.endpoint ||
    unsafeEndpointUrlViolation(selected)
  )
    return null;
  try {
    const endpoint = new URL(selected);
    const configured = new URL(profile.endpoint);
    const localHosts = ["localhost", "127.0.0.1", "[::1]", "host.openshell.internal"];
    if (
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      endpoint.protocol !== "http:" ||
      configured.protocol !== "http:" ||
      !localHosts.includes(endpoint.hostname) ||
      !localHosts.includes(configured.hostname) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      configured.username ||
      configured.password ||
      configured.search ||
      configured.hash ||
      Number(endpoint.port) !== port ||
      Number(configured.port) !== port ||
      endpoint.pathname.replace(/\/$/, "") !== configured.pathname.replace(/\/$/, "") ||
      !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\/?$/.test(endpoint.pathname)
    )
      return null;
    return `http://host.openshell.internal:${port}${endpoint.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/** Host configuration keeps Router credentials bound to the selected blueprint. */
export function nativeLocalCredentialReference(
  provider: string | null | undefined,
  endpointUrl: string,
  agentName?: string | null,
): string | null {
  if (
    nativeModelRouterEndpoint(provider, endpointUrl) &&
    qualifiedNativeLocalEndpointUrl(endpointUrl)
  )
    return `openshell:resolve:env:${NATIVE_LOCAL_CREDENTIAL_ENV}`;
  return agentCredentialReference(provider, endpointUrl, agentName);
}

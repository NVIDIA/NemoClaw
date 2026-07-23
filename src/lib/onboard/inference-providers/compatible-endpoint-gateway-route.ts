// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunOpenshell, UpsertProvider, UpsertProviderResult } from "./types";

// Keep this list aligned with the host.openshell.internal endpoints in
// nemoclaw-blueprint/policies/presets/local-inference.yaml. These are policy
// ports, not environment-overridable local provider ports.
export const BUNDLED_LOCAL_INFERENCE_GATEWAY_PORTS = [11434, 11435, 8000] as const;

const BUNDLED_LOCAL_INFERENCE_GATEWAY_PORT_SET = new Set<number>(
  BUNDLED_LOCAL_INFERENCE_GATEWAY_PORTS,
);

// #5744: keep host-side validation on the user-entered loopback URL, but
// register the sandbox route through OpenShell's host bridge. Remove this when
// OpenShell can verify provider routes from the sandbox/gateway network context.
export function gatewayReachableCompatibleEndpointUrl(
  provider: string,
  endpointUrl: string | null | undefined,
): string | null | undefined {
  if (provider !== "compatible-endpoint" || !endpointUrl) return endpointUrl;
  const hasExactLoopbackAuthority =
    /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]+(?:[/?#]|$)/i.test(endpointUrl);
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return endpointUrl;
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = parsed.port ? Number(parsed.port) : null;
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    hostname.includes("%") ||
    !hasExactLoopbackAuthority ||
    !isLoopback ||
    port === null ||
    !Number.isInteger(port) ||
    !BUNDLED_LOCAL_INFERENCE_GATEWAY_PORT_SET.has(port)
  ) {
    return endpointUrl;
  }
  parsed.hostname = "host.openshell.internal";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname || "/";
  const routeSuffix = `${parsed.search}${parsed.hash}`;
  return parsed.pathname === "/"
    ? `${parsed.origin}${routeSuffix}`
    : `${parsed.origin}${parsed.pathname}${routeSuffix}`;
}

export function reuseRegisteredProviderWithGatewayEndpoint(args: {
  provider: string;
  providerType: string;
  credentialEnv: string | null | undefined;
  endpointUrl: string | null | undefined;
  gatewayEndpointUrl: string | null | undefined;
  runOpenshell: RunOpenshell;
  upsertProvider: UpsertProvider;
}): UpsertProviderResult {
  const {
    provider,
    providerType,
    credentialEnv,
    endpointUrl,
    gatewayEndpointUrl,
    runOpenshell,
    upsertProvider,
  } = args;
  // The caller has already authorized the recovered provider's non-secret
  // credential/config identity through assessRecoveredProviderCredentialReuse.
  const existing = runOpenshell(["provider", "get", provider], {
    ignoreError: true,
    suppressOutput: true,
  });
  if (existing.status !== 0) {
    return {
      ok: false,
      status: existing.status || 1,
      message: `Recovered provider '${provider}' is no longer registered in OpenShell.`,
    };
  }
  if (gatewayEndpointUrl === endpointUrl) return { ok: true };
  return upsertProvider(provider, providerType, credentialEnv, gatewayEndpointUrl, {});
}

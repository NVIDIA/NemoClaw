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

export const COMPATIBLE_ENDPOINT_AUTH_MODE_ENV = "NEMOCLAW_COMPATIBLE_AUTH_MODE";
export const COMPATIBLE_ENDPOINT_NO_AUTH_MODE = "none";

export function compatibleEndpointAllowsMissingApiKey(endpointUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    !parsed.username &&
    !parsed.password &&
    (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1")
  );
}

export async function selectCompatibleEndpointAuthMode(options: {
  endpointUrl: string;
  nonInteractive: boolean;
  credentialAvailable: boolean;
  configuredMode?: string | null;
  prompt: (message: string) => Promise<string>;
  log: (message?: string) => void;
}): Promise<"api-key" | "none"> {
  const configuredMode = String(options.configuredMode || "")
    .trim()
    .toLowerCase();
  if (options.nonInteractive) {
    if (configuredMode && configuredMode !== "api-key" && configuredMode !== "none") {
      throw new Error(`${COMPATIBLE_ENDPOINT_AUTH_MODE_ENV} must be 'api-key' or 'none'.`);
    }
    if (configuredMode === "none") {
      if (!compatibleEndpointAllowsMissingApiKey(options.endpointUrl)) {
        throw new Error(
          `${COMPATIBLE_ENDPOINT_AUTH_MODE_ENV}=none is allowed only for an exact loopback endpoint.`,
        );
      }
      return "none";
    }
    if (!options.credentialAvailable) {
      const noAuthOption = compatibleEndpointAllowsMissingApiKey(options.endpointUrl)
        ? ` or ${COMPATIBLE_ENDPOINT_AUTH_MODE_ENV}=none`
        : "";
      throw new Error(`Set COMPATIBLE_API_KEY${noAuthOption} in non-interactive mode.`);
    }
    return "api-key";
  }
  if (!compatibleEndpointAllowsMissingApiKey(options.endpointUrl)) return "api-key";
  options.log("");
  options.log("  Authentication:");
  options.log("    1) API key");
  options.log("    2) No authentication");
  options.log("");
  const selected = Number.parseInt((await options.prompt("  Choose [1]: ")) || "1", 10);
  return selected === 2 ? "none" : "api-key";
}

export async function selectCompatibleEndpointCredentialEnv(options: {
  endpointUrl: string;
  credentialEnv: string | null;
  credentialAvailable: boolean;
  recordedCredentialEnv?: string | null;
  recoveredFromSandbox: boolean;
  nonInteractive: boolean;
  configuredMode?: string | null;
  prompt: (message: string) => Promise<string>;
  log: (message?: string) => void;
  error: (message: string) => void;
  exitProcess: (code: number) => never;
}): Promise<string | null> {
  try {
    const authMode = await selectCompatibleEndpointAuthMode(options);
    return authMode === COMPATIBLE_ENDPOINT_NO_AUTH_MODE ||
      (options.recoveredFromSandbox && options.recordedCredentialEnv === null)
      ? null
      : options.credentialEnv;
  } catch (error) {
    options.error(`  ${error instanceof Error ? error.message : String(error)}`);
    return options.exitProcess(1);
  }
}

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

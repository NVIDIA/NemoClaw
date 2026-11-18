// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isAllowedOpenShellSandboxBridgeUrl, isPrivateHostname } from "../../private-networks";
import {
  fixedHostedNativeProvider,
  recordedHermesEndpointUrl,
  type HostedProviderDefinition,
} from "./catalog.ts";
export {
  HOSTED_NATIVE_PROVIDERS,
  customNativeCredentialEnv,
  isCustomHostedProvider,
  resolveCustomNativeApi,
  type HostedProviderDefinition,
} from "./catalog.ts";

import { type NativeProviderAttachment } from "./contract.ts";

/** Only the authenticated Hermes provider may bind a returned endpoint. */
export function canonicalHermesNativeEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (
    endpoint.hostname === "inference.local" ||
    endpoint.hostname === "localhost" ||
    endpoint.hostname.endsWith(".internal") ||
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    /[\\\s]/u.test(value) ||
    /%2f|%5c/iu.test(endpoint.pathname)
  ) {
    throw new Error(
      "Hermes inference requires an HTTPS endpoint without credentials, query, fragment, or encoded separators",
    );
  }
  return `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}`;
}

/** Restore an existing Hermes endpoint without admitting other private destinations. */
export function canonicalRecordedHermesEndpoint(value: string): string {
  const endpoint = recordedHermesEndpointUrl(value);
  if (isPrivateHostname(endpoint.hostname) && !isAllowedOpenShellSandboxBridgeUrl(endpoint))
    throw new Error("Recorded Hermes inference endpoint is not an admitted HTTP(S) destination");
  if (isAllowedOpenShellSandboxBridgeUrl(endpoint)) endpoint.hostname = "host.openshell.internal";
  return `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}`;
}

export function hostedNativeProvider(
  provider: string | null | undefined,
  endpointUrl?: string | null,
): HostedProviderDefinition | undefined {
  const definition = fixedHostedNativeProvider(provider);
  if (!definition || definition.logicalProvider !== "hermes-provider" || !endpointUrl)
    return definition;
  const endpoint = canonicalRecordedHermesEndpoint(endpointUrl);
  if (endpoint === definition.endpoint) return definition;
  const suffix = createHash("sha256").update(endpoint).digest("hex").slice(0, 20);
  return {
    ...definition,
    endpoint,
    endpointUrl: endpoint,
    profileId: `nemoclaw-hermes-inference-${suffix}-v1`,
    providerName: `nemoclaw-hermes-${suffix}-v1`,
  };
}

/** Existing Hermes endpoints now use an endpoint-bound provider. */
export function usesNativeHermesEndpoint(
  endpoint: string | null | undefined,
  _authority?: NativeProviderAttachment,
): boolean {
  if (!endpoint) return true;
  canonicalRecordedHermesEndpoint(endpoint);
  return true;
}

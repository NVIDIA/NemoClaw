// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  fixedHostedNativeProvider,
  recordedHermesEndpointUrl,
  customNativeCredentialEnv,
  isCustomHostedProvider,
} from "./catalog.ts";

/** Public configuration only; this grants neither egress nor a provider attachment.
 * Host admission validates destinations before OpenShell receives the real credential.
 */
export function nativeHostedAgentConfig(provider: string | null | undefined, baseUrl: string) {
  if (isCustomHostedProvider(provider) && new URL(baseUrl).hostname !== "inference.local") {
    const endpoint = new URL(baseUrl);
    if (
      !["https:", "http:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("Invalid native custom inference endpoint");
    if (["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) return undefined;
    const credentialEnv = customNativeCredentialEnv(provider!);
    return { credentialEnv, apiKey: `openshell:resolve:env:${credentialEnv}` };
  }
  const definition = fixedHostedNativeProvider(provider);
  if (!definition) return undefined;
  // Existing shared-route selections keep their original configuration until explicitly changed.
  if (new URL(baseUrl).hostname === "inference.local") return undefined;
  const endpoint =
    provider === "hermes-provider" ? recordedHermesEndpointUrl(baseUrl) : new URL(baseUrl);
  const expected = provider === "hermes-provider" ? endpoint : new URL(definition.endpoint);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.origin !== expected.origin ||
    endpoint.pathname.replace(/\/+$/, "") !== expected.pathname.replace(/\/+$/, "")
  ) {
    throw new Error(
      `Native ${definition.label} configuration does not match its attached provider endpoint`,
    );
  }
  return {
    credentialEnv: definition.credentialEnv,
    apiKey: `openshell:resolve:env:${definition.credentialEnv}`,
    ...(provider === "openrouter-api"
      ? {
          headers: {
            "HTTP-Referer": "https://www.nvidia.com/nemoclaw/",
            "X-OpenRouter-Title": "NVIDIA NemoClaw",
          },
        }
      : {}),
  };
}

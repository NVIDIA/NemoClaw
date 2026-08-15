// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertEndpointResolvesPublic as assertSharedEndpointResolvesPublic,
  type EndpointDnsLookupFn,
  type EndpointSsrfPreflightOptions,
  type EndpointSsrfPreflightResult,
  isOpenShellManagedHost,
  parseTrustedPrivateHosts,
} from "../security/trusted-private-endpoint";

export * from "../security/trusted-private-endpoint";
export { parseTrustedPrivateHosts as parseTrustedPrivateInferenceHosts } from "../security/trusted-private-endpoint";

/** Preserve the established local inference routes outside the generic endpoint boundary. */
export async function assertEndpointResolvesPublic(
  endpointUrl: string,
  lookup?: EndpointDnsLookupFn,
  options: EndpointSsrfPreflightOptions = {},
): Promise<EndpointSsrfPreflightResult> {
  try {
    const hostname = new URL(String(endpointUrl)).hostname;
    const { isLoopbackHostname } =
      require("../private-networks") as typeof import("../private-networks");
    if (isLoopbackHostname(hostname) || isOpenShellManagedHost(hostname)) {
      return { ok: true, addresses: [] };
    }
  } catch {
    // The shared validator owns the stable malformed-URL result.
  }
  return assertSharedEndpointResolvesPublic(endpointUrl, lookup, options);
}

/** Read the generic trust source and the legacy inference-only source. */
export function parseTrustedPrivateInferenceHostsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set([
      ...parseTrustedPrivateHosts(env.NEMOCLAW_TRUSTED_PRIVATE_HOSTS),
      ...parseTrustedPrivateHosts(env.NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS),
    ]),
  ];
}

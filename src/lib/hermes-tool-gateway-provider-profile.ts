// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { OpenShellProviderAdapter } from "./adapters/openshell/provider-adapter";
import type { OpenShellGatewayTarget } from "./adapters/openshell/sandbox-observer";
import {
  matchesGatewayCredentialOnlyProviderBinding,
  type GatewayProviderMetadata,
} from "./onboard/gateway-provider-metadata";

export const HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV =
  "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN";
export const HERMES_TOOL_GATEWAY_PROVIDER_PROFILE_TYPE = "nemoclaw-hermes-tool-gateway-v1";
export const LEGACY_HERMES_TOOL_GATEWAY_PROVIDER_TYPE = "generic";

/** Import or verify the NemoClaw-owned profile on the given gateway. */
export function importHermesToolGatewayProfile(
  adapter: Pick<OpenShellProviderAdapter, "importProviderProfile">,
  target: OpenShellGatewayTarget,
  root: string,
) {
  return adapter.importProviderProfile({
    target,
    profilePath: path.join(
      root,
      "agents",
      "hermes",
      "host",
      `${HERMES_TOOL_GATEWAY_PROVIDER_PROFILE_TYPE}.yaml`,
    ),
  });
}

/** Return the provider type that holds the exact credential binding, or null if none does. */
export function matchHermesToolGatewayProviderType(
  observed: GatewayProviderMetadata,
  providerName: string,
):
  | typeof HERMES_TOOL_GATEWAY_PROVIDER_PROFILE_TYPE
  | typeof LEGACY_HERMES_TOOL_GATEWAY_PROVIDER_TYPE
  | null {
  return (
    (
      [HERMES_TOOL_GATEWAY_PROVIDER_PROFILE_TYPE, LEGACY_HERMES_TOOL_GATEWAY_PROVIDER_TYPE] as const
    ).find((type) =>
      matchesGatewayCredentialOnlyProviderBinding(observed, {
        name: providerName,
        type,
        credentialKey: HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV,
      }),
    ) ?? null
  );
}

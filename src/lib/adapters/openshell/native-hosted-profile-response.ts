// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { requireHermesPublicPins } from "../../inference/native-provider/hermes-pins";
import {
  customNativeProvider,
  type CustomNativeBinding,
} from "../../inference/native-provider/custom";
import {
  HOSTED_NATIVE_PROVIDERS,
  type HostedProviderDefinition,
  hostedNativeProvider,
} from "../../inference/native-provider/hosted";
import {
  isManagedNativeProfileResponse,
  type NativeProfileBoundary,
} from "./native-inference-profile-response";

export type HostedNativeProfileId =
  | (typeof HOSTED_NATIVE_PROVIDERS)[number]["profileId"]
  | `nemoclaw-custom-${string}-v1`
  | `nemoclaw-hermes-inference-${string}-v1`;

export function hostedNativeProfile(
  profileId: string,
  endpointUrl?: string,
  custom?: CustomNativeBinding,
): HostedProviderDefinition | undefined {
  if (custom) {
    const bound = customNativeProvider(custom);
    return bound.profileId === profileId && bound.endpoint === endpointUrl ? bound : undefined;
  }
  if (endpointUrl) {
    const bound = hostedNativeProvider("hermes-provider", endpointUrl);
    return bound?.profileId === profileId ? bound : undefined;
  }
  return HOSTED_NATIVE_PROVIDERS.find((definition) => definition.profileId === profileId);
}

export function hostedNativeProfileBoundary(
  profileId: string,
  endpointUrl?: string,
  allowedIps?: readonly string[],
  custom?: CustomNativeBinding,
): NativeProfileBoundary<HostedNativeProfileId> | undefined {
  const definition = hostedNativeProfile(profileId, endpointUrl, custom);
  if (!definition) return undefined;
  const endpoint = new URL(definition.endpoint);
  const base = endpoint.pathname.replace(/\/+$/, "");
  const prefix = definition.api === "anthropic-messages" ? `${custom ? base : ""}/v1` : base;
  let paths = ["chat/completions"];
  if (definition.api === "anthropic-messages") paths = ["messages", "messages/count_tokens"];
  else if (custom && definition.api === "openai-responses") paths = ["responses"];
  else if (definition.logicalProvider === "openai-api") paths.push("responses");
  let pins: readonly string[] | undefined;
  if (custom) pins = definition.allowedIps ?? [];
  else if (definition.endpointUrl) pins = requireHermesPublicPins(allowedIps);
  return {
    profileId: definition.profileId as HostedNativeProfileId,
    ...(pins ? { allowedIps: pins } : {}),
    ...(custom && endpoint.protocol === "https:" ? { tls: "terminate" as const } : {}),
    credentialEnv: definition.credentialEnv,
    authStyle: definition.api === "anthropic-messages" ? "header" : "bearer",
    headerName: definition.api === "anthropic-messages" ? "x-api-key" : "authorization",
    host: endpoint.hostname.replace(/^\[|\]$/gu, ""),
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    rules: [
      { method: "GET", path: `${prefix}/models` },
      ...paths.map((path) => ({ method: "POST" as const, path: `${prefix}/${path}` })),
    ],
  };
}

export function isManagedNativeHostedProfileResponse(
  value: unknown,
  profileId: string,
  endpointUrl?: string,
  allowedIps?: readonly string[],
  custom?: CustomNativeBinding,
) {
  let boundary;
  try {
    boundary = hostedNativeProfileBoundary(profileId, endpointUrl, allowedIps, custom);
  } catch {
    return undefined;
  }
  return boundary && isManagedNativeProfileResponse(value, boundary) ? value : undefined;
}

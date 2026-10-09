// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HOSTED_NATIVE_PROVIDERS,
  hostedNativeProvider,
} from "../../inference/native-provider/hosted";
import {
  isManagedNativeProfileResponse,
  type NativeProfileBoundary,
} from "./native-nvidia-profile-response";

export type HostedNativeProfileId =
  | (typeof HOSTED_NATIVE_PROVIDERS)[number]["profileId"]
  | `nemoclaw-hermes-inference-${string}-v1`;

export function hostedNativeProfile(profileId: string, endpointUrl?: string) {
  if (endpointUrl) {
    const bound = hostedNativeProvider("hermes-provider", endpointUrl);
    return bound?.profileId === profileId ? bound : undefined;
  }
  return HOSTED_NATIVE_PROVIDERS.find((definition) => definition.profileId === profileId);
}

export function hostedNativeProfileBoundary(
  profileId: string,
  endpointUrl?: string,
): NativeProfileBoundary<HostedNativeProfileId> | undefined {
  const definition = hostedNativeProfile(profileId, endpointUrl);
  if (!definition) return undefined;
  const endpoint = new URL(definition.endpoint);
  const prefix =
    definition.api === "anthropic-messages" ? "/v1" : endpoint.pathname.replace(/\/+$/, "");
  let paths = ["chat/completions"];
  if (definition.api === "anthropic-messages") paths = ["messages", "messages/count_tokens"];
  else if (definition.logicalProvider === "openai-api") paths.push("responses");
  return {
    profileId: definition.profileId as HostedNativeProfileId,
    credentialEnv: definition.credentialEnv,
    authStyle: definition.api === "anthropic-messages" ? "header" : "bearer",
    headerName: definition.api === "anthropic-messages" ? "x-api-key" : "authorization",
    host: endpoint.hostname,
    port: Number(endpoint.port || 443),
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
) {
  const boundary = hostedNativeProfileBoundary(profileId, endpointUrl);
  return boundary && isManagedNativeProfileResponse(value, boundary) ? value : undefined;
}

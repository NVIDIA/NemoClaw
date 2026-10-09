// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";
import { isValidName } from "../../name-validation";
import { unsafeEndpointUrlViolation } from "../../core/endpoint-url-safety";
import { isPrivateIp, isLoopbackHostname } from "../../private-networks";
import { isOperatorTrustablePrivateIp } from "../../security/trusted-private-endpoint";
import {
  BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
  classifyCustomAnthropicEndpoint,
} from "../bedrock-runtime";
import {
  buildHttpsPinRouteBaseUrl,
  computeHttpsPinRouteId,
  isHttpsPinRuntimeEligible,
} from "../https-pin-runtime";

export type NativeCustomAdapterTransport =
  | Readonly<{
      kind: "https-pin";
      gatewayName: string;
      sourceEndpointUrl: string;
      sourceAddresses: readonly string[];
      trustedPrivateEndpoint: boolean;
    }>
  | Readonly<{
      kind: "bedrock-runtime";
      gatewayName: string;
      sourceEndpointUrl: string;
      region: string;
    }>;

/** Restore only a restricted bridge produced by the existing adapter owners. */
export function normalizeNativeCustomAdapterTransport(
  value: unknown,
  input: { sandboxName: string; provider: string; api: string; endpointUrl: string },
): NativeCustomAdapterTransport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.gatewayName !== "string" ||
    !isValidName(record.gatewayName) ||
    typeof record.sourceEndpointUrl !== "string" ||
    unsafeEndpointUrlViolation(record.sourceEndpointUrl)
  )
    return undefined;
  try {
    const source = new URL(record.sourceEndpointUrl);
    if (
      source.username ||
      source.password ||
      source.search ||
      source.hash ||
      isLoopbackHostname(source.hostname) ||
      /[*[\]{}\\]/u.test(source.pathname) ||
      /%2f|%5c/iu.test(source.pathname)
    )
      return undefined;
    if (record.kind === "https-pin") {
      if (
        !isHttpsPinRuntimeEligible(source) ||
        typeof record.trustedPrivateEndpoint !== "boolean" ||
        !Array.isArray(record.sourceAddresses) ||
        !record.sourceAddresses.length
      )
        return undefined;
      const addresses: string[] = [];
      for (const address of record.sourceAddresses) {
        if (
          typeof address !== "string" ||
          !isIP(address) ||
          (isPrivateIp(address) &&
            (!record.trustedPrivateEndpoint || !isOperatorTrustablePrivateIp(address)))
        )
          return undefined;
        addresses.push(address);
      }
      const expected = buildHttpsPinRouteBaseUrl(
        computeHttpsPinRouteId(
          record.gatewayName,
          input.provider,
          record.sourceEndpointUrl,
          input.sandboxName,
        ),
      );
      if (input.endpointUrl !== `${expected}/v1`) return undefined;
      return {
        kind: "https-pin",
        gatewayName: record.gatewayName,
        sourceEndpointUrl: record.sourceEndpointUrl,
        sourceAddresses: [...new Set(addresses)].sort(),
        trustedPrivateEndpoint: record.trustedPrivateEndpoint,
      };
    }
    if (record.kind === "bedrock-runtime") {
      const classification = classifyCustomAnthropicEndpoint(record.sourceEndpointUrl);
      if (
        classification.kind !== "bedrock-runtime" ||
        classification.endpointUrl !== record.sourceEndpointUrl ||
        input.provider !== "compatible-anthropic-endpoint" ||
        input.api !== "openai-completions" ||
        input.endpointUrl !== BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL ||
        typeof record.region !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(record.region)
      )
        return undefined;
      return {
        kind: "bedrock-runtime",
        gatewayName: record.gatewayName,
        sourceEndpointUrl: classification.endpointUrl,
        region: record.region,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

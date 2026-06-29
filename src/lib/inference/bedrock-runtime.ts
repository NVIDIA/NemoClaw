// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bedrock Runtime endpoint classification and hidden adapter constants.
 *
 * This file intentionally classifies only raw AWS Bedrock Runtime endpoints.
 * Anthropic-compatible gateways that happen to proxy Bedrock stay on the
 * existing Anthropic Messages path.
 */

import { BEDROCK_RUNTIME_ADAPTER_PORT } from "../core/ports";
import { normalizeProviderBaseUrl } from "../core/url-utils";

export const BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV =
  "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN";
export const BEDROCK_RUNTIME_AWS_BEARER_TOKEN_ENV = "AWS_BEARER_TOKEN_BEDROCK";
export const BEDROCK_RUNTIME_COMPATIBLE_CREDENTIAL_ENV = "COMPATIBLE_ANTHROPIC_API_KEY";
export const BEDROCK_RUNTIME_PROVIDER_NAME = "compatible-anthropic-endpoint";
export const BEDROCK_RUNTIME_ADAPTER_BIND_HOST = "0.0.0.0";
export const BEDROCK_RUNTIME_ADAPTER_LOOPBACK_HOST = "127.0.0.1";
export const BEDROCK_RUNTIME_ADAPTER_SANDBOX_HOST = "host.openshell.internal";
export const BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL = `http://${BEDROCK_RUNTIME_ADAPTER_SANDBOX_HOST}:${BEDROCK_RUNTIME_ADAPTER_PORT}/v1`;
export const BEDROCK_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL = `http://${BEDROCK_RUNTIME_ADAPTER_LOOPBACK_HOST}:${BEDROCK_RUNTIME_ADAPTER_PORT}/v1`;

export type CustomAnthropicEndpointClassification =
  | {
      kind: "bedrock-runtime";
      endpointUrl: string;
      hostname: string;
      region: string;
      fips: boolean;
    }
  | {
      kind: "anthropic-messages";
      endpointUrl: string;
      hostname: string | null;
    };

function parseEndpointUrl(value: string | URL | null | undefined): URL | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function classifyBedrockRuntimeHostname(
  hostname: string,
): { region: string; fips: boolean } | null {
  const normalized = hostname.trim().toLowerCase();
  const match = normalized.match(
    /^bedrock-runtime(-fips)?\.([a-z0-9-]+)\.(?:amazonaws\.com(?:\.cn)?|api\.aws)$/,
  );
  if (!match) return null;
  return { region: match[2], fips: Boolean(match[1]) };
}

export function classifyCustomAnthropicEndpoint(
  value: string | URL | null | undefined,
): CustomAnthropicEndpointClassification {
  const normalized = normalizeProviderBaseUrl(value, "anthropic");
  const parsed = parseEndpointUrl(normalized);
  if (!parsed) {
    return {
      kind: "anthropic-messages",
      endpointUrl: normalized,
      hostname: null,
    };
  }

  const bedrock = classifyBedrockRuntimeHostname(parsed.hostname);
  if (!bedrock) {
    return {
      kind: "anthropic-messages",
      endpointUrl: normalized,
      hostname: parsed.hostname.toLowerCase(),
    };
  }

  return {
    kind: "bedrock-runtime",
    endpointUrl: parsed.origin,
    hostname: parsed.hostname.toLowerCase(),
    region: bedrock.region,
    fips: bedrock.fips,
  };
}

export function isBedrockRuntimeEndpoint(value: string | URL | null | undefined): boolean {
  return classifyCustomAnthropicEndpoint(value).kind === "bedrock-runtime";
}

export function hasBedrockRuntimeAwsAuthEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env[BEDROCK_RUNTIME_AWS_BEARER_TOKEN_ENV] ||
      env.AWS_PROFILE ||
      env.AWS_ACCESS_KEY_ID ||
      env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
  );
}

export function resolveBedrockRuntimeRegion(
  classification: Extract<CustomAnthropicEndpointClassification, { kind: "bedrock-runtime" }>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    String(env.AWS_REGION || "").trim() ||
    String(env.AWS_DEFAULT_REGION || "").trim() ||
    classification.region
  );
}

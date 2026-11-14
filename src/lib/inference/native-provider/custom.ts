// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  MAX_CANONICAL_ENDPOINT_LENGTH,
  unsafeEndpointUrlViolation,
} from "../../core/endpoint-url-safety";
import { normalizeProviderBaseUrl } from "../../core/provider-endpoint";
import type { NativeProviderDefinition } from "./contract";
import { nativeHostedAgentConfig } from "./agent-config";
import {
  isPrivateIp,
  isLoopbackHostname,
  isAllowedOpenShellSandboxBridgeUrl,
} from "../../private-networks";
import {
  isOperatorTrustablePrivateIp,
  isOpenShellManagedHost,
} from "../../security/trusted-private-endpoint";
import {
  isBedrockRuntimeEndpoint,
  BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
} from "../bedrock-runtime";
import { getCompatibleAnthropicOpenAiSurfaceBaseUrl } from "../anthropic/openai-surface";

export type CustomNativeBinding = Readonly<{
  provider: "compatible-endpoint" | "compatible-anthropic-endpoint";
  endpointUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  /** Host credential lookup name, never its value. */
  credentialEnv: string;
  allowedIps: readonly string[];
  /** Existing Bedrock adapter transport; AWS credentials remain in its host process. */
  adapterEndpointUrl?: string;
}>;

/** Native custom routes retain the existing sandbox bridge admission boundary. */
export function isCustomNativeEndpoint(
  provider: string,
  endpointUrl: string | null | undefined,
): boolean {
  if (
    (provider !== "compatible-endpoint" && provider !== "compatible-anthropic-endpoint") ||
    !endpointUrl
  )
    return false;
  const host = new URL(endpointUrl).hostname;
  return (
    (provider === "compatible-anthropic-endpoint" &&
      isAllowedOpenShellSandboxBridgeUrl(new URL(endpointUrl))) ||
    (!isLoopbackHostname(host) && !isOpenShellManagedHost(host))
  );
}

export function isCustomNativeProviderName(name: string): boolean {
  return /^nemoclaw-custom-[a-f0-9]{32}-v1$/u.test(name);
}

/** Validate persisted shape without granting DNS or credential authority. */
export function customNativeProvider(value: unknown): NativeProviderDefinition & {
  endpoint: string;
  api: CustomNativeBinding["api"];
  custom: CustomNativeBinding;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Missing custom native provider binding");
  const binding = value as CustomNativeBinding;
  if (
    (binding.provider !== "compatible-endpoint" &&
      binding.provider !== "compatible-anthropic-endpoint") ||
    !["openai-completions", "openai-responses", "anthropic-messages"].includes(binding.api) ||
    (binding.provider === "compatible-endpoint" && binding.api === "anthropic-messages") ||
    !/^[A-Z_][A-Z0-9_]*$/u.test(binding.credentialEnv ?? "") ||
    typeof binding.endpointUrl !== "string" ||
    binding.endpointUrl.length > MAX_CANONICAL_ENDPOINT_LENGTH ||
    unsafeEndpointUrlViolation(binding.endpointUrl) ||
    /%2f|%5c|%2e/iu.test(binding.endpointUrl)
  )
    throw new Error("Invalid custom native provider binding");
  const endpoint = new URL(binding.endpointUrl);
  if (isOpenShellManagedHost(endpoint.hostname) || isLoopbackHostname(endpoint.hostname))
    throw new Error("Custom hosted native inference requires a hosted endpoint");
  const canonical = normalizeProviderBaseUrl(
    binding.endpointUrl,
    binding.provider === "compatible-anthropic-endpoint" ? "anthropic" : "openai",
  );
  if (canonical !== binding.endpointUrl) throw new Error("Custom native endpoint is not canonical");
  const bedrock =
    binding.provider === "compatible-anthropic-endpoint" && isBedrockRuntimeEndpoint(canonical);
  const adapter = binding.adapterEndpointUrl ? new URL(binding.adapterEndpointUrl) : undefined;
  if (
    bedrock !== Boolean(adapter) ||
    (adapter &&
      (binding.api !== "openai-completions" ||
        binding.adapterEndpointUrl !== BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL))
  )
    throw new Error("Invalid native Bedrock adapter binding");
  if (
    !Array.isArray(binding.allowedIps) ||
    (!bedrock && binding.allowedIps.length === 0) ||
    (bedrock && binding.allowedIps.length !== 0) ||
    binding.allowedIps.some(
      (address) =>
        typeof address !== "string" ||
        !isIP(address) ||
        address.includes("%") ||
        (isPrivateIp(address) && !isOperatorTrustablePrivateIp(address)),
    ) ||
    new Set(binding.allowedIps).size !== binding.allowedIps.length
  )
    throw new Error("Custom native inference requires exact destination addresses");
  const custom: CustomNativeBinding = {
    provider: binding.provider,
    endpointUrl: canonical,
    api: binding.api,
    credentialEnv: binding.credentialEnv,
    allowedIps: [...binding.allowedIps].sort(),
    ...(adapter ? { adapterEndpointUrl: binding.adapterEndpointUrl } : {}),
  };
  const suffix = createHash("sha256").update(JSON.stringify(custom)).digest("hex").slice(0, 32);
  const nativeEndpoint =
    custom.adapterEndpointUrl ??
    (custom.provider === "compatible-anthropic-endpoint" && custom.api !== "anthropic-messages"
      ? getCompatibleAnthropicOpenAiSurfaceBaseUrl(canonical)
      : canonical);
  return {
    logicalProvider: custom.provider,
    label: "custom hosted",
    profileId: `nemoclaw-custom-${suffix}-v1`,
    providerName: `nemoclaw-custom-${suffix}-v1`,
    credentialEnv: nativeHostedAgentConfig(custom.provider, nativeEndpoint)!.credentialEnv,
    endpointUrl: nativeEndpoint,
    endpoint: nativeEndpoint,
    ...(custom.allowedIps.length ? { allowedIps: custom.allowedIps } : {}),
    api: custom.api,
    custom,
  };
}

/** Bind the existing executable and credential boundary to one selected API. */
export function boundCustomNativeProfile(
  definition: NativeProviderDefinition,
  templatePath: string,
): string {
  const expected = customNativeProvider(definition.custom);
  if (
    expected.profileId !== definition.profileId ||
    expected.providerName !== definition.providerName
  )
    throw new Error("Custom native provider identity does not match its binding");
  const anthropic = expected.api === "anthropic-messages";
  const profile = YAML.parse(fs.readFileSync(templatePath, "utf8"));
  const endpoint = new URL(expected.endpoint);
  const prefix = endpoint.pathname.replace(/\/+$/u, "");
  const apiPrefix = anthropic ? `${prefix}/v1` : prefix;
  const requestPath = anthropic
    ? "messages"
    : expected.api === "openai-responses"
      ? "responses"
      : "chat/completions";
  profile.id = expected.profileId;
  profile.display_name = "NemoClaw Custom Hosted Inference";
  profile.description = "Native inference for one validated sandbox endpoint and API";
  profile.credentials[0].env_vars = [expected.credentialEnv];
  profile.endpoints = [
    {
      host: endpoint.hostname.replace(/^\[|\]$/gu, ""),
      port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
      ...(expected.allowedIps ? { allowed_ips: expected.allowedIps } : {}),
      protocol: "rest",
      enforcement: "enforce",
      rules: [
        { allow: { method: "GET", path: `${apiPrefix}/models` } },
        { allow: { method: "POST", path: `${apiPrefix}/${requestPath}` } },
        ...(anthropic
          ? [{ allow: { method: "POST", path: `${apiPrefix}/messages/count_tokens` } }]
          : []),
      ],
    },
  ];
  return YAML.stringify(profile);
}

export async function withCustomNativeProfile<T>(
  definition: NativeProviderDefinition,
  use: (profilePath: string) => Promise<T> | T,
  templatePath: string,
): Promise<T> {
  const source = boundCustomNativeProfile(definition, templatePath);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-profile-"));
  try {
    const profilePath = path.join(directory, `${definition.profileId}.yaml`);
    fs.writeFileSync(profilePath, source, { mode: 0o600 });
    return await use(profilePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

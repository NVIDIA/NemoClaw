// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ensureNativeHostedProvider,
  type NativeHostedProviderAttachment,
} from "./inference/native-hosted";
import { nativeHostedProfile } from "./inference/native-hosted/profiles";
/**
 * Hermes Provider credential orchestration.
 *
 * NemoClaw may collect or mint a Hermes/Nous credential during onboarding, but
 * it does not durably persist that secret on the host. Durable credential
 * ownership stays with OpenShell provider registration.
 */

import type { StdioOptions } from "node:child_process";

import { createCliOpenShellProviderAdapter } from "./adapters/openshell/provider-adapter-cli";
import { HERMES_PROVIDER_NAME } from "./onboard/inference-providers/hermes-provider-identity";
import * as oauth from "./oauth-device-code";

export { HERMES_PROVIDER_NAME };

const onboardProviders = require("./onboard/providers") as {
  providerExistsInGateway: (name: string, runOpenshell: RunOpenshell) => Promise<boolean>;
  upsertProvider: (
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: NodeJS.ProcessEnv,
    runOpenshell: RunOpenshell,
  ) => Promise<{ ok: boolean; status?: number; message?: string }>;
};

type HermesToolGatewayBroker = {
  registerHermesToolGatewayRefreshProvider: (
    sandboxName: string,
    refreshToken: string,
    runOpenshell: RunOpenshell,
  ) => Promise<{ providerName: string; brokerToken: string }>;
  ensureHermesToolGatewayBroker: (options?: { refreshToken?: string }) => boolean;
};

function getHermesToolGatewayBroker(): HermesToolGatewayBroker {
  return require("./hermes-tool-gateway-broker") as HermesToolGatewayBroker;
}

export const HERMES_INFERENCE_CREDENTIAL_ENV = "OPENAI_API_KEY";
export const HERMES_NOUS_API_KEY_CREDENTIAL_ENV = "NOUS_API_KEY";
export const AGENT_KEY_MIN_TTL_SECONDS = 1800;

export type HermesAuthMethod = "oauth" | "api_key";

type RunOpenshellResult = {
  status: number | null;
  output?: string | Buffer | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type RunOpenshell = (
  args: string[],
  opts?: {
    env?: NodeJS.ProcessEnv;
    stdio?: StdioOptions;
    ignoreError?: boolean;
    suppressOutput?: boolean;
    timeout?: number;
  },
) => RunOpenshellResult;

export type HermesProviderCredentialState = {
  auth_method: HermesAuthMethod;
  provider: typeof HERMES_PROVIDER_NAME;
  credential_env: string;
  inference_base_url: string;
  agent_key_expires_at?: string | null;
};

function nonEmptyString(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function agentKeyExpiresAt(minted: oauth.AgentKeyResponse): string | null {
  if (minted.expires_at) return minted.expires_at;
  if (typeof minted.expires_in === "number" && Number.isFinite(minted.expires_in)) {
    return new Date(Date.now() + minted.expires_in * 1000).toISOString();
  }
  return null;
}

export function isHermesProviderRegistered(runOpenshell: RunOpenshell): Promise<boolean> {
  return onboardProviders.providerExistsInGateway(
    nativeHostedProfile(HERMES_PROVIDER_NAME)!.providerName,
    runOpenshell,
  );
}

export type HermesProviderBinding = {
  exists: boolean;
  credentialKeys: string[] | null;
};

export async function inspectHermesProviderBinding(
  runOpenshell: RunOpenshell,
): Promise<HermesProviderBinding> {
  const result = await createCliOpenShellProviderAdapter({ run: runOpenshell }).getProvider({
    target: { kind: "selected" },
    providerName: nativeHostedProfile(HERMES_PROVIDER_NAME)!.providerName,
  });
  if (!result.ok) {
    return result.error.kind === "command" && result.error.reason === "not_found"
      ? { exists: false, credentialKeys: null }
      : { exists: true, credentialKeys: null };
  }
  return {
    exists: true,
    credentialKeys: [...result.value.credentialKeys].sort(),
  };
}

export async function registerHermesInferenceProvider(
  apiKey: string,
  runOpenshell: RunOpenshell,
  credentialEnv = HERMES_INFERENCE_CREDENTIAL_ENV,
  baseUrl = oauth.DEFAULT_INFERENCE_BASE_URL,
  expected?: NativeHostedProviderAttachment,
): Promise<void> {
  const normalizedApiKey = nonEmptyString(apiKey);
  if (!normalizedApiKey) {
    throw new Error("Hermes Provider credential is empty");
  }
  const profile = nativeHostedProfile(HERMES_PROVIDER_NAME)!;
  if (baseUrl.replace(/\/+$/u, "") !== profile.endpoint) {
    throw new Error(
      "Hermes Provider returned a noncanonical inference endpoint; fixed native profiles cannot be repointed.",
    );
  }
  if (
    credentialEnv !== HERMES_INFERENCE_CREDENTIAL_ENV &&
    credentialEnv !== HERMES_NOUS_API_KEY_CREDENTIAL_ENV
  ) {
    throw new Error("Unsupported Hermes Provider credential binding");
  }
  await ensureNativeHostedProvider({
    adapter: createCliOpenShellProviderAdapter({ run: runOpenshell }),
    target: { kind: "selected" },
    profile,
    credentialValue: normalizedApiKey,
    ...(expected ? { expected } : {}),
  });
}

export async function ensureHermesProviderOAuthCredentials(
  _sandboxName: string,
  {
    allowInteractiveLogin = true,
    runOpenshell = null,
    log = console.error,
    fetch = undefined,
    noBrowser = false,
    expected,
    baseUrl = oauth.DEFAULT_INFERENCE_BASE_URL,
    toolGatewayPresets = [],
  }: {
    allowInteractiveLogin?: boolean;
    runOpenshell?: RunOpenshell | null;
    log?: (line: string) => void;
    fetch?: typeof globalThis.fetch;
    noBrowser?: boolean;
    baseUrl?: string;
    expected?: NativeHostedProviderAttachment;
    toolGatewayPresets?: string[];
  } = {},
): Promise<HermesProviderCredentialState | null> {
  if (!runOpenshell) {
    throw new Error("OpenShell runner is required for Hermes Provider credential storage");
  }
  if (!allowInteractiveLogin) {
    return null;
  }

  const tokens = await oauth.runDeviceCodeFlow({ fetch, log, noBrowser });
  const minted = await oauth.mintAgentKeyWithAccessToken(tokens.access_token, {
    fetch,
    minTtlSeconds: AGENT_KEY_MIN_TTL_SECONDS,
  });
  const inferenceBaseUrl = minted.inference_base_url || baseUrl;
  await registerHermesInferenceProvider(
    minted.api_key,
    runOpenshell,
    HERMES_INFERENCE_CREDENTIAL_ENV,
    inferenceBaseUrl,
    expected,
  );
  if (Array.isArray(toolGatewayPresets) && toolGatewayPresets.length > 0) {
    const hermesToolGateway = getHermesToolGatewayBroker();
    await hermesToolGateway.registerHermesToolGatewayRefreshProvider(
      _sandboxName,
      tokens.refresh_token,
      runOpenshell,
    );
    if (!hermesToolGateway.ensureHermesToolGatewayBroker({ refreshToken: tokens.refresh_token })) {
      throw new Error("Hermes managed-tool gateway broker did not become ready");
    }
  }
  return {
    auth_method: "oauth",
    provider: HERMES_PROVIDER_NAME,
    credential_env: HERMES_INFERENCE_CREDENTIAL_ENV,
    inference_base_url: inferenceBaseUrl,
    agent_key_expires_at: agentKeyExpiresAt(minted),
  };
}

export async function ensureHermesProviderApiKeyCredentials(
  _sandboxName: string,
  {
    apiKey = null,
    runOpenshell = null,
    expected,
    baseUrl = oauth.DEFAULT_INFERENCE_BASE_URL,
  }: {
    apiKey?: string | null;
    runOpenshell?: RunOpenshell | null;
    baseUrl?: string;
    expected?: NativeHostedProviderAttachment;
  } = {},
): Promise<HermesProviderCredentialState | null> {
  if (!runOpenshell) {
    throw new Error("OpenShell runner is required for Hermes Provider credential storage");
  }
  const normalizedApiKey = nonEmptyString(apiKey);
  if (!normalizedApiKey) return null;

  await registerHermesInferenceProvider(
    normalizedApiKey,
    runOpenshell,
    HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
    baseUrl,
    expected,
  );
  return {
    auth_method: "api_key",
    provider: HERMES_PROVIDER_NAME,
    credential_env: HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
    inference_base_url: baseUrl,
  };
}

module.exports = {
  HERMES_PROVIDER_NAME,
  HERMES_INFERENCE_CREDENTIAL_ENV,
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
  AGENT_KEY_MIN_TTL_SECONDS,
  isHermesProviderRegistered,
  inspectHermesProviderBinding,
  registerHermesInferenceProvider,
  ensureHermesProviderOAuthCredentials,
  ensureHermesProviderApiKeyCredentials,
};

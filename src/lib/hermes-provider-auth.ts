// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hermes Provider credential orchestration.
 *
 * NemoClaw may collect or mint a Hermes/Nous credential during onboarding, but
 * it does not durably persist that secret on the host. Durable credential
 * ownership stays with OpenShell provider registration.
 */

import type { StdioOptions } from "node:child_process";

import * as oauth from "./oauth-device-code";

const onboardProviders = require("./onboard/providers") as {
  providerExistsInGateway: (name: string, runOpenshell: RunOpenshell) => boolean;
  upsertProvider: (
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: NodeJS.ProcessEnv,
    runOpenshell: RunOpenshell,
  ) => { ok: boolean; status?: number; message?: string };
};

export const HERMES_PROVIDER_NAME = "hermes-provider";
export const HERMES_INFERENCE_CREDENTIAL_ENV = "OPENAI_API_KEY";
export const HERMES_NOUS_API_KEY_CREDENTIAL_ENV = "NOUS_API_KEY";
export const AGENT_KEY_MIN_TTL_SECONDS = 1800;

export type HermesAuthMethod = "oauth" | "api_key";

type RunOpenshellResult = {
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type RunOpenshell = (
  args: string[],
  opts?: {
    env?: NodeJS.ProcessEnv;
    stdio?: StdioOptions;
    ignoreError?: boolean;
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

export function isHermesProviderRegistered(runOpenshell: RunOpenshell): boolean {
  return onboardProviders.providerExistsInGateway(HERMES_PROVIDER_NAME, runOpenshell);
}

export function registerHermesInferenceProvider(
  apiKey: string,
  runOpenshell: RunOpenshell,
  credentialEnv = HERMES_INFERENCE_CREDENTIAL_ENV,
  baseUrl = oauth.DEFAULT_INFERENCE_BASE_URL,
): void {
  const normalizedApiKey = nonEmptyString(apiKey);
  if (!normalizedApiKey) {
    throw new Error("Hermes Provider credential is empty");
  }
  const result = onboardProviders.upsertProvider(
    HERMES_PROVIDER_NAME,
    "openai",
    credentialEnv,
    baseUrl,
    { [credentialEnv]: normalizedApiKey },
    runOpenshell,
  );
  if (!result.ok) {
    throw new Error(result.message || `failed to upsert provider '${HERMES_PROVIDER_NAME}'`);
  }
}

export async function ensureHermesProviderOAuthCredentials(
  _sandboxName: string,
  {
    allowInteractiveLogin = true,
    runOpenshell = null,
    log = console.error,
    fetch = undefined,
    noBrowser = false,
    baseUrl = oauth.DEFAULT_INFERENCE_BASE_URL,
  }: {
    allowInteractiveLogin?: boolean;
    runOpenshell?: RunOpenshell | null;
    log?: (line: string) => void;
    fetch?: typeof globalThis.fetch;
    noBrowser?: boolean;
    baseUrl?: string;
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
  registerHermesInferenceProvider(
    minted.api_key,
    runOpenshell,
    HERMES_INFERENCE_CREDENTIAL_ENV,
    inferenceBaseUrl,
  );
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
    baseUrl = oauth.DEFAULT_INFERENCE_BASE_URL,
  }: {
    apiKey?: string | null;
    runOpenshell?: RunOpenshell | null;
    baseUrl?: string;
  } = {},
): Promise<HermesProviderCredentialState | null> {
  if (!runOpenshell) {
    throw new Error("OpenShell runner is required for Hermes Provider credential storage");
  }
  const normalizedApiKey = nonEmptyString(apiKey);
  if (!normalizedApiKey) return null;

  registerHermesInferenceProvider(
    normalizedApiKey,
    runOpenshell,
    HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
    baseUrl,
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
  registerHermesInferenceProvider,
  ensureHermesProviderOAuthCredentials,
  ensureHermesProviderApiKeyCredentials,
};

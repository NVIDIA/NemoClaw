// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-side Hermes Provider inference credentials.
 *
 * This is the provider-foundation slice only. It owns host persistence for
 * Nous Portal OAuth/API-key inference and OpenShell provider registration.
 * The managed-tool broker and messaging bridge lifecycle live in the next
 * Hermes wrapper runtime branch.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { getCredsDir } = require("./credentials");
const oauth = require("./oauth-device-code");
const onboardProviders = require("./onboard-providers");
const { validateName } = require("./runner");

const HERMES_PROVIDER_NAME = "hermes-provider";
const HERMES_INFERENCE_CREDENTIAL_ENV = "OPENAI_API_KEY";
const HERMES_NOUS_API_KEY_CREDENTIAL_ENV = "NOUS_API_KEY";
const HERMES_OAUTH_DIR = path.join(getCredsDir(), "hermes-oauth");
const ACCESS_REFRESH_SKEW_MS = 120_000;
const AGENT_KEY_MIN_TTL_SECONDS = 1800;

function ensurePrivateStateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function ensureHermesOAuthDir() {
  ensurePrivateStateDir(HERMES_OAUTH_DIR);
}

function getHermesOAuthStatePath(sandboxName) {
  const safeName = validateName(sandboxName, "sandbox name");
  ensureHermesOAuthDir();
  return path.join(HERMES_OAUTH_DIR, `${safeName}.json`);
}

function atomicWriteJson(file, value) {
  ensurePrivateStateDir(path.dirname(file));
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${crypto
      .randomBytes(4)
      .toString("hex")}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function loadHermesOAuthState(sandboxName) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getHermesOAuthStatePath(sandboxName), "utf8"),
    );
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function persistHermesOAuthState(sandboxName, state) {
  atomicWriteJson(getHermesOAuthStatePath(sandboxName), {
    version: 1,
    sandbox: sandboxName,
    ...state,
    updated_at: new Date().toISOString(),
  });
}

function tokenExpiresSoon(expiresAt, skewMs = ACCESS_REFRESH_SKEW_MS) {
  if (!expiresAt || typeof expiresAt !== "string") return true;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) return true;
  return timestamp - Date.now() < skewMs;
}

function withTokenMetadata(existing, tokenResp) {
  const now = new Date();
  const expiresIn =
    typeof tokenResp.expires_in === "number" &&
    Number.isFinite(tokenResp.expires_in)
      ? tokenResp.expires_in
      : 900;
  return {
    ...(existing || {}),
    auth_method: "oauth",
    api_key: undefined,
    access_token: tokenResp.access_token,
    refresh_token: tokenResp.refresh_token,
    token_type: tokenResp.token_type || "Bearer",
    scope: tokenResp.scope || existing?.scope || oauth.DEFAULT_SCOPE,
    expires_in: expiresIn,
    expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    obtained_at: now.toISOString(),
    client_id: oauth.DEFAULT_CLIENT_ID,
    portal_base_url: oauth.DEFAULT_PORTAL_BASE_URL,
    inference_base_url: oauth.DEFAULT_INFERENCE_BASE_URL,
  };
}

function withApiKeyMetadata(existing, apiKey, sandboxName) {
  const now = new Date();
  return {
    ...(existing || {}),
    version: 1,
    sandbox: sandboxName,
    auth_method: "api_key",
    api_key: apiKey,
    access_token: undefined,
    refresh_token: undefined,
    token_type: "Bearer",
    portal_base_url: oauth.DEFAULT_PORTAL_BASE_URL,
    inference_base_url: oauth.DEFAULT_INFERENCE_BASE_URL,
    obtained_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

async function ensureHermesOAuthState(
  sandboxName,
  { allowInteractiveLogin = true, log = console.error, fetch = undefined } = {},
) {
  let state = loadHermesOAuthState(sandboxName);
  if (
    state?.auth_method === "oauth" &&
    state?.refresh_token &&
    !tokenExpiresSoon(state.expires_at)
  ) {
    return state;
  }

  if (state?.auth_method === "oauth" && state?.refresh_token) {
    try {
      const refreshed = await oauth.refreshAccessTokenWithRefreshToken(
        state.refresh_token,
        {
          fetch,
        },
      );
      state = withTokenMetadata(state, refreshed);
      persistHermesOAuthState(sandboxName, state);
      return state;
    } catch (err) {
      if (!allowInteractiveLogin) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(`  ⚠ Hermes Provider OAuth refresh failed: ${message}`);
      log("    Falling back to browser authorization.");
    }
  }

  if (!allowInteractiveLogin) {
    return null;
  }

  const tokens = await oauth.runDeviceCodeFlow({ fetch, log });
  state = withTokenMetadata(state, tokens);
  persistHermesOAuthState(sandboxName, state);
  return state;
}

async function ensureHermesAgentKey(
  sandboxName,
  state,
  { fetch = undefined } = {},
) {
  if (
    state?.agent_key &&
    !tokenExpiresSoon(
      state.agent_key_expires_at,
      AGENT_KEY_MIN_TTL_SECONDS * 1000,
    )
  ) {
    return state;
  }

  const minted = await oauth.mintAgentKeyWithAccessToken(state.access_token, {
    fetch,
    minTtlSeconds: AGENT_KEY_MIN_TTL_SECONDS,
  });
  const now = new Date();
  const expiresIn =
    typeof minted.expires_in === "number" && Number.isFinite(minted.expires_in)
      ? minted.expires_in
      : AGENT_KEY_MIN_TTL_SECONDS;
  const next = {
    ...state,
    agent_key: minted.api_key,
    agent_key_id: minted.key_id || null,
    agent_key_expires_at:
      minted.expires_at ||
      new Date(now.getTime() + expiresIn * 1000).toISOString(),
    agent_key_expires_in: expiresIn,
    agent_key_reused: Boolean(minted.reused),
    agent_key_obtained_at: now.toISOString(),
    inference_base_url: minted.inference_base_url || state.inference_base_url,
  };
  persistHermesOAuthState(sandboxName, next);
  return next;
}

function upsertProvider(name, type, credentialEnv, baseUrl, env, runOpenshell) {
  const result = onboardProviders.upsertProvider(
    name,
    type,
    credentialEnv,
    baseUrl,
    env,
    runOpenshell,
  );
  if (!result.ok) {
    throw new Error(result.message || `failed to upsert provider '${name}'`);
  }
}

function registerHermesInferenceProvider(
  apiKey,
  runOpenshell,
  credentialEnv = HERMES_INFERENCE_CREDENTIAL_ENV,
  baseUrl = oauth.DEFAULT_INFERENCE_BASE_URL,
) {
  upsertProvider(
    HERMES_PROVIDER_NAME,
    "openai",
    credentialEnv,
    baseUrl,
    { [credentialEnv]: apiKey },
    runOpenshell,
  );
}

async function ensureHermesProviderOAuthCredentials(
  sandboxName,
  {
    allowInteractiveLogin = true,
    runOpenshell = null,
    log = console.error,
    fetch = undefined,
  } = {},
) {
  let state = await ensureHermesOAuthState(sandboxName, {
    allowInteractiveLogin,
    log,
    fetch,
  });
  if (!state) return null;
  state = await ensureHermesAgentKey(sandboxName, state, { fetch });
  if (runOpenshell) {
    registerHermesInferenceProvider(state.agent_key, runOpenshell);
  }
  return state;
}

async function ensureHermesProviderApiKeyCredentials(
  sandboxName,
  { apiKey = null, runOpenshell = null } = {},
) {
  const existing = loadHermesOAuthState(sandboxName);
  const existingApiKey =
    existing?.auth_method === "api_key" || existing?.api_key
      ? existing.api_key || existing.access_token
      : null;
  const normalizedApiKey = String(apiKey || existingApiKey || "").trim();
  if (!normalizedApiKey) return null;

  let state = existing;
  if (
    !state ||
    state.auth_method !== "api_key" ||
    state.api_key !== normalizedApiKey
  ) {
    state = withApiKeyMetadata(existing, normalizedApiKey, sandboxName);
    persistHermesOAuthState(sandboxName, state);
  }

  if (runOpenshell) {
    registerHermesInferenceProvider(
      normalizedApiKey,
      runOpenshell,
      HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
    );
  }
  return state;
}

module.exports = {
  HERMES_PROVIDER_NAME,
  HERMES_INFERENCE_CREDENTIAL_ENV,
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
  HERMES_OAUTH_DIR,
  AGENT_KEY_MIN_TTL_SECONDS,
  getHermesOAuthStatePath,
  loadHermesOAuthState,
  persistHermesOAuthState,
  ensureHermesOAuthState,
  ensureHermesAgentKey,
  ensureHermesProviderOAuthCredentials,
  ensureHermesProviderApiKeyCredentials,
  registerHermesInferenceProvider,
};

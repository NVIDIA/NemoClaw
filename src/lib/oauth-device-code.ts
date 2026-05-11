// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth 2.0 Device Authorization Grant helpers for Hermes Provider onboarding.
 *
 * Hermes OAuth/API-key material must not be durably persisted to host-side
 * NemoClaw storage such as ~/.nemoclaw. Onboarding uses ephemeral OAuth tokens
 * to mint short-lived agent keys for OpenShell provider registration. The
 * sandbox receives only the normal OpenShell inference placeholder, never raw
 * Hermes/Nous OAuth tokens or API keys.
 */

import { spawn } from "node:child_process";

export const DEFAULT_PORTAL_BASE_URL = "https://portal.nousresearch.com";
export const DEFAULT_INFERENCE_BASE_URL =
  "https://inference-api.nousresearch.com/v1";
export const DEFAULT_CLIENT_ID = "hermes-cli";
export const DEFAULT_SCOPE = "inference:mint_agent_key";

const POLL_INTERVAL_MIN_SECONDS = 1;
const POLL_INTERVAL_MAX_SECONDS = 30;
const DEFAULT_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  iat?: number;
  exp?: number;
}

export interface AgentKeyResponse {
  api_key: string;
  key_id?: string;
  expires_at?: string;
  expires_in?: number;
  reused?: boolean;
  inference_base_url?: string;
}

export interface DeviceCodeFlowOptions {
  portalBaseUrl?: string;
  clientId?: string;
  scope?: string;
  timeoutSeconds?: number;
  requestTimeoutMs?: number;
  noBrowser?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export class OAuthError extends Error {
  code: string;
  description?: string;

  constructor(code: string, description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.name = "OAuthError";
    this.code = code;
    this.description = description;
  }
}

export class OAuthTimeoutError extends OAuthError {
  constructor() {
    super("timeout", "device code expired before user completed approval");
    this.name = "OAuthTimeoutError";
  }
}

function openBrowser(url: string): void {
  let command: string;
  let args: string[];
  switch (process.platform) {
    case "darwin":
      command = "open";
      args = [url];
      break;
    case "win32":
      command = "cmd";
      args = ["/c", "start", "", url];
      break;
    default:
      command = "xdg-open";
      args = [url];
      break;
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best effort only; the URL is also printed for copy/paste.
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInterval(value: unknown): number {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : POLL_INTERVAL_MIN_SECONDS;
  return Math.min(
    POLL_INTERVAL_MAX_SECONDS,
    Math.max(POLL_INTERVAL_MIN_SECONDS, n),
  );
}

function createRequestTimeout(timeoutMs: number | undefined): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const ms = Math.max(1, Math.round(timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function postForm(
  url: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
  requestTimeoutMs?: number,
): Promise<Response> {
  const timeout = createRequestTimeout(requestTimeoutMs);
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
      signal: timeout.signal,
    });
  } finally {
    timeout.clear();
  }
}

export async function requestDeviceCode(
  opts: DeviceCodeFlowOptions = {},
): Promise<DeviceCodeResponse> {
  const fetchImpl = opts.fetch ?? fetch;
  const portalBaseUrl = opts.portalBaseUrl ?? DEFAULT_PORTAL_BASE_URL;
  const clientId = opts.clientId ?? DEFAULT_CLIENT_ID;
  const scope = opts.scope ?? DEFAULT_SCOPE;

  const resp = await postForm(
    `${portalBaseUrl}/api/oauth/device/code`,
    { client_id: clientId, scope },
    fetchImpl,
    opts.requestTimeoutMs,
  );

  if (resp.status !== 200) {
    let description = "";
    try {
      const payload = (await resp.json()) as { error_description?: string };
      description = payload.error_description ?? "";
    } catch {
      // keep generic error below
    }
    throw new OAuthError(
      `device_code_request_failed_http_${resp.status}`,
      description || `device-code request returned HTTP ${resp.status}`,
    );
  }

  const payload = (await resp.json()) as DeviceCodeResponse;
  if (!payload.device_code || !payload.user_code) {
    throw new OAuthError(
      "device_code_response_invalid",
      "device-code response missing required fields",
    );
  }
  return payload;
}

export async function pollForToken(
  deviceCode: DeviceCodeResponse,
  opts: DeviceCodeFlowOptions = {},
): Promise<TokenResponse> {
  const fetchImpl = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  const portalBaseUrl = opts.portalBaseUrl ?? DEFAULT_PORTAL_BASE_URL;
  const clientId = opts.clientId ?? DEFAULT_CLIENT_ID;
  const log = opts.log ?? ((line: string) => console.error(line));
  const deadline =
    now() + (opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  let interval = clampInterval(deviceCode.interval);
  let lastWaitLog = 0;

  while (now() < deadline) {
    await sleep(interval * 1000);
    if (now() - lastWaitLog > 30_000) {
      log("  Waiting for browser approval...");
      lastWaitLog = now();
    }

    const resp = await postForm(
      `${portalBaseUrl}/api/oauth/token`,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode.device_code,
        client_id: clientId,
      },
      fetchImpl,
      opts.requestTimeoutMs,
    );

    if (resp.status === 200) {
      const payload = (await resp.json()) as TokenResponse;
      if (!payload.access_token || !payload.refresh_token) {
        throw new OAuthError(
          "token_response_missing_tokens",
          "portal returned no access_token or refresh_token; cannot complete host-side authorization",
        );
      }
      return payload;
    }

    let errorPayload: { error?: string; error_description?: string } = {};
    try {
      errorPayload = (await resp.json()) as typeof errorPayload;
    } catch {
      // use generic code below
    }
    const errorCode = errorPayload.error ?? `http_${resp.status}`;
    switch (errorCode) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval = clampInterval(interval + 5);
        continue;
      case "access_denied":
        throw new OAuthError(
          "access_denied",
          "user denied the authorization request",
        );
      case "expired_token":
        throw new OAuthTimeoutError();
      default:
        throw new OAuthError(errorCode, errorPayload.error_description);
    }
  }

  throw new OAuthTimeoutError();
}

export async function refreshAccessTokenWithRefreshToken(
  refreshToken: string,
  opts: DeviceCodeFlowOptions = {},
): Promise<TokenResponse> {
  const fetchImpl = opts.fetch ?? fetch;
  const portalBaseUrl = opts.portalBaseUrl ?? DEFAULT_PORTAL_BASE_URL;
  const clientId = opts.clientId ?? DEFAULT_CLIENT_ID;

  const resp = await postForm(
    `${portalBaseUrl}/api/oauth/token`,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    },
    fetchImpl,
    opts.requestTimeoutMs,
  );

  if (resp.status !== 200) {
    let errorPayload: { error?: string; error_description?: string } = {};
    try {
      errorPayload = (await resp.json()) as typeof errorPayload;
    } catch {
      // use generic code below
    }
    throw new OAuthError(
      errorPayload.error ?? `refresh_failed_http_${resp.status}`,
      errorPayload.error_description ??
        `refresh-token grant returned HTTP ${resp.status}`,
    );
  }

  const payload = (await resp.json()) as TokenResponse;
  if (!payload.access_token || !payload.refresh_token) {
    throw new OAuthError(
      "token_response_missing_tokens",
      "refresh response missing access_token or refresh_token",
    );
  }
  return payload;
}

export async function mintAgentKeyWithAccessToken(
  accessToken: string,
  opts: DeviceCodeFlowOptions & { minTtlSeconds?: number } = {},
): Promise<AgentKeyResponse> {
  const fetchImpl = opts.fetch ?? fetch;
  const portalBaseUrl = opts.portalBaseUrl ?? DEFAULT_PORTAL_BASE_URL;
  const minTtlSeconds = Math.max(60, Math.round(opts.minTtlSeconds ?? 1800));

  const timeout = createRequestTimeout(opts.requestTimeoutMs);
  let resp: Response;
  try {
    resp = await fetchImpl(`${portalBaseUrl}/api/oauth/agent-key`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ min_ttl_seconds: minTtlSeconds }),
      signal: timeout.signal,
    });
  } finally {
    timeout.clear();
  }

  if (resp.status !== 200) {
    let errorPayload: { error?: string; error_description?: string } = {};
    try {
      errorPayload = (await resp.json()) as typeof errorPayload;
    } catch {
      // use generic code below
    }
    throw new OAuthError(
      errorPayload.error ?? `agent_key_failed_http_${resp.status}`,
      errorPayload.error_description ??
        `agent-key mint returned HTTP ${resp.status}`,
    );
  }

  const payload = (await resp.json()) as AgentKeyResponse;
  if (!payload.api_key) {
    throw new OAuthError(
      "agent_key_response_missing_api_key",
      "agent-key response missing api_key",
    );
  }
  return payload;
}

export async function runDeviceCodeFlow(
  opts: DeviceCodeFlowOptions = {},
): Promise<TokenResponse> {
  const log = opts.log ?? ((line: string) => console.error(line));

  log("");
  log("  Requesting device code from portal.nousresearch.com...");
  const deviceCode = await requestDeviceCode(opts);
  const verificationUri =
    deviceCode.verification_uri_complete ?? deviceCode.verification_uri;

  log("");
  log("  Hermes Provider OAuth");
  log("  Open this URL in your browser to approve:");
  log("");
  log(`    ${verificationUri}`);
  log("");
  if (!deviceCode.verification_uri_complete) {
    log(`  Then enter this code: ${deviceCode.user_code}`);
    log("");
  }
  log("  Waiting for approval (timeout: 15 min)...");

  if (!opts.noBrowser) {
    openBrowser(verificationUri);
  }

  const token = await pollForToken(deviceCode, opts);
  log("");
  log("  ✓ Hermes Provider authorization complete");
  log("");
  return token;
}

module.exports = {
  DEFAULT_PORTAL_BASE_URL,
  DEFAULT_INFERENCE_BASE_URL,
  DEFAULT_CLIENT_ID,
  DEFAULT_SCOPE,
  OAuthError,
  OAuthTimeoutError,
  requestDeviceCode,
  pollForToken,
  refreshAccessTokenWithRefreshToken,
  mintAgentKeyWithAccessToken,
  runDeviceCodeFlow,
};

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCOPE,
  isNousInvokeAccessToken,
  jwtExpiresAt,
  mintAgentKeyWithAccessToken,
  pollForToken,
  refreshAccessTokenWithRefreshToken,
  requestDeviceCode,
} from "./oauth-device-code";

function jwtWithClaims(claims: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.sig`;
}

describe("requestDeviceCode", () => {
  it("requests both invoke JWT and legacy agent-key scopes by default", async () => {
    const calls: Array<{ body: string }> = [];
    await requestDeviceCode({
      fetch: (async (_url, init) => {
        calls.push({ body: String(init?.body ?? "") });
        return new Response(
          JSON.stringify({
            device_code: "device-1",
            user_code: "USER-1",
            verification_uri: "https://portal.example/verify",
            expires_in: 900,
            interval: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    });

    expect(DEFAULT_SCOPE).toBe("inference:invoke inference:mint_agent_key");
    expect(new URLSearchParams(calls[0]?.body).get("scope")).toBe(DEFAULT_SCOPE);
  });
});

describe("pollForToken", () => {
  it("rejects successful token responses missing an access token", async () => {
    await expect(
      pollForToken(
        {
          device_code: "device-1",
          user_code: "USER-1",
          verification_uri: "https://portal.example/verify",
          expires_in: 900,
          interval: 1,
        },
        {
          sleep: async () => {},
          log: () => {},
          fetch: (async () =>
            new Response(
              JSON.stringify({
                refresh_token: "refresh-1",
                expires_in: 900,
                token_type: "Bearer",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )) as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({
      name: "OAuthError",
      code: "token_response_missing_tokens",
    });
  });
});

describe("isNousInvokeAccessToken", () => {
  it("accepts unexpired JWTs with inference invoke scope", () => {
    const token = jwtWithClaims({
      exp: Math.floor(Date.now() / 1000) + 3600,
      scope: "inference:invoke inference:mint_agent_key",
    });

    expect(isNousInvokeAccessToken(token)).toBe(true);
    expect(isNousInvokeAccessToken("opaque-access-token")).toBe(false);
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  it.each([
    { description: "malformed", exp: "not-a-number", hasValidDate: false },
    { description: "out-of-range", exp: Number.MAX_SAFE_INTEGER, hasValidDate: false },
    { description: "expired", exp: nowSeconds - 60, hasValidDate: true },
    { description: "near-expiry", exp: nowSeconds + 60, hasValidDate: true },
  ])("rejects invoke JWTs with $description expiration values", ({ exp, hasValidDate }) => {
    const token = jwtWithClaims({
      exp,
      scope: "inference:invoke inference:mint_agent_key",
    });

    expect(jwtExpiresAt(token) !== null).toBe(hasValidDate);
    expect(isNousInvokeAccessToken(token)).toBe(false);
  });
});

describe("refreshAccessTokenWithRefreshToken", () => {
  it("sends the refresh token in x-nous-refresh-token instead of the form body", async () => {
    const calls: Array<{
      url: string;
      body: string;
      refreshHeader: string | null;
      signal: AbortSignal | null;
    }> = [];
    const token = await refreshAccessTokenWithRefreshToken("refresh-1", {
      fetch: (async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(url),
          body: String(init?.body ?? ""),
          refreshHeader: headers.get("x-nous-refresh-token"),
          signal: init?.signal instanceof AbortSignal ? init.signal : null,
        });
        return new Response(
          JSON.stringify({
            access_token: "access-2",
            refresh_token: "refresh-2",
            expires_in: 900,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    });

    expect(token.access_token).toBe("access-2");
    expect(token.refresh_token).toBe("refresh-2");
    expect(calls[0]?.url).toBe("https://portal.nousresearch.com/api/oauth/token");
    expect(new URLSearchParams(calls[0]?.body).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(calls[0]?.body).get("refresh_token")).toBeNull();
    expect(calls[0]?.refreshHeader).toBe("refresh-1");
    expect(new URLSearchParams(calls[0]?.body).get("client_id")).toBe("hermes-cli");
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces refresh-token grant errors", async () => {
    await expect(
      refreshAccessTokenWithRefreshToken("bad-refresh", {
        fetch: (async () =>
          new Response(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "refresh token expired",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          )) as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "OAuthError",
      code: "invalid_grant",
      description: "refresh token expired",
    });
  });
});

describe("mintAgentKeyWithAccessToken", () => {
  it("mints a short-lived agent key with Authorization bearer auth", async () => {
    const calls: Array<{
      url: string;
      auth: string | null;
      body: string;
      signal: AbortSignal | null;
    }> = [];
    const key = await mintAgentKeyWithAccessToken("access-1", {
      minTtlSeconds: 120,
      fetch: (async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(url),
          auth: headers.get("authorization"),
          body: String(init?.body ?? ""),
          signal: init?.signal instanceof AbortSignal ? init.signal : null,
        });
        return new Response(
          JSON.stringify({
            api_key: "agent-key-1",
            key_id: "key-1",
            expires_in: 1800,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    });

    expect(key.api_key).toBe("agent-key-1");
    expect(calls[0]?.url).toBe("https://portal.nousresearch.com/api/oauth/agent-key");
    expect(calls[0]?.auth).toBe("Bearer access-1");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      min_ttl_seconds: 120,
    });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

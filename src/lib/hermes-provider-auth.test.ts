// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const SOURCE_AUTH = path.join(import.meta.dirname, "hermes-provider-auth.ts");
const SOURCE_BROKER = path.join(import.meta.dirname, "hermes-tool-gateway-broker.ts");

function clearSourceModule(modulePath: string): void {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // not loaded
  }
}

function loadAuth(): Record<string, any> {
  clearSourceModule(SOURCE_AUTH);
  return require(SOURCE_AUTH);
}

function loadAuthWithBrokerStub(brokerStub: Record<string, any>): Record<string, any> {
  clearSourceModule(SOURCE_AUTH);
  clearSourceModule(SOURCE_BROKER);
  const broker = require(SOURCE_BROKER);
  Object.assign(broker, brokerStub);
  return require(SOURCE_AUTH);
}

function jwtWithClaims(claims: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.sig`;
}

function invokeJwt(seconds = 3600): string {
  return jwtWithClaims({
    exp: Math.floor(Date.now() / 1000) + seconds,
    scope: "inference:invoke inference:mint_agent_key",
  });
}

afterEach(() => {
  clearSourceModule(SOURCE_AUTH);
  clearSourceModule(SOURCE_BROKER);
});

describe("Hermes provider OpenShell credential handoff", () => {
  it("inspects exact OpenShell credential key bindings without exposing values", () => {
    const auth = loadAuth();
    const binding = auth.inspectHermesProviderBinding(() => ({
      status: 0,
      stdout: "Provider:\n\n  Name: hermes-provider\n  Credential keys: NOUS_API_KEY\n",
      stderr: "",
    }));
    expect(binding).toEqual({ exists: true, credentialKeys: ["NOUS_API_KEY"] });
  });

  it("fails closed when OpenShell provider details omit credential metadata", () => {
    const auth = loadAuth();
    expect(
      auth.inspectHermesProviderBinding(() => ({ status: 0, stdout: "Provider: exists" })),
    ).toEqual({ exists: true, credentialKeys: null });
  });

  it("registers Nous API-key inference in OpenShell without host-side persistence", async () => {
    const originalHome = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-api-key-"));
    try {
      process.env.HOME = tmp;
      const auth = loadAuth();
      const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
      const state = await auth.ensureHermesProviderApiKeyCredentials("my-assistant", {
        apiKey: "nous-key-1",
        runOpenshell: (args: string[], opts: { env?: Record<string, string> } = {}) => {
          calls.push({ args, env: opts.env });
          if (args[0] === "provider" && args[1] === "get") {
            return { status: 1, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      expect(state.auth_method).toBe("api_key");
      expect(state.credential_env).toBe("NOUS_API_KEY");
      expect(calls.some((call) => call.args.includes("hermes-provider"))).toBe(true);
      expect(calls.some((call) => call.args.includes("NOUS_API_KEY"))).toBe(true);
      expect(calls.some((call) => call.env?.NOUS_API_KEY === "nous-key-1")).toBe(true);
      expect(fs.existsSync(path.join(tmp, ".nemoclaw", "hermes-oauth"))).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses OAuth invoke JWTs directly for OpenShell registration", async () => {
    const originalHome = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-oauth-"));
    try {
      process.env.HOME = tmp;
      const auth = loadAuth();
      const token = invokeJwt();
      const fetchCalls: Array<{ url: string; auth: string | null; body: string }> = [];
      const providerCalls: Array<{ args: string[]; env?: Record<string, string> }> = [];
      const state = await auth.ensureHermesProviderOAuthCredentials("my-assistant", {
        allowInteractiveLogin: true,
        fetch: (async (url, init) => {
          const headers = new Headers(init?.headers);
          fetchCalls.push({
            url: String(url),
            auth: headers.get("authorization"),
            body: String(init?.body ?? ""),
          });
          if (String(url).endsWith("/api/oauth/device/code")) {
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
          }
          if (String(url).endsWith("/api/oauth/token")) {
            return new Response(
              JSON.stringify({
                access_token: token,
                refresh_token: "refresh-2",
                expires_in: 900,
                inference_base_url: "https://staging.nous.example/v1",
                token_type: "Bearer",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          throw new Error(`unexpected fetch ${url}`);
        }) as typeof fetch,
        log: () => {},
        noBrowser: true,
        runOpenshell: (args: string[], opts: { env?: Record<string, string> } = {}) => {
          providerCalls.push({ args, env: opts.env });
          if (args[0] === "provider" && args[1] === "get") {
            return { status: 1, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      expect(state.auth_method).toBe("oauth");
      expect(state.credential_env).toBe("OPENAI_API_KEY");
      expect(state.inference_base_url).toBe("https://staging.nous.example/v1");
      expect(state.auth_path).toBe("invoke_jwt");
      expect(new URLSearchParams(fetchCalls[0]?.body).get("scope")).toBe(
        "inference:invoke inference:mint_agent_key",
      );
      expect(providerCalls.some((call) => call.env?.OPENAI_API_KEY === token)).toBe(true);
      expect(
        providerCalls.some((call) =>
          call.args.includes("OPENAI_BASE_URL=https://staging.nous.example/v1"),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(tmp, ".nemoclaw", "hermes-oauth"))).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    { caseName: "opaque", token: () => "opaque-access" },
    { caseName: "malformed", token: () => "header.not-json.sig" },
    {
      caseName: "expired",
      token: () =>
        jwtWithClaims({
          exp: Math.floor(Date.now() / 1000) - 60,
          scope: "inference:invoke inference:mint_agent_key",
        }),
    },
    {
      caseName: "near-expiry",
      token: () =>
        jwtWithClaims({
          exp: Math.floor(Date.now() / 1000) + 60,
          scope: "inference:invoke inference:mint_agent_key",
        }),
    },
    {
      caseName: "wrong-scope",
      token: () =>
        jwtWithClaims({
          exp: Math.floor(Date.now() / 1000) + 3600,
          scope: "inference:mint_agent_key",
        }),
    },
    {
      caseName: "missing-scope",
      token: () => jwtWithClaims({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    },
  ])("falls back once to a registered legacy agent key for an unusable $caseName OAuth token (#6885)", async ({
    token: makeToken,
  }) => {
    const originalHome = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-oauth-fallback-"));
    try {
      process.env.HOME = tmp;
      const auth = loadAuth();
      const token = makeToken();
      const mintedKey = "agent-key-1";
      const fetchCalls: Array<{ url: string; auth: string | null }> = [];
      const providerCalls: Array<{ args: string[]; env?: Record<string, string> }> = [];
      const responseByPath: Record<string, () => Record<string, unknown>> = {
        "/api/oauth/device/code": () => ({
          device_code: "device-1",
          user_code: "USER-1",
          verification_uri: "https://portal.example/verify",
          expires_in: 900,
          interval: 1,
        }),
        "/api/oauth/token": () => ({
          access_token: token,
          refresh_token: "refresh-2",
          expires_in: 900,
          token_type: "Bearer",
        }),
        "/api/oauth/agent-key": () => ({
          api_key: mintedKey,
          key_id: "agent-key-id",
          expires_in: 1800,
        }),
      };
      const state = await auth.ensureHermesProviderOAuthCredentials("my-assistant", {
        allowInteractiveLogin: true,
        fetch: (async (url, init) => {
          const requestUrl = String(url);
          const headers = new Headers(init?.headers);
          fetchCalls.push({ url: requestUrl, auth: headers.get("authorization") });
          const responseBody = (
            responseByPath[new URL(requestUrl).pathname] ??
            (() => {
              throw new Error(`unexpected fetch ${requestUrl}`);
            })
          )();
          return new Response(JSON.stringify(responseBody), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch,
        log: () => {},
        noBrowser: true,
        runOpenshell: (args: string[], opts: { env?: Record<string, string> } = {}) => {
          providerCalls.push({ args, env: opts.env });
          return args[0] === "provider" && args[1] === "get"
            ? { status: 1, stdout: "", stderr: "" }
            : { status: 0, stdout: "", stderr: "" };
        },
      });

      const agentKeyRequests = fetchCalls.filter((call) =>
        call.url.endsWith("/api/oauth/agent-key"),
      );
      expect(agentKeyRequests).toEqual([
        {
          url: "https://portal.nousresearch.com/api/oauth/agent-key",
          auth: `Bearer ${token}`,
        },
      ]);
      expect(state).toMatchObject({
        auth_method: "oauth",
        auth_path: "legacy_agent_key",
        credential_env: "OPENAI_API_KEY",
        inference_base_url: "https://inference-api.nousresearch.com/v1",
      });
      expect(providerCalls.filter((call) => call.env?.OPENAI_API_KEY === mintedKey)).toHaveLength(
        1,
      );
      expect(providerCalls.some((call) => call.env?.OPENAI_API_KEY === token)).toBe(false);
      expect(fs.existsSync(path.join(tmp, ".nemoclaw", "hermes-oauth"))).toBe(false);
    } finally {
      originalHome === undefined
        ? Reflect.deleteProperty(process.env, "HOME")
        : Reflect.set(process.env, "HOME", originalHome);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("registers a separate managed-tool refresh provider without writing raw OAuth state", async () => {
    const originalHome = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-tool-oauth-"));
    try {
      process.env.HOME = tmp;
      const brokerCalls: Array<{ sandboxName?: string; refreshToken?: string }> = [];
      const auth = loadAuthWithBrokerStub({
        registerHermesToolGatewayRefreshProvider: (sandboxName: string, refreshToken: string) => {
          brokerCalls.push({ sandboxName, refreshToken });
          return { providerName: `${sandboxName}-hermes-tool-gateway`, brokerToken: "broker-3" };
        },
        ensureHermesToolGatewayBroker: (options: { refreshToken?: string }) => {
          expect(options.refreshToken).toBe("refresh-3");
          return true;
        },
      });
      const providerCalls: Array<{ args: string[]; env?: Record<string, string> }> = [];
      const token = invokeJwt();
      const state = await auth.ensureHermesProviderOAuthCredentials("my-assistant", {
        allowInteractiveLogin: true,
        fetch: (async (url, init) => {
          if (String(url).endsWith("/api/oauth/device/code")) {
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
          }
          if (String(url).endsWith("/api/oauth/token")) {
            return new Response(
              JSON.stringify({
                access_token: token,
                refresh_token: "refresh-3",
                expires_in: 900,
                token_type: "Bearer",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          throw new Error(`unexpected fetch ${url}`);
        }) as typeof fetch,
        log: () => {},
        noBrowser: true,
        runOpenshell: (args: string[], opts: { env?: Record<string, string> } = {}) => {
          providerCalls.push({ args, env: opts.env });
          if (args[0] === "provider" && args[1] === "get") {
            return { status: 1, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
        toolGatewayPresets: ["nous-web", "nous-audio"],
      });

      expect(state.auth_method).toBe("oauth");
      expect(state.auth_path).toBe("invoke_jwt");
      expect(providerCalls.some((call) => call.env?.OPENAI_API_KEY === token)).toBe(true);
      expect(brokerCalls).toEqual([{ sandboxName: "my-assistant", refreshToken: "refresh-3" }]);
      expect(fs.existsSync(path.join(tmp, ".nemoclaw", "hermes-oauth"))).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

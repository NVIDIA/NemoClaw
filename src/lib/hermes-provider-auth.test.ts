// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { createNativeProviderCommandRuntime } from "../../test/support/native-provider-command-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  clearSourceModule(SOURCE_AUTH);
  clearSourceModule(SOURCE_BROKER);
});

const NATIVE_PROVIDER = "nemoclaw-hermes-provider-v1";
const NATIVE_PROFILE = "nemoclaw-hermes-inference-v1";

function nativeRunner(initiallyExists = false) {
  const runtime = createNativeProviderCommandRuntime("hermes-provider", initiallyExists);
  return vi.fn(
    (args: string[], _opts: { env?: Record<string, string> } = {}) =>
      runtime.run(args) ?? { status: 0, stdout: "", stderr: "" },
  );
}

describe("Hermes provider OpenShell credential handoff", () => {
  it("inspects exact OpenShell credential key bindings without exposing values", async () => {
    const auth = loadAuth();
    const binding = await auth.inspectHermesProviderBinding(nativeRunner(true));
    expect(binding).toEqual({ exists: true, credentialKeys: ["OPENAI_API_KEY"] });
  });

  it("fails closed when OpenShell provider details omit credential metadata", async () => {
    const auth = loadAuth();
    await expect(
      auth.inspectHermesProviderBinding(() => ({ status: 0, stdout: "Provider: exists" })),
    ).resolves.toEqual({ exists: true, credentialKeys: null });
  });

  it("registers only the owned native profile with a protected credential", async () => {
    const auth = loadAuth();
    const run = nativeRunner();
    await auth.registerHermesInferenceProvider("nous-key", run);
    expect(run.mock.calls.some(([args]) => args.includes("profile"))).toBe(true);
    const create = run.mock.calls.find(([args]) => args[1] === "create")!;
    expect(create[0]).toEqual(
      expect.arrayContaining([NATIVE_PROVIDER, NATIVE_PROFILE, "OPENAI_API_KEY"]),
    );
    expect(create[1]?.env?.OPENAI_API_KEY).toBe("nous-key");
    expect(create[0].join(" ")).not.toContain("nous-key");
  });

  it("rejects a noncanonical endpoint before any OpenShell mutation", async () => {
    const run = nativeRunner();
    await expect(
      loadAuth().registerHermesInferenceProvider(
        "key",
        run,
        "OPENAI_API_KEY",
        "https://other.example/v1",
      ),
    ).rejects.toThrow("noncanonical");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses credential rotation when the recorded provider identity changed", async () => {
    const run = nativeRunner(true);
    await expect(
      loadAuth().ensureHermesProviderApiKeyCredentials("alpha", {
        apiKey: "new-key",
        runOpenshell: run,
        expected: {
          schemaVersion: 1,
          profileId: NATIVE_PROFILE,
          providerName: NATIVE_PROVIDER,
          providerId: "replaced-id",
        },
      }),
    ).rejects.toThrow("changed identity");
    expect(run.mock.calls.some(([args]) => args[1] === "create" || args[1] === "update")).toBe(
      false,
    );
  });

  it("registers Nous API-key inference in OpenShell without host-side persistence", async () => {
    const originalHome = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-api-key-"));
    try {
      process.env.HOME = tmp;
      const auth = loadAuth();
      const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
      const run = nativeRunner();
      const state = await auth.ensureHermesProviderApiKeyCredentials("my-assistant", {
        apiKey: "nous-key-1",
        runOpenshell: (args: string[], opts: { env?: Record<string, string> } = {}) => {
          calls.push({ args, env: opts.env });
          return run(args, opts);
        },
      });

      expect(state.auth_method).toBe("api_key");
      expect(state.credential_env).toBe("NOUS_API_KEY");
      expect(calls.some((call) => call.args.includes(NATIVE_PROVIDER))).toBe(true);
      expect(calls.some((call) => call.args.includes("OPENAI_API_KEY"))).toBe(true);
      expect(calls.some((call) => call.env?.OPENAI_API_KEY === "nous-key-1")).toBe(true);
      expect(fs.existsSync(path.join(tmp, ".nemoclaw", "hermes-oauth"))).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses OAuth only as an in-memory minting step before OpenShell registration", async () => {
    const originalHome = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-oauth-"));
    try {
      process.env.HOME = tmp;
      const auth = loadAuth();
      const fetchCalls: Array<{ url: string; auth: string | null; body: string }> = [];
      const providerCalls: Array<{ args: string[]; env?: Record<string, string> }> = [];
      const run = nativeRunner();
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
                access_token: "access-2",
                refresh_token: "refresh-2",
                expires_in: 900,
                token_type: "Bearer",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              api_key: "agent-key-1",
              key_id: "agent-key-id",
              expires_in: 1800,
              inference_base_url: "https://inference-api.nousresearch.com/v1",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }) as typeof fetch,
        log: () => {},
        noBrowser: true,
        runOpenshell: (args: string[], opts: { env?: Record<string, string> } = {}) => {
          providerCalls.push({ args, env: opts.env });
          return run(args, opts);
        },
      });

      expect(state.auth_method).toBe("oauth");
      expect(state.credential_env).toBe("OPENAI_API_KEY");
      expect(state.inference_base_url).toBe("https://inference-api.nousresearch.com/v1");
      expect(fetchCalls.some((call) => call.auth === "Bearer access-2")).toBe(true);
      expect(providerCalls.some((call) => call.env?.OPENAI_API_KEY === "agent-key-1")).toBe(true);
      expect(
        providerCalls.some((call) =>
          call.args.includes("OPENAI_BASE_URL=https://inference-api.nousresearch.com/v1"),
        ),
      ).toBe(false);
      expect(fs.existsSync(path.join(tmp, ".nemoclaw", "hermes-oauth"))).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
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
        registerHermesToolGatewayRefreshProvider: async (
          sandboxName: string,
          refreshToken: string,
        ) => {
          brokerCalls.push({ sandboxName, refreshToken });
          return { providerName: `${sandboxName}-hermes-tool-gateway`, brokerToken: "broker-3" };
        },
        ensureHermesToolGatewayBroker: (options: { refreshToken?: string }) => {
          expect(options.refreshToken).toBe("refresh-3");
          return true;
        },
      });
      const providerCalls: Array<{ args: string[]; env?: Record<string, string> }> = [];
      const run = nativeRunner();
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
                access_token: "access-3",
                refresh_token: "refresh-3",
                expires_in: 900,
                token_type: "Bearer",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          const headers = new Headers(init?.headers);
          expect(headers.get("authorization")).toBe("Bearer access-3");
          return new Response(
            JSON.stringify({
              api_key: "agent-key-3",
              key_id: "agent-key-id",
              expires_in: 1800,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }) as typeof fetch,
        log: () => {},
        noBrowser: true,
        runOpenshell: (args: string[], opts: { env?: Record<string, string> } = {}) => {
          providerCalls.push({ args, env: opts.env });
          return run(args, opts);
        },
        toolGatewayPresets: ["nous-web", "nous-audio"],
      });

      expect(state.auth_method).toBe("oauth");
      expect(providerCalls.some((call) => call.env?.OPENAI_API_KEY === "agent-key-3")).toBe(true);
      expect(brokerCalls).toEqual([{ sandboxName: "my-assistant", refreshToken: "refresh-3" }]);
      expect(fs.existsSync(path.join(tmp, ".nemoclaw", "hermes-oauth"))).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

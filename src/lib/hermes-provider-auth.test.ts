// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const SOURCE_AUTH = path.join(import.meta.dirname, "hermes-provider-auth.ts");
const SOURCE_BROKER = path.join(import.meta.dirname, "hermes-tool-gateway-broker.ts");
const EXACT_OPENAI_PROFILE = JSON.stringify({
  id: "openai",
  credentials: [],
  endpoints: [],
  binaries: [],
  inference_capable: true,
});

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

  it("imports the OpenAI profile before Hermes credential registration (#10155)", () => {
    const auth = loadAuth();
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 0, stdout: "Imported", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "provider not found" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    auth.registerHermesInferenceProvider("nous-key", runOpenshell);

    expect(runOpenshell.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "profile", "export", "openai", "--output", "json"],
      ["provider", "profile", "import", "--file", expect.stringMatching(/openai\.yaml$/u)],
      ["provider", "get", "hermes-provider"],
      expect.arrayContaining([
        "provider",
        "create",
        "--name",
        "hermes-provider",
        "--type",
        "openai",
      ]),
    ]);
    expect(runOpenshell.mock.calls[0]?.[1]).toMatchObject({
      ignoreError: true,
      suppressOutput: true,
      timeout: 30_000,
    });
  });

  it("rejects an incompatible OpenAI profile before Hermes credential mutation (#10155)", () => {
    const auth = loadAuth();
    const secret = "nous-incompatible-secret";
    const runOpenshell = vi.fn().mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        id: "openai",
        credentials: [{ env: "OPENAI_API_KEY" }],
        endpoints: [],
        binaries: [],
        inference_capable: true,
      }),
      stderr: "",
    });

    let thrown: unknown;
    try {
      auth.registerHermesInferenceProvider(secret, runOpenshell);
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).toContain("does not match NemoClaw's endpointless inference contract");
    expect(String(thrown)).not.toContain(secret);
    expect(runOpenshell).toHaveBeenCalledOnce();
  });

  it("suppresses failed OpenAI profile import output before Hermes credential mutation (#10155)", () => {
    const auth = loadAuth();
    const secret = "profile-import-secret";
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: `import rejected: ${secret}` });

    let thrown: unknown;
    try {
      auth.registerHermesInferenceProvider("nous-key", runOpenshell);
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).toContain("could not import the checked-in 'openai'");
    expect(String(thrown)).not.toContain(secret);
    expect(String(thrown)).not.toContain("import rejected");
    expect(runOpenshell).toHaveBeenCalledTimes(2);
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
          return args[1] === "profile"
            ? { status: 0, stdout: EXACT_OPENAI_PROFILE, stderr: "" }
            : args[1] === "get"
              ? { status: 1, stdout: "", stderr: "" }
              : { status: 0, stdout: "", stderr: "" };
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

  it("uses OAuth only as an in-memory minting step before OpenShell registration", async () => {
    const originalHome = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-oauth-"));
    try {
      process.env.HOME = tmp;
      const auth = loadAuth();
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
              inference_base_url: "https://staging.nous.example/v1",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }) as typeof fetch,
        log: () => {},
        noBrowser: true,
        runOpenshell: (args: string[], opts: { env?: Record<string, string> } = {}) => {
          providerCalls.push({ args, env: opts.env });
          return args[1] === "profile"
            ? { status: 0, stdout: EXACT_OPENAI_PROFILE, stderr: "" }
            : args[1] === "get"
              ? { status: 1, stdout: "", stderr: "" }
              : { status: 0, stdout: "", stderr: "" };
        },
      });

      expect(state.auth_method).toBe("oauth");
      expect(state.credential_env).toBe("OPENAI_API_KEY");
      expect(state.inference_base_url).toBe("https://staging.nous.example/v1");
      expect(fetchCalls.some((call) => call.auth === "Bearer access-2")).toBe(true);
      expect(providerCalls.some((call) => call.env?.OPENAI_API_KEY === "agent-key-1")).toBe(true);
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
          return args[1] === "profile"
            ? { status: 0, stdout: EXACT_OPENAI_PROFILE, stderr: "" }
            : args[1] === "get"
              ? { status: 1, stdout: "", stderr: "" }
              : { status: 0, stdout: "", stderr: "" };
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

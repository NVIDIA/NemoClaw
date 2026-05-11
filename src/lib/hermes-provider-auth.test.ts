// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const DIST_AUTH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "dist",
  "lib",
  "hermes-provider-auth.js",
);

function clearDistModule(modulePath: string): void {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // not loaded
  }
}

function loadAuth(): Record<string, any> {
  clearDistModule(DIST_AUTH);
  return require(DIST_AUTH);
}

afterEach(() => {
  clearDistModule(DIST_AUTH);
});

describe("Hermes provider OpenShell credential handoff", () => {
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
          if (args[0] === "provider" && args[1] === "get") {
            return { status: 1, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      expect(state.auth_method).toBe("oauth");
      expect(state.credential_env).toBe("OPENAI_API_KEY");
      expect(state.inference_base_url).toBe("https://staging.nous.example/v1");
      expect(fetchCalls.some((call) => call.auth === "Bearer access-2")).toBe(true);
      expect(
        providerCalls.some((call) => call.env?.OPENAI_API_KEY === "agent-key-1"),
      ).toBe(true);
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
});

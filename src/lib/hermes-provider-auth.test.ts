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
const DIST_CREDS = path.join(
  import.meta.dirname,
  "..",
  "..",
  "dist",
  "lib",
  "credentials.js",
);

function clearDistModule(modulePath: string): void {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // not loaded
  }
}

function loadAuthForHome(home: string): Record<string, any> {
  process.env.HOME = home;
  clearDistModule(DIST_AUTH);
  clearDistModule(DIST_CREDS);
  return require(DIST_AUTH);
}

afterEach(() => {
  clearDistModule(DIST_AUTH);
  clearDistModule(DIST_CREDS);
});

describe("Hermes provider host auth", () => {
  it("persists API-key inference state with private permissions and registers OpenShell provider", async () => {
    const originalHome = process.env.HOME;
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-hermes-api-key-"),
    );
    try {
      const auth = loadAuthForHome(tmp);
      const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
      const state = await auth.ensureHermesProviderApiKeyCredentials(
        "my-assistant",
        {
          apiKey: "nous-key-1",
          runOpenshell: (
            args: string[],
            opts: { env?: Record<string, string> } = {},
          ) => {
            calls.push({ args, env: opts.env });
            if (args[0] === "provider" && args[1] === "get") {
              return { status: 1, stdout: "", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );

      expect(state.auth_method).toBe("api_key");
      const statePath = auth.getHermesOAuthStatePath("my-assistant");
      expect(fs.statSync(path.dirname(statePath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(statePath, "utf8")).api_key).toBe(
        "nous-key-1",
      );
      expect(calls.some((call) => call.args.includes("hermes-provider"))).toBe(
        true,
      );
      expect(calls.some((call) => call.args.includes("NOUS_API_KEY"))).toBe(
        true,
      );
      expect(
        calls.some((call) => call.env?.NOUS_API_KEY === "nous-key-1"),
      ).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refreshes OAuth state and mints an inference agent key", async () => {
    const originalHome = process.env.HOME;
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-hermes-oauth-"),
    );
    try {
      const auth = loadAuthForHome(tmp);
      auth.persistHermesOAuthState("my-assistant", {
        auth_method: "oauth",
        access_token: "old-access",
        refresh_token: "refresh-1",
        expires_at: "2000-01-01T00:00:00.000Z",
      });
      const calls: Array<{ url: string; auth: string | null; body: string }> =
        [];
      const state = await auth.ensureHermesProviderOAuthCredentials(
        "my-assistant",
        {
          allowInteractiveLogin: false,
          fetch: (async (url, init) => {
            const headers = new Headers(init?.headers);
            calls.push({
              url: String(url),
              auth: headers.get("authorization"),
              body: String(init?.body ?? ""),
            });
            if (String(url).endsWith("/api/oauth/token")) {
              return new Response(
                JSON.stringify({
                  access_token: "access-2",
                  refresh_token: "refresh-2",
                  expires_in: 900,
                  token_type: "Bearer",
                }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
            return new Response(
              JSON.stringify({
                api_key: "agent-key-1",
                key_id: "agent-key-id",
                expires_in: 1800,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }) as typeof fetch,
          runOpenshell: (
            args: string[],
            opts: { env?: Record<string, string> } = {},
          ) => {
            if (args[0] === "provider" && args[1] === "get") {
              return { status: 1, stdout: "", stderr: "" };
            }
            expect(opts.env?.OPENAI_API_KEY).toBe("agent-key-1");
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );

      expect(state.refresh_token).toBe("refresh-2");
      expect(state.agent_key).toBe("agent-key-1");
      expect(calls[0]?.body).toContain("refresh_token=refresh-1");
      expect(calls[1]?.auth).toBe("Bearer access-2");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

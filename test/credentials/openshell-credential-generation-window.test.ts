// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { MCP_BRIDGE_TEST_CREDENTIALS } from "../e2e/fixtures/mcp-bridge-credentials.ts";
import {
  buildCredentialWindowChildScript,
  buildCredentialWindowOneShotScript,
  buildCredentialWindowProviderUpdateArgs,
  CREDENTIAL_WINDOW_ENV_NAME,
  CREDENTIAL_WINDOW_EXPIRY_DELAY_MS,
  CREDENTIAL_WINDOW_PATHS,
  CREDENTIAL_WINDOW_ROTATION_COUNT,
  CREDENTIAL_WINDOW_STEPS,
  credentialWindowRequestId,
  credentialWindowSecrets,
  OPENSHELL_RETAINED_CREDENTIAL_GENERATIONS,
} from "../e2e/live/openshell-credential-generation-window.ts";

describe("OpenShell exact-main credential generation-window proof", () => {
  it("crosses the complete upstream retention window with unique scannable values", () => {
    const secrets = credentialWindowSecrets();

    expect(CREDENTIAL_WINDOW_ROTATION_COUNT).toBe(OPENSHELL_RETAINED_CREDENTIAL_GENERATIONS + 1);
    expect(secrets).toHaveLength(CREDENTIAL_WINDOW_ROTATION_COUNT + 3);
    expect(new Set(secrets).size).toBe(secrets.length);
    expect(
      secrets.every((secret) => secret.startsWith(MCP_BRIDGE_TEST_CREDENTIALS.generationWindow)),
    ).toBe(true);
  });

  it("keeps the old child on one revision while resolving each request at proxy time", () => {
    const script = buildCredentialWindowChildScript({
      mcpUrl: "https://credential-window.example.test/mcp",
      maxRuntimeMs: 12_345,
    });
    const snapshot = "const credentialPlaceholder = process.env[config.envName]";

    expect(script.split(snapshot)).toHaveLength(2);
    expect(script.indexOf(snapshot)).toBeLessThan(script.indexOf("while (Date.now() < deadline"));
    expect(script).toContain('"^openshell:resolve:env:(v[0-9]{1,20})_" + config.envName + "$"');
    expect(script).toContain('authorization: "Bearer " + credentialPlaceholder');
    expect(script).toContain('response.statusCode === 200 ? "allowed" : "denied"');
    expect(script).toContain("outbound.setTimeout(30_000");
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_PATHS.acknowledgement));
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.allowedBeforeExpiry));
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.deniedAfterExpiry));
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.fallbackAfterEviction));
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRemoval));
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.deniedAfterDetach));
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.deniedAfterReadd));
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.stop));
    expect(script).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.generationWindow);
  });

  it("builds explicit bounded expiry and attached-key-removal updates", () => {
    expect(CREDENTIAL_WINDOW_EXPIRY_DELAY_MS).toBe(3 * 60_000);
    expect(buildCredentialWindowProviderUpdateArgs("owned-provider", 123_456)).toEqual([
      "provider",
      "update",
      "owned-provider",
      "--credential",
      "FAKE_MCP_SECRET",
      "--credential-expires-at",
      "FAKE_MCP_SECRET=123456",
    ]);
    expect(buildCredentialWindowProviderUpdateArgs("owned-provider", 0, true)).toEqual([
      "provider",
      "update",
      "owned-provider",
      "--credential",
      "FAKE_MCP_SECRET=",
      "--credential-expires-at",
      "FAKE_MCP_SECRET=0",
    ]);
  });

  it("keeps fresh-exec requests revision-scoped and independently identifiable", () => {
    const script = buildCredentialWindowOneShotScript();

    expect(CREDENTIAL_WINDOW_ENV_NAME).toBe("FAKE_MCP_SECRET");
    expect(script).toContain("process.argv[1]");
    expect(script).toContain("process.argv[2]");
    expect(script).toContain('"^openshell:resolve:env:(v[0-9]{1,20})_" + config.envName + "$"');
    expect(script).toContain('authorization: "Bearer " + credentialPlaceholder');
    expect(script).toContain("request.setTimeout(30_000");
    expect(credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.fallbackAfterEviction)).toBe(
      "nemoclaw-credential-window:fallback-after-eviction",
    );
    expect(script).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.generationWindow);
  });

  it.each(["ECONNRESET", "ERR_PROXY_TUNNEL", "SENSITIVE_ERROR_VALUE"])(
    "reports only safe request metadata for %s",
    (code) => {
      const secret = "SENSITIVE_ERROR_VALUE";
      let stderr = "";
      const outbound = Object.assign(new EventEmitter(), {
        setTimeout: (milliseconds: number) => expect(milliseconds).toBe(30_000),
        end: () =>
          outbound.emit("error", {
            code,
            name: secret,
            message: secret,
            statusCode: code === "ERR_PROXY_TUNNEL" ? 403 : secret,
          }),
      });
      const childProcess = {
        env: { FAKE_MCP_SECRET: "openshell:resolve:env:v123_FAKE_MCP_SECRET" },
        argv: ["node", "https://credential-window.example.test/mcp", "request-id"],
        stdout: {
          write: () => {
            throw new Error("failed request must not report success");
          },
        },
        stderr: {
          write: (value: string) => {
            stderr += value;
          },
        },
        exitCode: 0,
      };
      runInNewContext(buildCredentialWindowOneShotScript(), {
        URL,
        Buffer,
        process: childProcess,
        require: () => ({ request: () => outbound }),
      });
      expect(JSON.parse(stderr)).toEqual({
        transportCode: code === secret ? "UNKNOWN" : code,
        ...(code === "ERR_PROXY_TUNNEL" ? { httpStatus: 403 } : {}),
      });
      expect(childProcess.exitCode).toBe(1);
    },
  );

  it("keeps the live target on the reviewed agent and mutation boundaries", () => {
    const liveTarget = fs.readFileSync(
      "test/e2e/live/openshell-credential-generation-window.test.ts",
      "utf8",
    );

    expect(liveTarget).toContain('NEMOCLAW_AGENT: "openclaw"');
    expect(liveTarget).toContain('["nemoclaw-start", "node", "-e"');
    expect(liveTarget).toContain("CREDENTIAL_WINDOW_STEPS.deniedAfterExpiry");
    expect(liveTarget).toContain("CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRemoval");
    expect(liveTarget).toContain('[SANDBOX_NAME, "mcp", "remove", SERVER_NAME]');
    expect(liveTarget).toMatch(/\[\s*SANDBOX_NAME,\s*"mcp",\s*"add",\s*SERVER_NAME,/u);
    expect(liveTarget).not.toContain('["sandbox", "provider", "detach"');
    expect(liveTarget).toContain('[SANDBOX_NAME, "mcp", "restart", SERVER_NAME]');
    expect(liveTarget).toContain('[SANDBOX_NAME, "rebuild", "--yes"]');
    expect(liveTarget).toContain('!request.auth.includes("openshell:resolve:env")');
  });
});

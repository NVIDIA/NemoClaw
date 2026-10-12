// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";
import { credentialWindowHttpFixture } from "../helpers/credential-window-http-fixture.ts";

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
  it.each([200, 401, "ECONNRESET", "private-error-secret"])(
    "records bounded request evidence for %s without changing the acknowledgement",
    async (result) => {
      const writes = new Map<string, string>();
      let diagnostic = "";
      let summary = "";
      const script = buildCredentialWindowChildScript({
        mcpUrl: "https://credential-window.example.test/mcp",
        maxRuntimeMs: 3000,
      });
      await runInNewContext(script, {
        Buffer,
        URL,
        setTimeout,
        process: {
          env: { FAKE_MCP_SECRET: "openshell:resolve:env:v42_FAKE_MCP_SECRET" },
          stdout: {
            write: (value: string) => {
              summary += value;
            },
          },
          stderr: {
            write: (value: string) => {
              diagnostic += value;
            },
          },
        },
        require: (name: string) =>
          new Map<string, unknown>([
            [
              "node:fs",
              {
                existsSync: () => true,
                readFileSync: () =>
                  writes.has(CREDENTIAL_WINDOW_PATHS.acknowledgement)
                    ? CREDENTIAL_WINDOW_STEPS.stop
                    : CREDENTIAL_WINDOW_STEPS.allowedBeforeExpiry,
                writeFileSync: (file: string, value: string) => writes.set(file, value),
              },
            ],
            ["node:https", credentialWindowHttpFixture(result)],
          ]).get(name),
      });
      const outcome = result === 200 ? "allowed" : "denied";
      const expected = { step: CREDENTIAL_WINDOW_STEPS.allowedBeforeExpiry, outcome };
      expect(JSON.parse(writes.get(CREDENTIAL_WINDOW_PATHS.acknowledgement)!)).toEqual(expected);
      expect(JSON.parse(summary)).toEqual({ revision: "v42", outcomes: [expected] });
      expect(JSON.parse(diagnostic)).toEqual({
        ...expected,
        ...(typeof result === "number"
          ? { httpStatus: result }
          : { transportCode: result === "ECONNRESET" ? result : "OTHER" }),
      });
      expect(diagnostic).not.toContain("private-error-secret");
      expect(diagnostic).not.toContain("openshell:resolve:");
    },
  );

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
    expect(script).toContain('transportCode: knownCodes.has(error.code) ? error.code : "OTHER"');
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
    expect(liveTarget).toContain('[SANDBOX_NAME, "rebuild", "--yes", "--force"]');
    expect(liveTarget).toContain("HOSTED_INFERENCE_PROVIDER_NAME");
    expect(liveTarget).toContain("HOSTED_INFERENCE_CREDENTIAL_ENV");
    expect(liveTarget).toContain("credential-window-source-sandbox-after-expired-rebuild");
    expect(liveTarget).toContain("parseOpenShellSandboxId");
    expect(liveTarget).toContain("Backing up sandbox state|Deleting old sandbox");
    expect(liveTarget).toContain('expect(providerName).toBe("e2e-cred-window-mcp-fake")');
    expect(liveTarget).toContain('!request.auth.includes("openshell:resolve:env")');
  });
});

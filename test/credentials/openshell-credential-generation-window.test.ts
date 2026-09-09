// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { MCP_BRIDGE_TEST_CREDENTIALS } from "../e2e/fixtures/mcp-bridge-credentials.ts";
import {
  buildCredentialWindowChildScript,
  buildCredentialWindowOneShotScript,
  buildCredentialWindowProviderUpdateArgs,
  CREDENTIAL_WINDOW_ENV_NAME,
  CREDENTIAL_WINDOW_PATHS,
  CREDENTIAL_WINDOW_REFRESH_COUNT,
  CREDENTIAL_WINDOW_STEPS,
  credentialWindowRequestId,
  credentialWindowSecrets,
} from "../e2e/live/openshell-credential-generation-window.ts";

describe("OpenShell 0.0.116 stable credential-handle proof", () => {
  it("exercises repeated token refreshes with unique scannable values", () => {
    const secrets = credentialWindowSecrets();

    expect(CREDENTIAL_WINDOW_REFRESH_COUNT).toBe(9);
    expect(secrets).toHaveLength(CREDENTIAL_WINDOW_REFRESH_COUNT + 3);
    expect(new Set(secrets).size).toBe(secrets.length);
    expect(
      secrets.every((secret) =>
        secret.startsWith(MCP_BRIDGE_TEST_CREDENTIALS.generationWindow),
      ),
    ).toBe(true);
  });

  it("keeps the old child on one stable handle while resolving each request at proxy time", () => {
    const script = buildCredentialWindowChildScript({
      mcpUrl: "https://credential-window.example.test/mcp",
      maxRuntimeMs: 12_345,
    });
    const snapshot =
      "const credentialPlaceholder = process.env[config.envName]";

    expect(script.split(snapshot)).toHaveLength(2);
    expect(script.indexOf(snapshot)).toBeLessThan(
      script.indexOf("while (Date.now() < deadline"),
    );
    expect(script).toContain(
      '"^openshell:resolve:env:(s[a-f0-9]{64})_" + config.envName + "$"',
    );
    expect(script).toContain(
      'authorization: "Bearer " + credentialPlaceholder',
    );
    expect(script).toContain(
      'response.statusCode === 200 ? "allowed" : "denied"',
    );
    expect(script).toContain('outbound.on("error", () => resolve("denied"))');
    expect(script).toContain("outbound.setTimeout(30_000");
    expect(script).toContain(
      JSON.stringify(CREDENTIAL_WINDOW_PATHS.acknowledgement),
    );
    expect(script).toContain(
      JSON.stringify(CREDENTIAL_WINDOW_STEPS.allowedAfterRefresh),
    );
    expect(script).toContain(
      JSON.stringify(CREDENTIAL_WINDOW_STEPS.allowedAfterRotations),
    );
    expect(script).toContain(
      JSON.stringify(CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRemoval),
    );
    expect(script).toContain(
      JSON.stringify(CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRestore),
    );
    expect(script).toContain(
      JSON.stringify(CREDENTIAL_WINDOW_STEPS.allowedBeforeDetach),
    );
    expect(script).toContain(
      JSON.stringify(CREDENTIAL_WINDOW_STEPS.deniedAfterDetach),
    );
    expect(script).toContain(
      JSON.stringify(CREDENTIAL_WINDOW_STEPS.deniedAfterReadd),
    );
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.stop));
    expect(script).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.generationWindow);
  });

  it("builds explicit attached-key refresh and removal updates", () => {
    expect(buildCredentialWindowProviderUpdateArgs("owned-provider")).toEqual([
      "provider",
      "update",
      "owned-provider",
      "--credential",
      "FAKE_MCP_SECRET",
    ]);
    expect(
      buildCredentialWindowProviderUpdateArgs("owned-provider", true),
    ).toEqual([
      "provider",
      "update",
      "owned-provider",
      "--credential",
      "FAKE_MCP_SECRET=",
    ]);
  });

  it("keeps fresh-exec requests stable-handle scoped and independently identifiable", () => {
    const script = buildCredentialWindowOneShotScript();

    expect(CREDENTIAL_WINDOW_ENV_NAME).toBe("FAKE_MCP_SECRET");
    expect(script).toContain("process.argv[1]");
    expect(script).toContain("process.argv[2]");
    expect(script).toContain(
      '"^openshell:resolve:env:(s[a-f0-9]{64})_" + config.envName + "$"',
    );
    expect(script).toContain(
      'authorization: "Bearer " + credentialPlaceholder',
    );
    expect(script).toContain("request.setTimeout(30_000");
    expect(
      credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.deniedAfterReadd),
    ).toBe("nemoclaw-credential-window:denied-after-readd");
    expect(script).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.generationWindow);
  });

  it("keeps the live target on the reviewed agent and mutation boundaries", () => {
    const liveTarget = fs.readFileSync(
      "test/e2e/live/openshell-credential-generation-window.test.ts",
      "utf8",
    );

    expect(liveTarget).toContain('NEMOCLAW_AGENT: "openclaw"');
    expect(liveTarget).toContain('"nemoclaw-start",');
    expect(liveTarget).toContain("CREDENTIAL_WINDOW_STEPS.allowedAfterRefresh");
    expect(liveTarget).toContain(
      "CREDENTIAL_WINDOW_STEPS.allowedAfterRotations",
    );
    expect(liveTarget).toContain(
      "CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRemoval",
    );
    expect(liveTarget).toContain(
      "CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRestore",
    );
    expect(liveTarget).toContain("CREDENTIAL_WINDOW_STEPS.allowedBeforeDetach");
    expect(liveTarget).toContain("CREDENTIAL_WINDOW_STEPS.deniedAfterDetach");
    expect(liveTarget).toContain("CREDENTIAL_WINDOW_STEPS.deniedAfterReadd");
    expect(liveTarget).toContain("RESTORED_CREDENTIAL_WINDOW_PATHS");
    expect(liveTarget).toContain(
      '[SANDBOX_NAME, "mcp", "remove", SERVER_NAME]',
    );
    expect(liveTarget).toMatch(
      /\[\s*SANDBOX_NAME,\s*"mcp",\s*"add",\s*SERVER_NAME,/u,
    );
    expect(liveTarget).not.toContain('["sandbox", "provider", "detach"');
    expect(liveTarget).toContain(
      '[SANDBOX_NAME, "mcp", "restart", SERVER_NAME]',
    );
    expect(liveTarget).toContain('[SANDBOX_NAME, "rebuild", "--yes"]');
    expect(liveTarget).toContain(
      '!request.auth.includes("openshell:resolve:env")',
    );
  });
});

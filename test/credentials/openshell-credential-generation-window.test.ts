// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import fs from "node:fs";
import vm from "node:vm";

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
  credentialWindowProviderDetachArgs,
  credentialWindowRequestId,
  credentialWindowSecrets,
  OPENSHELL_RETAINED_CREDENTIAL_GENERATIONS,
  parseCredentialWindowRequestObservation,
} from "../e2e/live/mcp-bridge-credential-generation-window.ts";

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
    expect(script).toContain("outbound.setTimeout(30_000");
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_PATHS.acknowledgement));
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.allowedBeforeExpiry));
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.deniedAfterExpiry));
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.fallbackAfterEviction));
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRemoval));
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.deniedAfterDetach));
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.fallbackAfterRestart));
    expect(script).toContain(JSON.stringify(CREDENTIAL_WINDOW_STEPS.stop));
    expect(script).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.generationWindow);
  });

  it("settles a request when the response closes before ending (#10155)", async () => {
    const writes = new Map<string, string>();
    let control: string = CREDENTIAL_WINDOW_STEPS.deniedAfterDetach;
    let stdout = "";
    let stderr = "";
    const script = buildCredentialWindowChildScript({
      mcpUrl: "https://credential-window.example.test/mcp",
      maxRuntimeMs: 10_000,
    });
    const response = Object.assign(new EventEmitter(), {
      readableEnded: false,
      resume: () => response,
      statusCode: 200,
    });
    const https = {
      request: (_options: unknown, onResponse: (value: typeof response) => void) => {
        const outbound = Object.assign(new EventEmitter(), {
          destroy: () => outbound,
          end: () => {
            onResponse(response);
            queueMicrotask(() => response.emit("close"));
            return outbound;
          },
          setTimeout: () => outbound,
        });
        return outbound;
      },
    };
    const fileSystem = {
      existsSync: () => true,
      readFileSync: () => control,
      writeFileSync: (file: string, value: string) => {
        writes.set(file, value);
        control =
          file === CREDENTIAL_WINDOW_PATHS.acknowledgement ? CREDENTIAL_WINDOW_STEPS.stop : control;
      },
    };
    const builtins = new Map<string, unknown>([
      ["node:fs", fileSystem],
      ["node:https", https],
    ]);
    const childProcess = {
      env: {
        [CREDENTIAL_WINDOW_ENV_NAME]: `openshell:resolve:env:v7_${CREDENTIAL_WINDOW_ENV_NAME}`,
      },
      exitCode: undefined as number | undefined,
      stderr: {
        write: (value: string) => {
          stderr += value;
          return true;
        },
      },
      stdout: {
        write: (value: string) => {
          stdout += value;
          return true;
        },
      },
    };

    await (vm.runInNewContext(script, {
      Buffer,
      URL,
      process: childProcess,
      queueMicrotask,
      require: (id: string) =>
        builtins.get(id) ??
        (() => {
          throw new Error(`unexpected child require: ${id}`);
        })(),
      setTimeout: (callback: () => void) => {
        queueMicrotask(callback);
        return 1;
      },
    }) as Promise<void>);

    const observation = {
      step: CREDENTIAL_WINDOW_STEPS.deniedAfterDetach,
      outcome: "denied",
      statusCode: null,
      errorCode: "PREMATURE_CLOSE",
    };
    expect(stderr).toBe("");
    expect(childProcess.exitCode).toBeUndefined();
    expect(JSON.parse(writes.get(CREDENTIAL_WINDOW_PATHS.acknowledgement) ?? "")).toEqual(
      observation,
    );
    expect(JSON.parse(stdout)).toEqual({ revision: "v7", outcomes: [observation] });
  });

  it("accepts bounded request diagnostics and rejects raw error text (#10155)", () => {
    expect(
      parseCredentialWindowRequestObservation(
        JSON.stringify({
          step: CREDENTIAL_WINDOW_STEPS.allowedBeforeExpiry,
          outcome: "allowed",
          statusCode: 200,
          errorCode: null,
        }),
      ),
    ).toEqual({
      step: CREDENTIAL_WINDOW_STEPS.allowedBeforeExpiry,
      outcome: "allowed",
      statusCode: 200,
      errorCode: null,
    });
    expect(
      parseCredentialWindowRequestObservation(
        JSON.stringify({
          step: CREDENTIAL_WINDOW_STEPS.deniedAfterExpiry,
          outcome: "denied",
          statusCode: 503,
          errorCode: null,
        }),
      ),
    ).toEqual({
      step: CREDENTIAL_WINDOW_STEPS.deniedAfterExpiry,
      outcome: "denied",
      statusCode: 503,
      errorCode: null,
    });
    expect(
      parseCredentialWindowRequestObservation(
        JSON.stringify({
          step: CREDENTIAL_WINDOW_STEPS.deniedAfterDetach,
          outcome: "denied",
          statusCode: null,
          errorCode: "ECONNRESET",
        }),
      ),
    ).toEqual({
      step: CREDENTIAL_WINDOW_STEPS.deniedAfterDetach,
      outcome: "denied",
      statusCode: null,
      errorCode: "ECONNRESET",
    });
    expect(
      parseCredentialWindowRequestObservation(
        JSON.stringify({
          step: CREDENTIAL_WINDOW_STEPS.deniedAfterDetach,
          outcome: "denied",
          statusCode: null,
          errorCode: "Error: fixture credential leaked",
        }),
      ),
    ).toBeNull();
    expect(
      parseCredentialWindowRequestObservation(
        JSON.stringify({
          step: CREDENTIAL_WINDOW_STEPS.allowedBeforeExpiry,
          outcome: "allowed",
          statusCode: 401,
          errorCode: null,
        }),
      ),
    ).toBeNull();
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

  it("scopes provider detach to the NemoClaw gateway (#10155)", () => {
    expect(credentialWindowProviderDetachArgs("sandbox", "provider")).toEqual([
      "sandbox",
      "provider",
      "detach",
      "-g",
      "nemoclaw",
      "sandbox",
      "provider",
    ]);
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
    expect(liveTarget).toContain("credentialWindowProviderDetachArgs(SANDBOX_NAME, providerName)");
    expect(liveTarget).toContain('[SANDBOX_NAME, "mcp", "restart", SERVER_NAME]');
    expect(liveTarget).toContain('[SANDBOX_NAME, "rebuild", "--yes"]');
    expect(liveTarget).toContain('!request.auth.includes("openshell:resolve:env")');
  });
});

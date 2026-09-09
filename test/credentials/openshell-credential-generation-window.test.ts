// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../e2e/fixtures/artifacts.ts";
import { HostCliClient } from "../e2e/fixtures/clients/host.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../e2e/fixtures/mcp-bridge-credentials.ts";
import { startTestProgress } from "../e2e/fixtures/progress.ts";
import { redactString } from "../e2e/fixtures/redaction.ts";
import { ShellProbe } from "../e2e/fixtures/shell-probe.ts";
import {
  buildCredentialWindowChildScript,
  buildCredentialWindowOneShotScript,
  buildCredentialWindowProviderUpdateArgs,
  captureCredentialWindowFailureDiagnostics,
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
  it("captures recent proxy logs once with bounded output and every fixture credential", async () => {
    const command = vi.fn().mockResolvedValue({ exitCode: 0 });
    const redactionValues = [
      MCP_BRIDGE_TEST_CREDENTIALS.compatibleEndpoint,
      ...credentialWindowSecrets(),
    ];
    const env = { OPENSHELL_GATEWAY: "fixture-gateway" };

    await captureCredentialWindowFailureDiagnostics(
      { command, openshellCommandPath: "/fixture/openshell" },
      {
        phaseCompleted: false,
        sandboxName: "e2e-cred-window",
        artifactName: "credential-window-expiry-failure-proxy-logs",
        env,
        redactionValues,
      },
    );

    expect(command).toHaveBeenCalledExactlyOnceWith(
      "/fixture/openshell",
      ["logs", "e2e-cred-window", "-n", "500", "--source", "all", "--since", "2m"],
      {
        artifactName: "credential-window-expiry-failure-proxy-logs",
        captureLimitBytes: 64 * 1024,
        env,
        redactionValues,
        timeoutMs: 30_000,
      },
    );
  });

  it("does not replace the scenario failure or retry when log capture throws", async () => {
    const command = vi.fn().mockRejectedValue(new Error("fixture log capture unavailable"));

    await expect(
      captureCredentialWindowFailureDiagnostics(
        { command, openshellCommandPath: "/fixture/openshell" },
        {
          phaseCompleted: false,
          sandboxName: "e2e-cred-window",
          artifactName: "credential-window-expiry-failure-proxy-logs",
          env: {},
          redactionValues: credentialWindowSecrets(),
        },
      ),
    ).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("does not collect logs after a completed credential phase", async () => {
    const command = vi.fn();

    await captureCredentialWindowFailureDiagnostics(
      { command, openshellCommandPath: "/fixture/openshell" },
      {
        phaseCompleted: true,
        sandboxName: "e2e-cred-window",
        artifactName: "credential-window-expiry-failure-proxy-logs",
        env: {},
        redactionValues: credentialWindowSecrets(),
      },
    );

    expect(command).not.toHaveBeenCalled();
  });

  it("persists bounded proxy reasons and addresses while redacting every credential from both streams", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-credential-window-logs-"));
    try {
      const redactionValues = [
        MCP_BRIDGE_TEST_CREDENTIALS.compatibleEndpoint,
        ...credentialWindowSecrets(),
      ];
      const diagnostic = JSON.stringify({
        reason: "policy_denied",
        binary: "/usr/bin/node",
        host: "credential-window.example.test",
        resolved_address: "104.16.230.132",
        credentials: redactionValues,
      });
      const openshellPath = path.join(rootDir, "openshell-fixture");
      fs.writeFileSync(
        openshellPath,
        `#!${process.execPath}\n` +
          `process.stdout.write("o".repeat(96 * 1024) + "\\n" + ${JSON.stringify(diagnostic)} + "\\n");\n` +
          `process.stderr.write("e".repeat(96 * 1024) + "\\n" + ${JSON.stringify(diagnostic)} + "\\n");\n` +
          "process.exitCode = 1;\n",
        { mode: 0o700 },
      );
      const artifacts = new ArtifactSink(path.join(rootDir, "artifacts"));
      await artifacts.ensureRoot();
      const probe = new ShellProbe({
        artifacts,
        progress: startTestProgress(
          "credential-window diagnostics",
          ["capture logs", "verify redacted evidence"],
          { logLine: () => undefined },
        ),
        redact: redactString,
        signal: new AbortController().signal,
      });

      await captureCredentialWindowFailureDiagnostics(new HostCliClient(probe, { openshellPath }), {
        phaseCompleted: false,
        sandboxName: "e2e-cred-window",
        artifactName: "failure-proxy-logs",
        env: {},
        redactionValues,
      });

      const [stdout, stderr, resultText] = ["stdout.txt", "stderr.txt", "result.json"].map(
        (suffix) =>
          fs.readFileSync(
            path.join(artifacts.rootDir, "shell", `failure-proxy-logs.${suffix}`),
            "utf8",
          ),
      );
      expect(
        [stdout, stderr].every((stream) => Buffer.byteLength(stream!) <= 64 * 1024 + 256),
      ).toBe(true);
      expect([stdout, stderr].every((stream) => stream!.includes("[shell-probe omitted "))).toBe(
        true,
      );
      expect(
        [stdout, stderr].map((stream) => JSON.parse(stream!.trim().split("\n").at(-1)!)),
      ).toEqual([
        expect.objectContaining({
          reason: "policy_denied",
          binary: "/usr/bin/node",
          host: "credential-window.example.test",
          resolved_address: "104.16.230.132",
        }),
        expect.objectContaining({
          reason: "policy_denied",
          binary: "/usr/bin/node",
          host: "credential-window.example.test",
          resolved_address: "104.16.230.132",
        }),
      ]);
      expect(
        redactionValues.some((secret) => [stdout, stderr, resultText].join("\n").includes(secret)),
      ).toBe(false);
      expect(JSON.parse(resultText!)).toMatchObject({ exitCode: 1, timedOut: false });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

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
    expect(script).toContain('outbound.on("error", () => resolve("denied"))');
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
    expect(liveTarget).toContain('expect(providerName).toBe("e2e-cred-window-mcp-fake")');
    expect(liveTarget).toContain('!request.auth.includes("openshell:resolve:env")');
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CleanupRegistry } from "../fixtures/cleanup.ts";
import {
  buildIssue4462DiagnosticsCommand,
  captureIssue4462FailureDiagnostics,
  trackIssue4462FailureDiagnostics,
} from "../fixtures/issue-4462-diagnostics.ts";

describe("pairing failure evidence", () => {
  it("invokes structured auto-pair and gateway diagnostics with fixed arguments (#9844)", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0 }));

    await captureIssue4462FailureDiagnostics({ exec } as never, {
      env: { PATH: "/usr/bin" },
      redactionValues: ["secret-api-key"],
      sandboxName: "issue-4462",
    });

    expect(exec).toHaveBeenCalledExactlyOnceWith(
      "issue-4462",
      ["node", "-e", expect.any(String), "/tmp/auto-pair.log", "/tmp/gateway.log"],
      expect.objectContaining({
        artifactName: "failure-openclaw-pairing-diagnostics",
        redactionValues: ["secret-api-key"],
      }),
    );
  });

  it("emits only structured allowlisted diagnostics from secret-bearing logs (#9844)", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-issue4462-diagnostics-"));
    const autoPairPath = join(fixtureRoot, "auto-pair.log");
    const gatewayPath = join(fixtureRoot, "gateway.log");
    const secrets = [
      "runtime-generated-gateway-token",
      "nvapi-secret-value",
      "opaque-runtime-secret-value",
      "private-operator-message",
      "cookie-session-secret",
      "set-cookie-auth-secret",
      "generic-query-key-secret",
      "plain-password-secret",
      "plain-secret-value",
      "plain-token-secret",
      "github_pat_secret-value",
      "private-key-shaped-secret",
    ];

    try {
      writeFileSync(
        autoPairPath,
        `[auto-pair] stage=request-creation waiting reason=no-request token=${secrets[0]}\n` +
          `[auto-pair] stage=listing failed reason=invalid-response password=${secrets[7]}\n` +
          `[auto-pair] stage=validation accepted request=request-secret reason=allowlisted-request\n` +
          `[auto-pair] stage=approval failed reason=command-failed secret=${secrets[8]}\n` +
          `[auto-pair] stage=approval failed reason=timeout token=${secrets[9]}\n` +
          `[auto-pair] stage=watcher-execution failed error=RuntimeError\n` +
          `[auto-pair] approve failed request=request-secret: [auto-pair] stage=validation rejected reason=malformed-request-id token=${secrets[9]}\n` +
          `unknown raw line secret=${secrets[8]}\n`,
      );
      writeFileSync(
        gatewayPath,
        `pairing required Authorization: Bearer ${secrets[0]}\n` +
          `scope upgrade pending approval x-api-key=${secrets[1]}\n` +
          `${JSON.stringify({ Authorization: secrets[2], message: secrets[3] })}\n` +
          `Cookie: session=${secrets[4]}\nSet-Cookie: auth=${secrets[5]}\n` +
          `https://example.invalid/?key=${secrets[6]} password=${secrets[7]}\n` +
          `secret=${secrets[8]} token=${secrets[9]} ${secrets[10]}\n` +
          `${JSON.stringify({ privateKey: secrets[11] })}\n` +
          `device pairing approval denied\ngateway unavailable\n`,
      );
      const [command, ...args] = buildIssue4462DiagnosticsCommand([autoPairPath, gatewayPath]);
      const result = spawnSync(command, args, { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 1,
        autoPair: {
          readable: true,
          events: [
            { stage: "request-creation", outcome: "waiting", reason: "no-request" },
            { stage: "listing", outcome: "failed", reason: "invalid-response" },
            { stage: "validation", outcome: "accepted", reason: "allowlisted-request" },
            { stage: "approval", outcome: "failed", reason: "command-failed" },
            { stage: "approval", outcome: "failed", reason: "timeout" },
            { stage: "watcher-execution", outcome: "failed" },
          ],
        },
        gateway: {
          readable: true,
          signals: {
            pairingRequired: 1,
            scopeUpgradePending: 1,
            pairingApprovalDenied: 1,
            gatewayUnavailable: 1,
          },
        },
      });
      expect(secrets.some((secret) => result.stdout.includes(secret))).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("marks missing logs unreadable without emitting their paths (#9844)", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-issue4462-diagnostics-"));
    const autoPairPath = join(fixtureRoot, "auto-pair.log");
    const gatewayPath = join(fixtureRoot, "gateway.log");

    try {
      const [command, ...args] = buildIssue4462DiagnosticsCommand([autoPairPath, gatewayPath]);
      const result = spawnSync(command, args, { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 1,
        autoPair: { readable: false, events: [] },
        gateway: {
          readable: false,
          signals: {
            pairingRequired: 0,
            scopeUpgradePending: 0,
            pairingApprovalDenied: 0,
            gatewayUnavailable: 0,
          },
        },
      });
      expect(result.stdout).not.toContain(autoPairPath);
      expect(result.stdout).not.toContain(gatewayPath);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails closed with a fixed record when diagnostics inputs are invalid (#9844)", () => {
    const [command, ...args] = buildIssue4462DiagnosticsCommand([]);
    const result = spawnSync(command, args, { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('{"schemaVersion":1,"status":"unavailable"}\n');
    expect(result.stderr).toBe("");
  });

  it("preserves the primary failure through unavailable diagnostic cleanup (#9844)", async () => {
    const cleanup = new CleanupRegistry();
    const exec = vi.fn(async () => {
      throw new Error("sandbox not found");
    });
    trackIssue4462FailureDiagnostics(cleanup, { exec } as never, "issue-4462", {}, []);
    const primaryFailure = new Error("sentinel primary failure");
    let observedFailure: unknown;

    try {
      throw primaryFailure;
    } catch (error) {
      observedFailure = error;
    } finally {
      expect(await cleanup.runAll()).toEqual({
        failures: [],
        passed: ["capture OpenClaw pairing failure diagnostics"],
      });
    }

    expect(observedFailure).toBe(primaryFailure);
    expect(exec).toHaveBeenCalledOnce();
  });
});

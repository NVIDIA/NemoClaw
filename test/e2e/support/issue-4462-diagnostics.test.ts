// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildIssue4462DiagnosticsCommand,
  captureIssue4462FailureDiagnostics,
} from "../fixtures/issue-4462-diagnostics.ts";

describe("pairing failure evidence", () => {
  it("captures redacted auto-pair and gateway logs before cleanup (#9844)", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0 }));

    await captureIssue4462FailureDiagnostics({ exec } as never, {
      env: { PATH: "/usr/bin" },
      redactionValues: ["secret-api-key"],
      sandboxName: "issue-4462",
    });

    expect(exec).toHaveBeenCalledExactlyOnceWith(
      "issue-4462",
      expect.arrayContaining([
        "node",
        "-e",
        expect.any(String),
        "/sandbox/.openclaw/openclaw.json",
        "/tmp/auto-pair.log",
        "/tmp/gateway.log",
      ]),
      expect.objectContaining({
        artifactName: "failure-openclaw-pairing-diagnostics",
        redactionValues: ["secret-api-key"],
      }),
    );
  });

  it("redacts runtime and patterned secrets before emitting log content (#9844)", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-issue4462-diagnostics-"));
    const configPath = join(fixtureRoot, "openclaw.json");
    const autoPairPath = join(fixtureRoot, "auto-pair.log");
    const gatewayPath = join(fixtureRoot, "gateway.log");
    const gatewayToken = "runtime-generated-gateway-token";
    const inferenceKey = "nvapi-secret-value";
    const jsonAuthorization = "opaque-runtime-secret-value";
    const privateMessage = "private operator message";

    try {
      writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: gatewayToken } } }));
      writeFileSync(
        autoPairPath,
        `[auto-pair] stage=request-creation waiting reason=no-request token=${gatewayToken}\n`,
      );
      writeFileSync(
        gatewayPath,
        `Authorization: Bearer ${gatewayToken}\nx-api-key=${inferenceKey}\n` +
          `${JSON.stringify({ Authorization: jsonAuthorization, message: privateMessage })}\n`,
      );
      const [command, ...args] = buildIssue4462DiagnosticsCommand(configPath, [
        autoPairPath,
        gatewayPath,
      ]);
      const result = spawnSync(command, args, { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("stage=request-creation waiting reason=no-request");
      expect(result.stdout).toContain("[REDACTED_OPENCLAW_GATEWAY_TOKEN]");
      expect(result.stdout).toContain("[REDACTED_NVIDIA_INFERENCE_API_KEY]");
      expect(result.stdout).toContain('"Authorization":"[REDACTED_AUTHORIZATION]"');
      expect(result.stdout).toContain('"message":"[REDACTED_TEXT]"');
      expect(result.stdout).not.toContain(gatewayToken);
      expect(result.stdout).not.toContain(inferenceKey);
      expect(result.stdout).not.toContain(jsonAuthorization);
      expect(result.stdout).not.toContain(privateMessage);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("emits no log content when gateway-token redaction cannot be established (#9844)", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-issue4462-diagnostics-"));
    const configPath = join(fixtureRoot, "openclaw.json");
    const autoPairPath = join(fixtureRoot, "auto-pair.log");
    const secret = "must-not-escape";

    try {
      writeFileSync(configPath, "{}");
      writeFileSync(autoPairPath, `raw secret ${secret}\n`);
      const [command, ...args] = buildIssue4462DiagnosticsCommand(configPath, [autoPairPath]);
      const result = spawnSync(command, args, { encoding: "utf8" });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe(
        "pairing diagnostics unavailable: redaction prerequisites failed\n",
      );
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("preserves the primary failure when the sandbox is already unavailable (#9844)", async () => {
    const exec = vi.fn(async () => {
      throw new Error("sandbox not found");
    });

    await expect(
      captureIssue4462FailureDiagnostics({ exec } as never, {
        env: {},
        redactionValues: [],
        sandboxName: "issue-4462",
      }),
    ).resolves.toBeUndefined();
  });
});

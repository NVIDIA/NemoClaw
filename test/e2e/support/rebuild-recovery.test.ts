// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  readInterruptedRebuildEvidence,
  startRebuildAtDurableBoundary,
} from "../fixtures/rebuild-recovery.ts";

const roots: string[] = [];
const sandboxName = "e2e-sandbox-rebuild-test";
const transactionId = "11111111-1111-4111-8111-111111111111";
const fingerprintA = `sha256:${"a".repeat(64)}`;
const fingerprintB = `sha256:${"b".repeat(64)}`;
const fingerprintC = `sha256:${"c".repeat(64)}`;

function createHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-rebuild-recovery-"));
  roots.push(home);
  return home;
}

function statePaths(home: string) {
  const transactionStem = crypto.createHash("sha256").update(sandboxName).digest("hex");
  return {
    transaction: path.join(
      home,
      ".nemoclaw",
      "state",
      "rebuild-transactions",
      `${transactionStem}.json`,
    ),
    registry: path.join(home, ".nemoclaw", "sandboxes.json"),
    session: path.join(home, ".nemoclaw", "onboard-session.json"),
  };
}

function writeState(home: string): void {
  const paths = statePaths(home);
  for (const file of Object.values(paths)) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    paths.transaction,
    JSON.stringify({
      version: 1,
      transactionId,
      revision: 2,
      status: "active",
      phase: "old_deleted",
      intent: {
        sandboxName,
        target: {
          provider: "secret-provider-name",
          model: "secret-model-name",
          credentialEnv: "SECRET_API_KEY",
          endpointUrl: "https://secret.invalid/token",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          imageFingerprint: fingerprintA,
          configurationFingerprint: fingerprintB,
        },
      },
      receipts: {
        backup: { manifestTimestamp: "2026-07-09T00-00-00-000Z" },
        oldSandboxDeletion: { observedAt: "2026-07-09T00:01:00.000Z" },
      },
      createdAt: "2026-07-09T00:00:00.000Z",
      completedAt: null,
    }),
  );
  fs.writeFileSync(
    paths.registry,
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          agentVersion: "2026.7.1",
        },
      },
    }),
  );
  fs.writeFileSync(
    paths.session,
    JSON.stringify({
      sandboxName,
      metadata: {
        rebuild: {
          transactionId,
          imageFingerprint: fingerprintA,
          configurationFingerprint: fingerprintB,
          replacementFingerprint: fingerprintC,
        },
      },
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("live rebuild interruption evidence", () => {
  it("returns control only after the guarded child is stopped and captures SIGKILL (#6437)", async () => {
    const home = createHome();
    const command = path.join(home, "fake-nemoclaw");
    const secret = "fixture-secret-value";
    fs.writeFileSync(
      command,
      `#!/usr/bin/env node
const phase = process.env.NEMOCLAW_E2E_FORCE_FAIL_AT_STEP.replace("rebuild_", "");
const marker = "[e2e] Rebuild interruption point '" + phase + "' (pid " + process.pid + ").";
const output = "x".repeat(300000) + process.env.INJECTED_SECRET + "\\n" + marker + "\\n";
process.stderr.write(output, () => {
  process.kill(process.pid, "SIGSTOP");
  setInterval(() => undefined, 1000);
});
`,
      { mode: 0o755 },
    );
    const artifacts = new ArtifactSink(path.join(home, "artifacts"), [secret]);

    const paused = await startRebuildAtDurableBoundary({
      artifacts,
      artifactName: "process-death",
      commandPath: command,
      env: { HOME: home, PATH: process.env.PATH, INJECTED_SECRET: secret },
      phase: "old_deleted",
      redact: (text) => text.replaceAll(secret, "[REDACTED]"),
      sandboxName,
      timeoutMs: 10_000,
    });

    expect(
      execFileSync("ps", ["-o", "stat=", "-p", String(paused.pid)], {
        encoding: "utf8",
      }).trim(),
    ).toMatch(/^T/u);
    await expect(paused.kill()).resolves.toMatchObject({ signal: "SIGKILL" });
    const stderr = fs.readFileSync(
      path.join(artifacts.rootDir, "process-death.stderr.txt"),
      "utf8",
    );
    expect(stderr).toContain("[earlier output truncated]");
    expect(stderr).toContain("[REDACTED]");
    expect(stderr).not.toContain(secret);
    expect(stderr.length).toBeLessThanOrEqual(256 * 1024);
  }, 15_000);

  it("projects only allow-listed recovery identity at replacement_unjournaled (#6437)", () => {
    const home = createHome();
    writeState(home);

    const evidence = readInterruptedRebuildEvidence(sandboxName, "replacement_unjournaled", home);
    const serialized = JSON.stringify(evidence);

    expect(evidence).toMatchObject({
      transactionId,
      status: "active",
      phase: "old_deleted",
      receipts: { backup: true, oldSandboxDeletion: true, replacement: false },
      target: {
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        imageFingerprint: fingerprintA,
        configurationFingerprint: fingerprintB,
      },
      replacement: {
        sessionTransactionId: transactionId,
        replacementFingerprint: fingerprintC,
      },
    });
    expect(serialized).not.toContain("secret-provider-name");
    expect(serialized).not.toContain("secret-model-name");
    expect(serialized).not.toContain("SECRET_API_KEY");
    expect(serialized).not.toContain("secret.invalid");
  });
});

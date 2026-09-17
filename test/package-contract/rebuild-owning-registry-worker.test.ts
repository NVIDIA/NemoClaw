// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { rebuildOwningRegistryDependencies } from "../../dist/lib/actions/sandbox/rebuild/owning-registry";

const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";
const TIMESTAMP = "2026-09-17T00-00-00-000Z";

afterEach(() => {
  vi.unstubAllEnvs();
});

function writeRecoveryFixture(home: string): void {
  const backupPath = path.join(
    home,
    ".nemoclaw",
    "gateways",
    "9000",
    "rebuild-backups",
    "alpha",
    TIMESTAMP,
  );
  fs.mkdirSync(backupPath, { recursive: true, mode: 0o700 });
  const policy = "version: 1\nprocess:\n  environment:\n    SERVICE_API_KEY: retained\n";
  const sha256 = createHash("sha256").update(policy).digest("hex");
  const handoffPath = path.join(backupPath, `rebuild-policy-handoff.${sha256}.yaml`);
  fs.writeFileSync(handoffPath, policy, { mode: 0o600 });
  fs.writeFileSync(
    path.join(backupPath, "rebuild-manifest.json"),
    JSON.stringify({
      version: 1,
      sandboxName: "alpha",
      timestamp: TIMESTAMP,
      agentType: "openclaw",
      agentVersion: null,
      expectedVersion: null,
      stateDirs: [],
      backupComplete: true,
      dir: "/sandbox/.openclaw",
      backupPath,
      blueprintDigest: null,
      rebuildPolicyHandoff: { file: path.basename(handoffPath), sha256 },
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(backupPath, ".nemoclaw-rebuild-recovery.json"),
    `${JSON.stringify({
      schemaVersion: 3,
      transactionId: TRANSACTION_ID,
      sandboxName: "alpha",
      backupTimestamp: TIMESTAMP,
      gatewayName: "nemoclaw-9000",
      gatewayPort: 9000,
      phase: "restore",
    })}\n`,
    { mode: 0o600 },
  );
}

function writeBlockingOpenShell(home: string, descendantMarker: string): string {
  const executable = path.join(home, "blocking-openshell.cjs");
  fs.writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      `fs.writeFileSync(${JSON.stringify(descendantMarker)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    { mode: 0o755 },
  );
  return executable;
}

function writeSiblingRegistry(home: string): void {
  const stateRoot = path.join(home, ".nemoclaw", "gateways", "9000");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(stateRoot, "sandboxes.json"),
    `${JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: {
          name: "alpha",
          provider: "ollama-local",
          model: "nvidia/nemotron",
          agent: "openclaw",
          nemoclawVersion: "0.1.0",
          dashboardPort: 18_789,
          gatewayName: "nemoclaw-9000",
          gatewayPort: 9000,
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
}

describe("compiled rebuild owning-registry worker", () => {
  it("executes the real pipeline and preserves its bounded failure", async () => {
    const expectedMessage = "toolDisclosure must be one of: progressive, direct.";
    let failure: unknown;

    try {
      await rebuildOwningRegistryDependencies.runWorker(
        {
          operation: "rebuild",
          sandboxName: "alpha",
          options: { yes: true, toolDisclosure: "invalid" } as never,
          executionOptions: {},
        },
        9000,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(expectedMessage);
    expect((failure as Error).cause).toEqual({
      ok: false,
      operation: "rebuild",
      sandboxName: "alpha",
      gatewayPort: 9000,
      message: expectedMessage,
    });
  });

  it("rejects invalid descriptor input before the rebuild pipeline boundary", async () => {
    await expect(
      rebuildOwningRegistryDependencies.runWorker(
        {
          operation: "rebuild",
          sandboxName: "alpha",
          options: null,
          executionOptions: {},
        } as never,
        9000,
      ),
    ).rejects.toThrow();
  });

  it("binds a valid rebuild descriptor to the selected sibling registry root", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-worker-sibling-root-"));
    try {
      writeSiblingRegistry(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE", "1");
      vi.stubEnv("DOCKER_HOST", `unix://${path.join(home, "missing-docker.sock")}`);
      vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", path.join(home, "missing-openshell"));
      let failure: unknown;

      try {
        await rebuildOwningRegistryDependencies.runWorker(
          {
            operation: "rebuild",
            sandboxName: "alpha",
            options: { yes: true },
            executionOptions: {},
          },
          9000,
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Replacement onboarding preflight failed");
      expect((failure as Error).cause).toEqual(
        expect.objectContaining({
          ok: false,
          operation: "rebuild",
          sandboxName: "alpha",
          gatewayPort: 9000,
          message: "Replacement onboarding preflight failed",
        }),
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("terminates an unresponsive worker with an unknown-outcome recovery diagnostic", async () => {
    await expect(
      rebuildOwningRegistryDependencies.runWorker(
        {
          operation: "retire-recovery",
          sandboxName: "alpha",
          transactionId: "11111111-1111-4111-8111-111111111111",
          confirmDataRecovered: true,
        },
        9000,
        { timeoutMs: 1 },
      ),
    ).rejects.toThrow(
      "Delegated recovery retirement for sandbox 'alpha' on owning gateway port 9000 exceeded its 1 ms deadline. The worker was terminated, but the operation outcome is unknown. NemoClaw did not remove retained recovery state; inspect the sandbox and recovery state before retrying.",
    );
  });

  it("terminates worker descendants before reporting an unknown recovery outcome", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-worker-process-group-"));
    const descendantMarker = path.join(home, "descendant.pid");
    let descendantPid: number | undefined;
    try {
      writeRecoveryFixture(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", writeBlockingOpenShell(home, descendantMarker));

      await expect(
        rebuildOwningRegistryDependencies.runWorker(
          {
            operation: "retire-recovery",
            sandboxName: "alpha",
            transactionId: TRANSACTION_ID,
            confirmDataRecovered: true,
          },
          9000,
          { timeoutMs: 3_000, terminationGraceMs: 100 },
        ),
      ).rejects.toThrow("The worker was terminated, but the operation outcome is unknown.");

      descendantPid = Number(fs.readFileSync(descendantMarker, "utf8"));
      expect(() => process.kill(descendantPid!, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    } finally {
      try {
        process.kill(descendantPid as number, "SIGKILL");
      } catch {
        // The process group cleanup succeeded or the marker was never written.
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

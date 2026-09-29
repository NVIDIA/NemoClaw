// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { rebuildOwningRegistryDependencies } from "../../dist/lib/actions/sandbox/rebuild/owning-registry";
import { withSandboxLifecycleLock } from "../../dist/lib/actions/sandbox/lifecycle/lock";
import { testTimeout } from "../helpers/timeouts";

const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";
const TIMESTAMP = "2026-09-17T00-00-00-000Z";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function writeRecoveryFixture(home: string) {
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
  const manifest = {
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
  };
  fs.writeFileSync(path.join(backupPath, "rebuild-manifest.json"), JSON.stringify(manifest), {
    mode: 0o600,
  });
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
  return manifest;
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

function writeCredentialProbeOpenShell(home: string, marker: string): string {
  const executable = path.join(home, "credential-probe-openshell.cjs");
  fs.writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(marker)}, String(process.ppid));`,
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    { mode: 0o755 },
  );
  return executable;
}

function writeMissingSandboxOpenShell(home: string): string {
  const executable = path.join(home, "missing-sandbox-openshell.cjs");
  fs.writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'if (process.argv[2] === "sandbox" && process.argv[3] === "get") {',
      '  console.error("no such sandbox alpha");',
      "}",
      "process.exitCode = 1;",
    ].join("\n"),
    { mode: 0o755 },
  );
  return executable;
}

function writeSiblingRegistry(
  home: string,
  entryOverrides: Readonly<Record<string, unknown>> = {},
): void {
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
          dashboardPort: 18_789,
          gatewayName: "nemoclaw-9000",
          gatewayPort: 9000,
          ...entryOverrides,
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

  it("rejects delegated worker startup on unsupported native Windows", () => {
    expect(() => rebuildOwningRegistryDependencies.assertWorkerPlatformSupported("win32")).toThrow(
      "Delegated owning-registry rebuild work is unsupported on native Windows. Run NemoClaw inside WSL.",
    );
  });

  it.runIf(process.platform === "linux")(
    "forwards only allowlisted credentials into the delegated rebuild consumer",
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-worker-credential-"));
      const marker = path.join(home, "credential-probe.json");
      let worker: Promise<void> | undefined;
      try {
        const recoveryManifest = writeRecoveryFixture(home);
        writeSiblingRegistry(home, {
          provider: "build",
          credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        });
        vi.stubEnv("HOME", home);
        vi.stubEnv("NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE", "1");
        vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", writeCredentialProbeOpenShell(home, marker));
        vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "nvapi-worker-test-value");
        vi.stubEnv("OPENAI_API_KEY", "openai-unrelated-test-value");
        vi.stubEnv("UNRELATED_REBUILD_SECRET", "must-not-cross-worker-boundary");

        worker = rebuildOwningRegistryDependencies.runWorker(
          {
            operation: "rebuild",
            sandboxName: "alpha",
            options: { yes: true },
            executionOptions: {
              recoveryManifest,
              allowLegacyManagedImageRecovery: true,
            },
          },
          9000,
          {
            credentialEnvNames: ["NVIDIA_INFERENCE_API_KEY"],
            timeoutMs: 3_000,
            terminationGraceMs: 100,
          },
        );

        await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), { timeout: 2_000 });
        const workerPid = Number(fs.readFileSync(marker, "utf8"));
        const workerEnvironment = fs
          .readFileSync(`/proc/${String(workerPid)}/environ`, "utf8")
          .split("\0");

        expect(workerEnvironment).toContain("NVIDIA_INFERENCE_API_KEY=nvapi-worker-test-value");
        expect(workerEnvironment).not.toContain("OPENAI_API_KEY=openai-unrelated-test-value");
        expect(workerEnvironment).not.toContain(
          "UNRELATED_REBUILD_SECRET=must-not-cross-worker-boundary",
        );
        await expect(worker).rejects.toThrow(
          "The worker was terminated, but the operation outcome is unknown.",
        );
      } finally {
        await worker?.catch(() => undefined);
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("binds a valid rebuild descriptor to the selected sibling registry root", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-worker-sibling-root-"));
    try {
      writeSiblingRegistry(home);
      const recoveryManifest = writeRecoveryFixture(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE", "1");
      let failure: unknown;

      try {
        await rebuildOwningRegistryDependencies.runWorker(
          {
            operation: "rebuild",
            sandboxName: "alpha",
            options: { yes: true },
            executionOptions: { recoveryManifest },
          },
          9000,
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        "Recovery registry entry has no NemoClaw-managed image fingerprint.",
      );
      expect((failure as Error).cause).toEqual(
        expect.objectContaining({
          ok: false,
          operation: "rebuild",
          sandboxName: "alpha",
          gatewayPort: 9000,
          message: "Recovery registry entry has no NemoClaw-managed image fingerprint.",
        }),
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("waits for the owning sandbox lifecycle lock before retiring recovery", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-worker-retirement-lock-"));
    let releaseLock: () => void = vi.fn();
    try {
      const manifest = writeRecoveryFixture(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", writeMissingSandboxOpenShell(home));
      const stateDir = path.join(home, ".nemoclaw", "gateways", "9000");
      let markLockHeld: () => void = vi.fn();
      const lockHeld = new Promise<void>((resolve) => {
        markLockHeld = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const holder = withSandboxLifecycleLock(
        "alpha",
        async () => {
          markLockHeld();
          await release;
        },
        { stateDir },
      );
      await lockHeld;

      const worker = rebuildOwningRegistryDependencies.runWorker(
        {
          operation: "retire-recovery",
          sandboxName: "alpha",
          transactionId: TRANSACTION_ID,
          confirmDataRecovered: true,
        },
        9000,
      );

      const outcome = await Promise.race([
        worker.then(() => "completed" as const),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 250)),
      ]);
      expect(outcome).toBe("waiting");
      expect(
        fs.existsSync(path.join(manifest.backupPath, manifest.rebuildPolicyHandoff.file)),
      ).toBe(true);

      releaseLock();
      await holder;
      await worker;
      expect(
        fs.existsSync(path.join(manifest.backupPath, manifest.rebuildPolicyHandoff.file)),
      ).toBe(false);
    } finally {
      releaseLock();
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

  it(
    "reaps a delegated worker process group before preserving parent SIGINT semantics",
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-worker-sigint-"));
      const descendantMarker = path.join(home, "descendant.pid");
      const modulePath = path.join(
        import.meta.dirname,
        "../../dist/lib/actions/sandbox/rebuild/owning-registry.js",
      );
      let descendantPid: number | undefined;
      writeRecoveryFixture(home);
      const harness = spawn(
        process.execPath,
        [
          "-e",
          [
            `const { rebuildOwningRegistryDependencies } = require(${JSON.stringify(modulePath)});`,
            "void rebuildOwningRegistryDependencies.runWorker(",
            `  { operation: "retire-recovery", sandboxName: "alpha", transactionId: ${JSON.stringify(TRANSACTION_ID)}, confirmDataRecovered: true },`,
            "  9000,",
            "  { timeoutMs: 30000, terminationGraceMs: 100 },",
            ").catch((error) => { console.error(error); process.exitCode = 1; });",
          ].join("\n"),
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            NEMOCLAW_OPENSHELL_BIN: writeBlockingOpenShell(home, descendantMarker),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const output: Buffer[] = [];
      harness.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      harness.stderr.on("data", (chunk: Buffer) => output.push(chunk));
      const exited = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
        (resolve, reject) => {
          harness.once("error", reject);
          harness.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      try {
        await vi.waitFor(() => expect(fs.existsSync(descendantMarker)).toBe(true), {
          timeout: testTimeout(20_000),
        });
        descendantPid = Number(fs.readFileSync(descendantMarker, "utf8"));

        expect(harness.kill("SIGINT")).toBe(true);
        await expect(exited).resolves.toEqual({ code: null, signal: "SIGINT" });
        expect(() => process.kill(descendantPid!, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } catch (error) {
        throw new Error(`${String(error)}\n${Buffer.concat(output).toString("utf8")}`);
      } finally {
        harness.kill("SIGKILL");
        try {
          process.kill(descendantPid as number, "SIGKILL");
        } catch {
          // The delegated worker cleanup succeeded or the marker was never written.
        }
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    testTimeout(30_000),
  );

  it("reports an unreaped worker as potentially active", async () => {
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) =>
      pid < 0 && signal === 0 ? true : kill(pid, signal),
    );

    await expect(
      rebuildOwningRegistryDependencies.runWorker(
        {
          operation: "retire-recovery",
          sandboxName: "alpha",
          transactionId: TRANSACTION_ID,
          confirmDataRecovered: true,
        },
        9000,
        { timeoutMs: 1, terminationGraceMs: 1 },
      ),
    ).rejects.toThrow(
      /Delegated recovery retirement for sandbox 'alpha' on owning gateway port 9000 exceeded its 1 ms deadline\. Termination is unconfirmed for worker PID \d+, so the worker or one of its descendants may still be active and the operation outcome is unknown\. NemoClaw did not remove retained recovery state; inspect that worker, the sandbox, and recovery state before retrying\./,
    );
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const sessionPath = require.resolve("./onboard-session");
const originalHome = process.env.HOME;
type OnboardSessionModule = typeof import("./onboard-session");
let session: OnboardSessionModule;
let tempHome: string;

function restoreHome(): boolean {
  return originalHome === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", originalHome);
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-lock-process-"));
  process.env.HOME = tempHome;
  delete require.cache[sessionPath];
  session = require("./onboard-session");
  session.releaseOnboardLock();
});

afterEach(() => {
  session.releaseOnboardLock();
  delete require.cache[sessionPath];
  fs.rmSync(tempHome, { recursive: true, force: true });
  restoreHome();
});

describe("cross-process onboard lock", () => {
  it("releases its lock when legacy-state migration already owns the handshake", () => {
    const migrationLock = path.join(tempHome, ".nemoclaw", ".gateway-state-migration.lock");
    fs.mkdirSync(migrationLock, { recursive: true });

    expect(session.acquireOnboardLock("nemoclaw onboard").acquired).toBe(false);
    expect(fs.existsSync(session.LOCK_FILE)).toBe(false);
  });

  it("rejects caller-asserted onboarding lock ownership without a live descriptor (#9833)", async () => {
    const authority = await import("../onboard/portable-retirement-authority");

    expect(() =>
      authority.beginPortableOnboardRetirementEntry({
        alreadyHeld: true,
        command: "nemoclaw onboard --resume",
        displayName: "NemoClaw",
        homeDir: tempHome,
        loadRegistry: () => ({ defaultSandbox: null, sandboxes: {} }),
        registryFile: path.join(tempHome, ".nemoclaw", "registry.json"),
        sessionFile: session.SESSION_FILE,
        withLifecycleLock: async (_sandboxName, operation) => await operation(),
      }),
    ).toThrow(/does not own.*onboarding lock/u);
  });

  it("updates under a caller-owned onboard lock without releasing it", () => {
    session.saveSession(
      session.createSession({
        sessionId: "destroy-session",
        sandboxName: "alpha",
      }),
    );
    expect(session.acquireOnboardLock("nemoclaw destroy").acquired).toBe(true);

    const result = session.compareAndSwapSession(
      (current) => current.sessionId === "destroy-session",
      (current) => {
        current.sandboxName = null;
        return current;
      },
    );

    expect(result).toBe("updated");
    expect(session.loadSession()?.sandboxName).toBeNull();
    expect(fs.existsSync(session.LOCK_FILE)).toBe(true);
  });

  it("refuses a replacement state directory after acquiring the onboarding lock (#9833)", () => {
    const stateDirectory = path.dirname(session.SESSION_FILE);
    const lockedDirectory = `${stateDirectory}.locked`;
    expect(session.acquireOnboardLock("nemoclaw onboard").acquired).toBe(true);
    fs.renameSync(stateDirectory, lockedDirectory);
    fs.mkdirSync(stateDirectory, { mode: 0o700 });

    expect(() =>
      session.saveSession(
        session.createSession({ sessionId: "replacement-directory", sandboxName: "alpha" }),
      ),
    ).toThrow(/state directory changed|lock ownership changed/u);
    expect(fs.existsSync(session.SESSION_FILE)).toBe(false);
  });

  it("refuses a state-directory swap that is restored during the session write (#9833)", () => {
    const stateDirectory = path.dirname(session.SESSION_FILE);
    const lockedDirectory = `${stateDirectory}.locked`;
    const replacementDirectory = `${stateDirectory}.replacement`;
    expect(session.acquireOnboardLock("nemoclaw onboard").acquired).toBe(true);
    session.saveSession(session.createSession({ sessionId: "original", sandboxName: "alpha" }));
    fs.mkdirSync(replacementDirectory, { mode: 0o700 });
    const originalRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      return destination !== session.SESSION_FILE
        ? originalRename(source, destination)
        : (() => {
            originalRename(stateDirectory, lockedDirectory);
            originalRename(replacementDirectory, stateDirectory);
            fs.writeFileSync(String(source), '{"version":1,"sessionId":"replacement"}');
            originalRename(source, destination);
            originalRename(stateDirectory, replacementDirectory);
            originalRename(lockedDirectory, stateDirectory);
          })();
    });
    try {
      expect(() =>
        session.saveSession(
          session.createSession({ sessionId: "attempted-update", sandboxName: "alpha" }),
        ),
      ).toThrow(/session state changed|state directory changed/u);
    } finally {
      renameSpy.mockRestore();
    }
    expect(session.loadSession()?.sessionId).toBe("original");
  });

  it("reads the session file already bound to the locked directory (#9833)", () => {
    const stateDirectory = path.dirname(session.SESSION_FILE);
    const lockedDirectory = `${stateDirectory}.locked`;
    const replacementDirectory = `${stateDirectory}.replacement`;
    expect(session.acquireOnboardLock("nemoclaw onboard").acquired).toBe(true);
    session.saveSession(session.createSession({ sessionId: "original", sandboxName: "alpha" }));
    fs.mkdirSync(replacementDirectory, { mode: 0o700 });
    fs.writeFileSync(
      path.join(replacementDirectory, path.basename(session.SESSION_FILE)),
      JSON.stringify(session.createSession({ sessionId: "replacement", sandboxName: "bravo" })),
    );
    const originalRead = fs.readFileSync;
    const originalRename = fs.renameSync;
    let readThroughPinnedDescriptor = false;
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((source, options) => {
      return typeof source !== "number" || readThroughPinnedDescriptor
        ? originalRead(source, options as never)
        : (() => {
            readThroughPinnedDescriptor = true;
            originalRename(stateDirectory, lockedDirectory);
            originalRename(replacementDirectory, stateDirectory);
            try {
              return originalRead(source, options as never);
            } finally {
              originalRename(stateDirectory, replacementDirectory);
              originalRename(lockedDirectory, stateDirectory);
            }
          })();
    });
    try {
      expect(session.loadSession()?.sessionId).toBe("original");
    } finally {
      readSpy.mockRestore();
    }
    expect(readThroughPinnedDescriptor).toBe(true);
  });

  it("refuses a session delete through a restored replacement directory (#9833)", () => {
    const stateDirectory = path.dirname(session.SESSION_FILE);
    const lockedDirectory = `${stateDirectory}.locked`;
    const replacementDirectory = `${stateDirectory}.replacement`;
    expect(session.acquireOnboardLock("nemoclaw onboard").acquired).toBe(true);
    session.saveSession(session.createSession({ sessionId: "original", sandboxName: "alpha" }));
    fs.mkdirSync(replacementDirectory, { mode: 0o700 });
    fs.writeFileSync(
      path.join(replacementDirectory, path.basename(session.SESSION_FILE)),
      JSON.stringify(session.createSession({ sessionId: "replacement", sandboxName: "bravo" })),
    );
    const originalUnlink = fs.unlinkSync;
    const originalRename = fs.renameSync;
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((candidate) => {
      return candidate !== session.SESSION_FILE
        ? originalUnlink(candidate)
        : (() => {
            originalRename(stateDirectory, lockedDirectory);
            originalRename(replacementDirectory, stateDirectory);
            try {
              return originalUnlink(candidate);
            } finally {
              originalRename(stateDirectory, replacementDirectory);
              originalRename(lockedDirectory, stateDirectory);
            }
          })();
    });
    try {
      expect(() => session.clearSession()).toThrow(/state directory changed|session state changed/u);
    } finally {
      unlinkSpy.mockRestore();
    }
    expect(session.loadSession()?.sessionId).toBe("original");
  });

  it("reports the holder without acquiring a competing lock", async () => {
    const childScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      const lockFile = process.argv[1];
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      const fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: "separate nemoclaw onboard process",
      }));
      process.stdout.write("locked\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", childScript, session.LOCK_FILE], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await once(child.stdout, "data");

    try {
      const acquired = session.acquireOnboardLock("competing nemoclaw onboard");
      expect(acquired.acquired).toBe(false);
      expect(acquired.holderPid).toBe(child.pid);
      expect(acquired.holderCommand).toBe("separate nemoclaw onboard process");

      const authority = await import("../onboard/portable-retirement-authority");
      const messages: string[] = [];
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation((message) => messages.push(String(message)));
      try {
        authority.printPortableOnboardLockContention("NemoClaw", acquired);
        expect(messages.join("\n")).toContain("Wait for the active onboarding run to finish");
        expect(messages.join("\n")).not.toContain("rm -f");
      } finally {
        errorSpy.mockRestore();
      }
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });

  it("does not replace a session written by the process that owns the onboard lock", async () => {
    session.saveSession(
      session.createSession({
        sessionId: "destroyed-sandbox-session",
        sandboxName: "alpha",
        endpointUrl: "http://host.openshell.internal:4000/v1",
        routerPid: 4242,
        routerCredentialHash: "old-hash",
      }),
    );
    const childScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      const lockFile = process.argv[1];
      const sessionFile = process.argv[2];
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      const fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: "replacement nemoclaw onboard process",
      }));
      const replacement = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      replacement.sessionId = "replacement-session";
      replacement.sandboxName = "alpha";
      replacement.endpointUrl = "http://host.openshell.internal:4000/v1";
      replacement.routerPid = 6262;
      replacement.routerCredentialHash = "replacement-hash";
      const tempFile = sessionFile + ".replacement";
      fs.writeFileSync(tempFile, JSON.stringify(replacement), { mode: 0o600 });
      fs.renameSync(tempFile, sessionFile);
      process.stdout.write("replacement-written\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(
      process.execPath,
      ["-e", childScript, session.LOCK_FILE, session.SESSION_FILE],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await once(child.stdout, "data");

    try {
      const result = session.compareAndSwapSession(
        (current) => current.sessionId === "destroyed-sandbox-session",
        (current) => {
          current.routerPid = null;
          current.routerCredentialHash = null;
          return current;
        },
        "nemoclaw destroy Model Router session cleanup",
      );

      expect(result).toBe("busy");
      expect(session.loadSession()).toMatchObject({
        sessionId: "replacement-session",
        sandboxName: "alpha",
        endpointUrl: "http://host.openshell.internal:4000/v1",
        routerPid: 6262,
        routerCredentialHash: "replacement-hash",
      });
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });

  it("never reports two successful recovery writes after losing one record (#9833)", async () => {
    const readyA = path.join(tempHome, "writer-a.ready");
    const readyB = path.join(tempHome, "writer-b.ready");
    const childScript = `
      const fs = require("node:fs");
      const session = require(process.argv[1]);
      const ownReady = process.argv[2];
      const peerReady = process.argv[3];
      const role = process.argv[4];
      const originalWriteFileSync = fs.writeFileSync;
      const wait = (milliseconds) => Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        milliseconds,
      );
      let synchronized = false;
      fs.writeFileSync = (...args) => {
        if (!synchronized && typeof args[0] === "number") {
          synchronized = true;
          originalWriteFileSync(ownReady, role);
          const deadline = Date.now() + 750;
          while (!fs.existsSync(peerReady) && Date.now() < deadline) wait(10);
          if (role === "b") wait(100);
        }
        return originalWriteFileSync(...args);
      };
      try {
        const recorded = session.recordRetainedSandboxRecovery({
          sandboxName: "writer-" + role,
          sandboxIdentityFingerprint: role.repeat(64),
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          lifecycleGeneration: "generation-" + role,
          verifiedEffectivePolicyIdentity: null,
          createAttemptNonce: "c".repeat(62),
          policyCreationReceipt: null,
          reason: "retained_after_sandbox_creation_failure",
        });
        process.stdout.write(JSON.stringify({ ok: true, recordId: recorded.recordId }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));
      }
    `;
    const runWriter = (role: "a" | "b", ownReady: string, peerReady: string) =>
      new Promise<{ ok: boolean }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--require", "tsx/cjs", "-e", childScript, sessionPath, ownReady, peerReady, role],
          { env: { ...process.env, HOME: tempHome }, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += String(chunk)));
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        child.once("error", reject);
        child.once("close", (code) => {
          code === 0
            ? resolve(JSON.parse(stdout) as { ok: boolean })
            : reject(new Error(`recovery writer exited ${String(code)}: ${stderr}`));
        });
      });

    const results = await Promise.all([
      runWriter("a", readyA, readyB),
      runWriter("b", readyB, readyA),
    ]);
    const successfulWrites = results.filter((result) => result.ok).length;
    const records = session.listRetainedSandboxRecoveryRecords();

    expect(successfulWrites).toBeGreaterThan(0);
    expect(records).toHaveLength(successfulWrites);
  });

  it("reconstructs retained recovery after an independent writer failure and restart (#9833)", () => {
    const fingerprint = "a".repeat(64);
    const createAttemptNonce = "b".repeat(62);
    const lifecycleGeneration = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const policyCreationReceipt = {
      schemaVersion: 1,
      origin: "sandbox-create",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: "alpha",
      lifecycleGeneration,
      sandboxIdentityFingerprint: fingerprint,
      policyHash: "sha256:effective",
      policyVersion: 4,
    };
    const writer = spawnSync(
      process.execPath,
      [
        "--require",
        "tsx/cjs",
        "-e",
        `
          const fs = require("node:fs");
          const session = require(process.argv[1]);
          const context = JSON.parse(process.argv[2]);
          session.saveSession(session.createSession({ sessionId: "recovery-writer", sandboxName: "alpha" }));
          const originalRename = fs.renameSync;
          fs.renameSync = (source, destination) => {
            if (destination === session.RETAINED_SANDBOX_RECOVERY_FILE) {
              throw new Error("independent recovery writer unavailable");
            }
            return originalRename(source, destination);
          };
          try {
            session.markRetainedSandboxRecovery(
              "alpha",
              "post-create verification failed",
              ${JSON.stringify(fingerprint)},
              context,
            );
          } catch {}
        `,
        sessionPath,
        JSON.stringify({
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          lifecycleGeneration,
          verifiedEffectivePolicyIdentity: { hash: "sha256:effective", activeVersion: 4 },
          createAttemptNonce,
          policyCreationReceipt,
        }),
      ],
      { env: { ...process.env, HOME: tempHome }, encoding: "utf8" },
    );
    expect(writer.status, writer.stderr).toBe(0);

    delete require.cache[sessionPath];
    const restarted = require("./onboard-session") as OnboardSessionModule;
    const records = restarted.listRetainedSandboxRecoveryRecords();
    expect(records).toEqual([
      expect.objectContaining({
        sandboxName: "alpha",
        sandboxIdentityFingerprint: fingerprint,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration,
        verifiedEffectivePolicyIdentity: { hash: "sha256:effective", activeVersion: 4 },
        createAttemptNonce,
        policyCreationReceipt,
      }),
    ]);
  });
});

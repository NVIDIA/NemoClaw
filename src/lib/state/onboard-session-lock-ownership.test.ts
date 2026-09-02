// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMcpLifecycleLockOwner } from "./mcp-lifecycle-lock-identity";

type OnboardSessionModule = typeof import("./onboard-session");
let session: OnboardSessionModule;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lock-ownership-"));
  vi.stubEnv("HOME", tmpDir);
  vi.resetModules();
  session = await import("./onboard-session");
  session.releaseOnboardLock();
});

afterEach(() => {
  session.releaseOnboardLock();
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("onboard lock ownership", () => {
  it("refuses an oversized onboard lock without reading its body", () => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    fs.writeFileSync(session.LOCK_FILE, "x".repeat(65_537), { mode: 0o600 });
    const readSpy = vi.spyOn(fs, "readSync");
    try {
      expect(() => session.acquireOnboardLock("nemoclaw onboard --resume")).toThrow(
        /regular file exceeds the 65536-byte read limit/u,
      );
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO onboard lock without blocking", () => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    execFileSync("mkfifo", [session.LOCK_FILE]);

    expect(() => session.acquireOnboardLock("nemoclaw onboard --resume")).toThrow(
      /path is not a regular file/u,
    );
  });

  it("reports ownership only while this process holds the acquired lock (#9833)", () => {
    expect(session.isOnboardLockHeldByCurrentProcess()).toBe(false);
    expect(session.acquireOnboardLock("nemoclaw onboard").acquired).toBe(true);
    expect(session.isOnboardLockHeldByCurrentProcess()).toBe(true);

    session.releaseOnboardLock();

    expect(session.isOnboardLockHeldByCurrentProcess()).toBe(false);
  });

  it("refuses cleanup authority after the acquired lock path is replaced (#9833)", () => {
    expect(session.acquireOnboardLock("nemoclaw onboard").acquired).toBe(true);
    expect(session.isOnboardLockHeldByCurrentProcess()).toBe(true);
    const replacement = `${session.LOCK_FILE}.replacement`;
    fs.writeFileSync(
      replacement,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: "replacement owner",
      }),
      { mode: 0o600 },
    );
    fs.renameSync(replacement, session.LOCK_FILE);

    expect(session.isOnboardLockHeldByCurrentProcess()).toBe(false);
    session.releaseOnboardLock();

    expect(session.isOnboardLockHeldByCurrentProcess()).toBe(false);
    expect(JSON.parse(fs.readFileSync(session.LOCK_FILE, "utf8"))).toMatchObject({
      command: "replacement owner",
    });
  });

  it("refuses cleanup authority after the acquired lock gains a hard link (#9833)", () => {
    expect(session.acquireOnboardLock("nemoclaw onboard").acquired).toBe(true);
    const linkedLock = `${session.LOCK_FILE}.linked`;
    fs.linkSync(session.LOCK_FILE, linkedLock);

    expect(session.isOnboardLockHeldByCurrentProcess()).toBe(false);
    expect(() => session.assertOnboardLockOwned()).toThrow(/onboarding lock ownership changed/u);
  });

  it("serializes a contender after the stale inode check and before unlink (#10779)", () => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    fs.writeFileSync(
      session.LOCK_FILE,
      JSON.stringify({
        pid: 999999,
        startedAt: "2026-03-25T00:00:00.000Z",
        command: "departed onboarding owner",
      }),
      { mode: 0o600 },
    );
    const originalUnlinkSync = fs.unlinkSync.bind(fs);
    let contender: ReturnType<OnboardSessionModule["acquireOnboardLock"]> | null = null;
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementationOnce(((target) => {
      contender = session.acquireOnboardLock("nemoclaw onboard --contender");
      originalUnlinkSync(target);
    }) as typeof fs.unlinkSync);

    try {
      const cleaner = session.acquireOnboardLock("nemoclaw onboard --resume");

      expect(cleaner.acquired).toBe(true);
      expect(contender).toMatchObject({ acquired: false });
      expect(JSON.parse(fs.readFileSync(session.LOCK_FILE, "utf8"))).toMatchObject({
        command: "nemoclaw onboard --resume",
      });
    } finally {
      unlinkSpy.mockRestore();
      session.releaseOnboardLock();
    }
  });

  it("recovers an onboarding reclamation guard left by a departed process (#10779)", () => {
    const guardFile = path.join(path.dirname(session.LOCK_FILE), "onboard.lock.reclamation-guard");
    const departedOwner = {
      ...createMcpLifecycleLockOwner("onboard-lock-reclamation", "departed-guard"),
      pid: 2_147_483_647,
      processIdentity: "departed-process",
    };
    fs.mkdirSync(path.dirname(guardFile), { recursive: true });
    fs.writeFileSync(guardFile, JSON.stringify(departedOwner), { mode: 0o600 });

    expect(session.acquireOnboardLock("nemoclaw onboard --resume").acquired).toBe(true);
    expect(fs.existsSync(guardFile)).toBe(false);
  });

  it("reports a foreign reclamation guard without removing it (#10779)", () => {
    const guardFile = path.join(path.dirname(session.LOCK_FILE), "onboard.lock.reclamation-guard");
    const foreignOwner = {
      ...createMcpLifecycleLockOwner("onboard-lock-reclamation", "foreign-guard"),
      pid: 4242,
      processIdentity: "foreign-process",
      hostIdentity: "foreign-host",
      pidNamespaceIdentity: "pid:[4242]",
    };
    fs.mkdirSync(path.dirname(guardFile), { recursive: true });
    fs.writeFileSync(guardFile, JSON.stringify(foreignOwner), { mode: 0o600 });

    const result = session.acquireOnboardLock("nemoclaw onboard --resume");

    expect(result).toMatchObject({
      acquired: false,
      reclamationGuard: {
        guardFile,
        owner: {
          pid: 4242,
          processIdentity: "foreign-process",
          hostIdentity: "foreign-host",
          pidNamespaceIdentity: "pid:[4242]",
        },
      },
    });
    expect(fs.existsSync(guardFile)).toBe(true);
    expect(session.describeOnboardLockContention(result)).toEqual({
      reason: expect.stringContaining(`reclamation guard '${guardFile}'`),
      remediation:
        "Wait briefly and retry. If the guard remains, confirm on its reported host and PID " +
        "namespace that the owner no longer uses it. Do not remove the guard if you cannot " +
        `confirm this; ask that host's administrator to resolve '${guardFile}', then retry.`,
    });
  });

  it("reports an oversized canonical reclamation guard without reading its body (#10779)", () => {
    expect(session.acquireOnboardLock("prime reclamation owner identity cache").acquired).toBe(true);
    session.releaseOnboardLock();
    const guardFile = path.join(path.dirname(session.LOCK_FILE), "onboard.lock.reclamation-guard");
    fs.mkdirSync(path.dirname(guardFile), { recursive: true });
    fs.writeFileSync(guardFile, "x".repeat(65_537), { mode: 0o600 });
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("oversized guard body must not be read");
    });

    const result = session.acquireOnboardLock("nemoclaw onboard --resume");

    expect(result).toMatchObject({
      acquired: false,
      reclamationGuard: { guardFile },
    });
    expect(readSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(guardFile)).toBe(true);
  });

  it.each(["candidate", "reclaim"] as const)(
    "reconciles an interrupted stale reclamation-guard %s artifact (#10779)",
    (kind) => {
      const guardFile = path.join(path.dirname(session.LOCK_FILE), "onboard.lock.reclamation-guard");
      const token = "11111111-1111-4111-8111-111111111111";
      const departedOwner = {
        ...createMcpLifecycleLockOwner("onboard-lock-reclamation", token),
        pid: 2_147_483_647,
        processIdentity: "departed-process",
      };
      const artifactFile =
        kind === "candidate"
          ? `${guardFile}.candidate-${String(departedOwner.pid)}-${token}`
          : `${guardFile}.reclaim-${String(process.pid)}-22222222-2222-4222-8222-222222222222`;
      fs.mkdirSync(path.dirname(guardFile), { recursive: true });
      fs.writeFileSync(artifactFile, JSON.stringify(departedOwner), { mode: 0o600 });

      expect(session.acquireOnboardLock("nemoclaw onboard --resume").acquired).toBe(true);
      expect(fs.existsSync(artifactFile)).toBe(false);
    },
  );

  it("reports an unverifiable reclamation-guard artifact without removing it (#10779)", () => {
    const guardFile = path.join(path.dirname(session.LOCK_FILE), "onboard.lock.reclamation-guard");
    const token = "33333333-3333-4333-8333-333333333333";
    const foreignOwner = {
      ...createMcpLifecycleLockOwner("onboard-lock-reclamation", token),
      pid: 4242,
      processIdentity: "foreign-process",
      hostIdentity: "foreign-host",
    };
    const artifactFile = `${guardFile}.candidate-${String(foreignOwner.pid)}-${token}`;
    fs.mkdirSync(path.dirname(guardFile), { recursive: true });
    fs.writeFileSync(artifactFile, JSON.stringify(foreignOwner), { mode: 0o600 });

    const result = session.acquireOnboardLock("nemoclaw onboard --resume");

    expect(result).toMatchObject({
      acquired: false,
      reclamationGuard: { guardFile: artifactFile, owner: { hostIdentity: "foreign-host" } },
    });
    expect(fs.existsSync(artifactFile)).toBe(true);
  });

  it("blocks an oversized replacement that appears while reclaiming a stale guard artifact", () => {
    const guardFile = path.join(path.dirname(session.LOCK_FILE), "onboard.lock.reclamation-guard");
    const token = "44444444-4444-4444-8444-444444444444";
    const departedOwner = {
      ...createMcpLifecycleLockOwner("onboard-lock-reclamation", token),
      pid: 2_147_483_647,
      processIdentity: "departed-process",
    };
    const artifactFile = `${guardFile}.candidate-${String(departedOwner.pid)}-${token}`;
    fs.mkdirSync(path.dirname(guardFile), { recursive: true });
    fs.writeFileSync(artifactFile, JSON.stringify(departedOwner), { mode: 0o600 });
    const originalRenameSync = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(((from, to) => {
      originalRenameSync(from, to);
      fs.writeFileSync(from, "x".repeat(65_537), { mode: 0o600 });
    }) as typeof fs.renameSync);
    const result = session.acquireOnboardLock("nemoclaw onboard --resume");

    expect(result).toMatchObject({
      acquired: false,
      reclamationGuard: { guardFile: artifactFile },
    });
    expect(fs.statSync(artifactFile).size).toBe(65_537);
    renameSpy.mockRestore();
  });

  it("restores and blocks a guard artifact that grows after its reclamation rename", () => {
    const guardFile = path.join(path.dirname(session.LOCK_FILE), "onboard.lock.reclamation-guard");
    const token = "55555555-5555-4555-8555-555555555555";
    const departedOwner = {
      ...createMcpLifecycleLockOwner("onboard-lock-reclamation", token),
      pid: 2_147_483_647,
      processIdentity: "departed-process",
    };
    const artifactFile = `${guardFile}.candidate-${String(departedOwner.pid)}-${token}`;
    fs.mkdirSync(path.dirname(guardFile), { recursive: true });
    fs.writeFileSync(artifactFile, JSON.stringify(departedOwner), { mode: 0o600 });
    const originalRenameSync = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(((from, to) => {
      originalRenameSync(from, to);
      fs.appendFileSync(to, "x".repeat(65_537));
    }) as typeof fs.renameSync);
    const result = session.acquireOnboardLock("nemoclaw onboard --resume");

    expect(result).toMatchObject({
      acquired: false,
      reclamationGuard: { guardFile: artifactFile },
    });
    expect(fs.statSync(artifactFile).size).toBeGreaterThan(65_536);
    renameSpy.mockRestore();
  });

  it("retries a failed local guard-candidate cleanup before the next acquisition", () => {
    let retainedCandidatePath: string | null = null;
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementationOnce(((target) => {
      retainedCandidatePath = String(target);
      throw Object.assign(new Error("candidate cleanup denied"), { code: "EACCES" });
    }) as typeof fs.rmSync);

    try {
      expect(session.acquireOnboardLock("nemoclaw onboard --resume").acquired).toBe(true);
      session.releaseOnboardLock();
      expect(retainedCandidatePath).not.toBeNull();
      expect(fs.existsSync(retainedCandidatePath!)).toBe(false);

      expect(session.acquireOnboardLock("nemoclaw onboard --retry").acquired).toBe(true);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("reports a retained local guard candidate whose cleanup keeps failing", () => {
    const originalRenameSync = fs.renameSync.bind(fs);
    let retainedCandidatePath: string | null = null;
    const denied = () => Object.assign(new Error("candidate cleanup denied"), { code: "EACCES" });
    const denyRename = (): never => {
      throw denied();
    };
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementationOnce(((target) => {
      retainedCandidatePath = String(target);
      throw denied();
    }) as typeof fs.rmSync);
    const renameSpy = vi
      .spyOn(fs, "renameSync")
      .mockImplementation(
        ((from, to) =>
          from === retainedCandidatePath
            ? denyRename()
            : originalRenameSync(from, to)) as typeof fs.renameSync,
      );

    try {
      expect(session.acquireOnboardLock("nemoclaw onboard --resume").acquired).toBe(true);
      session.releaseOnboardLock();
      const result = session.acquireOnboardLock("nemoclaw onboard --retry");

      expect(result).toMatchObject({
        acquired: false,
        reclamationGuard: {
          cleanupFailure: true,
          guardFile: retainedCandidatePath,
          owner: { pid: process.pid },
        },
      });
      expect(session.describeOnboardLockContention(result)).toEqual({
        reason: expect.stringContaining(
          `Cleanup of onboarding lock reclamation guard artifact '${retainedCandidatePath!}' failed`,
        ),
        remediation: expect.stringContaining("Let the reported NemoClaw process exit, then retry"),
      });
      expect(fs.existsSync(retainedCandidatePath!)).toBe(true);
    } finally {
      renameSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });
});

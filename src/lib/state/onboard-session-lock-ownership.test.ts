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
});

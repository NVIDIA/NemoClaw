// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OnboardLockEvidence } from "./onboard-session/lock-observation";

type OnboardSessionModule = typeof import("./onboard-session");
let session: OnboardSessionModule;
let tmpDir: string;

function completeEvidence(): OnboardLockEvidence {
  return {
    hostIdentity: () => "host-a",
    pidNamespaceIdentity: () => "pid:[1]",
    processGeneration: () => "process-generation-a",
    processAlive: () => true,
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lock-ownership-"));
  vi.stubEnv("HOME", tmpDir);
  vi.resetModules();
  session = await import("./onboard-session");
  session.releaseOnboardLock();
});

afterEach(() => {
  session.releaseOnboardLock();
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("onboard lock ownership", () => {
  it("does not create an onboard lock without complete owner evidence", () => {
    const incompleteEvidence: OnboardLockEvidence = {
      hostIdentity: () => "host-a",
      pidNamespaceIdentity: () => "pid:[1]",
      processGeneration: () => null,
      processAlive: () => true,
    };

    expect(session.acquireOnboardLock("nemoclaw onboard", incompleteEvidence)).toEqual({
      acquired: false,
      lockFile: session.LOCK_FILE,
      stale: false,
    });
    expect(fs.existsSync(session.LOCK_FILE)).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "refuses a FIFO lock path without blocking or replacing it",
    () => {
      fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
      expect(spawnSync("mkfifo", [session.LOCK_FILE]).status).toBe(0);

      expect(session.acquireOnboardLock("nemoclaw onboard")).toEqual({
        acquired: false,
        lockFile: session.LOCK_FILE,
        stale: false,
      });
      expect(fs.lstatSync(session.LOCK_FILE).isFIFO()).toBe(true);
    },
  );

  it("refuses an oversized lock file without reading or replacing it", () => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    const contents = Buffer.alloc(64 * 1024 + 1, "x");
    fs.writeFileSync(session.LOCK_FILE, contents, { mode: 0o600 });

    const readSpy = vi.spyOn(fs, "readSync");
    try {
      expect(session.acquireOnboardLock("nemoclaw onboard")).toEqual({
        acquired: false,
        lockFile: session.LOCK_FILE,
        stale: false,
      });
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
    expect(fs.readFileSync(session.LOCK_FILE)).toEqual(contents);
  });

  it("publishes the complete lock payload across short writes", () => {
    const originalWriteSync = fs.writeSync.bind(fs) as typeof fs.writeSync;
    const writeSync = vi
      .spyOn(fs, "writeSync")
      .mockImplementation(((
        fd: number,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number | null,
      ) =>
        originalWriteSync(
          fd,
          buffer,
          offset,
          Math.min(length, 7),
          position,
        )) as typeof fs.writeSync);

    let writeCount = 0;
    try {
      expect(session.acquireOnboardLock("nemoclaw onboard", completeEvidence()).acquired).toBe(
        true,
      );
      writeCount = writeSync.mock.calls.length;
    } finally {
      writeSync.mockRestore();
    }

    expect(writeCount).toBeGreaterThan(1);
    expect(JSON.parse(fs.readFileSync(session.LOCK_FILE, "utf8"))).toMatchObject({
      pid: process.pid,
      command: "nemoclaw onboard",
      hostIdentity: "host-a",
    });
  });

  it("rejects a zero-progress lock write and removes only that attempt", () => {
    const writeSync = vi
      .spyOn(fs, "writeSync")
      .mockImplementation((() => 0) as typeof fs.writeSync);

    try {
      expect(() => session.acquireOnboardLock("nemoclaw onboard", completeEvidence())).toThrow(
        "write made no progress",
      );
    } finally {
      writeSync.mockRestore();
    }

    expect(fs.existsSync(session.LOCK_FILE)).toBe(false);
    expect(session.isOnboardLockHeldByCurrentProcess()).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "preserves a replacement raced into place after a failed lock write",
    () => {
      fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
      const replacement = `${session.LOCK_FILE}.replacement`;
      const replacementContents = "replacement lock";
      fs.writeFileSync(replacement, replacementContents, { mode: 0o600 });
      const writeSync = vi.spyOn(fs, "writeSync").mockImplementation((() => {
        fs.renameSync(replacement, session.LOCK_FILE);
        return 0;
      }) as typeof fs.writeSync);

      try {
        expect(() => session.acquireOnboardLock("nemoclaw onboard", completeEvidence())).toThrow(
          "write made no progress",
        );
      } finally {
        writeSync.mockRestore();
      }

      expect(fs.readFileSync(session.LOCK_FILE, "utf8")).toBe(replacementContents);
      expect(session.isOnboardLockHeldByCurrentProcess()).toBe(false);
    },
  );

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

  it("does not release a foreign lock with the local PID without an acquired descriptor", () => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    const contents = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: "foreign owner",
      processGeneration: "foreign-process-generation",
      hostIdentity: "foreign-host",
      pidNamespaceIdentity: "foreign-pid-namespace",
    });
    fs.writeFileSync(session.LOCK_FILE, contents, { mode: 0o600 });

    session.releaseOnboardLock();

    expect(fs.readFileSync(session.LOCK_FILE, "utf8")).toBe(contents);
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OnboardSessionModule = typeof import("./onboard-session");
type LockHolderModule = typeof import("./onboard-session/lock-holder");
type OnboardLockRecord = ReturnType<LockHolderModule["createOnboardLockRecord"]>;
let session: OnboardSessionModule;
let lockHolder: LockHolderModule;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lock-ownership-"));
  vi.stubEnv("HOME", tmpDir);
  vi.resetModules();
  session = await import("./onboard-session");
  lockHolder = await import("./onboard-session/lock-holder");
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

  it("gives guarded recovery for a live PID without verified process identity", () => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    const record = lockHolder.createOnboardLockRecord(
      "unverified onboarding owner",
      "2026-09-02T00:00:00.000Z",
    );
    fs.writeFileSync(
      session.LOCK_FILE,
      JSON.stringify({
        ...record,
        processStartIdentity: null,
      }),
      { mode: 0o600 },
    );

    const result = session.acquireOnboardLock("nemoclaw onboard --resume");

    expect(result).toMatchObject({
      acquired: false,
      holderIdentityVerified: false,
      holderPid: process.pid,
      lockFile: session.LOCK_FILE,
    });
    const contention = session.describeOnboardLockContention(result);
    expect(contention.reason).toContain(
      `Onboarding lock '${session.LOCK_FILE}' records live PID ${String(process.pid)}`,
    );
    expect(contention.reason).toContain("NemoClaw cannot confirm that PID owns an onboarding run");
    expect(contention.reason).not.toContain("Another onboarding run owns");
    expect(contention.remediation).toBe(
      "Verify that no onboarding run is active. If none is active, remove only " +
        `'${session.LOCK_FILE}', then retry.`,
    );
    expect(fs.existsSync(session.LOCK_FILE)).toBe(true);
  });

  it.each([
    [
      "foreign host",
      (record: OnboardLockRecord) => ({
        record: { ...record, hostIdentity: `${record.hostIdentity ?? "host"}:foreign` },
        provenance: "foreign",
        reason: "in a different host or PID namespace",
      }),
    ],
    [
      "foreign PID namespace",
      (record: OnboardLockRecord) => ({
        record: {
          ...record,
          pidNamespaceIdentity: `${record.pidNamespaceIdentity ?? "pid:[local]"}:foreign`,
        },
        provenance: record.pidNamespaceIdentity === null ? "unknown" : "foreign",
        reason:
          record.pidNamespaceIdentity === null
            ? "has no verifiable host and PID-namespace provenance"
            : "in a different host or PID namespace",
      }),
    ],
    [
      "legacy owner without provenance",
      (record: OnboardLockRecord) => ({
        record: {
          pid: record.pid,
          processStartIdentity: record.processStartIdentity,
          startedAt: record.startedAt,
          command: record.command,
        },
        provenance: "unknown",
        reason: "has no verifiable host and PID-namespace provenance",
      }),
    ],
  ] as const)("does not replace an onboard lock from a %s", (_case, makeOwner) => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    const localRecord = lockHolder.createOnboardLockRecord(
      "foreign or legacy onboarding owner",
      "2026-09-02T00:00:00.000Z",
    );
    const owner = makeOwner(localRecord);
    const contents = JSON.stringify(owner.record);
    fs.writeFileSync(session.LOCK_FILE, contents, { mode: 0o600 });
    const inode = fs.statSync(session.LOCK_FILE).ino;

    const result = session.acquireOnboardLock("nemoclaw onboard --resume");

    expect(result).toMatchObject({
      acquired: false,
      holderPid: process.pid,
      holderIdentityVerified: false,
      holderProvenance: owner.provenance,
    });
    expect(fs.statSync(session.LOCK_FILE).ino).toBe(inode);
    expect(fs.readFileSync(session.LOCK_FILE, "utf8")).toBe(contents);
    const contention = session.describeOnboardLockContention(result);
    expect(contention.reason).toContain(session.LOCK_FILE);
    expect(contention.reason).toContain(owner.reason);
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

  it.each([
    [
      "verified replacement",
      (record: OnboardLockRecord) => record,
      "local",
    ],
    [
      "unverified replacement",
      (record: OnboardLockRecord) => ({
        pid: record.pid,
        processStartIdentity: record.processStartIdentity,
        startedAt: record.startedAt,
        command: record.command,
      }),
      "unknown",
    ],
  ] as const)("restores a %s raced into an atomic stale-generation claim", (_case, replace, provenance) => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    const staleRecord = {
      ...lockHolder.createOnboardLockRecord(
        "departed onboarding owner",
        "2026-03-25T00:00:00.000Z",
      ),
      pid: 2_147_483_647,
      processStartIdentity: "departed-process",
    };
    fs.writeFileSync(session.LOCK_FILE, JSON.stringify(staleRecord), { mode: 0o600 });
    const replacement = replace(
      lockHolder.createOnboardLockRecord(
        "replacement onboarding owner",
        "2026-09-02T00:00:00.000Z",
      ),
    );
    const replacementContents = JSON.stringify(replacement);
    let replacementInode: number | null = null;
    const displacedStale = `${session.LOCK_FILE}.observed-stale`;
    const originalRenameSync = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(((from, to) => {
      originalRenameSync(from, displacedStale);
      fs.writeFileSync(from, replacementContents, { mode: 0o600 });
      replacementInode = fs.statSync(from).ino;
      originalRenameSync(from, to);
    }) as typeof fs.renameSync);

    const result = session.acquireOnboardLock("nemoclaw onboard --resume");

    expect(result).toMatchObject({
      acquired: false,
      holderPid: process.pid,
      holderProvenance: provenance,
    });
    expect(renameSpy).toHaveBeenCalledOnce();
    expect(fs.statSync(session.LOCK_FILE).ino).toBe(replacementInode);
    expect(fs.readFileSync(session.LOCK_FILE, "utf8")).toBe(replacementContents);
    expect(
      fs
        .readdirSync(path.dirname(session.LOCK_FILE))
        .filter((name) => name.startsWith(`${path.basename(session.LOCK_FILE)}.reclaim-`)),
    ).toEqual([]);
    renameSpy.mockRestore();
  });

  it("restores an oversized replacement without reading it during atomic stale reclamation", () => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    const staleRecord = {
      ...lockHolder.createOnboardLockRecord(
        "departed onboarding owner",
        "2026-03-25T00:00:00.000Z",
      ),
      pid: 2_147_483_647,
    };
    fs.writeFileSync(session.LOCK_FILE, JSON.stringify(staleRecord), { mode: 0o600 });
    const oversizedReplacement = "x".repeat(65_537);
    const displacedStale = `${session.LOCK_FILE}.observed-stale`;
    let replacementInode: number | null = null;
    const originalRenameSync = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(((from, to) => {
      originalRenameSync(from, displacedStale);
      fs.writeFileSync(from, oversizedReplacement, { mode: 0o600 });
      replacementInode = fs.statSync(from).ino;
      originalRenameSync(from, to);
    }) as typeof fs.renameSync);
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("oversized replacement body must not be read");
    });

    try {
      expect(() => session.acquireOnboardLock("nemoclaw onboard --resume")).toThrow(
        /exceeds the 65536-byte observation limit/u,
      );
      expect(readSpy).not.toHaveBeenCalled();
      expect(fs.statSync(session.LOCK_FILE).ino).toBe(replacementInode);
      expect(fs.statSync(session.LOCK_FILE).size).toBe(65_537);
    } finally {
      readSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });
});

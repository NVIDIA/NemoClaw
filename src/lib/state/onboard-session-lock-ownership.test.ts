// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("removes a quarantined replacement when link-back loses a race (#11395)", () => {
    expect(session.acquireOnboardLock("nemoclaw onboard").acquired).toBe(true);
    const renameSync = fs.renameSync.bind(fs);
    const replacementContents = JSON.stringify({
      command: "replacement owner",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const concurrentContents = JSON.stringify({
      command: "concurrent owner",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      const replacement = `${String(source)}.replacement`;
      fs.writeFileSync(replacement, replacementContents, { mode: 0o600 });
      renameSync(replacement, source);
      renameSync(source, destination);
    });
    vi.spyOn(fs, "linkSync").mockImplementation((_existingPath, newPath) => {
      fs.writeFileSync(newPath, concurrentContents, { mode: 0o600 });
      throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
    });

    session.releaseOnboardLock();

    expect(JSON.parse(fs.readFileSync(session.LOCK_FILE, "utf8"))).toMatchObject({
      command: "concurrent owner",
    });
    expect(
      fs
        .readdirSync(path.dirname(session.LOCK_FILE))
        .filter((entry) => entry.includes(".release-")),
    ).toEqual([]);
  });
});

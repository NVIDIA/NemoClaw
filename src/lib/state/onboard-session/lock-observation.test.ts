// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  observeOnboardLock,
  type OnboardLockEvidence,
  type OnboardLockOwner,
} from "./lock-observation";

const roots: string[] = [];

function fixture(): {
  evidence: OnboardLockEvidence;
  lock: string;
  owner: OnboardLockOwner;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-observation-"));
  roots.push(root);
  const lock = path.join(root, "onboard.lock");
  const owner: OnboardLockOwner = {
    pid: 123,
    startedAt: "2026-09-02T00:00:00.000Z",
    command: "nemoclaw onboard",
    processGeneration: "boot:10",
    hostIdentity: "host-a",
    pidNamespaceIdentity: "pid:[1]",
  };
  const evidence: OnboardLockEvidence = {
    hostIdentity: () => "host-a",
    pidNamespaceIdentity: () => "pid:[1]",
    processGeneration: () => "boot:10",
    processAlive: () => true,
  };
  return { evidence, lock, owner };
}

function writeOwner(lock: string, owner: OnboardLockOwner): void {
  fs.writeFileSync(lock, JSON.stringify(owner), { mode: 0o600 });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("onboarding lock observation", () => {
  it("reports a missing lock as absent", () => {
    const { evidence, lock } = fixture();
    expect(observeOnboardLock(lock, evidence)).toEqual({ kind: "absent" });
  });

  it("reports only proven-local departed and reused owners as stale", () => {
    const { evidence, lock, owner } = fixture();
    writeOwner(lock, owner);
    expect(observeOnboardLock(lock, { ...evidence, processAlive: () => false })).toMatchObject({
      kind: "stale",
      reason: "departed",
    });
    expect(
      observeOnboardLock(lock, {
        ...evidence,
        processGeneration: () => "boot:11",
      }),
    ).toMatchObject({ kind: "stale", reason: "pid-reused" });
  });

  it.each([
    ["active", {}],
    ["unverified", { processGeneration: () => null }],
    ["foreign", { hostIdentity: () => "host-b" }],
    ["foreign", { pidNamespaceIdentity: () => "pid:[2]" }],
  ] as const)("keeps %s owners busy", (reason, overrides) => {
    const { evidence, lock, owner } = fixture();
    writeOwner(lock, owner);
    expect(observeOnboardLock(lock, { ...evidence, ...overrides })).toMatchObject({
      kind: "busy",
      reason,
    });
  });

  it("keeps legacy, oversized, linked, and non-regular state busy", () => {
    const { evidence, lock } = fixture();
    fs.writeFileSync(lock, JSON.stringify({ pid: 123 }));
    expect(observeOnboardLock(lock, evidence)).toMatchObject({ kind: "busy" });
    fs.writeFileSync(lock, "x".repeat(64 * 1024 + 1));
    expect(observeOnboardLock(lock, evidence)).toEqual({
      kind: "busy",
      reason: "unsafe",
    });
    fs.rmSync(lock);
    fs.mkdirSync(lock);
    expect(observeOnboardLock(lock, evidence)).toEqual({
      kind: "busy",
      reason: "unsafe",
    });
  });

  it("keeps symlink and hard-linked lock paths unsafe", () => {
    const { evidence, lock, owner } = fixture();
    const target = `${lock}.target`;
    writeOwner(target, owner);
    fs.symlinkSync(target, lock);
    expect(observeOnboardLock(lock, evidence)).toEqual({ kind: "busy", reason: "unsafe" });

    fs.rmSync(lock);
    fs.linkSync(target, lock);
    expect(observeOnboardLock(lock, evidence)).toEqual({ kind: "busy", reason: "unsafe" });
  });

  it.runIf(process.platform !== "win32")("keeps a FIFO lock path unsafe", () => {
    const { evidence, lock } = fixture();
    expect(spawnSync("mkfifo", [lock]).status).toBe(0);
    expect(observeOnboardLock(lock, evidence)).toEqual({ kind: "busy", reason: "unsafe" });
  });

  it("keeps a lock changed during its stable read busy", () => {
    const { evidence, lock, owner } = fixture();
    writeOwner(lock, owner);
    const original = fs.fstatSync.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "fstatSync").mockImplementation((fd) => {
      calls += 1;
      if (calls === 2) fs.appendFileSync(lock, " ");
      return original(fd);
    });
    expect(observeOnboardLock(lock, evidence)).toEqual({ kind: "busy", reason: "publishing" });
  });

  it("keeps a lock replaced between descriptor and path checks unsafe", () => {
    const { evidence, lock, owner } = fixture();
    writeOwner(lock, owner);
    const original = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation((path) => {
      fs.renameSync(lock, `${lock}.old`);
      writeOwner(lock, owner);
      return original(path);
    });
    expect(observeOnboardLock(lock, evidence)).toEqual({ kind: "busy", reason: "unsafe" });
  });

  it.each([0, -1])("keeps a malformed PID %s unverified", (pid) => {
    const { evidence, lock, owner } = fixture();
    writeOwner(lock, { ...owner, pid });
    expect(observeOnboardLock(lock, evidence)).toEqual({
      kind: "busy",
      reason: "unverified",
    });
  });

  it("keeps an empty process generation unverified", () => {
    const { evidence, lock, owner } = fixture();
    writeOwner(lock, { ...owner, processGeneration: "" });
    expect(observeOnboardLock(lock, evidence)).toEqual({
      kind: "busy",
      reason: "unverified",
    });
  });

  it("does not consult the local PID table for a foreign owner", () => {
    const { evidence, lock, owner } = fixture();
    writeOwner(lock, owner);
    let probed = false;
    const result = observeOnboardLock(lock, {
      ...evidence,
      hostIdentity: () => "host-b",
      processAlive: () => {
        probed = true;
        return false;
      },
    });
    expect(result).toMatchObject({ kind: "busy", reason: "foreign" });
    expect(probed).toBe(false);
  });
});

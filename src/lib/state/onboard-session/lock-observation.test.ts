// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  observeOnboardLock,
  type OnboardLockEvidence,
  type OnboardLockOwner,
} from "./lock-observation";

const roots: string[] = [];

function fixture(): { evidence: OnboardLockEvidence; lock: string; owner: OnboardLockOwner } {
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
      observeOnboardLock(lock, { ...evidence, processGeneration: () => "boot:11" }),
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
    expect(observeOnboardLock(lock, evidence)).toEqual({ kind: "busy", reason: "unsafe" });
    fs.rmSync(lock);
    fs.mkdirSync(lock);
    expect(observeOnboardLock(lock, evidence)).toEqual({ kind: "busy", reason: "unsafe" });
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
